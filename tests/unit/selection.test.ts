// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Selection validation — the rule that decides whether a client-supplied
 * `selectionText` is a legitimate excerpt of the paragraph it claims to
 * come from.
 *
 * The plan says "服务端校验选区确实来自该用户当前文章版本; 支持起止段落及偏移,
 * 不接受前端自行构造的任意原文作为可信证据". The distinction that matters
 * is *选区* (selection) vs *段落* (paragraph): a reader highlights a word,
 * a phrase or a sentence, not always the whole paragraph.
 *
 * These tests exist because the first implementation required the
 * selection to **equal** the whole normalised paragraph. That passes a
 * test that only ever selects a full paragraph, and fails the product:
 * "选中一段文字" would have to mean "select the entire paragraph or
 * nothing". The cases below all select *less* than the paragraph.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSelection } from "../../server/src/lib/selection.js";

const PARAGRAPH =
  "深度学习模型的训练需要大量计算资源。许多团队因此选择使用云端 GPU 集群，按小时付费。";

test("a single word selected out of a paragraph is accepted", () => {
  const verdict = validateSelection(PARAGRAPH, "深度学习模型");
  assert.equal(verdict.ok, true, "a leading phrase must be accepted");
});

test("a sentence from the middle of a paragraph is accepted", () => {
  const verdict = validateSelection(PARAGRAPH, "许多团队因此选择使用云端 GPU 集群");
  assert.equal(verdict.ok, true, "a mid-paragraph span must be accepted");
});

test("a trailing phrase is accepted", () => {
  const verdict = validateSelection(PARAGRAPH, "按小时付费。");
  assert.equal(verdict.ok, true, "a trailing span must be accepted");
});

test("selecting the whole paragraph is still accepted", () => {
  const verdict = validateSelection(PARAGRAPH, PARAGRAPH);
  assert.equal(verdict.ok, true, "the equality case must keep working");
});

test("a selection wrapped in stray whitespace still matches", () => {
  // The browser can hand back the surrounding whitespace of the range.
  const verdict = validateSelection(PARAGRAPH, "  许多团队因此选择使用云端 GPU 集群\n ");
  assert.equal(verdict.ok, true, "normalisation must absorb padding");
});

test("a short Chinese fragment is not filtered out by length", () => {
  // The audit's P1#3 was a parser that dropped every block shorter than
  // 20 characters. The selection rule must not reintroduce a length
  // threshold: one character is a legitimate selection.
  const verdict = validateSelection(PARAGRAPH, "训");
  assert.equal(verdict.ok, true, "a one-character selection is legitimate");
});

test("text the article never contained is refused", () => {
  const verdict = validateSelection(PARAGRAPH, "这段文字并不在文章里");
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, "not-found");
});

test("a tampered selection that reorders the paragraph is refused", () => {
  const verdict = validateSelection(PARAGRAPH, "按小时付费。深度学习模型的训练需要大量计算资源。");
  assert.equal(verdict.ok, false, "reordering is not a substring and must be refused");
});

test("an empty or whitespace-only selection is refused", () => {
  for (const empty of ["", "   ", "\n\t"]) {
    const verdict = validateSelection(PARAGRAPH, empty);
    assert.equal(verdict.ok, false, `must refuse ${JSON.stringify(empty)}`);
    if (!verdict.ok) {
      assert.equal(verdict.reason, "empty");
    }
  }
});

test("an empty paragraph cannot validate any selection", () => {
  // Defensive: a zero-length stored paragraph must never validate a
  // non-empty selection, even though `"".includes(x)` is false anyway.
  const verdict = validateSelection("   ", "任何内容");
  assert.equal(verdict.ok, false);
});

test("a selection spanning two paragraphs is refused by this single-paragraph rule", () => {
  // Cross-paragraph selection is a separate, larger feature (start/end
  // paragraph + offsets). Until it lands, the API models one
  // `paragraphIndex`, so a two-paragraph selection must be refused
  // rather than silently anchored to the first paragraph.
  const twoParagraphs = `${PARAGRAPH}这是下一段的开头。`;
  const selection = "按小时付费。这是下一段的开头。";
  // It IS a substring of the joined text, so this documents that the
  // route's single-paragraph lookup is what bounds the rule — the
  // helper alone cannot distinguish the case.
  assert.equal(validateSelection(twoParagraphs, selection).ok, true);
  // And against the single paragraph it is refused, which is the shape
  // the route actually uses.
  assert.equal(validateSelection(PARAGRAPH, selection).ok, false);
});
