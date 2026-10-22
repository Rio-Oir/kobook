// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Block-level structure of an article.
 *
 * The parse layer already classifies every block (`type`), and for
 * headings it records the depth (`level`), for code the fence language
 * (`lang`), for list items whether the list is ordered (`ordered`).
 * The `paragraph` table stores all four. What was missing is the last
 * mile: the Reader rendered one `<p>` per block regardless of `type`,
 * so a Markdown document that the server understood perfectly arrived
 * on screen as an undifferentiated stack of paragraphs.
 *
 * Everything here is pure and React-free on purpose. The rules that
 * decide *which element* a block becomes and *which heading depth*
 * maps to which tag are exactly the rules that must agree between the
 * renderer and its regression test, and this repo's test convention is
 * pure functions plus jsdom rather than rendering components
 * (see `tests/unit/text-offset.test.ts`).
 *
 * ## The constraint all of this has to respect
 *
 * `lib/text-offset.ts` measures a selection by asking the browser for
 * `Range.toString().length` — so **a block's rendered text must equal
 * `paragraph.text` character for character**. Consequences that are
 * easy to get wrong:
 *
 *   - No `::before { content: … }` anywhere inside a block: Chromium
 *     *does* include generated content in `Range.toString()`. That
 *     rules out CSS-drawn list bullets, quote marks, heading anchors
 *     and code-language badges. `list-style` / `::marker` are fine
 *     because they are not DOM text.
 *   - The paragraph-number `<span data-paragraph-marker>` must stay a
 *     real element inside the block, because it is what
 *     `rangeToOffsets` subtracts back out.
 *   - Code blocks carry the marker *outside* the `<pre>`: inside it,
 *     `white-space: pre` turns the whitespace around the marker into
 *     real characters and every offset in the block shifts.
 *
 * `tests/unit/blocks.test.ts` builds the exact DOM this module
 * describes and asserts the round trip, so a future stylistic flourish
 * that adds a character fails a test instead of silently corrupting
 * every stored highlight.
 */

import type { Paragraph } from "./types";

/** The block kinds the parse layer emits. */
export type BlockKind =
  | "heading"
  | "paragraph"
  | "listItem"
  | "code"
  | "quote"
  | "image"
  | "table"
  | "hr";

/**
 * The kind to render a paragraph as.
 *
 * Missing `type` means the paragraph predates the parse layer (a
 * legacy localStorage article, or one of the many test fixtures that
 * supply only `{index, text, hash}`), and the honest reading of those
 * is "plain prose" rather than an error.
 */
export function blockKindOf(paragraph: Pick<Paragraph, "type">): BlockKind {
  return paragraph.type ?? "paragraph";
}

/**
 * The tag a heading of this depth renders as.
 *
 * **Markdown `#` becomes `<h2>`, not `<h1>`.** The Reader already puts
 * the article title in an `<h1>` (`Reader.tsx`, in the title block just
 * above `.gloss-prose`), so mapping a document's top-level heading to
 * `<h1>` would put two `<h1>`s on the page and make the document
 * outline ambiguous for screen readers. Shifting the whole scale down
 * one keeps `#` visually and semantically the top level *of the
 * article body* while leaving the title as the page's single `<h1>`.
 *
 * Depth is clamped to 1..5 because there is no `<h7>`: this repo's
 * parser is 1..6, and an out-of-range value from a hand-edited blob
 * should land on a real tag rather than `undefined`.
 */
export function headingTag(level: number | undefined): `h${2 | 3 | 4 | 5 | 6}` {
  const depth = Math.min(5, Math.max(1, Math.floor(level ?? 1)));
  return `h${depth + 1}` as `h${2 | 3 | 4 | 5 | 6}`;
}

/**
 * How wide a title is, in the units the size steps below are counted in.
 *
 * A Chinese character occupies a full em; a Latin letter, digit or
 * half-width punctuation occupies roughly half of one. Counting raw
 * characters would therefore read a 20-character Chinese title as
 * "short" — the same number that describes a 20-character English
 * title, which is a whole sentence — and give it the largest step.
 * Counting in ems puts the two scripts on one scale, so the thresholds
 * are the same numbers a Latin-only reader would have chosen.
 *
 * This approximates Unicode's East Asian Width property rather than
 * implementing it: it covers the blocks an article title actually uses
 * (Han, kana, Hangul, CJK punctuation, full-width forms) and treats
 * everything else as half-width. An emoji or a rare script is therefore
 * counted as narrow, which can put a title one step larger than it
 * deserves — a wrong step, not a broken layout.
 */
function titleWidth(title: string): number {
  let units = 0;
  for (const char of title) {
    units += isFullWidth(char.codePointAt(0)!) ? 2 : 1;
  }
  return units;
}

/** East Asian Wide / Fullwidth, near enough for measuring a title. */
function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303f) || // CJK radicals, Kangxi, CJK punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana, Bopomofo, enclosed and compat CJK
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth signs
    (code >= 0x20000 && code <= 0x3fffd) //  CJK Extension B and beyond
  );
}

/**
 * The display size of the article title, as a function of its length.
 *
 * A fixed `text-5xl` is a size chosen for the shortest title that will
 * ever use it. The reader imports titles of every length, and a Chinese
 * title runs long by nature — 30 characters is an ordinary headline, not
 * an outlier — so at a fixed size a long one wraps to four lines and
 * takes the whole first screen before the article has started. Stepping
 * the size down as the title grows keeps a long title from towering
 * while leaving a short one exactly as large as it is today.
 *
 * The largest step is the current desktop size (`text-5xl`, 3rem) and
 * the smallest is 1.5rem, so this only ever moves a title *down* from
 * where it sits now. Each step is a `clamp()` so the size still tracks
 * the viewport between the phone and desktop ends.
 *
 * The returned string is size and leading only. `text-balance` is set on
 * the element itself, because balancing line lengths is a property of
 * the heading and not part of "how big is this title".
 */
export function titleSizeClass(title: string): string {
  const width = titleWidth(title);
  if (width <= 26) return "text-[clamp(2.25rem,4vw,3rem)] leading-[1.15]";
  if (width <= 50) return "text-[clamp(2rem,3.4vw,2.6rem)] leading-[1.2]";
  if (width <= 90) return "text-[clamp(1.75rem,3vw,2.2rem)] leading-[1.25]";
  return "text-[clamp(1.5rem,2.6vw,1.9rem)] leading-[1.3]";
}

/**
 * One unit of rendering: either a standalone block, or a run of
 * consecutive list items that must share a single `<ul>`/`<ol>`.
 *
 * Grouping matters because the store is a flat array — one record per
 * list item (the parse layer emits each item as its own block so a note
 * can anchor to the individual item). Emitting a `<ul>` per item would
 * restart the numbering on every line of an ordered list and put a
 * separate bullet block around each entry.
 *
 * The run breaks when `ordered` changes. It does **not** model nesting:
 * the parse layer flattens nested lists into sibling items, so a nested
 * list is not representable and this deliberately does not pretend
 * otherwise.
 */
export type BlockGroup =
  | { kind: "block"; paragraph: Paragraph }
  | { kind: "list"; ordered: boolean; items: Paragraph[] };

/** Split a flat paragraph list into renderable groups. */
export function groupBlocks(paragraphs: readonly Paragraph[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  for (const paragraph of paragraphs) {
    if (blockKindOf(paragraph) !== "listItem") {
      groups.push({ kind: "block", paragraph });
      continue;
    }
    const ordered = paragraph.ordered === true;
    const open = groups[groups.length - 1];
    if (open?.kind === "list" && open.ordered === ordered) {
      open.items.push(paragraph);
    } else {
      groups.push({ kind: "list", ordered, items: [paragraph] });
    }
  }
  return groups;
}

/**
 * One entry in the article outline.
 *
 * `index` is the heading's own paragraph index — the jump target, and
 * the same coordinate `notes.paragraphIndex` uses. `untilIndex` is the
 * index of the last block the heading covers (the block before the
 * next heading), or `null` when it runs to the end of the article.
 *
 * Section membership is expressed as an index *range* rather than a
 * list of members so it stays O(1) to test and does not care whether
 * the indices happen to be dense. Because the range is defined by
 * reading order, any index that falls between two headings belongs to
 * the earlier one — which is the right answer even if a document had a
 * gap in its numbering.
 */
export type OutlineEntry = {
  index: number;
  level: number;
  text: string;
  untilIndex: number | null;
};

/**
 * The headings of an article, in reading order.
 *
 * Returns an empty array for a document with no headings — the reader
 * shows an explicit "this article has no subheadings" state rather than
 * an empty panel, which is the honest presentation of a genuinely flat
 * document.
 */
export function outlineOf(paragraphs: readonly Paragraph[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]!;
    if (blockKindOf(paragraph) !== "heading") continue;
    // Close the previous section at the block just before this one.
    const previous = entries[entries.length - 1];
    if (previous) previous.untilIndex = paragraphs[i - 1]?.index ?? previous.index;
    entries.push({
      index: paragraph.index,
      level: Math.min(5, Math.max(1, Math.floor(paragraph.level ?? 1))),
      text: paragraph.text,
      untilIndex: null,
    });
  }
  return entries;
}
