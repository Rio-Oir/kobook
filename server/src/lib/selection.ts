// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Server-side selection validation for notes.
 *
 * The plan's requirement is "服务端校验选区确实来自该用户当前文章版本;
 * 支持起止段落及偏移，不接受前端自行构造的任意原文作为可信证据", plus
 * the phase-3 follow-up "补跨段坐标（起止 block ID/offset）及服务端版本/
 * 范围/选区校验；重复段落可区分，段内局部选择仍有效".
 *
 * There are two shapes the API accepts, and they get two different rules:
 *
 *  1. **Range shape** (`startParagraphIndex` / `startOffset` /
 *     `endParagraphIndex` / `endOffset`, optionally plus the block ids).
 *     This is what the Reader sends, because it knows the exact DOM
 *     range the user dragged. The rule is *exact reconstruction*: the
 *     server slices the stored, server-owned paragraph text along
 *     those coordinates and requires the result to equal the claimed
 *     selection after the same normalisation the parser used. A client
 *     cannot invent text, and it cannot point at text that is not
 *     there, because both the coordinates and the characters are
 *     re-derived from rows the client never wrote.
 *
 *  2. **Legacy shape** (only `paragraphIndex` + `selectionText`). Still
 *     accepted for compatibility, and the rule is *containment*, which
 *     is the weaker but still real check the first implementation
 *     shipped: the selection must be a substring of the paragraph the
 *     server stored. Kept because refusing it would break callers that
 *     predate offsets, and because containment is a strictly weaker
 *     claim than reconstruction — a request that passes (1) would also
 *     pass (2).
 *
 * Duplicate paragraphs are separated by *block id*, not by index:
 * `blockId` is `b<index>-<hash8>`, so two paragraphs with identical
 * text at different positions have different ids. When the client
 * supplies `startBlockId` / `endBlockId` the server requires them to
 * match the stored row at that index — that is what stops a client from
 * silently re-anchoring an annotation onto a different occurrence of
 * the same sentence.
 *
 * Whitespace handling: both sides are normalised with the same
 * `normalizeProse` the parser uses, so a browser that hands back
 * collapsed or padded whitespace still matches the stored text.
 */

import { normalizeProse } from "./parse/blocks.js";

/**
 * The separator used when a selection spans paragraph boundaries.
 *
 * A DOM range that crosses block elements stringifies with a `\n`
 * between them, and `normalizeProse` collapses that (and everything
 * else that reads as whitespace) to a single space. Joining with `\n`
 * therefore makes the server-side reconstruction and the browser's own
 * `Range.toString()` normalise to the same string.
 */
export const CROSS_PARAGRAPH_JOINER = "\n";

export type SelectionVerdict =
  | { ok: true; normalizedSelection: string }
  | { ok: false; reason: "empty" | "not-found" };

/**
 * Decide whether `selectionText` is a legitimate excerpt of
 * `paragraphText`.
 *
 * An empty (or whitespace-only) selection is refused explicitly rather
 * than by accident: `"".includes("")` is true, so a naive containment
 * check would accept a zero-length selection.
 *
 * This is the legacy single-paragraph rule; `validateRangeSelection`
 * below is the precise one the Reader uses.
 */
export function validateSelection(
  paragraphText: string,
  selectionText: string,
): SelectionVerdict {
  const paragraph = normalizeProse(paragraphText);
  const selection = normalizeProse(selectionText);

  if (selection.length === 0) return { ok: false, reason: "empty" };
  if (paragraph.length === 0) return { ok: false, reason: "not-found" };
  if (!paragraph.includes(selection)) return { ok: false, reason: "not-found" };

  return { ok: true, normalizedSelection: selection };
}

/** One stored paragraph, as much of it as range validation needs. */
export interface SelectionParagraph {
  /** 1-based position inside the version; matches `paragraph.blockIndex`. */
  blockIndex: number;
  /**
   * Parse-layer block id (`b<index>-<hash8>`). Optional so a caller
   * that has not selected the column still type-checks; when absent
   * the block-id comparison is skipped rather than failing.
   */
  blockId?: string;
  /** Normalised plain text, exactly as the parser produced it. */
  text: string;
}

export interface RangeSelectionInput {
  /** Every paragraph of the version the note is being anchored to. */
  paragraphs: SelectionParagraph[];
  startParagraphIndex: number;
  startOffset: number;
  endParagraphIndex: number;
  endOffset: number;
  /**
   * The text the user says they selected. Compared against the
   * server-side reconstruction, not trusted.
   */
  selectionText: string;
  /**
   * Block ids the client believes it is anchoring on. Optional; when
   * present they must match the stored row, which is what makes a
   * duplicate paragraph distinguishable from its twin.
   */
  startBlockId?: string;
  endBlockId?: string;
}

export type RangeFailureReason =
  | "empty"
  | "block-missing"
  | "block-id-mismatch"
  | "range-invalid"
  | "offset-out-of-range"
  | "text-mismatch";

export type RangeVerdict =
  | {
      ok: true;
      normalizedSelection: string;
      startBlockId: string;
      endBlockId: string;
      /** The server's own reconstruction, normalised. */
      reconstructed: string;
    }
  | { ok: false; reason: RangeFailureReason; message: string };

/**
 * Reconstruct the text covered by a half-open `[start, end)` range over
 * an ordered list of paragraphs, joining across paragraph boundaries
 * with `CROSS_PARAGRAPH_JOINER`.
 *
 * Offsets are half-open and measured in the same UTF-16 code units the
 * parser's `text` column uses, which is also what a browser `Range`
 * reports (see `src/lib/text-offset.ts` for why the three coordinate
 * systems coincide here).
 *
 * Exported because the client's own slice of this maths has to agree
 * with it, and a unit test pinning the two together is cheaper than
 * discovering the disagreement through a 422 in production.
 */
export function sliceRange(
  texts: string[],
  startOffset: number,
  endOffset: number,
): string {
  if (texts.length === 1) return texts[0]!.slice(startOffset, endOffset);
  const head = texts[0]!.slice(startOffset);
  const middle = texts.slice(1, -1);
  const tail = texts[texts.length - 1]!.slice(0, endOffset);
  return [head, ...middle, tail].join(CROSS_PARAGRAPH_JOINER);
}

/**
 * Validate the precise range shape. This is the rule the Reader is
 * bound by.
 *
 * Order of checks matters for the error the user sees: an invalid range
 * (end before start) is reported before a text mismatch, and a missing
 * block is reported before an offset check, because "that paragraph no
 * longer exists — refresh the article" is a different recovery from
 * "re-select".
 */
export function validateRangeSelection(
  input: RangeSelectionInput,
): RangeVerdict {
  const { startParagraphIndex, endParagraphIndex, startOffset, endOffset } = input;

  if (normalizeProse(input.selectionText).length === 0) {
    return { ok: false, reason: "empty", message: "选区为空。" };
  }
  if (
    !Number.isInteger(startParagraphIndex) ||
    !Number.isInteger(endParagraphIndex) ||
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startParagraphIndex < 1 ||
    startOffset < 0 ||
    endOffset < 0
  ) {
    return { ok: false, reason: "range-invalid", message: "选区坐标无效。" };
  }
  if (
    endParagraphIndex < startParagraphIndex ||
    (endParagraphIndex === startParagraphIndex && endOffset <= startOffset)
  ) {
    return { ok: false, reason: "range-invalid", message: "选区范围无效。" };
  }

  const byIndex = new Map<number, SelectionParagraph>();
  for (const paragraph of input.paragraphs) byIndex.set(paragraph.blockIndex, paragraph);

  const covered: SelectionParagraph[] = [];
  for (let index = startParagraphIndex; index <= endParagraphIndex; index += 1) {
    const paragraph = byIndex.get(index);
    if (!paragraph) {
      return {
        ok: false,
        reason: "block-missing",
        message: `当前版本没有第 ${index} 段，请刷新文章后重新选择。`,
      };
    }
    covered.push(paragraph);
  }

  const first = covered[0]!;
  const last = covered[covered.length - 1]!;

  // Duplicate paragraphs: the id, not the index, is the anchor. A
  // mismatch means the client is pointing at a different occurrence of
  // the same text than the one it claims, which is exactly the case the
  // plan asks to be distinguishable.
  if (input.startBlockId !== undefined && first.blockId !== undefined && input.startBlockId !== first.blockId) {
    return {
      ok: false,
      reason: "block-id-mismatch",
      message: "选区起始段落标识与当前版本不一致，请重新选择。",
    };
  }
  if (input.endBlockId !== undefined && last.blockId !== undefined && input.endBlockId !== last.blockId) {
    return {
      ok: false,
      reason: "block-id-mismatch",
      message: "选区结束段落标识与当前版本不一致，请重新选择。",
    };
  }

  // Offsets are half-open, so `startOffset` may equal the length of the
  // first paragraph only when the range continues past it; likewise
  // `endOffset` may be 0 only for a range that started earlier.
  const lastAllowedStart = covered.length === 1 ? endOffset : first.text.length;
  if (startOffset > first.text.length || startOffset >= lastAllowedStart) {
    return { ok: false, reason: "offset-out-of-range", message: "选区起始偏移超出当前版本范围。" };
  }
  if (endOffset > last.text.length) {
    return { ok: false, reason: "offset-out-of-range", message: "选区结束偏移超出当前版本范围。" };
  }

  const reconstructed = normalizeProse(
    sliceRange(
      covered.map((p) => p.text),
      startOffset,
      endOffset,
    ),
  );
  const claimed = normalizeProse(input.selectionText);
  if (reconstructed.length === 0) {
    return { ok: false, reason: "empty", message: "选区为空。" };
  }
  if (reconstructed !== claimed) {
    return {
      ok: false,
      reason: "text-mismatch",
      message: "选区文本与当前版本不符，请重新选择。",
    };
  }

  return {
    ok: true,
    normalizedSelection: claimed,
    startBlockId: first.blockId ?? `b${first.blockIndex}-`,
    endBlockId: last.blockId ?? `b${last.blockIndex}-`,
    reconstructed,
  };
}
