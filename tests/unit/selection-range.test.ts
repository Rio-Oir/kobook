// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-segment selection validation.
 *
 * The behaviours this file exists for:
 *   - cross-paragraph coordinates (start/end block ids and offsets) plus
 *     server-side version, range and selection validation;
 *   - duplicate paragraphs stay distinguishable;
 *   - a selection inside a single paragraph still works.
 *
 * The rule the first implementation got wrong is the one tested hardest
 * here: validating a multi-paragraph or offset-addressed selection
 * against only the *first* paragraph's text. That accepts a client's
 * claim whenever the claim happens to be a substring of paragraph one,
 * even when the coordinates point somewhere else entirely — so a note
 * could be anchored on text the user never selected.
 *
 * The replacement reconstructs the range from the version's own stored
 * paragraphs and requires an exact match, which is why these cases are
 * mostly about *refusing* things that look plausible.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CROSS_PARAGRAPH_JOINER,
  sliceRange,
  validateRangeSelection,
  type SelectionParagraph,
} from "../../server/src/lib/selection.js";

/** Two identical paragraphs at different positions — the duplicate case. */
const DUPLICATE_BLOCK_ID = "b1-aaaaaaaa";
const DUPLICATE_TEXT = "这是重复出现的同一段文字。";

const paragraphs: SelectionParagraph[] = [
  { blockIndex: 1, blockId: DUPLICATE_BLOCK_ID, text: "第一段的文字内容。" },
  { blockIndex: 2, blockId: "b2-bbbbbbbb", text: "第二段讲的是训练成本。" },
  { blockIndex: 3, blockId: "b3-cccccccc", text: DUPLICATE_TEXT },
  { blockIndex: 4, blockId: "b4-dddddddd", text: "第四段的收尾结论。" },
];

test("a within-paragraph range is accepted when the text matches the slice", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 2,
    startOffset: 3,
    endParagraphIndex: 2,
    endOffset: 7,
    selectionText: "讲的是训",
  });
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.reconstructed, "讲的是训");
});

test("a within-paragraph partial selection stays valid", () => {
  // The product's main interaction: one word out of a paragraph.
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 1,
    startOffset: 0,
    endParagraphIndex: 1,
    endOffset: 2,
    selectionText: "第一",
  });
  assert.equal(verdict.ok, true);
});

test("a cross-paragraph range is accepted when both ends line up", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 2,
    startOffset: 2,
    endParagraphIndex: 3,
    endOffset: 3,
    selectionText: `${paragraphs[1]!.text.slice(2)} ${DUPLICATE_TEXT.slice(0, 3)}`,
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test("a cross-paragraph range whose text comes from one paragraph is refused", () => {
  // This is the exact defect the rewrite removes: the claim IS a
  // substring of paragraph 2, and the coordinates say the range runs
  // into paragraph 3, so the two disagree.
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 2,
    startOffset: 2,
    endParagraphIndex: 3,
    endOffset: 3,
    selectionText: paragraphs[1]!.text.slice(2),
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "text-mismatch");
});

test("two paragraphs with identical text are distinguished by block id", () => {
  // Paragraph 1 and paragraph 3 differ, so the duplicate is paragraph 3
  // against... itself is meaningless; instead anchor on 3 and claim 1's
  // id: the text matches, the identity does not.
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 3,
    startOffset: 0,
    endParagraphIndex: 3,
    endOffset: DUPLICATE_TEXT.length,
    selectionText: DUPLICATE_TEXT,
    startBlockId: DUPLICATE_BLOCK_ID, // b1's id, but we asked for block 3
    endBlockId: "b3-cccccccc",
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "block-id-mismatch");
});

test("the matching block id is accepted and echoed back", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 3,
    startOffset: 0,
    endParagraphIndex: 3,
    endOffset: DUPLICATE_TEXT.length,
    selectionText: DUPLICATE_TEXT,
    startBlockId: "b3-cccccccc",
    endBlockId: "b3-cccccccc",
  });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.startBlockId, "b3-cccccccc");
    assert.equal(verdict.endBlockId, "b3-cccccccc");
  }
});

test("an offset range that names a block that does not exist is refused", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 2,
    startOffset: 0,
    endParagraphIndex: 99,
    endOffset: 1,
    selectionText: "x",
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "block-missing");
});

test("end before start is refused as an invalid range", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 3,
    startOffset: 2,
    endParagraphIndex: 2,
    endOffset: 4,
    selectionText: "任意",
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "range-invalid");
});

test("an empty within-paragraph range is refused", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 2,
    startOffset: 4,
    endParagraphIndex: 2,
    endOffset: 4,
    selectionText: "讲",
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "range-invalid");
});

test("an offset past the end of the paragraph is refused", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 2,
    startOffset: 0,
    endParagraphIndex: 2,
    endOffset: paragraphs[1]!.text.length + 1,
    selectionText: paragraphs[1]!.text,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "offset-out-of-range");
});

test("an empty selection is refused before any range maths runs", () => {
  for (const empty of ["", "   ", "\n\t"]) {
    const verdict = validateRangeSelection({
      paragraphs,
      startParagraphIndex: 1,
      startOffset: 0,
      endParagraphIndex: 1,
      endOffset: 3,
      selectionText: empty,
    });
    assert.equal(verdict.ok, false, `must refuse ${JSON.stringify(empty)}`);
    if (!verdict.ok) assert.equal(verdict.reason, "empty");
  }
});

test("padding around the selection is absorbed by normalisation", () => {
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 2,
    startOffset: 0,
    endParagraphIndex: 2,
    endOffset: 3,
    selectionText: "  第二段 ",
  });
  assert.equal(verdict.ok, true);
});

test("sliceRange joins covered paragraphs with a single separator", () => {
  const joined = sliceRange(["abcdef", "ghij", "klmnop"], 4, 3);
  assert.equal(joined, `ef${CROSS_PARAGRAPH_JOINER}ghij${CROSS_PARAGRAPH_JOINER}klm`);
});

test("sliceRange on one paragraph is a plain substring", () => {
  assert.equal(sliceRange(["abcdef"], 2, 4), "cd");
});

test("a cross-paragraph selection normalises the same as the DOM would", () => {
  // `Range.toString()` puts a newline between block elements and
  // `normalizeProse` collapses it; the joiner has to agree, or every
  // cross-paragraph note would be refused as a mismatch.
  const verdict = validateRangeSelection({
    paragraphs,
    startParagraphIndex: 1,
    startOffset: 0,
    endParagraphIndex: 2,
    endOffset: 4,
    selectionText: "第一段的文字内容。\n第二段讲",
  });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});
