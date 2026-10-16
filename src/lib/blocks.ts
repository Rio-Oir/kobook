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
export type BlockKind = "heading" | "paragraph" | "listItem" | "code" | "quote";

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
export function groupBlocks(paragraphs: Paragraph[]): BlockGroup[] {
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
export function outlineOf(paragraphs: Paragraph[]): OutlineEntry[] {
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
