// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Block structure gates.
 *
 * Two things are pinned here.
 *
 * **1. The tag and grouping rules.** `groupBlocks` decides which
 * records share a `<ul>`/`<ol>` and `headingTag` decides how deep a
 * Markdown `#` renders. Both are pure so they can be asserted directly
 * rather than by rendering React, which is this repo's testing
 * convention (`tests/unit/text-offset.test.ts` does the same for the
 * offset math).
 *
 * **2. The character-offset round trip, per block kind.** This is the
 * load-bearing part. `rangeToOffsets` measures a selection with
 * `Range.toString().length` over the block element, so a block's
 * rendered text has to equal `paragraph.text` and nothing else. The
 * tempting ways to decorate a block — a generated `content: "•"`
 * bullet, a quote glyph, a heading anchor, a code-language badge —
 * all *add DOM text* and would shift every stored highlight in that
 * block. Chromium counts `::before { content }` in `Range.toString()`,
 * CSS cannot demonstrate that in jsdom, so instead the DOM this file
 * builds is the exact shape `Reader.tsx` emits, and the assertion is
 * that a whole-block selection still maps to `[0, text.length)`.
 *
 * If someone later gives a block kind an extra inline wrapper that
 * carries a character, the round trip breaks here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  blockKindOf,
  groupBlocks,
  headingTag,
  outlineOf,
  titleSizeClass,
  type BlockKind,
} from "../../src/lib/blocks.js";
import { PARAGRAPH_MARKER_ATTR, rangeToOffsets } from "../../src/lib/text-offset.js";
import type { Paragraph } from "../../src/lib/types.js";

function p(
  index: number,
  text: string,
  extra: Partial<Paragraph> = {},
): Paragraph {
  return { index, text, hash: `h${index}`, ...extra };
}

/* ────────────────────────── blockKindOf ────────────────────────── */

test("blockKindOf: a missing type reads as plain prose", () => {
  // Every legacy localStorage blob and most test fixtures supply only
  // {index, text, hash}; treating that as an error would blank the
  // reader for existing data.
  assert.equal(blockKindOf({ type: undefined }), "paragraph");
  assert.equal(blockKindOf({}), "paragraph");
});

test("blockKindOf: every parsed kind passes through", () => {
  const kinds: BlockKind[] = ["heading", "paragraph", "listItem", "code", "quote"];
  for (const kind of kinds) {
    assert.equal(blockKindOf({ type: kind }), kind);
  }
});

/* ────────────────────────── headingTag ─────────────────────────── */

test("headingTag shifts the scale down one so the article title keeps the only <h1>", () => {
  // Reader.tsx renders the article title into an <h1> just above
  // .gloss-prose. Mapping a document's `#` to <h1> would put two on the
  // page.
  assert.equal(headingTag(1), "h2");
  assert.equal(headingTag(2), "h3");
  assert.equal(headingTag(3), "h4");
  assert.equal(headingTag(4), "h5");
  assert.equal(headingTag(5), "h6");
});

test("headingTag clamps rather than producing a tag that does not exist", () => {
  assert.equal(headingTag(6), "h6", "there is no h7");
  assert.equal(headingTag(99), "h6");
  assert.equal(headingTag(0), "h2");
  assert.equal(headingTag(-3), "h2");
  assert.equal(headingTag(undefined), "h2");
  assert.equal(headingTag(2.7), "h3", "depth is floored, not rounded up");
});

/* ────────────────────────── groupBlocks ────────────────────────── */

test("groupBlocks: non-list blocks each stand alone", () => {
  const groups = groupBlocks([
    p(1, "标题", { type: "heading", level: 1 }),
    p(2, "正文"),
    p(3, "引用", { type: "quote" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ["block", "block", "block"],
  );
});

test("groupBlocks: consecutive list items share one list", () => {
  // One `<ul>` per item would put a separate bullet block around each
  // line and restart ordered numbering on every entry.
  const groups = groupBlocks([
    p(1, "前"),
    p(2, "一", { type: "listItem", ordered: false }),
    p(3, "二", { type: "listItem", ordered: false }),
    p(4, "三", { type: "listItem", ordered: false }),
  ]);
  assert.equal(groups.length, 2);
  const list = groups[1]!;
  assert.equal(list.kind, "list");
  assert.ok(list.kind === "list");
  assert.equal(list.ordered, false);
  assert.deepEqual(
    list.items.map((i) => i.index),
    [2, 3, 4],
  );
});

test("groupBlocks: a change of list kind breaks the run", () => {
  const groups = groupBlocks([
    p(1, "一", { type: "listItem", ordered: false }),
    p(2, "二", { type: "listItem", ordered: false }),
    p(3, "1.", { type: "listItem", ordered: true }),
    p(4, "2.", { type: "listItem", ordered: true }),
    p(5, "三", { type: "listItem", ordered: false }),
  ]);
  assert.deepEqual(
    groups.map((g) => (g.kind === "list" ? `list:${g.ordered}:${g.items.length}` : "block")),
    ["list:false:2", "list:true:2", "list:false:1"],
  );
});

test("groupBlocks: a missing `ordered` is treated as unordered", () => {
  const groups = groupBlocks([
    p(1, "一", { type: "listItem" }),
    p(2, "二", { type: "listItem" }),
  ]);
  assert.equal(groups.length, 1);
  assert.ok(groups[0]!.kind === "list");
  assert.equal(groups[0]!.ordered, false);
});

test("groupBlocks: a paragraph between list items ends the list", () => {
  const groups = groupBlocks([
    p(1, "一", { type: "listItem" }),
    p(2, "打断"),
    p(3, "二", { type: "listItem" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ["list", "block", "list"],
  );
});

test("groupBlocks: empty input yields no groups", () => {
  assert.deepEqual(groupBlocks([]), []);
});

/* ────────────────────────── outlineOf ──────────────────────────── */

test("outlineOf collects headings in reading order and nothing else", () => {
  const entries = outlineOf([
    p(1, "引言"),
    p(2, "第一章", { type: "heading", level: 1 }),
    p(3, "正文"),
    p(4, "一节", { type: "heading", level: 2 }),
    p(5, "正文"),
  ]);
  assert.deepEqual(
    entries.map((e) => e.index),
    [2, 4],
  );
  assert.deepEqual(
    entries.map((e) => e.text),
    ["第一章", "一节"],
  );
});

test("outlineOf closes each section at the block before the next heading", () => {
  const entries = outlineOf([
    p(1, "第一章", { type: "heading", level: 1 }),
    p(2, "正文"),
    p(3, "一节", { type: "heading", level: 2 }),
    p(4, "正文"),
    p(5, "尾"),
  ]);
  assert.equal(entries[0]!.untilIndex, 2, "section ends at the block before the next heading");
  assert.equal(entries[1]!.untilIndex, null, "the last section runs to the end");
});

test("outlineOf clamps depth and tolerates a heading with no level", () => {
  const entries = outlineOf([
    p(1, "没级别", { type: "heading" }),
    p(2, "太深", { type: "heading", level: 9 }),
  ]);
  assert.equal(entries[0]!.level, 1);
  assert.equal(entries[1]!.level, 5, "depth is clamped to the range the tag scale supports");
});

test("outlineOf is empty for a document with no headings", () => {
  // The reader shows an explicit "this article has no subheadings"
  // line for this, rather than inventing structure.
  assert.deepEqual(outlineOf([p(1, "甲"), p(2, "乙")]), []);
  assert.deepEqual(outlineOf([]), []);
});

/* ────────────────── the offset round trip, per kind ────────────────── */

/**
 * Build the DOM `HighlightedParagraph` emits for a block.
 *
 * Kept here rather than shared with the component: a test that imported
 * the renderer's own helper could not catch the renderer drifting from
 * this contract, which is the whole point of the exercise.
 */
function renderBlock(
  doc: Document,
  kind: BlockKind,
  text: string,
  opts: { index?: number; level?: number; hasNote?: boolean } = {},
): HTMLElement {
  const index = opts.index ?? 1;
  const hasNote = opts.hasNote ?? false;

  const marker = doc.createElement("span");
  marker.setAttribute(PARAGRAPH_MARKER_ATTR, "");
  // List items show nothing in the gutter unless they carry a note.
  marker.textContent = hasNote
    ? "•"
    : kind === "listItem"
      ? ""
      : String(index);

  if (kind === "code") {
    // The marker sits outside the <pre>: inside it, `white-space: pre`
    // would turn the surrounding whitespace into real characters.
    const wrapper = doc.createElement("div");
    wrapper.setAttribute("data-paragraph-index", String(index));
    wrapper.appendChild(marker);
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    code.textContent = text;
    pre.appendChild(code);
    wrapper.appendChild(pre);
    return wrapper;
  }

  const tag =
    kind === "heading"
      ? headingTag(opts.level)
      : kind === "quote"
        ? "blockquote"
        : kind === "listItem"
          ? "li"
          : "p";
  const el = doc.createElement(tag);
  el.setAttribute("data-paragraph-index", String(index));
  el.appendChild(marker);
  el.appendChild(doc.createTextNode(text));
  return el;
}

/** A range covering the whole block, as a "select everything" drag is. */
function wholeBlockRange(doc: Document, el: HTMLElement): Range {
  const range = doc.createRange();
  range.setStart(el, 0);
  range.setEnd(el, el.childNodes.length);
  return range;
}

test("offset round trip: every block kind measures exactly its own text", () => {
  // This is the regression that matters. If a block ever renders one
  // character that is not in `paragraph.text` — a generated bullet, a
  // quote mark, a language badge — the end offset comes back longer
  // than the text and this fails.
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const cases: Array<[BlockKind, string, number | undefined]> = [
    ["paragraph", "普通段落的一行文字。", undefined],
    ["heading", "标题不算标点。", 1],
    ["heading", "深一点的标题。", 3],
    ["quote", "被引用的一句话。", undefined],
    ["listItem", "列表项一。", undefined],
    ["code", "const x = 1;\nconsole.log(x);", undefined],
  ];

  for (const [kind, text, level] of cases) {
    const el = renderBlock(doc, kind, text, { level });
    const offsets = rangeToOffsets(el, wholeBlockRange(doc, el));
    assert.deepEqual(
      offsets,
      { start: 0, end: text.length },
      `${kind} (level ${level ?? "-"}) must round-trip to its own text`,
    );
  }
});

test("offset round trip: a list item's empty gutter marker is a no-op", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const text = "列表项二。";
  const el = renderBlock(doc, "listItem", text);
  const marker = el.querySelector(`[${PARAGRAPH_MARKER_ATTR}]`);
  assert.equal(marker?.textContent, "", "a plain list item spends no gutter characters");
  assert.deepEqual(rangeToOffsets(el, wholeBlockRange(doc, el)), {
    start: 0,
    end: text.length,
  });
});

test("offset round trip: a note dot in the gutter is still subtracted", () => {
  // The dot is a real character in the DOM, so it *must* be inside the
  // marked span — if it were appended as a bare text node, every offset
  // in a noted block would drift by one.
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const text = "带笔记的列表项。";
  const el = renderBlock(doc, "listItem", text, { hasNote: true });
  assert.deepEqual(rangeToOffsets(el, wholeBlockRange(doc, el)), {
    start: 0,
    end: text.length,
  });
});

test("offset round trip: a partial selection lands where the text says", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const text = "从前读一篇文章，常常是泡一杯茶。";
  const el = renderBlock(doc, "heading", text, { level: 2 });
  // The heading's text node is the last child, after the marker.
  const textNode = el.lastChild as Text;
  const range = doc.createRange();
  range.setStart(textNode, 3);
  range.setEnd(textNode, 9);
  assert.deepEqual(rangeToOffsets(el, range), { start: 3, end: 9 });
  assert.equal(text.slice(3, 9), "一篇文章，常");
});

test("offset round trip: a code block with a multi-digit number keeps line structure", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const text = "line one\n  indented\nline three";
  const el = renderBlock(doc, "code", text, { index: 123 });
  const offsets = rangeToOffsets(el, wholeBlockRange(doc, el));
  assert.deepEqual(offsets, { start: 0, end: text.length });
  // The preserved newlines are part of the stored text, so an offset
  // landing on one must still line up.
  assert.equal(text.slice(0, 8), "line one");
});

/* ────────────────── inline emphasis, and the offset contract ────────────────── */

/** Build the inline markup `Reader.tsx` emits for a block with emphasis. */
function renderEmphasisedBlock(
  doc: Document,
  parts: Array<string | { tag: "strong" | "em" | "code" | "del" | "a"; text: string }>,
  index = 1,
): { el: HTMLElement; text: string } {
  const el = doc.createElement("p");
  el.setAttribute("data-paragraph-index", String(index));

  const marker = doc.createElement("span");
  marker.setAttribute(PARAGRAPH_MARKER_ATTR, "");
  marker.textContent = String(index);
  el.appendChild(marker);

  let text = "";
  for (const part of parts) {
    if (typeof part === "string") {
      el.appendChild(doc.createTextNode(part));
      text += part;
      continue;
    }
    const child = doc.createElement(part.tag);
    if (part.tag === "a") child.setAttribute("href", "https://example.com/");
    child.textContent = part.text;
    el.appendChild(child);
    text += part.text;
  }
  return { el, text };
}

test("offset round trip: inline emphasis adds no characters to a block", () => {
  // The inline feature wraps parts of a block in <strong> / <em> / <code> /
  // <del> / <a>. None of them contributes text, and `rangeToOffsets` measures
  // `Range.toString()` over the whole block, so a block must still measure
  // exactly `paragraph.text`. The tempting addition — an external-link arrow or
  // a domain badge next to a link, even via `::after { content }`, which
  // Chromium counts — would break this, and would break every stored highlight
  // in the block rather than just the link.
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const { el, text } = renderEmphasisedBlock(doc, [
    "这一段有 ",
    { tag: "strong", text: "粗体" },
    " 与 ",
    { tag: "em", text: "斜体" },
    " 与 ",
    { tag: "code", text: "行内代码" },
    " 与 ",
    { tag: "del", text: "删除" },
    " 与 ",
    { tag: "a", text: "链接" },
    "。",
  ]);

  assert.equal(el.textContent, `1${text}`, "the block renders the marker and nothing else");
  assert.deepEqual(rangeToOffsets(el, wholeBlockRange(doc, el)), {
    start: 0,
    end: text.length,
  });
});

test("offset round trip: a selection that starts inside emphasis still lands right", () => {
  // The case a highlight straddling a bold/plain boundary produces: one
  // boundary is inside the `<strong>`, the other in the plain text after it.
  // The two boundaries are measured against different nodes, and the answer has
  // to be offsets into the same flat string.
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const { el, text } = renderEmphasisedBlock(doc, [
    "一段 ",
    { tag: "strong", text: "粗体" },
    " 尾巴",
  ]);
  const strong = el.querySelector("strong")!;
  const tail = el.lastChild as Text;

  const range = doc.createRange();
  range.setStart(strong.firstChild as Text, 1);
  range.setEnd(tail, 2);
  const offsets = rangeToOffsets(el, range);
  assert.ok(offsets);
  assert.equal(text.slice(offsets.start, offsets.end), "体 尾");
  assert.deepEqual(offsets, { start: 4, end: 7 });
});


/**
 * Title size steps.
 *
 * The exact class strings are not pinned — a Tailwind class is a
 * presentation detail and asserting it verbatim would make every
 * cosmetic tweak a test failure. What is pinned is the *behaviour* the
 * step exists for: a longer title never gets a larger size than a
 * shorter one, the largest step is no bigger than the fixed size it
 * replaced, and "long" is measured in ems rather than in characters, so
 * a Chinese title is not treated as short just because it has fewer
 * code points than an English one.
 */

/** The `clamp()` lower bound of a size class, in rem. */
function minRem(className: string): number {
  const match = className.match(/clamp\(([\d.]+)rem/);
  assert.ok(match, `expected a clamp() in "${className}"`);
  return Number(match[1]);
}

/** The `clamp()` upper bound of a size class, in rem. */
function maxRem(className: string): number {
  const match = className.match(/clamp\([^,]+,[^,]+,\s*([\d.]+)rem\)/);
  assert.ok(match, `expected a three-stop clamp() in "${className}"`);
  return Number(match[1]);
}

test("title size: a longer title never gets a larger step", () => {
  // One Han character is two width units, so these are 26, 40, 80 and
  // 120 units — one sample inside each of the four steps. Written as
  // repeats rather than as realistic titles so the arithmetic is
  // checkable at a glance; a realistic title has to be counted by hand
  // and silently drifts into the wrong step when the thresholds move.
  const titles = [13, 20, 40, 60].map((n) => "一".repeat(n));
  const sizes = titles.map((t) => minRem(titleSizeClass(t)));
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(
      sizes[i]! < sizes[i - 1]!,
      `step ${i} (${sizes[i]}) should be smaller than step ${i - 1} (${sizes[i - 1]})`,
    );
  }
});

test("title size: no title is set larger than the fixed size it replaced", () => {
  // The h1 used to be `text-4xl md:text-5xl` — 2.25rem on a phone, 3rem
  // from the `md` breakpoint up. The steps only ever move a title down.
  for (const title of ["短", "一".repeat(20), "a ".repeat(40)]) {
    const cls = titleSizeClass(title);
    assert.ok(minRem(cls) <= 2.25, `${minRem(cls)}rem floor exceeds the old phone size`);
    assert.ok(maxRem(cls) <= 3, `${maxRem(cls)}rem ceiling exceeds the old desktop size`);
  }
});

test("title size: width is counted in ems, so a Chinese title is not short", () => {
  // 13 Han characters and 26 Latin characters are the same width, and
  // must land on the same step. This is the whole reason the count is
  // not `title.length`.
  const han13 = titleSizeClass("一".repeat(13));
  const latin26 = titleSizeClass("a".repeat(26));
  assert.equal(han13, latin26);

  // One character more of Han is a whole step wider.
  assert.notEqual(titleSizeClass("一".repeat(14)), han13);
  assert.ok(minRem(titleSizeClass("一".repeat(14))) < minRem(han13));
});

test("title size: mixed Chinese and Latin add up", () => {
  // "AI 时代的阅读" is 5 Latin code points plus 5 Han characters: the
  // Latin half counts as 5 units and the Han half as 10.
  assert.equal(titleSizeClass("AI 时代的阅读"), titleSizeClass("a".repeat(13)));
});

test("title size: an empty or whitespace title still returns a step", () => {
  // The store can hold a title the parser failed to find. The reader
  // must render something rather than throw on the way to an error
  // boundary.
  assert.equal(titleSizeClass(""), titleSizeClass("短"));
  assert.equal(titleSizeClass("   "), titleSizeClass("短"));
});
