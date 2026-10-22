// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The draggable edges of the reading column.
 *
 * At 1024px and up the reader is three grid tracks: the outline rail, the
 * article, the notes rail. The two seams between them are this component —
 * one handle per seam, so the article can be widened or narrowed and the
 * rails take what is left.
 *
 * ## Where the handles sit
 *
 * Each handle is a grid item in the rail's own track, pushed half its
 * width across the boundary by a negative margin (`index.css`). That puts
 * it exactly on the seam without measuring anything, and — unlike nesting
 * it inside the rail's `<aside>` — keeps the left handle alive while the
 * outline is closed, since the track is still there even when the
 * `OutlineSidebar` that fills it has returned null.
 *
 * That is what makes a rail dismissible. A rail can be dragged past the
 * width it stops being useful at, and what is left of it is a lane the
 * width of this handle (`RAIL_LANE_PX`) with nothing drawn in it. The
 * handle has to survive that, because pulling the rail back out is the
 * only way to undo the gesture — a handle that vanished with its rail
 * would make the drag one-way.
 *
 * ## What this component does not know
 *
 * It reports *pixels the pointer has moved* and nothing else. The
 * arithmetic — what a delta means for the column width, where the clamp
 * is, what the resulting character count is — belongs to the Reader, which
 * is the only place that can see the grid, the article and the stored
 * preference together. Keeping that out of here is also what makes the
 * handle testable without a layout: it has no geometry of its own.
 */

import { useRef, useState } from "react";
import { MEASURE_RANGE } from "@/lib/reading-prefs";

export type GripSide = "left" | "right";

export function ColumnGrip({
  side,
  measure,
  collapsed,
  onDragStart,
  onDragMove,
  onDragEnd,
  onNudge,
}: {
  side: GripSide;
  /** Characters per line — reported as the separator's value, not used to draw. */
  measure: number;
  /**
   * The rail on this side has been pushed out of the way.
   *
   * Only affects how the handle is drawn: a rail that is gone leaves no
   * seam to read, so the handle is the one thing still marking where it
   * was, and `index.css` shows it at rest instead of on hover.
   */
  collapsed: boolean;
  /** The pointer went down. Capture the geometry now, before anything moves. */
  onDragStart: () => void;
  /** The pointer has moved this many pixels from where the drag began. */
  onDragMove: (dx: number) => void;
  /** The pointer came up (or the gesture was cancelled). */
  onDragEnd: () => void;
  /** Keyboard nudge, in characters. Positive widens the column. */
  onNudge: (characters: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);

  return (
    <button
      type="button"
      // A window splitter, which is what ARIA calls a separator that can be
      // moved and has a value. `aria-valuenow` is the measure, so the
      // handle announces "30" rather than "50%".
      role="separator"
      aria-orientation="vertical"
      aria-label={
        side === "left" ? "拖动调整正文左边界" : "拖动调整正文右边界"
      }
      aria-valuenow={measure}
      aria-valuemin={MEASURE_RANGE[0]}
      aria-valuemax={MEASURE_RANGE[1]}
      aria-valuetext={`每行 ${measure} 字`}
      data-testid={`column-grip-${side}`}
      data-side={side}
      data-dragging={dragging ? "" : undefined}
      data-collapsed={collapsed ? "" : undefined}
      className="gloss-column-grip"
      onPointerDown={(event) => {
        // Stops the pointer-down from starting a text selection, which
        // would otherwise drag a blue highlight across the article for the
        // whole gesture.
        event.preventDefault();
        // Capture so the drag keeps reporting to this element even when
        // the pointer outruns it — which it will, since the handle is
        // 12px wide and the gesture is hundreds.
        event.currentTarget.setPointerCapture(event.pointerId);
        startXRef.current = event.clientX;
        setDragging(true);
        onDragStart();
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        onDragMove(event.clientX - startXRef.current);
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        onDragEnd();
      }}
      // A cancelled gesture — the browser taking over, a second finger —
      // has to end the drag the same way a release does, or the handle
      // stays in its dragging state and the next move resumes a stale one.
      onPointerCancel={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        onDragEnd();
      }}
      onKeyDown={(event) => {
        // The arrow that points away from the article widens it. On the
        // left edge that is ArrowLeft; on the right edge, ArrowRight. The
        // gesture and the key therefore mean the same thing: "this edge
        // moves outward".
        const outward = side === "left" ? "ArrowLeft" : "ArrowRight";
        const inward = side === "left" ? "ArrowRight" : "ArrowLeft";
        if (event.key === outward) {
          event.preventDefault();
          onNudge(1);
        } else if (event.key === inward) {
          event.preventDefault();
          onNudge(-1);
        }
      }}
    />
  );
}
