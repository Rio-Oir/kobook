// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Text-offset helpers for article highlighting.
 *
 * The whole highlighting feature rests on one property of this app's
 * reader: **a paragraph is a single line of normalised plain text**.
 * `Reader.tsx` renders `{p.text}` verbatim, and for a signed-in user
 * that string came from the server's `normalizeProse` pass
 * (`server/src/lib/parse/blocks.ts`), which collapses CRLF, runs of
 * whitespace and newlines. So a browser `Range` offset inside that
 * paragraph, a JS `String.prototype.slice` index, and the server's
 * stored `paragraph.text` index are all the same coordinate system
 * (UTF-16 code units). That is what makes storing plain integer
 * offsets viable here instead of the heavier quote-based anchoring a
 * general web annotator needs.
 *
 * Three pure functions, all unit-tested:
 *
 *   - `rangeToOffsets` turns a DOM `Range` inside a paragraph element
 *     into `[start, end)` indices into that paragraph's text. It
 *     measures how much text precedes each boundary and subtracts the
 *     paragraph-number marker, so it keeps working after highlighting
 *     has split the paragraph into several text nodes *and* when a
 *     boundary lands on the `<p>` element itself.
 *
 *   - `segmentBlock` does the inverse for rendering: given the block
 *     text, the highlights covering it and the inline emphasis found in
 *     the source, it returns the text split at every boundary of either
 *     kind, each slice carrying the ids of the marks covering it and the
 *     emphasis that applies. React then maps that to `<strong>` /
 *     `<mark>` / plain text. This is deliberately a pure
 *     `string -> segments` transform rather than a DOM mutation, because
 *     mutating the DOM React owns (`Range.surroundContents`) gets wiped
 *     on the next render.
 *
 *   - `segmentParagraph` is `segmentBlock` without emphasis, kept for the
 *     highlight-only callers and tests.
 *
 * Mark direction: the paragraph-number marker is skipped by
 * attribute, not by position, so reordering the marker or adding
 * another decorative node does not silently shift every offset.
 */

import {
  INLINE_MARK_ORDER,
  type InlineMarkKind,
  type InlineSpan,
} from "../../shared/contracts/index";

/** A highlight as far as the renderer is concerned. */
export interface HighlightMark {
  id: string;
  /** Inclusive start index into the paragraph text. */
  start: number;
  /** Exclusive end index into the paragraph text. */
  end: number;
}

/** One slice of a paragraph, with the ids of the marks covering it. */
export interface Segment {
  text: string;
  /** Marks covering this slice, outermost first. Empty for plain text. */
  marks: string[];
}

/**
 * One slice of a block, ready to render: what text, which highlights cover
 * it, and how the source emphasised that text.
 *
 * A block's text is cut at every boundary of either kind, so one pass produces
 * both the highlight structure and the inline emphasis. Two independent passes
 * would have to agree about where the cuts are, and any disagreement would
 * slide the highlight one character off the emphasis it was drawn on.
 */
export interface BlockSlice {
  text: string;
  /** Highlight ids covering this slice, outermost first. Empty for plain text. */
  markIds: string[];
  /** Inline emphasis covering this slice, in canonical order. */
  kinds: InlineMarkKind[];
  /** Link target, present only when `kinds` includes `"link"`. */
  href?: string;
}

/**
 * The attribute the paragraph-number `<span>` carries so
 * `rangeToOffsets` can skip it. Exported so `Reader.tsx` and the
 * test file agree on the spelling.
 */
export const PARAGRAPH_MARKER_ATTR = "data-paragraph-marker";

/**
 * How many characters of `paragraphEl`'s flattened text precede the
 * boundary `(node, offset)`, or `null` when that boundary is not a
 * position inside `paragraphEl`.
 *
 * Measured by asking the browser: build `[paragraphStart, boundary)`
 * as a `Range` and read `toString()`. That replaces the hand-rolled
 * text-node walk this function used to do, because a boundary is not
 * always on a text node. **A range boundary may sit on an element**,
 * and real drags produce exactly that: press in a paragraph's left
 * padding (the reader gives every `<p>` `padding-left: 2rem`),
 * release below its last line, or drag from just outside the first
 * glyph, and the browser anchors the boundary to the `<p>` itself at
 * child offset `0` or `childNodes.length`. The old walker only knew
 * how to add up text nodes, saw no match, and returned `null` — which
 * the toolbar renders as four greyed-out swatches. Selecting a whole
 * paragraph, the single most common gesture, could not be marked at
 * all.
 *
 * Grading the boundary through `Range` also means nested markup
 * (`<mark>`, `<span>`) needs no special handling: whatever the
 * renderer wrapped the text in, the browser reports the same
 * character count.
 */
function textLengthBefore(
  paragraphEl: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  // `contains` is true for the element itself, which is a boundary
  // the caller does pass in (`setStart(p, 0)`).
  if (!paragraphEl.contains(node)) return null;

  const range = paragraphEl.ownerDocument.createRange();
  try {
    range.setStart(paragraphEl, 0);
    range.setEnd(node, offset);
  } catch {
    // `setEnd` throws IndexSizeError for an offset past the end of a
    // text node or past the last child of an element. That is a
    // boundary the DOM itself rejects, so there is no honest offset
    // to report.
    return null;
  }
  return range.toString().length;
}

/**
 * The text offset of a single range boundary inside `paragraphEl`,
 * excluding the paragraph-number marker, or `null` when that boundary
 * is not a position inside `paragraphEl`.
 *
 * A cross-paragraph selection has its two boundaries in two different
 * `<p>` elements, so `rangeToOffsets` — which needs both boundaries in
 * one element — cannot express it. The Reader uses this per-boundary
 * form to anchor each end separately, which is what lets the server
 * validate a range that spans blocks.
 */
export function boundaryOffset(
  paragraphEl: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  const raw = textLengthBefore(paragraphEl, node, offset);
  if (raw === null) return null;

  const marker = paragraphEl.querySelector(`[${PARAGRAPH_MARKER_ATTR}]`);
  const markerCharCount = marker ? (marker.textContent ?? "").length : 0;
  const markerStart = marker
    ? (textLengthBefore(paragraphEl, marker, 0) ?? 0)
    : 0;
  const markerEnd = markerStart + markerCharCount;

  if (raw <= markerStart) return raw;
  if (raw < markerEnd) return markerStart;
  return raw - markerCharCount;
}

/**
 * Compute `[start, end)` offsets of `range` within `paragraphEl`,
 * measured over the paragraph's text *excluding* the
 * paragraph-number marker.
 *
 * Returns `null` when either boundary is outside this paragraph.
 * Callers treat that as "no usable selection" — the same outcome the
 * current selection handler already produces for a selection that
 * leaves the paragraph.
 *
 * Offsets are half-open: a caret at index 3 gives `start === end === 3`,
 * which callers reject as empty.
 */
export function rangeToOffsets(
  paragraphEl: HTMLElement,
  range: Range,
): { start: number; end: number } | null {
  const rawStart = boundaryOffset(paragraphEl, range.startContainer, range.startOffset);
  const rawEnd = boundaryOffset(paragraphEl, range.endContainer, range.endOffset);
  if (rawStart === null || rawEnd === null) return null;
  // No backwards-drag handling is needed: the DOM spec collapses a
  // Range whose end is set before its start, so `end < start` can
  // only come from the marker clamp.
  if (rawEnd < rawStart) return null;
  return { start: rawStart, end: rawEnd };
}

/**
 * Split `text` at every highlight boundary and every emphasis boundary, and
 * report what covers each slice.
 *
 * Both kinds are clamped to the text and dropped when they end up empty or
 * inverted, so a stale or hostile offset can never produce a negative
 * `slice` index. This is the only place spans are sanitised — the contract
 * forbids overlapping spans and the server re-checks them on the way out, but
 * a local-storage blob written by an older build is not covered by either, and
 * this is the function that would turn such a value into a broken render.
 *
 * Overlapping highlights are supported: a slice lists every highlight
 * covering it, sorted outermost-first, and the renderer paints the last entry
 * (the innermost) so nested highlights read as "inner wins". Emphasis has no
 * such ambiguity — the contract keeps spans non-overlapping — but the union is
 * taken anyway, for the same reason the clamping is here.
 *
 * Returns a single plain slice when there is nothing to draw, and an empty
 * array for empty text — callers render nothing in that case.
 */
export function segmentBlock(
  text: string,
  marks: HighlightMark[],
  spans: readonly InlineSpan[] = [],
): BlockSlice[] {
  if (text.length === 0) return [];

  const clamp = (value: number): number =>
    Math.max(0, Math.min(text.length, value));

  const validMarks = marks
    .map((mark) => ({
      id: mark.id,
      start: clamp(mark.start),
      end: clamp(mark.end),
    }))
    .filter((mark) => mark.end > mark.start);

  const validSpans = spans
    .map((span) => ({
      start: clamp(span.start),
      end: clamp(span.end),
      kinds: INLINE_MARK_ORDER.filter((kind) => span.kinds.includes(kind)),
      href: span.href,
    }))
    .filter((span) => span.end > span.start && span.kinds.length > 0);

  if (validMarks.length === 0 && validSpans.length === 0) {
    return [{ text, markIds: [], kinds: [] }];
  }

  const boundaries = new Set<number>([0, text.length]);
  for (const mark of validMarks) {
    boundaries.add(mark.start);
    boundaries.add(mark.end);
  }
  for (const span of validSpans) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  const sorted = Array.from(boundaries).sort((a, b) => a - b);

  const slices: BlockSlice[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i]!;
    const to = sorted[i + 1]!;
    if (to <= from) continue;

    // Outermost first: earlier start wins, then the longer span. The
    // renderer paints the last entry, i.e. the innermost mark.
    const markIds = validMarks
      .filter((mark) => mark.start <= from && mark.end >= to)
      .sort((a, b) => a.start - b.start || b.end - a.end)
      .map((mark) => mark.id);

    const covering = validSpans.filter((span) => span.start <= from && span.end >= to);
    const kinds = INLINE_MARK_ORDER.filter((kind) =>
      covering.some((span) => span.kinds.includes(kind)),
    );
    const href = covering.find((span) => span.href !== undefined)?.href;

    slices.push(
      href === undefined
        ? { text: text.slice(from, to), markIds, kinds }
        : { text: text.slice(from, to), markIds, kinds, href },
    );
  }
  return slices;
}

/**
 * Split `text` at every mark boundary and report which marks cover each
 * slice — `segmentBlock` restricted to highlights.
 */
export function segmentParagraph(text: string, marks: HighlightMark[]): Segment[] {
  return segmentBlock(text, marks).map((slice) => ({
    text: slice.text,
    marks: slice.markIds,
  }));
}
