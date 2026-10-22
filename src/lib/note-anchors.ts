// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Note → original-text anchors: which characters of which paragraph a
 * stored note is about, as something the renderer can underline.
 *
 * ## Why this is a separate module
 *
 * A note already stores the range it was created from (`startOffset` /
 * `endOffset` plus the block ids), but the renderer cannot use those
 * numbers directly: a paragraph may have been re-parsed, a block id may
 * name a different occurrence, and a note written before offsets were
 * recorded at all only has a quote. Deciding *whether* a stored anchor
 * still describes the text on screen is a pure function of the note and
 * the paragraphs, so it lives here and is unit-tested without a DOM —
 * the alternative is that judgement being spread across the renderer,
 * where an off-by-one silently underlines the wrong sentence.
 *
 * ## The rule is "never guess"
 *
 * The failure this module exists to prevent is an underline on text the
 * note was *not* about. A wrong underline is worse than a missing one:
 * the missing one reads as "this note has no anchor", the wrong one reads
 * as "this is what the note means". So every ambiguous case resolves to
 * `[]`:
 *
 *   - explicit offsets that do not match the paragraph's current text —
 *     the quote reconstructed from them must equal `selectionText`
 *     character for character (whitespace-insensitively);
 *   - a block id that no longer names the paragraph the index does;
 *   - a legacy note with no offsets whose quote occurs more than once in
 *     the paragraph — the paragraph is known, the occurrence is not, so
 *     the note keeps its paragraph-level marker and gets no underline;
 *   - offsets that are not integers, are negative, run past the text, or
 *     are inverted.
 *
 * ## Version staleness is the caller's job
 *
 * A note anchored to a different article version describes text that is
 * not on screen at all, so the check belongs where "which version is
 * displayed" is known — `Reader` already filters those notes out before
 * this is called. Repeating it here would need a second source of truth
 * for the displayed version.
 *
 * ## Offsets are UTF-16 code units
 *
 * Same unit as `Range`/`String.prototype.slice`, which is what
 * `lib/text-offset.ts` stores. An emoji counts as two, so a range that
 * splits a surrogate pair round-trips to the same two halves it was cut
 * from rather than being "corrected" into something the user never
 * selected.
 */

import type { HighlightColor, Note, Paragraph } from "./types.js";

export type NoteSlice = {
  /** The note this slice belongs to. */
  id: string;
  paragraphIndex: number;
  start: number;
  end: number;
  /**
   * The note's identity colour, carried through so the renderer can paint
   * the underline in it. Absent means the note chose none, which is the
   * default blue — the same rule `noteColorRgb` applies. It travels with
   * the slice rather than being looked up again at paint time because the
   * slice *is* what gets painted, and a paragraph may carry slices from
   * several notes that each wear a different colour.
   */
  color?: HighlightColor;
};

/**
 * Whitespace-insensitive comparison key.
 *
 * A cross-paragraph selection is reconstructed by joining the per-block
 * slices, and the newline the user dragged across is not part of any
 * paragraph's stored text — so the round-trip has to ignore whitespace
 * to be comparable at all. Only whitespace is ignored: a different
 * character is a different anchor.
 */
const normalized = (text: string) => text.replace(/\s+/g, "").trim();

/**
 * The slices of `paragraphs` a note still provably covers.
 *
 * Empty means "do not underline anything" — never "underline
 * everything" — so a caller can treat the result as the complete set.
 */
export function noteSlices(note: Note, paragraphs: readonly Paragraph[]): NoteSlice[] {
  const first = paragraphs.findIndex(
    (p) => p.index === (note.startParagraphIndex ?? note.paragraphIndex),
  );
  const last = paragraphs.findIndex(
    (p) => p.index === (note.endParagraphIndex ?? note.paragraphIndex),
  );
  if (first < 0 || last < first || !note.selectionText.trim()) return [];
  const startBlock = paragraphs[first]!;
  const endBlock = paragraphs[last]!;
  // A block id that disagrees with the index means the document was
  // re-parsed and the same ordinal now holds different text. The index
  // alone is not enough to say the note is still about this block.
  if (
    (note.startBlockId && note.startBlockId !== startBlock.blockId) ||
    (note.endBlockId && note.endBlockId !== endBlock.blockId)
  ) {
    return [];
  }
  let start = note.startOffset;
  let end = note.endOffset;
  // Legacy note: no offsets, one paragraph, a quote. Recover the range
  // only when the quote identifies exactly one occurrence — a repeated
  // word is not evidence of which one the note meant.
  if (start === undefined && end === undefined && first === last) {
    start = startBlock.text.indexOf(note.selectionText);
    if (start < 0 || startBlock.text.indexOf(note.selectionText, start + 1) >= 0) {
      return [];
    }
    end = start + note.selectionText.length;
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start! < 0 ||
    end! < 0 ||
    start! > startBlock.text.length ||
    end! > endBlock.text.length ||
    (first === last && start! >= end!)
  ) {
    return [];
  }
  const slices = paragraphs.slice(first, last + 1).map((p, i, blocks) => ({
    id: note.id,
    paragraphIndex: p.index,
    start: i === 0 ? start! : 0,
    end: i === blocks.length - 1 ? end! : p.text.length,
    ...(note.color ? { color: note.color } : {}),
  }));
  // Final gate: the text these offsets actually cover has to be the text
  // the note quotes. This is what catches offsets that are in range but
  // point at a sentence the note was never about.
  const quote = slices
    .map((s) => paragraphs.find((p) => p.index === s.paragraphIndex)!.text.slice(s.start, s.end))
    .join("");
  return normalized(quote) === normalized(note.selectionText)
    ? slices.filter((s) => s.end > s.start)
    : [];
}
