// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Keeping highlights honest across an edit.
 *
 * A highlight is `[startOffset, endOffset)` into one paragraph's text plus the
 * `selectionText` it was created from. Editing the paragraph moves every
 * character after the edit, so a stored range can silently point at a different
 * sentence. Underlining text the user never marked is worse than underlining
 * nothing: the wrong underline reads as evidence. This module therefore applies
 * the same "never guess" rule the note validator already uses:
 *
 *  - the old range still covers exactly `selectionText` → keep it;
 *  - otherwise, `selectionText` occurs exactly once in the new text → move the
 *    range there (a deterministic match, not a guess);
 *  - otherwise → mark it `detached`, so the renderer stops drawing it while the
 *    record (colour, remark, creation time) is preserved for the user.
 *
 * Notes do not go through here: `noteSlices` already validates their quote on
 * every render and returns no slices when it cannot prove them. Mutating note
 * offsets would also diverge from the server-side anchor, so a note stays as
 * written and simply stops underlining.
 */

import type { Highlight } from "../types";

export type ReconcileHighlightsResult = {
  next: Highlight[];
  changed: WrapHighlight[];
  reanchored: number;
  detached: number;
};

export type WrapHighlight = {
  id: string;
  from: { startOffset: number; endOffset: number };
  to: { startOffset: number; endOffset: number } | null;
};

function validRange(highlight: Highlight, textLength: number): boolean {
  const { startOffset, endOffset } = highlight;
  return (
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset <= textLength &&
    startOffset < endOffset
  );
}

/**
 * Reconcile every highlight on `paragraphIndex` against the edited text.
 *
 * Highlights on other paragraphs are returned untouched (same object), so the
 * caller can shallow-compare the array and skip a write when nothing moved.
 */
export function reconcileHighlights(
  highlights: readonly Highlight[],
  paragraphIndex: number,
  text: string,
): ReconcileHighlightsResult {
  const changed: WrapHighlight[] = [];
  let reanchored = 0;
  let detached = 0;

  const next = highlights.map((highlight) => {
    if (highlight.paragraphIndex !== paragraphIndex || highlight.detached) return highlight;

    const quotes = highlight.selectionText ?? "";
    const inPlace =
      validRange(highlight, text.length) &&
      text.slice(highlight.startOffset, highlight.endOffset) === quotes;
    if (inPlace) return highlight;

    if (quotes.length > 0) {
      const first = text.indexOf(quotes);
      const unique = first >= 0 && text.indexOf(quotes, first + 1) < 0;
      if (unique) {
        reanchored += 1;
        const moved: Highlight = {
          ...highlight,
          startOffset: first,
          endOffset: first + quotes.length,
        };
        changed.push({
          id: highlight.id,
          from: { startOffset: highlight.startOffset, endOffset: highlight.endOffset },
          to: { startOffset: moved.startOffset, endOffset: moved.endOffset },
        });
        return moved;
      }
    }

    detached += 1;
    const lost: Highlight = { ...highlight, detached: true };
    changed.push({
      id: highlight.id,
      from: { startOffset: highlight.startOffset, endOffset: highlight.endOffset },
      to: null,
    });
    return lost;
  });

  return { next, changed, reanchored, detached };
}

/**
 * Reconcile every highlight after a whole-document edit.
 *
 * A document edit can move a paragraph to another index, so the per-paragraph
 * helper cannot be used: first try the paragraph that now holds the old index,
 * then look for the quoted text in the rest of the document. The latter only
 * succeeds when the quote appears exactly once *in the whole document* — two
 * matches across paragraphs are as ambiguous as two inside one.
 */
export function reconcileHighlightsAcrossDocument(
  highlights: readonly Highlight[],
  paragraphs: readonly { index: number; text: string }[],
): ReconcileHighlightsResult {
  const changed: WrapHighlight[] = [];
  let reanchored = 0;
  let detached = 0;

  const next = highlights.map((highlight) => {
    if (highlight.detached) return highlight;
    const quotes = highlight.selectionText ?? "";

    const atSameIndex = paragraphs.find((p) => p.index === highlight.paragraphIndex);
    if (
      atSameIndex &&
      validRange(highlight, atSameIndex.text.length) &&
      atSameIndex.text.slice(highlight.startOffset, highlight.endOffset) === quotes
    ) {
      return highlight;
    }

    if (quotes.length > 0) {
      const hits: { index: number; start: number }[] = [];
      for (const paragraph of paragraphs) {
        const first = paragraph.text.indexOf(quotes);
        if (first < 0) continue;
        const second = paragraph.text.indexOf(quotes, first + 1);
        if (second < 0) hits.push({ index: paragraph.index, start: first });
      }
      if (hits.length === 1) {
        const hit = hits[0]!;
        reanchored += 1;
        const moved: Highlight = {
          ...highlight,
          paragraphIndex: hit.index,
          startOffset: hit.start,
          endOffset: hit.start + quotes.length,
        };
        changed.push({
          id: highlight.id,
          from: { startOffset: highlight.startOffset, endOffset: highlight.endOffset },
          to: { startOffset: moved.startOffset, endOffset: moved.endOffset },
        });
        return moved;
      }
    }

    detached += 1;
    const lost: Highlight = { ...highlight, detached: true };
    changed.push({
      id: highlight.id,
      from: { startOffset: highlight.startOffset, endOffset: highlight.endOffset },
      to: null,
    });
    return lost;
  });

  return { next, changed, reanchored, detached };
}
