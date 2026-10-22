// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Whole-article editor ⇄ block serialization.
 *
 * The single-block serializer (`serialize.ts`) is the repair hatch for one
 * paragraph; the product's editing mode is a *document*: all blocks at once,
 * with structural operations (new paragraphs, headings, lists, quotes) that a
 * per-block editor cannot express. This module owns that translation.
 *
 * The stored model is still the flat `Paragraph[]` the reader renders. A nested
 * list is flattened back into `listItem` blocks in reading order (depth is a
 * later field); a blockquote's paragraphs become `quote` blocks. That keeps
 * every downstream consumer — the note validator, the outline, the sync wire —
 * on the same model they already understand.
 */

import {
  INLINE_MARK_ORDER,
  tableBlockText,
  type InlineMarkKind,
  type InlineSpan,
} from "../../../shared/contracts/index";
import { normalizeCode, normalizeProse, normalizeProseWithMap } from "../local-import-blocks";
import { canonicalizeSpans, spansAreSound, type RawMark } from "../local-import-inline";
import type { EditorMarkJson, EditorNodeJson } from "./serialize";

export type DocumentBlockKind =
  | "heading"
  | "paragraph"
  | "listItem"
  | "code"
  | "quote"
  | "image"
  | "table"
  | "hr";

export interface DocumentBlock {
  type: DocumentBlockKind;
  text: string;
  spans: InlineSpan[];
  level?: number;
  lang?: string | null;
  ordered?: boolean;
  /** List nesting depth (0-based), only for `listItem`. */
  depth?: number;
  /** Task-list state, only for `listItem`. */
  task?: boolean;
  checked?: boolean;
  /** Image metadata, only for `image`. */
  src?: string;
  alt?: string;
  title?: string;
  /** Table cells (first row is the header), only for `table`. */
  rows?: string[][];
}

export type SerializeDocumentResult =
  | { ok: true; blocks: DocumentBlock[] }
  | { ok: false; code: "EMPTY" | "UNSUPPORTED_NODE"; message: string };

const KIND_BY_MARK: ReadonlyMap<string, InlineMarkKind> = new Map([
  ["bold", "strong"],
  ["italic", "em"],
  ["code", "code"],
  ["strike", "del"],
  ["link", "link"],
]);

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

interface Run {
  text: string;
  marks: EditorMarkJson[];
}

function runsOf(nodes: readonly EditorNodeJson[]): Run[] {
  const runs: Run[] = [];
  const visit = (node: EditorNodeJson): void => {
    if (node.type === "text") {
      if ((node.text ?? "").length > 0) runs.push({ text: node.text!, marks: [...(node.marks ?? [])] });
      return;
    }
    if (node.type === "hardBreak") {
      runs.push({ text: "\n", marks: [] });
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return runs;
}

function proseFromNodes(nodes: readonly EditorNodeJson[]): { text: string; spans: InlineSpan[] } | null {
  const runs = runsOf(nodes);
  const raw = runs.map((run) => run.text).join("");
  const { text, map } = normalizeProseWithMap(raw);
  if (text.length === 0) return null;

  const rawMarks: RawMark[] = [];
  let offset = 0;
  for (const run of runs) {
    const start = offset;
    offset += run.text.length;
    for (const mark of run.marks) {
      const kind = KIND_BY_MARK.get(mark.type);
      if (!kind) continue;
      const href = kind === "link" ? hrefOf(mark) : undefined;
      if (kind === "link" && !href) continue;
      const mappedStart = map.toOutput(start, "start");
      const mappedEnd = map.toOutput(offset, "end");
      if (mappedStart >= mappedEnd) continue;
      rawMarks.push(
        href === undefined
          ? { start: mappedStart, end: mappedEnd, kind }
          : { start: mappedStart, end: mappedEnd, kind, href },
      );
    }
  }
  const spans = canonicalizeSpans(rawMarks, text.length);
  return spansAreSound(spans, text.length) ? { text, spans } : { text, spans: [] };
}

function codeFromNode(node: EditorNodeJson): DocumentBlock | null {
  const raw = runsOf(node.content ?? []).map((run) => run.text).join("");
  const text = normalizeCode(raw);
  if (text.length === 0) return null;
  const language = typeof node.attrs?.language === "string" ? node.attrs.language : null;
  return { type: "code", text, spans: [], lang: language };
}

function inlineContent(text: string, spans?: readonly InlineSpan[]): EditorNodeJson[] {
  if (text.length === 0) return [];
  const list = (spans ?? [])
    .filter((span) => span.start >= 0 && span.end <= text.length && span.start < span.end)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const bounds = new Set<number>([0, text.length]);
  for (const span of list) {
    bounds.add(span.start);
    bounds.add(span.end);
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const content: EditorNodeJson[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (end <= start) continue;
    const covering = list.filter((span) => span.start <= start && span.end >= end);
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
    const node: EditorNodeJson = { type: "text", text: text.slice(start, end) };
    if (marks.length > 0) node.marks = marks;
    content.push(node);
  }
  return content;
}

/** `Paragraph[]` → one ProseMirror document the whole-article editor mounts. */
export function paragraphsToEditorDoc(
  paragraphs: readonly {
    type?: DocumentBlockKind;
    text: string;
    spans?: readonly InlineSpan[];
    level?: number;
    lang?: string | null;
    ordered?: boolean;
    depth?: number;
    task?: boolean;
    checked?: boolean;
    src?: string;
    alt?: string;
    title?: string;
    rows?: string[][];
  }[],
): EditorNodeJson {
  const content: EditorNodeJson[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const paragraph = paragraphs[i]!;
    const kind = paragraph.type ?? "paragraph";
    if (kind === "image") {
      // An invalid `src` (a `javascript:` value from a hand-edited blob) has
      // no representable image node. Dropping it here is the same rule the
      // Reader applies when it renders "地址不受支持" instead of an image.
      const src = safeImageSrc(paragraph.src);
      if (src !== null) {
        content.push(imageNode(src, paragraph.alt, paragraph.title));
      }
      i += 1;
      continue;
    }
    if (kind === "table") {
      const rows = paragraph.rows ?? [];
      if (rows.length > 0) content.push(tableNode(rows));
      i += 1;
      continue;
    }
    if (kind === "hr") {
      content.push({ type: "horizontalRule" });
      i += 1;
      continue;
    }
    if (kind === "listItem") {
      // A maximal run of consecutive list items, nested ones included. Nesting
      // is expressed structurally in the editor because ProseMirror knows how
      // to indent and reorder it; the flat block model only carries `depth`.
      const run: EditorListItem[] = [];
      while (i < paragraphs.length) {
        const item = paragraphs[i]!;
        if ((item.type ?? "paragraph") !== "listItem") break;
        run.push({
          text: item.text,
          spans: item.spans,
          depth: Math.max(0, Math.floor(item.depth ?? 0)),
          kind: listKindOf(item),
          checked: item.checked === true,
        });
        i += 1;
      }
      let cursor = 0;
      while (cursor < run.length) {
        const first = run[cursor]!;
        const built = buildEditorList(run, cursor, first.depth, first.kind);
        content.push(built.node);
        cursor = built.next;
      }
      continue;
    }
    if (kind === "heading") {
      content.push({
        type: "heading",
        attrs: { level: paragraph.level ?? 1 },
        content: inlineContent(paragraph.text, paragraph.spans),
      });
    } else if (kind === "code") {
      content.push({
        type: "codeBlock",
        attrs: { language: paragraph.lang ?? null },
        content: paragraph.text.length > 0 ? [{ type: "text", text: paragraph.text }] : [],
      });
    } else if (kind === "quote") {
      content.push({
        type: "blockquote",
        content: [{ type: "paragraph", content: inlineContent(paragraph.text, paragraph.spans) }],
      });
    } else {
      content.push({ type: "paragraph", content: inlineContent(paragraph.text, paragraph.spans) });
    }
    i += 1;
  }
  return { type: "doc", content };
}

/** Image sources the Reader and the sync route both accept. */
const SAFE_IMAGE_SRC = /^(https?:\/\/|\/)/i;

function safeImageSrc(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return SAFE_IMAGE_SRC.test(value) ? value : null;
}

function imageNode(src: string, alt?: string, title?: string): EditorNodeJson {
  const attrs: Record<string, unknown> = { src, alt: alt ?? "" };
  if (title) attrs.title = title;
  return { type: "image", attrs };
}

/** A table block's rows as a Tiptap `table` node, first row as header cells. */
function tableNode(rows: readonly (readonly string[])[]): EditorNodeJson {
  return {
    type: "table",
    content: rows.map((cells, rowIndex) => ({
      type: "tableRow",
      content: cells.map((cell) => ({
        type: rowIndex === 0 ? "tableHeader" : "tableCell",
        content: [
          {
            type: "paragraph",
            content: cell.length > 0 ? [{ type: "text", text: cell }] : [],
          },
        ],
      })),
    })),
  };
}

type ListKind = "bullet" | "ordered" | "task";

interface EditorListItem {
  text: string;
  spans?: readonly InlineSpan[];
  depth: number;
  kind: ListKind;
  checked: boolean;
}

function listKindOf(item: { ordered?: boolean; task?: boolean }): ListKind {
  if (item.task) return "task";
  return item.ordered ? "ordered" : "bullet";
}

function listNodeType(kind: ListKind): "bulletList" | "orderedList" | "taskList" {
  return kind === "task" ? "taskList" : kind === "ordered" ? "orderedList" : "bulletList";
}

function itemNodeType(kind: ListKind): "listItem" | "taskItem" {
  return kind === "task" ? "taskItem" : "listItem";
}

/**
 * Build one editor list from a slice of flat items, consuming nested items
 * into their parent's `content`. `next` is where the caller resumes.
 */
function buildEditorList(
  items: readonly EditorListItem[],
  start: number,
  baseDepth: number,
  kind: ListKind,
): { node: EditorNodeJson; next: number } {
  const content: EditorNodeJson[] = [];
  let index = start;
  while (index < items.length) {
    const item = items[index]!;
    if (item.depth !== baseDepth) break;
    if (item.kind !== kind) break;
    const node: EditorNodeJson = {
      type: itemNodeType(kind),
      content: [{ type: "paragraph", content: inlineContent(item.text, item.spans) }],
    };
    if (kind === "task") node.attrs = { checked: item.checked };
    index += 1;
    if (index < items.length && items[index]!.depth > baseDepth) {
      const nested = items[index]!;
      const child = buildEditorList(items, index, nested.depth, nested.kind);
      node.content!.push(child.node);
      index = child.next;
    }
    content.push(node);
  }
  return { node: { type: listNodeType(kind), content }, next: index };
}

/** Editor document → the flat blocks the store persists. */
export function serializeEditorDocument(doc: EditorNodeJson): SerializeDocumentResult {
  const blocks: DocumentBlock[] = [];

  const addProse = (
    nodes: readonly EditorNodeJson[],
    type: "paragraph" | "listItem" | "quote" | "heading",
    extra: Partial<DocumentBlock> = {},
  ): void => {
    const result = proseFromNodes(nodes);
    if (!result) return;
    blocks.push({ type, text: result.text, spans: result.spans, ...extra });
  };

  const visitList = (node: EditorNodeJson, kind: ListKind, depth: number): void => {
    for (const item of node.content ?? []) {
      if (item.type !== "listItem" && item.type !== "taskItem") continue;
      const isTask = item.type === "taskItem";
      // A list item owns its first paragraph plus optional nested lists. The
      // flat model keeps one text block per item; nested items follow in
      // reading order with an incremented `depth`.
      for (const child of item.content ?? []) {
        if (child.type === "paragraph") {
          addProse(child.content ?? [], "listItem", {
            ordered: kind === "ordered",
            depth,
            ...(isTask ? { task: true, checked: item.attrs?.checked === true } : {}),
          });
        } else if (child.type === "bulletList") visitList(child, "bullet", depth + 1);
        else if (child.type === "orderedList") visitList(child, "ordered", depth + 1);
        else if (child.type === "taskList") visitList(child, "task", depth + 1);
      }
    }
  };

  for (const node of doc.content ?? []) {
    if (node.type === "paragraph") {
      addProse(node.content ?? [], "paragraph");
    } else if (node.type === "heading") {
      addProse(node.content ?? [], "heading", {
        level: typeof node.attrs?.level === "number" ? node.attrs.level : 1,
      });
    } else if (node.type === "codeBlock") {
      const block = codeFromNode(node);
      if (block) blocks.push(block);
    } else if (node.type === "image") {
      const src = safeImageSrc(typeof node.attrs?.src === "string" ? node.attrs.src : undefined);
      if (src === null) {
        return { ok: false, code: "UNSUPPORTED_NODE", message: "图片地址必须以 http(s):// 或 / 开头。" };
      }
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt.trim() : "";
      const title = typeof node.attrs?.title === "string" ? node.attrs.title.trim() : "";
      blocks.push({
        type: "image",
        text: alt.length > 0 ? alt : "图片",
        spans: [],
        src,
        ...(alt.length > 0 ? { alt } : {}),
        ...(title.length > 0 ? { title } : {}),
      });
    } else if (node.type === "table") {
      const rows: string[][] = [];
      for (const row of node.content ?? []) {
        if (row.type !== "tableRow") continue;
        const cells: string[] = [];
        for (const cell of row.content ?? []) {
          if (cell.type !== "tableCell" && cell.type !== "tableHeader") continue;
          cells.push(proseFromNodes(cell.content ?? [])?.text ?? "");
        }
        rows.push(cells);
      }
      if (rows.length > 0) {
        blocks.push({
          type: "table",
          // `normalizeProse` is what `BlockCollector` applies, so a table
          // edited here hashes to the same value as the same table parsed from
          // Markdown/HTML.
          text: normalizeProse(tableBlockText(rows)),
          spans: [],
          rows,
        });
      }
    } else if (node.type === "horizontalRule") {
      blocks.push({ type: "hr", text: "分隔线", spans: [] });
    } else if (node.type === "bulletList") {
      visitList(node, "bullet", 0);
    } else if (node.type === "orderedList") {
      visitList(node, "ordered", 0);
    } else if (node.type === "taskList") {
      visitList(node, "task", 0);
    } else if (node.type === "blockquote") {
      for (const child of node.content ?? []) {
        if (child.type === "paragraph" || child.type === "heading") {
          addProse(child.content ?? [], "quote");
        }
      }
    }
  }

  if (blocks.length === 0) {
    return { ok: false, code: "EMPTY", message: "文章不能为空。" };
  }
  return { ok: true, blocks };
}
