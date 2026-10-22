// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure layout and visibility rules for the document-space note rail.
 *
 * The notes rail used to be its own scroll container: every card was
 * always expanded and stayed on screen while the reader scrolled the
 * article. The lifecycle this module supports is different — a record
 * belongs where its passage is, so its position is a document coordinate
 * and a conversation that has scrolled out of the reading area collapses
 * to a compact record.
 *
 * Keeping the two decisions here (where a record goes, whether its
 * passage has left the reading area) rather than in the renderer is what
 * makes them testable without a DOM: an off-by-one in the collision rule
 * silently paints two cards on top of each other, and a threshold that
 * is too eager collapses a conversation the reader is still looking at.
 */

/** One card's request, before collisions are resolved. */
export type NoteRailItem = {
  id: string;
  /**
   * Document-relative top of the passage the note still resolves to.
   * `null` means the note has no anchor in the current document (a stale
   * offset, a missing paragraph, an ambiguous legacy quote).
   */
  anchorTop: number | null;
  /** Measured rendered height of the card at this position. */
  height: number;
  /** Tie-breaker: note creation order (the notes array is already sorted). */
  order: number;
  /**
   * A bounded, downward-only adjustment requested for an *open* record
   * whose top edge would otherwise sit under the sticky header.
   *
   * It is applied inside the collision pass rather than after it, so an
   * adjusted card can only push later records further down — it can never
   * overlap the one above it. See `noteCardShift` for who asks for it.
   */
  shift?: number;
  /**
   * What a `shift` is relative to, when it is not the passage's own top.
   *
   * A record's position can already have been decided by an earlier pass —
   * pushed down by the record above it — and the nudge has to move it from
   * *there*. Anchoring the shift to `anchorTop` instead would make the
   * second pass recompute the same collision and silently discard the
   * nudge, which is exactly the case where a card is both pushed down and
   * still under the header.
   *
   * Only used with `shift`; `anchorTop` still drives the ordering.
   */
  nudgeFrom?: number | null;
};

export type NoteRailLayoutOptions = {
  /** Vertical space between two cards. */
  gap?: number;
  /** Top padding of the rail, and the clamp for a passage above it. */
  top?: number;
};

const finiteOr = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

/**
 * Assign every card a document-relative top, without overlaps.
 *
 * Anchored cards keep the passage's position unless an earlier card
 * already occupies it; the collision pushes the later card *down*,
 * never back up, so document order is preserved. Unanchored cards go
 * after every anchored one, stacked in creation order — a note whose
 * passage is unknown must not be placed at a guessed paragraph.
 *
 * The rule is deliberately `max(requested, cursor)` rather than
 * `cursor`: a paragraph with no note above it keeps its empty rail
 * space, which is what makes the card line up with the text.
 *
 * `shift` rides on the *request*, not on the result, so the collision pass
 * still has the last word: a record nudged down for readability pushes the
 * ones below it, and none of them can end up overlapping.
 */
export function layoutNoteRail(
  items: NoteRailItem[],
  options: NoteRailLayoutOptions = {},
): Record<string, number> {
  const gap = Math.max(0, finiteOr(options.gap ?? 12, 12));
  const top = Math.max(0, finiteOr(options.top ?? 12, 12));
  const ordered = [...items].sort((a, b) => {
    const aAnchor = a.anchorTop === null ? Number.POSITIVE_INFINITY : a.anchorTop;
    const bAnchor = b.anchorTop === null ? Number.POSITIVE_INFINITY : b.anchorTop;
    if (aAnchor !== bAnchor) return aAnchor - bAnchor;
    return a.order - b.order;
  });

  const positions: Record<string, number> = {};
  let cursor = top;
  for (const item of ordered) {
    // The top this record is asking for before collisions: its passage, or
    // the position an earlier pass already resolved for it.
    const wanted =
      item.nudgeFrom === undefined ? item.anchorTop : item.nudgeFrom;
    const requested =
      wanted === null
        ? cursor
        : Math.max(top, finiteOr(wanted, cursor) + finiteOr(item.shift ?? 0, 0));
    const at = Math.max(requested, cursor);
    positions[item.id] = at;
    cursor = at + Math.max(0, finiteOr(item.height, 0)) + gap;
  }
  return positions;
}

/**
 * Hysteresis beyond the reading area before a passage counts as "away".
 *
 * The margin is what keeps a passage that is merely touching the edge
 * from collapsing its conversation: `24px` is about one line of the
 * default 20px body text. A larger value would leave an expanded card
 * following the reader through the next paragraph; a smaller one would
 * flicker while the page settles after a scroll.
 */
export const NOTE_RAIL_EDGE_PX = 24;
/** Fallback top of the reading area when the header has not measured yet. */
export const NOTE_RAIL_HEADER_PX = 64;

export type NoteAnchorRect = { top: number; bottom: number };
export type NoteAnchorAwayOptions = {
  headerPx?: number;
  edgePx?: number;
};

/**
 * Whether a resolved passage has left the reading area.
 *
 * Both boundaries are inclusive of the hysteresis margin:
 *
 *   - above: the passage's bottom is under the sticky header plus the
 *     margin. Using `bottom` (not `top`) means a tall passage that is
 *     still partly visible keeps its conversation;
 *   - below: the passage's top is past the viewport plus the margin.
 *
 * A non-finite rect is treated as "not away" — an unmeasurable element
 * must not be the reason a draft-bearing card collapses.
 */
export function isNoteAnchorAway(
  rect: NoteAnchorRect | null | undefined,
  viewportHeight: number,
  options: NoteAnchorAwayOptions = {},
): boolean {
  if (!rect) return false;
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return false;
  const header = Math.max(
    0,
    finiteOr(options.headerPx ?? NOTE_RAIL_HEADER_PX, NOTE_RAIL_HEADER_PX),
  );
  const edge = Math.max(0, finiteOr(options.edgePx ?? NOTE_RAIL_EDGE_PX, NOTE_RAIL_EDGE_PX));
  const viewport = finiteOr(viewportHeight, 0);
  return rect.bottom < header + edge || rect.top > viewport + edge;
}

/**
 * The largest adjustment an open record's card may make to its own
 * document position.
 *
 * "Modest" has to be a number, and it is the difference between an
 * adjustment and a second, competing layout: 96px is a little over four
 * lines of the default body text, so a nudged card still reads as *being*
 * at its passage — it has not been re-anchored to the viewport. A record
 * that wants more than this is a record whose passage is on its way out,
 * and the collapse rule (§4 of the lifecycle document) is what handles it.
 */
export const NOTE_CARD_SHIFT_MAX_PX = 96;
/** Breathing room kept between a nudged card and the reading area's edge. */
export const NOTE_CARD_EDGE_GAP_PX = 8;

export type NoteCardShiftInput = {
  /**
   * The passage's viewport rect, or `null` when the note resolves to
   * nothing — an unresolved record is never nudged, because there is no
   * "on screen" to be near.
   */
  anchor: NoteAnchorRect | null | undefined;
  /** The card's document-relative top, before any adjustment. */
  documentTop: number;
  /** The stage's viewport top: what turns a document top into a viewport one. */
  stageTop: number;
  /** The card's measured height, so its box can be reasoned about as a whole. */
  height: number;
  viewportHeight: number;
  headerPx?: number;
  maxShiftPx?: number;
  edgeGapPx?: number;
};

/**
 * How far an open record's card should move to stay readable.
 *
 * The record belongs at its passage and scrolls away with it; this is the
 * one exception, and it is deliberately one-directional. When the passage
 * is still in the reading area but the card's *top* has slid up under the
 * sticky header, the first lines of the answer are behind the header —
 * unreadable, while the reader is still looking at the text they asked
 * about. The card is nudged down until its top clears the header, by at
 * most `maxShiftPx`.
 *
 * It never nudges *up*. A card whose top is below the fold has its own
 * reason for being there (a collision pushed it), and pulling it up would
 * trade a hidden bottom for a hidden top — the top being the half the
 * reader needs to start reading. It never nudges a passage that has left
 * the reading area either: that record is about to collapse, and moving it
 * on the way out is motion with no purpose.
 *
 * And it is all-or-nothing: the shortfall has to be within the bound. A
 * partial nudge — moving the card 96px when its top is 300px under the
 * header — would relocate a record without making it readable, which is
 * the worst of both. Either the card clears the header or it stays exactly
 * where its passage is.
 *
 * The result is a delta in *document* space (added to the card's top), and
 * it is fed back through `layoutNoteRail`, so it cannot create an overlap.
 */
export function noteCardShift(input: NoteCardShiftInput): number {
  const { anchor } = input;
  if (!anchor) return 0;
  const viewportHeight = finiteOr(input.viewportHeight, 0);
  const height = Math.max(0, finiteOr(input.height, 0));
  if (viewportHeight <= 0) return 0;
  // An unmeasurable position means the card's place is unknown; moving it
  // would be a guess, and a guess is how a record ends up somewhere its
  // passage is not.
  if (!Number.isFinite(input.documentTop) || !Number.isFinite(input.stageTop)) return 0;
  if (isNoteAnchorAway(anchor, viewportHeight, { headerPx: input.headerPx })) return 0;

  const maxShift = Math.max(0, finiteOr(input.maxShiftPx ?? NOTE_CARD_SHIFT_MAX_PX, 0));
  const gap = Math.max(0, finiteOr(input.edgeGapPx ?? NOTE_CARD_EDGE_GAP_PX, 0));
  const header = Math.max(
    0,
    finiteOr(input.headerPx ?? NOTE_RAIL_HEADER_PX, NOTE_RAIL_HEADER_PX),
  );
  const readingTop = header + gap;
  const readingBottom = viewportHeight - gap;

  const shortfall = readingTop - (input.stageTop + input.documentTop);
  // Clear of the header already, or too far under it for the bound to fix.
  if (shortfall <= 0 || shortfall > maxShift) return 0;
  // A card taller than the reading area cannot be made to fit by moving it,
  // and nudging it would only push more of it past the fold.
  if (height > readingBottom - readingTop) return 0;
  return shortfall;
}
