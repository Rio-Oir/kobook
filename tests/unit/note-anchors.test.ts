// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Note anchor resolution gates.
 *
 * `lib/note-anchors.ts` decides whether a stored note still describes the
 * text on screen, and the failure it can produce is invisible: an
 * underline on the *wrong* sentence looks exactly like an underline on
 * the right one, so nothing on the page says the note is misplaced. That
 * makes these the assertions worth having, and they are all negative
 * except the first two:
 *
 *   - an exact anchor keeps the occurrence it was made on, even when the
 *     same words appear earlier in the paragraph;
 *   - a legacy note with no offsets recovers its quote only when that
 *     quote is unambiguous;
 *   - everything else — a stale offset, a block id that no longer
 *     matches, a range that runs past the text, a non-integer offset, a
 *     half-recorded range — resolves to "no underline".
 *
 * Pure function, no DOM, so it runs in the same suite as the rest of the
 * reader's rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { noteSlices } from "../../src/lib/note-anchors.js";
import type { Note, Paragraph } from "../../src/lib/types.js";

const paragraphs: Paragraph[] = [
  { index: 1, text: "世尊说：世尊。", hash: "a", blockId: "a" },
  { index: 2, text: "须菩提回答。", hash: "b", blockId: "b" },
];

const note = (patch: Partial<Note> = {}): Note => ({
  id: "n",
  articleId: "local-a",
  paragraphIndex: 1,
  selectionText: "世尊",
  question: "解释",
  answer: "",
  model: "test",
  type: "explain",
  isStreaming: false,
  createdAt: 1,
  ...patch,
});

test("exact offsets keep the second occurrence; an ambiguous legacy quote stays paragraph-only", () => {
  // "世尊" occurs at 0 and 4. The stored range says which one, and the
  // underline has to be the one the reader actually selected.
  assert.deepEqual(noteSlices(note({ startOffset: 4, endOffset: 6 }), paragraphs), [
    { id: "n", paragraphIndex: 1, start: 4, end: 6 },
  ]);
  // No offsets at all: the quote is the only evidence, and it is not
  // evidence of *which* "世尊". No underline — the paragraph-level marker
  // is all this note can honestly claim.
  assert.deepEqual(noteSlices(note(), paragraphs), []);
  // A quote that occurs once is unambiguous, so it is recovered.
  assert.equal(noteSlices(note({ selectionText: "说" }), paragraphs)[0]?.start, 2);
});

test("stale text, block ids and invalid ranges never underline unrelated text", () => {
  for (const patch of [
    // Offsets that are in range but cover different words than the quote.
    { startOffset: 2, endOffset: 4 },
    // Negative, past the end, inverted, non-integer, and half-recorded.
    { startOffset: -1, endOffset: 2 },
    { startOffset: 0, endOffset: 200 },
    { startOffset: 0, endOffset: 2, startBlockId: "old" },
    { startOffset: 0.5, endOffset: 2 },
    { startOffset: 0 },
  ]) {
    assert.deepEqual(
      noteSlices(note(patch), paragraphs),
      [],
      `patch ${JSON.stringify(patch)} must not produce an underline`,
    );
  }
});

test("a matching block id is what makes the index trustworthy", () => {
  assert.deepEqual(noteSlices(note({ startOffset: 4, endOffset: 6, startBlockId: "a" }), paragraphs), [
    { id: "n", paragraphIndex: 1, start: 4, end: 6 },
  ]);
  // The document was re-parsed and ordinal 1 now holds a different block.
  assert.deepEqual(noteSlices(note({ startOffset: 4, endOffset: 6, endBlockId: "old" }), paragraphs), []);
});

test("cross-paragraph selections preserve both endpoints and UTF-16 offsets", () => {
  const slices = noteSlices(
    note({
      startOffset: 4,
      endOffset: 3,
      endParagraphIndex: 2,
      selectionText: "世尊。\n须菩提",
    }),
    paragraphs,
  );
  assert.deepEqual(
    slices.map((s) => [s.paragraphIndex, s.start, s.end]),
    [
      [1, 4, 7],
      [2, 0, 3],
    ],
  );
  // Offsets are UTF-16 code units, the unit `Range` and `slice` both use,
  // so an emoji counts as two and a range that splits a surrogate pair
  // round-trips to the same halves rather than being "corrected".
  const unicode: Paragraph[] = [{ index: 1, text: "😀世尊", hash: "u" }];
  assert.equal(noteSlices(note({ startOffset: 2, endOffset: 4 }), unicode)[0]?.start, 2);
});

test("a note whose paragraph is gone, or that quotes nothing, is inert", () => {
  assert.deepEqual(noteSlices(note({ startOffset: 0, endOffset: 2, paragraphIndex: 9 }), paragraphs), []);
  assert.deepEqual(noteSlices(note({ selectionText: "   ", startOffset: 0, endOffset: 2 }), paragraphs), []);
  assert.deepEqual(noteSlices(note({ startOffset: 4, endOffset: 6 }), []), []);
});
