// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Editor ⇄ paragraph serialization.
 *
 * The reader's stored shape is deliberately not a rich-text document: a block is
 * plain `text` plus a flat list of half-open `InlineSpan`s. The editor
 * (ProseMirror through Tiptap) speaks a tree of nodes and marks. This module is
 * the only place that translates between the two, so the offset rules have one
 * home and can be unit-tested without a DOM or an editor instance.
 *
 * ## Why a tree at all
 *
 * The editor needs nesting to represent `**a _b_**` while it is being edited;
 * the stored form needs the flattened, non-overlapping runs that every consumer
 * already understands (the renderer, `Range.toString()` offsets, the note
 * validator, the sync schema). Translating on save is cheaper than teaching the
 * whole application ProseMirror's model.
 *
 * ## What is intentionally unsupported
 *
 * The editor schema is one paragraph plus the five inline marks the contract
 * knows. A hard break is folded to a space because a paragraph's stored text
 * cannot contain a newline (`normalizeProse` collapses it anyway). Any other
 * node type is rejected rather than silently dropped: a dropped node would be
 * an edit the user made and the application lost.
 */

import {
  INLINE_MARK_ORDER,
  type InlineMarkKind,
  type InlineSpan,
} from "../../../shared/contracts/index";
import { normalizeProseWithMap } from "../local-import-blocks";
import {
  canonicalizeSpans,
  spansAreSound,
  type RawMark,
} from "../local-import-inline";

/** The largest single block the editor will accept, in characters. */
export const MAX_EDIT_BLOCK_CHARS = 100_000;

/** The subset of ProseMirror's JSON a mark carries. */
export interface EditorMarkJson {
  type: string;
  attrs?: Record<string, unknown>;
}

/** The subset of ProseMirror's JSON this module reads and writes. */
export interface EditorNodeJson {
  type: string;
  text?: string;
  marks?: EditorMarkJson[];
  content?: EditorNodeJson[];
  attrs?: Record<string, unknown>;
}

export type SerializeEditResult =
  | { ok: true; text: string; spans: InlineSpan[] }
  | { ok: false; code: "EMPTY" | "TOO_LONG" | "UNSUPPORTED_NODE"; message: string };

/**
 * ProseMirror mark name → stored mark kind.
 *
 * `underline` is deliberately absent: the content contract does not have it,
 * and accepting it here would make an underline that disappears on reload.
 */
const KIND_BY_MARK: ReadonlyMap<string, InlineMarkKind> = new Map([
  ["bold", "strong"],
  ["italic", "em"],
  ["code", "code"],
  ["strike", "del"],
  ["link", "link"],
]);

/** Stored mark kind → ProseMirror mark name. Inverse of the map above. */
const MARK_BY_KIND: Readonly<Record<InlineMarkKind, string>> = {
  strong: "bold",
  em: "italic",
  code: "code",
  del: "strike",
  link: "link",
};

function hrefOf(mark: EditorMarkJson): string | undefined {
  const href = mark.attrs?.href;
  return typeof href === "string" && href.length > 0 ? href : undefined;
}

/** Mutable accumulator used while walking a text run. */
interface Run {
  text: string;
  marks: EditorMarkJson[];
}

function runsOf(doc: EditorNodeJson): { runs: Run[]; unsupported: string | null } {
  const runs: Run[] = [];
  let unsupported: string | null = null;

  const visit = (node: EditorNodeJson): void => {
    if (unsupported) return;
    if (node.type === "text") {
      const text = node.text ?? "";
      if (text.length > 0) runs.push({ text, marks: [...(node.marks ?? [])] });
      return;
    }
    if (node.type === "hardBreak") {
      runs.push({ text: " ", marks: [] });
      return;
    }
    if (node.type === "doc" || node.type === "paragraph") {
      for (const child of node.content ?? []) visit(child);
      return;
    }
    unsupported = node.type;
  };

  visit(doc);
  return { runs, unsupported };
}

/**
 * Editor document → `{ text, spans }` in the stored coordinate system.
 *
 * The raw text is normalised with the same `normalizeProseWithMap` the import
 * pipeline uses, so an edit and an import of the same characters produce the
 * same `hash` and the same spans. A naive `trim()` here would make an edited
 * paragraph hash differently from the identical imported one.
 */
export function serializeEditorDoc(doc: EditorNodeJson): SerializeEditResult {
  const { runs, unsupported } = runsOf(doc);
  if (unsupported) {
    return {
      ok: false,
      code: "UNSUPPORTED_NODE",
      message: `编辑器产生了不支持的节点：${unsupported}`,
    };
  }

  const raw = runs.map((run) => run.text).join("");
  const { text, map } = normalizeProseWithMap(raw);
  if (text.length === 0) {
    return { ok: false, code: "EMPTY", message: "段落不能为空。" };
  }
  if (text.length > MAX_EDIT_BLOCK_CHARS) {
    return {
      ok: false,
      code: "TOO_LONG",
      message: `单段超过 ${MAX_EDIT_BLOCK_CHARS} 字符上限。`,
    };
  }

  const rawMarks: RawMark[] = [];
  let offset = 0;
  for (const run of runs) {
    const start = offset;
    const end = offset + run.text.length;
    offset = end;
    if (run.text.length === 0) continue;
    for (const mark of run.marks) {
      const kind = KIND_BY_MARK.get(mark.type);
      if (!kind) continue;
      const href = kind === "link" ? hrefOf(mark) : undefined;
      if (kind === "link" && !href) continue;
      const mappedStart = map.toOutput(start, "start");
      const mappedEnd = map.toOutput(end, "end");
      if (mappedStart >= mappedEnd) continue;
      rawMarks.push(
        href === undefined
          ? { start: mappedStart, end: mappedEnd, kind }
          : { start: mappedStart, end: mappedEnd, kind, href },
      );
    }
  }

  const spans = canonicalizeSpans(rawMarks, text.length).filter((span) =>
    span.kinds.some((kind) => INLINE_MARK_ORDER.includes(kind)),
  );
  if (!spansAreSound(spans, text.length)) {
    return {
      ok: false,
      code: "UNSUPPORTED_NODE",
      message: "编辑器产生的行内标记越界，已拒绝保存。",
    };
  }

  return { ok: true, text, spans };
}

interface TextNode {
  type: "text";
  text: string;
  marks?: EditorMarkJson[];
}

function marksForSpan(span: InlineSpan): EditorMarkJson[] {
  const marks: EditorMarkJson[] = [];
  for (const kind of INLINE_MARK_ORDER) {
    if (!span.kinds.includes(kind)) continue;
    if (kind === "link") {
      if (span.href) marks.push({ type: MARK_BY_KIND.link, attrs: { href: span.href } });
      continue;
    }
    marks.push({ type: MARK_BY_KIND[kind] });
  }
  return marks;
}

function sameMarks(a: readonly EditorMarkJson[] | undefined, b: readonly EditorMarkJson[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((mark, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      mark.type === other.type &&
      (mark.attrs?.href ?? "") === (other.attrs?.href ?? "")
    );
  });
}

/**
 * Stored paragraph → editor document JSON.
 *
 * Boundaries are cut at every span start/end so overlapping emphasis becomes
 * adjacent text nodes with their own mark arrays — the shape ProseMirror
 * expects. Adjacent nodes with identical marks are merged to keep the document
 * (and therefore the editor's undo history) small.
 */
export function paragraphToEditorDoc(paragraph: {
  text: string;
  spans?: readonly InlineSpan[];
}): EditorNodeJson {
  const text = paragraph.text;
  const spans = (paragraph.spans ?? [])
    .filter((span) => span.start >= 0 && span.end <= text.length && span.start < span.end)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (text.length === 0) {
    return { type: "doc", content: [{ type: "paragraph", content: [] }] };
  }

  const boundaries = new Set<number>([0, text.length]);
  for (const span of spans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const content: TextNode[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (end <= start) continue;
    const covering = spans.filter((span) => span.start <= start && span.end >= end);
    const kinds = new Set<InlineMarkKind>();
    let href: string | undefined;
    for (const span of covering) {
      for (const kind of span.kinds) kinds.add(kind);
      if (span.kinds.includes("link") && span.href) href = span.href;
    }
    const marks: EditorMarkJson[] = [];
    for (const kind of INLINE_MARK_ORDER) {
      if (!kinds.has(kind)) continue;
      if (kind === "link") {
        if (href) marks.push({ type: MARK_BY_KIND.link, attrs: { href } });
        continue;
      }
      marks.push({ type: MARK_BY_KIND[kind] });
    }
    const node: TextNode = marks.length > 0
      ? { type: "text", text: text.slice(start, end), marks }
      : { type: "text", text: text.slice(start, end) };
    const previous = content[content.length - 1];
    if (previous && sameMarks(previous.marks, node.marks)) {
      previous.text += node.text;
    } else {
      content.push(node);
    }
  }

  return { type: "doc", content: [{ type: "paragraph", content }] };
}

/** Convenience: does this stored paragraph round-trip through the editor unchanged? */
export function roundTrips(paragraph: { text: string; spans?: readonly InlineSpan[] }): boolean {
  const serialized = serializeEditorDoc(paragraphToEditorDoc(paragraph));
  if (!serialized.ok) return false;
  if (serialized.text !== paragraph.text) return false;
  return JSON.stringify(serialized.spans) === JSON.stringify(paragraph.spans ?? []);
}


