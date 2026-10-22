// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The curve connecting a note's card to the passage it is about.
 *
 * A note lives in the notes rail and the text it annotates lives in the
 * article column, and on a wide screen those two are far enough apart that
 * a blue underline alone does not say *which* card it belongs to. This
 * draws the link: one quadratic curve from the end of the underlined
 * passage to the top of the card.
 *
 * ## Which note, when
 *
 * The Reader decides — it passes the note the reader is *pointing at*
 * (hover or keyboard focus) and falls back to the active one. The
 * connector deliberately has no opinion: it draws whatever it is handed,
 * or nothing. That is what keeps the line attached to the card under the
 * pointer instead of to whichever record was clicked last.
 *
 * ## Viewport coordinates, and why the `<svg>` is portalled to `<body>`
 *
 * `getBoundingClientRect()` is viewport space for both ends, so the path
 * needs no conversion — but only while the `<svg>`'s own user space starts
 * at the viewport's top-left. `position: fixed` gives that, *except* when
 * an ancestor establishes a containing block (a transform, a filter,
 * `contain: paint`, `will-change`). Nested inside the reading grid, one
 * such ancestor anywhere above would silently turn the svg into a
 * document-positioned box while the path kept using viewport numbers, and
 * the whole curve would be painted off by the scroll offset. Rendering it
 * into `document.body` removes the question: there is no ancestor left to
 * disagree with.
 *
 * ## When nothing is drawn
 *
 * The curve is hidden rather than approximated unless *both* ends are
 * genuinely visible:
 *
 *   - below the `lg` breakpoint the notes rail is `hidden`, so there is no
 *     card to point at;
 *   - a card inside a `display: none` subtree has a rect of all zeros, and
 *     a card in a rail that has been pushed out of the way is
 *     `visibility: hidden` but keeps a perfectly valid rect — so the rect
 *     is checked *and* the computed `visibility` is;
 *   - a passage whose lines have all scrolled under the sticky header, or
 *     past the bottom of the viewport, has no visible line box;
 *   - the card's own top edge has to be in the reading area, or the curve
 *     would end under the header where the card is not.
 *
 * A line to a point the reader cannot see is worse than no line: it claims
 * a connection whose other end is invisible, which is exactly the "floating
 * disconnected line" this component must not produce.
 *
 * ## Why the geometry is re-read every frame
 *
 * Scroll and resize cover the obvious movements, and a `ResizeObserver`
 * covers a card's answer growing. Neither covers a card that moves because
 * *something else* moved without changing any observed size: the sticky
 * header getting taller, a webfont landing and reflowing the article, the
 * article's own content above the passage changing height. Any of those
 * shifts both ends of the curve by the same amount and fires nothing this
 * component could listen for — which is how a curve ends up drawn a few
 * hundred pixels above the card it belongs to.
 *
 * So while a note is targeted, the endpoints are re-read once per animation
 * frame and the path is only written when it actually changed. The endpoint
 * *elements* are cached by note id and re-resolved only when the cache is
 * stale, so the per-frame cost is two `getBoundingClientRect()` calls and
 * two computed-style reads — not a `querySelectorAll` over the article.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { noteColorSolid } from "../lib/note-color";
import type { HighlightColor } from "../lib/types";

/** Kept between the curve's endpoints and the edges of the reading area. */
const EDGE_PX = 12;
/** Fallback reading-area top when the header has not been measured yet. */
const HEADER_FALLBACK_PX = 60;
/** How far below the card's top edge the curve arrives. */
const TARGET_INSET_PX = 24;
/** How far inside the article column's right edge the curve starts. */
const SOURCE_INSET_PX = 18;

type Geometry = { x: number; y: number; targetX: number; targetY: number };

/**
 * Where the curve should leave a passage: the bottom of the last line box
 * that is inside the reading area, or `null` when no line of it is.
 *
 * `getBoundingClientRect()` on an inline element is the *union* of its line
 * boxes, so a quote whose first lines have scrolled under the sticky header
 * still reports a top far above the viewport — the union cannot tell
 * "partly visible" from "gone". `getClientRects()` can, one line at a time.
 *
 * The returned value is always *inside* the area. A line that runs past the
 * bottom edge is still visible, so it is kept — but its bottom is clamped,
 * because a curve starting at a y the reader cannot see is the same defect
 * as a curve pointing at a card they cannot see.
 */
function sourceLineBottom(
  element: HTMLElement,
  top: number,
  bottom: number,
): number | null {
  let visible: number | null = null;
  let onScreenEnd: number | null = null;
  for (const rect of Array.from(element.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom <= top || rect.top >= bottom) continue;
    visible = rect.bottom;
    if (rect.bottom <= bottom) onScreenEnd = rect.bottom;
  }
  if (onScreenEnd !== null) return onScreenEnd;
  return visible === null ? null : Math.min(visible, bottom);
}

export default function NoteConnection({
  root,
  noteId,
  revision,
  headerPx,
  color,
}: {
  /** The element containing both the article column and the notes rail. */
  root: RefObject<HTMLDivElement | null>;
  /** The note to connect, or `null` for "draw nothing". */
  noteId: string | null;
  /**
   * A value that changes whenever a rail card moves without either end
   * resizing or the page scrolling.
   *
   * The rail is in document space, so collapsing a card *above* the
   * targeted one moves it down without a scroll, a resize or a change to
   * the card's own size — none of the events below fire. The Reader passes
   * the computed positions, and this value is what re-resolves the cached
   * endpoints in that case.
   */
  revision?: string | number;
  /** Measured height of the sticky header: the reading area's top edge. */
  headerPx?: number;
  /**
   * The note's own colour. The curve is the third thing that says "this
   * card is about that passage", so it wears the same colour as the
   * underline it starts from and the card border it arrives at. Absent
   * falls back to the blue every note wore before notes carried one.
   */
  color?: HighlightColor;
}) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const sourcesRef = useRef<HTMLElement[]>([]);
  const cardRef = useRef<HTMLElement | null>(null);

  // The cached endpoints belong to one note and one rail layout; a new
  // target or a re-laid-out rail invalidates them.
  useLayoutEffect(() => {
    sourcesRef.current = [];
    cardRef.current = null;
  }, [noteId, revision]);

  useEffect(() => {
    if (!noteId) {
      setGeometry(null);
      return;
    }
    let frame = 0;
    let disposed = false;
    /**
     * The last key actually written to state.
     *
     * `null`, not `""`, and that is load-bearing: `""` is also the key for
     * "nothing to draw", so a target that starts off screen would compare
     * equal to the initial value, skip the state write, and leave the
     * *previous* target's path on screen. That is a curve pointing at a
     * card the reader is no longer asking about — the exact failure this
     * component exists to prevent.
     */
    let last: string | null = null;

    const resolveSources = (container: HTMLElement): HTMLElement[] => {
      const cached = sourcesRef.current;
      // Cheap re-validation: the id can move to another slice of the same
      // quote when the reader hovers a different note over the same words,
      // and a re-import replaces the elements outright.
      if (
        cached.length > 0 &&
        cached.every((el) => el.isConnected && el.dataset.noteAnchor === noteId)
      ) {
        return cached;
      }
      const found = Array.from(
        container.querySelectorAll<HTMLElement>("[data-note-anchor]"),
      ).filter((el) => el.dataset.noteAnchor === noteId);
      sourcesRef.current = found;
      return found;
    };

    const resolveCard = (container: HTMLElement): HTMLElement | null => {
      const cached = cardRef.current;
      if (cached?.isConnected) return cached;
      const found =
        Array.from(
          container.querySelectorAll<HTMLElement>("[data-note-id]"),
        ).find((el) => el.dataset.noteId === noteId) ?? null;
      cardRef.current = found;
      return found;
    };

    const measure = (): Geometry | null => {
      const container = root.current;
      if (!container) return null;
      if (window.innerWidth < 1024) return null;
      const readingTop =
        Math.max(0, headerPx && headerPx > 0 ? headerPx : HEADER_FALLBACK_PX) + EDGE_PX;
      const readingBottom = window.innerHeight - EDGE_PX;
      if (readingBottom <= readingTop) return null;

      const card = resolveCard(container);
      if (!card) return null;
      // `getClientRects()` is empty in a `display: none` subtree; a card in
      // a rail that has been pushed out of the way keeps its rect but is
      // `visibility: hidden`, and would otherwise read as perfectly visible.
      if (!card.getClientRects().length) return null;
      if (getComputedStyle(card).visibility === "hidden") return null;

      // A note may underline more than one slice (a selection that crossed
      // a paragraph boundary), and the first slice can be off screen while
      // a later one is not — so the first slice *with a visible line box*
      // wins, rather than the first slice outright.
      let source: HTMLElement | null = null;
      let lineBottom: number | null = null;
      let main: DOMRect | undefined;
      for (const candidate of resolveSources(container)) {
        if (getComputedStyle(candidate).visibility === "hidden") continue;
        const bottom = sourceLineBottom(candidate, readingTop, readingBottom);
        if (bottom === null) continue;
        const rect = candidate.closest("main")?.getBoundingClientRect();
        if (!rect) continue;
        source = candidate;
        lineBottom = bottom;
        main = rect;
        break;
      }
      if (!source || lineBottom === null || !main) return null;

      const b = card.getBoundingClientRect();
      const targetY = b.top + TARGET_INSET_PX;
      if (targetY < readingTop || targetY > readingBottom) return null;
      if (b.left < main.right) return null;

      return {
        x: main.right - SOURCE_INSET_PX,
        // The last line of the passage the reader can see: the end of the
        // underline, and never a point above the header.
        y: lineBottom - 2,
        targetX: b.left,
        targetY,
      };
    };

    const tick = () => {
      if (disposed) return;
      frame = requestAnimationFrame(tick);
      const next = measure();
      // Quantised so sub-pixel jitter in `getBoundingClientRect` cannot turn
      // this into a render loop; the stored geometry keeps full precision.
      const key = next
        ? [next.x, next.y, next.targetX, next.targetY]
            .map((n) => Math.round(n * 2) / 2)
            .join("|")
        : "";
      if (key === last) return;
      last = key;
      setGeometry(next);
    };
    tick();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [root, noteId, revision, headerPx]);

  const path = geometry
    ? `M ${geometry.x} ${geometry.y} C ${geometry.x + 24} ${geometry.y}, ` +
      `${geometry.targetX - 24} ${geometry.targetY}, ${geometry.targetX} ${geometry.targetY}`
    : "";

  if (typeof document === "undefined") return null;
  return createPortal(
    <svg
      aria-hidden="true"
      className="fixed inset-0 w-full h-full pointer-events-none z-10"
      style={{ color: noteColorSolid(color) }}
    >
      {geometry && (
        <>
          <circle cx={geometry.x} cy={geometry.y} r="2.5" fill="currentColor" />
          <path
            data-testid="note-connection"
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </>
      )}
    </svg>,
    document.body,
  );
}
