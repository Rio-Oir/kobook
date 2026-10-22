// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PDF text reconstruction.
 *
 * Driven by synthetic item lists rather than real PDFs, which is the point of
 * splitting this out of the pdf.js integration: the judgement calls are all
 * here, and every one of them can be probed by hand. A real PDF would only
 * tell us that the happy path works.
 *
 * Coordinates are PDF user units with the origin at the bottom left, so a
 * *larger* `y` is *higher* on the page and reading order is descending `y`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  groupIntoLines,
  joinSeparator,
  looksLikeHeading,
  paragraphsFromItems,
  type PdfTextItem,
} from "../../src/lib/import/pdf-layout.js";

/** An item at a position, with a nominal 10-unit font and a proportional width. */
function item(str: string, x: number, y: number, height = 10, width?: number): PdfTextItem {
  return { str, x, y, height, width: width ?? str.length * height * 0.6 };
}

/**
 * One line of text at a given y, with each character as its own run.
 *
 * Emitting one run per character is not a contrivance — several producers do
 * exactly this — and it is the case that separates geometry-based run joining
 * from character-based joining.
 */
function lineAt(text: string, y: number, height = 10, startX = 0): PdfTextItem[] {
  const advance = height * 0.6;
  return [...text].map((ch, i) => item(ch, startX + i * advance, y, height, advance));
}

test("items on one baseline become one line", () => {
  const lines = groupIntoLines([item("Hello", 0, 700), item(" world", 40, 700)]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.text, "Hello world");
});

test("one-run-per-character output does not gain spaces", () => {
  // The case geometry is needed for. Joined by the character rule this would
  // come out as `f i r s t`, because nothing about an `f` followed by an `i`
  // says whether a space belongs between them — but the producer did say, by
  // placing them edge to edge.
  const lines = groupIntoLines(lineAt("first", 700));
  assert.equal(lines[0]?.text, "first");
});

test("adjacent runs join without a space when their edges touch", () => {
  const lines = groupIntoLines([item("foo", 0, 700, 10, 18), item("bar", 18, 700, 10, 18)]);
  assert.equal(lines[0]?.text, "foobar");
});

test("a visible gap between runs becomes a space", () => {
  // `foo` ends at 18; `bar` starts at 23. Five units of a ten-unit font is a
  // word space, and the producer put it there.
  const lines = groupIntoLines([item("foo", 0, 700, 10, 18), item("bar", 23, 700, 10, 18)]);
  assert.equal(lines[0]?.text, "foo bar");
});

test("a run reporting no width is joined without a space", () => {
  // The conservative failure: no space is recoverable, an inserted one is a
  // character the source does not have.
  const lines = groupIntoLines([item("前", 0, 700, 10, 0), item("后", 6, 700, 10, 0)]);
  assert.equal(lines[0]?.text, "前后");
});

test("padding already present at a run boundary is not doubled", () => {
  const lines = groupIntoLines([item("word ", 0, 700, 10, 25), item("next", 30, 700, 10, 20)]);
  assert.equal(lines[0]?.text, "word next");
});

test("items within the tolerance are the same line even if not exactly aligned", () => {
  // A superscript footnote marker three units above the baseline.
  const lines = groupIntoLines([item("text", 0, 700), item("1", 30, 703)], {
    lineToleranceRatio: 0.5,
  });
  assert.equal(lines.length, 1, "a superscript must not shatter the line");
});

test("separate baselines become separate lines", () => {
  const lines = groupIntoLines([...lineAt("first", 700), ...lineAt("second", 688)]);
  assert.deepEqual(
    lines.map((l) => l.text),
    ["first", "second"],
  );
});

test("lines come out top-to-bottom regardless of input order", () => {
  const shuffled = [...lineAt("bottom", 600), ...lineAt("top", 700)];
  const lines = groupIntoLines(shuffled);
  assert.deepEqual(
    lines.map((l) => l.text),
    ["top", "bottom"],
  );
});

test("runs within a line come out left-to-right regardless of input order", () => {
  // 你好 is two 6-wide runs from 0, so it ends at 12 — which is where 世界
  // starts. Placed edge to edge, as a producer actually writes them.
  const lines = groupIntoLines([item("世界", 12, 700, 10, 12), item("你好", 0, 700, 10, 12)]);
  assert.equal(lines[0]?.text, "你好世界");
});

test("a wide vertical gap starts a new paragraph", () => {
  const items = [...lineAt("段落一。", 700), ...lineAt("段落二。", 600)];
  assert.deepEqual(paragraphsFromItems(items), ["段落一。", "段落二。"]);
});

test("a normal leading gap joins the lines into one paragraph", () => {
  // 12 units apart with a 10-unit font: ordinary leading, not a break.
  const items = [...lineAt("第一行的内容", 700), ...lineAt("接着第二行", 688)];
  assert.deepEqual(paragraphsFromItems(items), ["第一行的内容接着第二行"]);
});

test("CJK line breaks join without a space", () => {
  // The case that makes the separator rule necessary: inserting a space here
  // would put a character into the text that the source never had.
  const items = [...lineAt("这是一段被排版", 700), ...lineAt("拆开的中文。", 688)];
  const paragraphs = paragraphsFromItems(items);
  assert.deepEqual(paragraphs, ["这是一段被排版拆开的中文。"]);
  assert.ok(!paragraphs[0]!.includes(" "), "no space may be inserted into Chinese prose");
});

test("Latin line breaks join with a space", () => {
  const items = [
    item("the quick brown", 0, 700),
    item("fox jumps over", 0, 688),
  ];
  assert.deepEqual(paragraphsFromItems(items), ["the quick brown fox jumps over"]);
});

test("a break between Latin and CJK still joins sensibly", () => {
  const items = [item("use the word", 0, 700), item("阅读 here", 0, 688)];
  const paragraphs = paragraphsFromItems(items);
  assert.deepEqual(paragraphs, ["use the word阅读 here"]);
});

test("a heading-sized line separated by a gap becomes its own paragraph", () => {
  const items = [
    ...lineAt("第一章", 760, 18),
    ...lineAt("正文从此开始，这里是比较长的内容。", 720),
    ...lineAt("正文继续。", 708),
  ];
  const paragraphs = paragraphsFromItems(items);
  assert.equal(paragraphs[0], "第一章");
  assert.equal(paragraphs[1], "正文从此开始，这里是比较长的内容。正文继续。");
});

test("items with empty strings are dropped", () => {
  const lines = groupIntoLines([item("", 0, 700), item("有字", 10, 700), item("", 20, 700)]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.text, "有字");
});

test("a list with no items yields no paragraphs", () => {
  assert.deepEqual(paragraphsFromItems([]), []);
  assert.deepEqual(paragraphsFromItems([item("", 0, 0)]), []);
});

test("items reporting no font size still produce lines", () => {
  // A producer that omits heights must not collapse to one item per line.
  const items = [item("甲乙", 0, 700, 0), item("丙丁", 10, 700, 0)];
  const lines = groupIntoLines(items);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.text, "甲乙丙丁");
});

test("a blank line between two paragraphs is recovered as a break", () => {
  // Two paragraphs of two lines each, with a blank line's worth of gap between.
  const items = [
    ...lineAt("第一段第一行", 700),
    ...lineAt("第一段第二行", 688),
    ...lineAt("第二段第一行", 660),
    ...lineAt("第二段第二行", 648),
  ];
  assert.deepEqual(paragraphsFromItems(items), ["第一段第一行第一段第二行", "第二段第一行第二段第二行"]);
});

test("joinSeparator is the rule the joins are built from", () => {
  assert.equal(joinSeparator("中文", "继续"), "");
  assert.equal(joinSeparator("word", "next"), " ");
  assert.equal(joinSeparator("word ", "next"), "");
  assert.equal(joinSeparator("word", " next"), "");
  assert.equal(joinSeparator("", "x"), "");
  assert.equal(joinSeparator("x", ""), "");
  // A CJK punctuation mark is unspaced too, so a break after a full stop in
  // Chinese does not gain a space the source never had.
  assert.equal(joinSeparator("结束。", "下一句"), "");
});

test("looksLikeHeading requires size, brevity and no terminal punctuation", () => {
  assert.equal(looksLikeHeading("第一章 起源", 14, 10), true);
  // Same size, but ends like a sentence.
  assert.equal(looksLikeHeading("这是正文的一句话。", 14, 10), false);
  // Right size and no punctuation, but far too long to be a heading.
  assert.equal(looksLikeHeading("一".repeat(80), 14, 10), false);
  // Short and unpunctuated, but body-sized.
  assert.equal(looksLikeHeading("嗯", 10, 10), false);
  // Punctuation that is not terminal does not disqualify.
  assert.equal(looksLikeHeading("第一章，起源", 14, 10), true);
});
