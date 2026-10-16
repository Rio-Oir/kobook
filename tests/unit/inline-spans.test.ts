// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Inline emphasis: the span algebra, and the offset map that carries emphasis
 * across whitespace normalisation.
 *
 * The map is the reason this file exists. `normalizeProse` collapses runs of
 * whitespace and trims the ends, which moves every index after the change;
 * emphasis is found *before* that, as offsets into the raw string the extractor
 * assembled. Getting the translation wrong does not throw — it slides a span by
 * a character or two, so the bold lands next to the word instead of on it, and
 * a highlight drawn across the boundary comes back one character off. There is
 * no downstream check that would notice, which is why it is pinned here at two
 * levels: the two normalisers must produce identical strings, and a span must
 * survive the trip onto the exact characters it was measured over.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdown } from "../../server/src/lib/parse/markdown.js";
import {
  normalizeProse,
  normalizeProseWithMap,
  shiftSpans,
} from "../../server/src/lib/parse/blocks.js";
import {
  canonicalizeSpans,
  spansAreSound,
  InlineTextBuilder,
  type RawMark,
} from "../../server/src/lib/parse/inline.js";

/** What `BlockCollector.add` does with a block's marks, without the collector. */
function measure(raw: string, marks: RawMark[]) {
  const { text, map } = normalizeProseWithMap(raw);
  return { text, spans: shiftSpans(marks, map, text.length) };
}

/* ───────────── the two normalisers must agree, character for character ───────────── */

test("normalizeProseWithMap produces exactly the string normalizeProse does", () => {
  // `BlockCollector` uses the mapped form only for blocks that carry emphasis,
  // and the plain form for everything else — including every call on the
  // server's selection path. If they ever disagreed, a block would have one
  // text when it was imported and a different one whenever it was checked, and
  // stored notes would start failing validation.
  const samples = [
    "",
    "   ",
    "\n",
    "a",
    "abc",
    "a  b",
    "a\tb",
    "a\t\t\tb",
    "a\nb",
    "a\n\n\nb",
    "a \n b",
    "  a  ",
    "\ta\t",
    "a b",
    "a　　b",
    "a \n　b",
    "a\r\nb",
    "a\rb",
    "a\r\n\r\nb",
    "　　",
    "第一项  加粗",
    "这一段有 粗体 与 斜体。",
    "段落一。\n\n段落二。",
    "  **never**  ",
  ];
  for (const raw of samples) {
    assert.equal(
      normalizeProseWithMap(raw).text,
      normalizeProse(raw),
      `${JSON.stringify(raw)} must normalise identically`,
    );
  }
});

/* ───────────────────────────── canonicalisation ───────────────────────────── */

test("canonicalizeSpans flattens nesting into one span per run", () => {
  // `**_x_**` is written as two marks over the same characters. The contract
  // allows exactly one representation, because two extractors that both got it
  // right would still not compare equal if one emitted nested spans and the
  // other a merged one.
  assert.deepEqual(
    canonicalizeSpans(
      [
        { start: 0, end: 3, kind: "strong" },
        { start: 0, end: 3, kind: "em" },
      ],
      3,
    ),
    [{ start: 0, end: 3, kinds: ["strong", "em"] }],
  );
});

test("canonicalizeSpans lists kinds in the contract's order regardless of nesting order", () => {
  // The checker writes `**_x_**`; the reader writes `<strong><em>`. Same run,
  // and it must serialise the same way.
  const fromMarkdownOrder = canonicalizeSpans(
    [
      { start: 0, end: 1, kind: "em" },
      { start: 0, end: 1, kind: "strong" },
    ],
    1,
  );
  assert.deepEqual(fromMarkdownOrder, [{ start: 0, end: 1, kinds: ["strong", "em"] }]);
});

test("canonicalizeSpans merges adjacent runs that describe the same thing", () => {
  // `[a](x)[b](x)` is two links to one target. Left unmerged it would be two
  // spans, which is a different array for the same document.
  assert.deepEqual(
    canonicalizeSpans(
      [
        { start: 0, end: 1, kind: "link", href: "https://x.example/" },
        { start: 1, end: 2, kind: "link", href: "https://x.example/" },
      ],
      2,
    ),
    [{ start: 0, end: 2, kinds: ["link"], href: "https://x.example/" }],
  );
});

test("canonicalizeSpans does not merge across a different kind or a different target", () => {
  assert.deepEqual(
    canonicalizeSpans(
      [
        { start: 0, end: 1, kind: "strong" },
        { start: 1, end: 2, kind: "em" },
      ],
      2,
    ),
    [
      { start: 0, end: 1, kinds: ["strong"] },
      { start: 1, end: 2, kinds: ["em"] },
    ],
  );
  assert.deepEqual(
    canonicalizeSpans(
      [
        { start: 0, end: 1, kind: "link", href: "https://a.example/" },
        { start: 1, end: 2, kind: "link", href: "https://b.example/" },
      ],
      2,
    ),
    [
      { start: 0, end: 1, kinds: ["link"], href: "https://a.example/" },
      { start: 1, end: 2, kinds: ["link"], href: "https://b.example/" },
    ],
  );
});

test("canonicalizeSpans keeps partial overlap as separate runs", () => {
  // `**a _b** c_` is not expressible in the contract's flat form, but the
  // algebra must still produce something ordered and non-overlapping rather
  // than whatever the mark list happened to contain.
  const spans = canonicalizeSpans(
    [
      { start: 0, end: 4, kind: "strong" },
      { start: 2, end: 6, kind: "em" },
    ],
    6,
  );
  assert.deepEqual(spans, [
    { start: 0, end: 2, kinds: ["strong"] },
    { start: 2, end: 4, kinds: ["strong", "em"] },
    { start: 4, end: 6, kinds: ["em"] },
  ]);
  assert.ok(spansAreSound(spans, 6));
});

test("canonicalizeSpans drops empty runs and copes with no marks", () => {
  assert.deepEqual(canonicalizeSpans([], 5), []);
  assert.deepEqual(canonicalizeSpans([{ start: 2, end: 2, kind: "strong" }], 5), []);
  assert.deepEqual(canonicalizeSpans([{ start: 0, end: 3, kind: "strong" }], 0), []);
});

/* ───────────────────────────── the offset map ───────────────────────────── */

test("a span survives whitespace collapsing onto the characters it named", () => {
  // The separator between `加粗` and `正文` is two spaces in the raw string and
  // one in the stored text. A span is measured in raw coordinates and has to
  // land on the same characters afterwards.
  const { text, spans } = measure("加粗  正文", [{ start: 0, end: 2, kind: "strong" }]);
  assert.equal(text, "加粗 正文");
  assert.deepEqual(spans, [{ start: 0, end: 2, kinds: ["strong"] }]);
  assert.equal(text.slice(0, 2), "加粗");
});

test("a span shrinks away from a collapsed run rather than swallowing it", () => {
  // The case that motivated the whole map. Normalising each emphasis run on its
  // own and concatenating gives `加粗正文` — one character short, no error, and
  // every offset after it in the block shifted.
  const raw = "加粗  正文";
  const perRun = normalizeProse(raw.slice(0, 2)) + normalizeProse(raw.slice(2));
  assert.notEqual(perRun, normalizeProse(raw), "the per-run shortcut really is wrong");

  // And the span covering the leading space of a run still lands on the text.
  const { text, spans } = measure("  加粗  正文", [{ start: 2, end: 4, kind: "strong" }]);
  assert.equal(text, "加粗 正文");
  assert.deepEqual(spans, [{ start: 0, end: 2, kinds: ["strong"] }]);
});

test("a span that covers only whitespace is dropped, not clamped to a point", () => {
  // An empty span would violate `start < end`; the contract has no way to say
  // "an emphasis on nothing".
  const { text, spans } = measure("a    b", [{ start: 1, end: 4, kind: "strong" }]);
  assert.equal(text, "a b");
  assert.deepEqual(spans, []);
});

test("a mark measured over an inserted separator keeps it outside the emphasis", () => {
  // Mirrors `<li>第一项 <strong>加粗</strong></li>`, where the extractor joins
  // its text nodes with a space it inserted itself. The space is real text, so
  // the raw string is `第一项  加粗` (two spaces) and the emphasis starts after
  // the second one — the Markdown extractor puts its separator between children
  // and must describe the same document.
  const { text, spans } = measure("第一项  加粗", [{ start: 5, end: 7, kind: "strong" }]);
  assert.equal(text, "第一项 加粗");
  assert.deepEqual(spans, [{ start: 4, end: 6, kinds: ["strong"] }]);
  assert.equal(text.slice(4, 6), "加粗");
});

test("emphasis at both ends of a block is unaffected by the trim", () => {
  const { text, spans } = measure(" 加粗 ", [{ start: 1, end: 3, kind: "strong" }]);
  assert.equal(text, "加粗");
  assert.deepEqual(spans, [{ start: 0, end: 2, kinds: ["strong"] }]);
});

/* ───────────────────────────── soundness ───────────────────────────── */

test("spansAreSound accepts what the pipeline produces and rejects what it cannot render", () => {
  assert.ok(spansAreSound([{ start: 1, end: 3, kinds: ["strong"] }], 5));
  assert.ok(spansAreSound([], 5));
  assert.ok(
    spansAreSound([{ start: 0, end: 2, kinds: ["link"], href: "https://x.example/" }], 5),
  );

  assert.ok(!spansAreSound([{ start: 0, end: 6, kinds: ["strong"] }], 5), "past the end");
  assert.ok(!spansAreSound([{ start: 3, end: 3, kinds: ["strong"] }], 5), "empty");
  assert.ok(!spansAreSound([{ start: 4, end: 2, kinds: ["strong"] }], 5), "inverted");
  assert.ok(!spansAreSound([{ start: -1, end: 2, kinds: ["strong"] }], 5), "negative");
  assert.ok(!spansAreSound([{ start: 0.5, end: 2, kinds: ["strong"] }], 5), "not an index");
  assert.ok(!spansAreSound([{ start: 0, end: 2, kinds: [] }], 5), "no kind");
  assert.ok(
    !spansAreSound([{ start: 0, end: 2, kinds: ["strong", "strong"] }], 5),
    "duplicate kind",
  );
  assert.ok(
    !spansAreSound([{ start: 0, end: 2, kinds: ["em", "strong"] }], 5),
    "out of canonical order",
  );
  assert.ok(
    !spansAreSound([{ start: 0, end: 2, kinds: ["strong"], href: "https://x.example/" }], 5),
    "href without a link",
  );
  assert.ok(!spansAreSound([{ start: 0, end: 2, kinds: ["link"] }], 5), "link without an href");
  assert.ok(
    !spansAreSound([{ start: 0, end: 2, kinds: ["link"], href: "" }], 5),
    "link to nowhere",
  );
  assert.ok(
    !spansAreSound(
      [
        { start: 2, end: 4, kinds: ["strong"] },
        { start: 3, end: 5, kinds: ["em"] },
      ],
      5,
    ),
    "overlapping",
  );
  assert.ok(
    !spansAreSound(
      [
        { start: 2, end: 4, kinds: ["strong"] },
        { start: 0, end: 2, kinds: ["em"] },
      ],
      5,
    ),
    "unordered",
  );
});

/* ───────────────────────────── the builder ───────────────────────────── */

test("the builder records nothing for an emphasis that wraps no text", () => {
  const out = new InlineTextBuilder();
  out.wrap("strong", () => {});
  assert.equal(out.text, "");
  assert.deepEqual(out.marks, []);
});

test("the builder records the run an emphasis wraps, separators included", () => {
  // The builder makes no attempt to decide what belongs inside a mark: the
  // caller appends the separator outside the `wrap` when it means it to be
  // outside. What it must never do is guess.
  const out = new InlineTextBuilder();
  out.append("第一项 ");
  out.wrap("strong", () => out.append("加粗"));
  assert.equal(out.text, "第一项 加粗");
  assert.deepEqual(out.marks, [{ start: 4, end: 6, kind: "strong" }]);
});

/* ───────────────────────────── extractor integration ───────────────────────────── */

test("every span an extractor emits is sound for the text it ships with", () => {
  // The guard in `BlockCollector.add` drops unsound spans, so a bug here would
  // show up as *missing* emphasis rather than as a broken render. Asserting
  // over a real parse catches that, where a unit test over hand-built marks
  // would not.
  const sources = [
    "# 标题 **粗** 尾\n\n一段 **粗** 与 *斜* 与 `码` 与 ~~删~~ 与 [链](https://x.example/) 与 **_双_**。\n\n- 项 **粗**\n- 项二\n",
    "**开头**强调。\n\n结尾强调**结尾**。\n\n**整段都是强调**\n",
  ];
  for (const source of sources) {
    const result = parseMarkdown(source);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    for (const block of result.document.blocks) {
      if (block.spans === undefined) continue;
      assert.ok(
        spansAreSound(block.spans, block.text.length),
        `${JSON.stringify(block.text)} has unsound spans ${JSON.stringify(block.spans)}`,
      );
      for (const span of block.spans) {
        assert.ok(block.text.slice(span.start, span.end).length > 0);
      }
    }
  }
});
