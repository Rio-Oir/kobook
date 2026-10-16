// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Text-offset gates for article highlighting.
 *
 * These two functions are the whole reason highlighting can store
 * plain integer offsets instead of quote-based anchors, so they get
 * the paranoid treatment: the boundary cases here are exactly the
 * ones that would silently corrupt a stored highlight.
 *
 * `rangeToOffsets` runs against a real jsdom document, because the
 * thing it has to get right is DOM traversal — skipping the
 * paragraph-number marker and summing across the multiple text
 * nodes that appear once a paragraph has been segmented for
 * rendering. A hand-rolled fake would not exercise either.
 *
 * `segmentParagraph` is pure and covers overlap, adjacency,
 * clamping and the empty cases.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  PARAGRAPH_MARKER_ATTR,
  rangeToOffsets,
  segmentBlock,
  segmentParagraph,
} from "../../src/lib/text-offset.js";

/** Build a paragraph element the way `Reader.tsx` does. */
function makeParagraph(
  doc: Document,
  opts: { marker: string; bodyNodes: Array<{ text: string; tag?: string }> },
): HTMLParagraphElement {
  const p = doc.createElement("p");
  p.setAttribute("data-paragraph-index", "1");

  const marker = doc.createElement("span");
  marker.setAttribute(PARAGRAPH_MARKER_ATTR, "");
  marker.textContent = opts.marker;
  p.appendChild(marker);

  for (const node of opts.bodyNodes) {
    if (node.tag) {
      const el = doc.createElement(node.tag);
      el.textContent = node.text;
      p.appendChild(el);
    } else {
      p.appendChild(doc.createTextNode(node.text));
    }
  }
  return p;
}

/** Select `[start, end)` over the paragraph's first body text node. */
function selectInNode(
  doc: Document,
  node: Text,
  start: number,
  end: number,
): Range {
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

test("rangeToOffsets: a selection over the single body text node maps 1:1", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const p = makeParagraph(doc, { marker: "7", bodyNodes: [{ text: "阅读是件慢事情" }] });
  const body = p.lastChild as Text;

  const range = selectInNode(doc, body, 0, 3);
  assert.deepEqual(rangeToOffsets(p, range), { start: 0, end: 3 });

  const mid = selectInNode(doc, body, 2, 6);
  assert.deepEqual(rangeToOffsets(p, mid), { start: 2, end: 6 });
});

test("rangeToOffsets: the paragraph-number marker does not shift offsets", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  // A long marker: if it were counted, every offset would be off by
  // its length.
  const p = makeParagraph(doc, { marker: "1234", bodyNodes: [{ text: "abcdef" }] });
  const body = p.lastChild as Text;

  assert.deepEqual(rangeToOffsets(p, selectInNode(doc, body, 0, 1)), {
    start: 0,
    end: 1,
  });
  assert.deepEqual(rangeToOffsets(p, selectInNode(doc, body, 5, 6)), {
    start: 5,
    end: 6,
  });
});

test("rangeToOffsets: offsets sum across multiple text nodes (post-segmentation DOM)", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  // This is the DOM shape after a highlight was rendered: the body
  // text is split into several nodes by the <mark> elements.
  const p = makeParagraph(doc, {
    marker: "7",
    bodyNodes: [{ text: "前缀" }, { text: "被标记", tag: "mark" }, { text: "后缀" }],
  });
  const [firstText, markEl, lastText] = Array.from(p.childNodes).slice(1) as [
    Text,
    HTMLElement,
    Text,
  ];

  // Selecting "被标记" (indices 2..5 of "前缀被标记后缀") spans one node only.
  const inner = selectInNode(doc, markEl.firstChild as Text, 0, 3);
  assert.deepEqual(rangeToOffsets(p, inner), { start: 2, end: 5 });

  // A selection that starts in the first node and ends in the third
  // crosses the mark; the offsets must still be flat paragraph indices.
  const crossing = doc.createRange();
  crossing.setStart(firstText, 1);
  crossing.setEnd(lastText, 1);
  assert.deepEqual(rangeToOffsets(p, crossing), { start: 1, end: 6 });
});

test("rangeToOffsets: a backwards drag is already normalised by the DOM", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const p = makeParagraph(doc, { marker: "1", bodyNodes: [{ text: "abcdef" }] });
  const body = p.lastChild as Text;

  // The DOM spec collapses a Range whose end is set before its start,
  // so a right-to-left drag never reaches us as start > end. Pinning
  // that here means a future refactor cannot "fix" a non-problem by
  // adding a swap that silently changes collapsed-caret behaviour.
  const backwards = doc.createRange();
  backwards.setStart(body, 5);
  backwards.setEnd(body, 2);
  assert.equal(backwards.startOffset, 2);
  assert.equal(backwards.endOffset, 2);
  assert.deepEqual(rangeToOffsets(p, backwards), { start: 2, end: 2 });
});

test("rangeToOffsets: a collapsed caret is `start === end` (caller rejects it)", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const p = makeParagraph(doc, { marker: "1", bodyNodes: [{ text: "abcdef" }] });
  const body = p.lastChild as Text;
  assert.deepEqual(rangeToOffsets(p, selectInNode(doc, body, 3, 3)), {
    start: 3,
    end: 3,
  });
});

test("rangeToOffsets: a whole-paragraph range (both boundaries on the <p>) maps to the full text", () => {
  // The regression this file exists for. A drag that starts in a
  // paragraph's left padding or ends past its last character anchors
  // its boundary to the `<p>` element, not to a text node — the DOM
  // produces `(p, 0)` … `(p, childNodes.length)`. The first version of
  // `rangeToOffsets` only summed text nodes, could not match an
  // element boundary, and returned `null`; the reader then disabled
  // all four colour swatches. Selecting a whole paragraph is the
  // single most common gesture, and it silently could not be marked.
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const p = makeParagraph(doc, { marker: "7", bodyNodes: [{ text: "阅读是件慢事情" }] });

  const range = doc.createRange();
  range.setStart(p, 0);
  range.setEnd(p, p.childNodes.length);

  assert.deepEqual(rangeToOffsets(p, range), { start: 0, end: 7 });
});

test("rangeToOffsets: an element boundary mid-paragraph resolves to the character before that child", () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const p = makeParagraph(doc, {
    marker: "1",
    bodyNodes: [{ text: "abc" }, { text: "def", tag: "mark" }, { text: "ghi" }],
  });
  // Child indices include the marker: 0 = marker, 1 = "abc",
  // 2 = <mark>def</mark>, 3 = "ghi". An element boundary `(p, n)` is
  // the position *immediately before* child n.
  const at = (n: number) => {
    const r = doc.createRange();
    r.setStart(p, 0);
    r.setEnd(p, n);
    return rangeToOffsets(p, r);
  };
  assert.deepEqual(at(1), { start: 0, end: 0 }, "(p,1) is before 'abc'");
  assert.deepEqual(at(2), { start: 0, end: 3 }, "(p,2) is before the <mark>");
  assert.deepEqual(at(3), { start: 0, end: 6 }, "(p,3) is before 'ghi'");
  assert.deepEqual(at(4), { start: 0, end: 9 }, "(p,4) is the paragraph end");

  // An element boundary and a text-node boundary naming the same
  // position must agree, or a highlight made by dragging one way
  // would be unreproducible by dragging the other.
  const mark = p.querySelector("mark")!;
  const viaText = doc.createRange();
  viaText.setStart(mark.firstChild as Text, 0);
  viaText.setEnd(mark.firstChild as Text, 3);
  assert.deepEqual(rangeToOffsets(p, viaText), { start: 3, end: 6 });
});

test("rangeToOffsets: a boundary inside the paragraph-number marker clamps to the paragraph start", () => {
  // The marker is `select-none`, but a drag that begins in the left
  // padding still puts a boundary on it. Reporting the marker's digit
  // as text would shift the whole anchor by one character.
  const { window } = new JSDOM("<!doctype html><body></body>");
  const doc = window.document;
  const p = makeParagraph(doc, { marker: "12", bodyNodes: [{ text: "abcdef" }] });
  const marker = p.querySelector("[data-paragraph-marker]")!;

  const range = doc.createRange();
  range.setStart(marker, 0);
  range.setEnd(p, p.childNodes.length);

  assert.deepEqual(rangeToOffsets(p, range), { start: 0, end: 6 });
});

test("rangeToOffsets: a boundary outside the paragraph is refused", () => {
  const { window } = new JSDOM("<!doctype html><body><div id=out>xyz</div></body>");
  const doc = window.document;
  const p = makeParagraph(doc, { marker: "1", bodyNodes: [{ text: "abcdef" }] });
  doc.body.appendChild(p);
  const outside = doc.getElementById("out")!.firstChild as Text;

  const range = doc.createRange();
  range.setStart(outside, 0);
  range.setEnd(p.lastChild as Text, 3);

  // `null` here is what keeps a selection that starts in the sidebar
  // (or another paragraph) from being written against this one.
  assert.equal(rangeToOffsets(p, range), null);
});

test("segmentParagraph: no marks returns one plain segment", () => {
  assert.deepEqual(segmentParagraph("abcdef", []), [
    { text: "abcdef", marks: [] },
  ]);
});

test("segmentParagraph: empty text returns nothing", () => {
  assert.deepEqual(segmentParagraph("", []), []);
  assert.deepEqual(
    segmentParagraph("", [{ id: "h1", start: 0, end: 5 }]),
    [],
    "clamped marks must not resurrect an empty paragraph",
  );
});

test("segmentParagraph: one mark splits the text in three", () => {
  const segments = segmentParagraph("abcdef", [{ id: "h1", start: 2, end: 4 }]);
  assert.deepEqual(segments, [
    { text: "ab", marks: [] },
    { text: "cd", marks: ["h1"] },
    { text: "ef", marks: [] },
  ]);
});

test("segmentParagraph: a mark at the very start or end adds no empty slice", () => {
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: 0, end: 2 }]), [
    { text: "ab", marks: ["h"] },
    { text: "c", marks: [] },
  ]);
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: 2, end: 3 }]), [
    { text: "ab", marks: [] },
    { text: "c", marks: ["h"] },
  ]);
  // Whole paragraph.
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: 0, end: 3 }]), [
    { text: "abc", marks: ["h"] },
  ]);
});

test("segmentParagraph: adjacent marks do not merge and do not produce gaps", () => {
  const segments = segmentParagraph("abcdef", [
    { id: "a", start: 0, end: 3 },
    { id: "b", start: 3, end: 6 },
  ]);
  assert.deepEqual(segments, [
    { text: "abc", marks: ["a"] },
    { text: "def", marks: ["b"] },
  ]);
});

test("segmentParagraph: overlapping marks list both ids, innermost last", () => {
  const segments = segmentParagraph("abcdef", [
    { id: "outer", start: 1, end: 5 },
    { id: "inner", start: 2, end: 4 },
  ]);
  assert.deepEqual(segments, [
    { text: "a", marks: [] },
    { text: "b", marks: ["outer"] },
    { text: "cd", marks: ["outer", "inner"] },
    { text: "e", marks: ["outer"] },
    { text: "f", marks: [] },
  ]);
});

test("segmentParagraph: identical marks list both ids deterministically", () => {
  const segments = segmentParagraph("abcdef", [
    { id: "first", start: 2, end: 4 },
    { id: "second", start: 2, end: 4 },
  ]);
  assert.deepEqual(segments, [
    { text: "ab", marks: [] },
    { text: "cd", marks: ["first", "second"] },
    { text: "ef", marks: [] },
  ]);
});

test("segmentParagraph: out-of-range and inverted marks are clamped or dropped", () => {
  // End past the text: clamped to the text length.
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: 1, end: 99 }]), [
    { text: "a", marks: [] },
    { text: "bc", marks: ["h"] },
  ]);
  // Negative start: clamped to 0.
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: -5, end: 2 }]), [
    { text: "ab", marks: ["h"] },
    { text: "c", marks: [] },
  ]);
  // Inverted: dropped, so the paragraph renders as plain text.
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: 2, end: 1 }]), [
    { text: "abc", marks: [] },
  ]);
  // Entirely past the end: dropped.
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: 5, end: 9 }]), [
    { text: "abc", marks: [] },
  ]);
  // Zero-width: dropped.
  assert.deepEqual(segmentParagraph("abc", [{ id: "h", start: 1, end: 1 }]), [
    { text: "abc", marks: [] },
  ]);
});

test("segmentParagraph: the concatenated segments always reproduce the input", () => {
  // The invariant the renderer depends on: no text is lost or
  // duplicated by slicing.
  const text = "阅读是件慢事情，从前读一篇文章，常常是泡一杯茶。";
  const marks = [
    { id: "a", start: 0, end: 3 },
    { id: "b", start: 2, end: 7 },
    { id: "c", start: 7, end: 7 },
    { id: "d", start: 10, end: 999 },
  ];
  const joined = segmentParagraph(text, marks)
    .map((s) => s.text)
    .join("");
  assert.equal(joined, text);
});

/* ─────────────────── segmentBlock: highlights and emphasis together ─────────────────── */

test("segmentBlock: with no emphasis it matches segmentParagraph slice for slice", () => {
  const text = "abcdef";
  const marks = [{ id: "h1", start: 2, end: 4 }];
  assert.deepEqual(
    segmentBlock(text, marks).map((s) => ({ text: s.text, marks: s.markIds })),
    segmentParagraph(text, marks),
  );
});

test("segmentBlock: emphasis splits the text and carries its kinds", () => {
  // "一段 粗体 尾": the bold covers indices 3..5.
  assert.deepEqual(segmentBlock("一段 粗体 尾", [], [{ start: 3, end: 5, kinds: ["strong"] }]), [
    { text: "一段 ", markIds: [], kinds: [] },
    { text: "粗体", markIds: [], kinds: ["strong"] },
    { text: " 尾", markIds: [], kinds: [] },
  ]);
});

test("segmentBlock: a link slice carries its target", () => {
  const spans = [{ start: 2, end: 4, kinds: ["link"] as const, href: "https://x.example/" }];
  const slices = segmentBlock("ab链接cd", [], spans as never);
  assert.deepEqual(slices, [
    { text: "ab", markIds: [], kinds: [] },
    { text: "链接", markIds: [], kinds: ["link"], href: "https://x.example/" },
    { text: "cd", markIds: [], kinds: [] },
  ]);
});

test("segmentBlock: a highlight inside emphasis keeps both, cut at both boundaries", () => {
  // The whole point of cutting once for both kinds. "一段 粗体字 尾": the bold
  // covers 3..6, the highlight 4..5 sits in the middle of it. The renderer gets
  // five slices, and the highlighted one carries both — the emphasis it is
  // inside and the mark drawn over it.
  const text = "一段 粗体字 尾";
  const slices = segmentBlock(
    text,
    [{ id: "h1", start: 4, end: 5 }],
    [{ start: 3, end: 6, kinds: ["strong"] }],
  );
  assert.deepEqual(slices, [
    { text: "一段 ", markIds: [], kinds: [] },
    { text: "粗", markIds: [], kinds: ["strong"] },
    { text: "体", markIds: ["h1"], kinds: ["strong"] },
    { text: "字", markIds: [], kinds: ["strong"] },
    { text: " 尾", markIds: [], kinds: [] },
  ]);
  assert.equal(slices.map((s) => s.text).join(""), text);
});

test("segmentBlock: nested emphasis arrives as one slice with both kinds", () => {
  const slices = segmentBlock("前粗斜后", [], [{ start: 1, end: 3, kinds: ["strong", "em"] }]);
  assert.deepEqual(slices[1], { text: "粗斜", markIds: [], kinds: ["strong", "em"] });
});

test("segmentBlock: stale or hostile spans cannot produce a negative slice", () => {
  // localStorage is user-editable and older builds wrote other shapes, so this
  // is the function that has to survive whatever is in the blob. Nothing here
  // may throw or index outside the text.
  const text = "abc";
  const cases: Array<[number, number]> = [
    [-5, 2],
    [1, 99],
    [2, 1],
    [5, 9],
    [1, 1],
    [0, 3],
  ];
  for (const [start, end] of cases) {
    const slices = segmentBlock(text, [], [{ start, end, kinds: ["strong"] }]);
    assert.equal(slices.map((s) => s.text).join(""), text);
  }
  assert.deepEqual(segmentBlock("abc", [], [{ start: 5, end: 9, kinds: ["strong"] }]), [
    { text: "abc", markIds: [], kinds: [] },
  ]);
  assert.deepEqual(segmentBlock("abc", [], [{ start: 1, end: 1, kinds: ["strong"] }]), [
    { text: "abc", markIds: [], kinds: [] },
  ]);
});

test("segmentBlock: an unknown or duplicated kind cannot render a stray tag", () => {
  // `kinds` comes off the wire and out of localStorage. A value the renderer
  // has no element for must be filtered out rather than reaching the switch in
  // `Emphasis`, which would fall through and return nothing.
  const slices = segmentBlock("ab", [], [
    { start: 0, end: 2, kinds: ["strong", "shout", "strong"] as never },
  ]);
  assert.deepEqual(slices, [{ text: "ab", markIds: [], kinds: ["strong"] }]);
  assert.deepEqual(segmentBlock("ab", [], [{ start: 0, end: 2, kinds: [] as never }]), [
    { text: "ab", markIds: [], kinds: [] },
  ]);
});

test("segmentBlock: emphasis is emitted in the contract's canonical order", () => {
  // The renderer nests outermost-first from this array, so the order decides
  // whether `**_x_**` comes out `<strong><em>` or `<em><strong>`. Both look
  // the same, but only one of them is what the other side of the wire stores.
  const slices = segmentBlock("x", [], [{ start: 0, end: 1, kinds: ["link", "em", "strong"], href: "https://x.example/" }]);
  assert.deepEqual(slices[0]!.kinds, ["strong", "em", "link"]);
});

test("segmentBlock: empty text renders nothing", () => {
  assert.deepEqual(segmentBlock("", [], [{ start: 0, end: 0, kinds: ["strong"] }]), []);
});
