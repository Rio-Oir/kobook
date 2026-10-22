// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Applying one edited block to an article body.
 *
 * This is the pure half of "save an edit": it takes the serialized text/spans,
 * derives everything the rest of the application measures against (hash, block
 * id, body stats, digest), and leaves persistence to the caller. Keeping it
 * pure is what lets the anchor and sync rules be tested without IndexedDB or a
 * browser.
 *
 * ## Why the block id survives an edit
 *
 * `blockId` is the anchor notes and highlights were created against, and the
 * sync route stores the client's id verbatim for exactly that reason. Recomputing
 * `b<index>-<hash8>` on every text change would silently detach every annotation
 * in the block — even when the user only fixed a typo at the start. The hash is
 * recomputed (the server re-derives it from `text` and rejects a mismatch), but
 * the id stays.
 */

import type { InlineSpan, Paragraph } from "../types";
import { sha256Hex } from "../local-import-blocks";
import { spansAreSound } from "../local-import-inline";

export type ParagraphEditInput = {
  /** Normalized text, as produced by `serializeEditorDoc`. */
  text: string;
  spans?: readonly InlineSpan[];
};

export type ApplyParagraphEditResult =
  | {
      ok: true;
      paragraphs: Paragraph[];
      paragraph: Paragraph;
      changed: boolean;
      stats: { paragraphs: number; chars: number };
      blocksDigest: string;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "EMPTY" | "UNSOUND_SPANS";
      message: string;
    };

/** `b<index>-<hash8>`, the parse layer's id shape. */
export function blockIdFor(index: number, hash: string): string {
  return `b${index}-${hash.slice(0, 8)}`;
}

/** The document digest the cloud upload compares versions by. */
export function blocksDigestOf(paragraphs: readonly Paragraph[]): string {
  return sha256Hex(paragraphs.map((paragraph) => paragraph.hash).join("\n"));
}

export function bodyStatsOf(paragraphs: readonly Paragraph[]): {
  paragraphs: number;
  chars: number;
} {
  return {
    paragraphs: paragraphs.length,
    chars: paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0),
  };
}

/**
 * Replace one paragraph's text/spans and re-derive the derived fields.
 *
 * `paragraphs` is not mutated. The caller decides whether to persist the result;
 * returning the full array rather than a patch keeps the "stats are computed
 * from the body they describe" property in one place.
 */
export function applyParagraphEdit(
  paragraphs: readonly Paragraph[],
  index: number,
  edit: ParagraphEditInput,
): ApplyParagraphEditResult {
  const position = paragraphs.findIndex((paragraph) => paragraph.index === index);
  if (position < 0) {
    return { ok: false, code: "NOT_FOUND", message: `找不到第 ${index} 段。` };
  }
  const previous = paragraphs[position]!;
  const text = edit.text;
  if (text.trim().length === 0) {
    return { ok: false, code: "EMPTY", message: "段落不能为空。" };
  }
  const spans = [...(edit.spans ?? [])];
  if (!spansAreSound(spans, text.length)) {
    return { ok: false, code: "UNSOUND_SPANS", message: "行内标记越界，已拒绝保存。" };
  }

  const hash = sha256Hex(text);
  const next: Paragraph = {
    ...previous,
    text,
    hash,
    // Keep the existing anchor id; derive one only for blocks that never had it.
    blockId: previous.blockId ?? blockIdFor(previous.index, hash),
  };
  if (spans.length > 0) next.spans = spans;
  else delete next.spans;

  const changed =
    next.text !== previous.text ||
    JSON.stringify(next.spans ?? []) !== JSON.stringify(previous.spans ?? []) ||
    next.hash !== previous.hash;

  const nextParagraphs = paragraphs.slice();
  nextParagraphs[position] = next;

  return {
    ok: true,
    paragraphs: nextParagraphs,
    paragraph: next,
    changed,
    stats: bodyStatsOf(nextParagraphs),
    blocksDigest: blocksDigestOf(nextParagraphs),
  };
}
