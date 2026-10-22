// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Note-rail lifecycle rules.
 *
 * Two failures are invisible on screen: two cards painted on top of each
 * other, and a conversation that collapses while the reader is still
 * looking at its passage. Both are decided by pure functions, so both
 * are pinned here rather than only in the browser gate.
 *
 * The third is the bounded nudge an *open* record may make: it is the one
 * place where a card's top is not exactly its passage's top, so the two
 * ways it can go wrong — nudging too far, or nudging into the card above
 * it — are pinned here too.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTE_CARD_EDGE_GAP_PX,
  NOTE_CARD_SHIFT_MAX_PX,
  NOTE_RAIL_EDGE_PX,
  NOTE_RAIL_HEADER_PX,
  isNoteAnchorAway,
  layoutNoteRail,
  noteCardShift,
} from "../../src/lib/note-rail.js";

const item = (
  id: string,
  anchorTop: number | null,
  height: number,
  order = 0,
) => ({ id, anchorTop, height, order });

test("a card sits at its passage, and an empty rail above it stays empty", () => {
  const positions = layoutNoteRail([item("a", 420, 80, 0)], { gap: 12, top: 12 });
  assert.equal(positions.a, 420);
});

test("cards that would collide are pushed down in document order, never up", () => {
  const positions = layoutNoteRail(
    [
      item("second", 400, 60, 1),
      item("first", 400, 100, 0),
    ],
    { gap: 12, top: 12 },
  );
  // Creation order breaks the tie: "first" is above, "second" follows it.
  assert.equal(positions.first, 400);
  assert.equal(positions.second, 400 + 100 + 12);
});

test("a measured expanded card pushes the next compact record clear of it", () => {
  const positions = layoutNoteRail(
    [item("tall", 200, 480, 0), item("next", 260, 50, 1)],
    { gap: 16, top: 12 },
  );
  assert.equal(positions.tall, 200);
  assert.equal(positions.next, 200 + 480 + 16);
  assert.ok(positions.next >= 200 + 480, "the second card must not overlap the first");
});

test("unanchored records go after every anchored one, in creation order", () => {
  const positions = layoutNoteRail(
    [
      item("unresolved-second", null, 40, 3),
      item("anchored", 100, 50, 1),
      item("unresolved-first", null, 40, 2),
      item("anchored-low", 500, 50, 0),
    ],
    { gap: 10, top: 12 },
  );
  assert.equal(positions.anchored, 100);
  assert.equal(positions["anchored-low"], 500);
  // Creation order decides among the unanchored: order 2 first, order 3 after.
  assert.equal(positions["unresolved-first"], 500 + 50 + 10);
  assert.equal(positions["unresolved-second"], 500 + 50 + 10 + 40 + 10);
});

test("passages above the rail are clamped to the top padding", () => {
  const positions = layoutNoteRail([item("a", -120, 50, 0)], { top: 12 });
  assert.equal(positions.a, 12);
});

test("unknown or absurd measurements fall back instead of producing NaN", () => {
  const positions = layoutNoteRail(
    [
      { id: "nan", anchorTop: Number.NaN, height: Number.NaN, order: 0 },
      item("ok", 100, 50, 1),
    ],
    { gap: Number.NaN, top: Number.NaN },
  );
  assert.equal(positions.ok, 100);
  assert.equal(Number.isFinite(positions.nan), true);
});

test("a passage is away only after it clears the header and viewport by the margin", () => {
  const viewport = 900;
  const header = 60;
  // Fully above the reading area, including the margin.
  assert.equal(
    isNoteAnchorAway({ top: -100, bottom: 60 + NOTE_RAIL_EDGE_PX - 1 }, viewport, {
      headerPx: header,
    }),
    true,
  );
  // Touching the header margin but not past it: still on screen.
  assert.equal(
    isNoteAnchorAway({ top: 0, bottom: 60 + NOTE_RAIL_EDGE_PX + 1 }, viewport, {
      headerPx: header,
    }),
    false,
  );
  // Below the viewport, past the margin.
  assert.equal(
    isNoteAnchorAway({ top: viewport + NOTE_RAIL_EDGE_PX + 1, bottom: 1000 }, viewport, {
      headerPx: header,
    }),
    true,
  );
  // At the bottom edge + margin: still considered on screen (hysteresis).
  assert.equal(
    isNoteAnchorAway({ top: viewport + NOTE_RAIL_EDGE_PX - 1, bottom: 1000 }, viewport, {
      headerPx: header,
    }),
    false,
  );
});

test("an unmeasurable anchor is never the reason to collapse", () => {
  assert.equal(isNoteAnchorAway(null, 900), false);
  assert.equal(
    isNoteAnchorAway({ top: Number.NaN, bottom: Number.NaN }, 900),
    false,
  );
});

// ── The bounded nudge for an open record ──────────────────────────────

/** A 600px-tall reading area under a 60px header, with the stage at the top. */
const shiftInput = (
  overrides: Partial<Parameters<typeof noteCardShift>[0]> = {},
) => ({
  anchor: { top: 40, bottom: 300 },
  documentTop: 40,
  stageTop: 0,
  height: 120,
  viewportHeight: 600,
  headerPx: 60,
  ...overrides,
});

test("a card whose top is clear of the header is not nudged at all", () => {
  // Reading area starts at 60 + 8 = 68; the card's top is at 80.
  assert.equal(noteCardShift(shiftInput({ documentTop: 80 })), 0);
});

test("a card whose top is under the header is nudged just clear of it", () => {
  // Top at 40, reading top at 68: eight pixels short of the gap.
  assert.equal(
    noteCardShift(shiftInput({ documentTop: 40 })),
    68 - 40,
  );
});

test("a shortfall the bound cannot fix is left alone rather than half-fixed", () => {
  // Top at -400: 468px under the reading top, far more than the 96px
  // bound. A 96px move would relocate the record without making it
  // readable, so nothing moves and the record stays at its passage.
  assert.equal(
    noteCardShift(shiftInput({ documentTop: -400, anchor: { top: -400, bottom: 300 } })),
    0,
  );
  // The same rule for a smaller overshoot, one pixel past the bound.
  assert.equal(
    noteCardShift(
      shiftInput({
        documentTop: 68 - NOTE_CARD_SHIFT_MAX_PX - 1,
        anchor: { top: 0, bottom: 400 },
      }),
    ),
    0,
  );
});

test("the nudge is never larger than the bound", () => {
  for (let top = -200; top <= 200; top += 1) {
    const shift = noteCardShift(
      shiftInput({ documentTop: top, anchor: { top: -300, bottom: 400 } }),
    );
    assert.ok(
      shift >= 0 && shift <= NOTE_CARD_SHIFT_MAX_PX,
      `shift ${shift} out of range at documentTop ${top}`,
    );
  }
});

test("a card taller than the reading area is left where it is", () => {
  // Nothing is gained by moving a card that cannot fit either way.
  assert.equal(
    noteCardShift(shiftInput({ documentTop: 40, height: 900 })),
    0,
  );
});

test("an unresolved record is never nudged, and neither is an absurd measurement", () => {
  assert.equal(noteCardShift(shiftInput({ anchor: null })), 0);
  assert.equal(noteCardShift(shiftInput({ anchor: undefined })), 0);
  assert.equal(noteCardShift(shiftInput({ viewportHeight: 0 })), 0);
  assert.equal(noteCardShift(shiftInput({ documentTop: Number.NaN })), 0);
});

test("the nudge defaults to a small, fixed bound and a visible gap", () => {
  assert.ok(NOTE_CARD_SHIFT_MAX_PX > 0 && NOTE_CARD_SHIFT_MAX_PX <= 200);
  assert.ok(NOTE_CARD_EDGE_GAP_PX > 0 && NOTE_CARD_EDGE_GAP_PX < NOTE_RAIL_HEADER_PX);
  // With no header measured yet the fallback is the rail's own constant.
  const shifted = noteCardShift({
    anchor: { top: 10, bottom: 400 },
    documentTop: 10,
    stageTop: 0,
    height: 60,
    viewportHeight: 900,
  });
  assert.equal(shifted, NOTE_RAIL_HEADER_PX + NOTE_CARD_EDGE_GAP_PX - 10);
});

test("a shift is applied inside the collision pass, so it cannot overlap", () => {
  const positions = layoutNoteRail(
    [
      { ...item("open", 300, 100, 0), shift: 60 },
      item("below", 380, 50, 1),
    ],
    { gap: 12, top: 12 },
  );
  assert.equal(positions.open, 360, "the open record moves by its shift");
  assert.equal(
    positions.below,
    360 + 100 + 12,
    "the record below is pushed clear rather than overlapped",
  );
});

test("a shift can never pull a record above the rail's own top padding", () => {
  const positions = layoutNoteRail(
    [{ ...item("open", 100, 100, 0), shift: -100 }],
    { gap: 12, top: 12 },
  );
  assert.equal(positions.open, 12);
});

test("a negative or absurd shift is ignored rather than applied", () => {
  const positions = layoutNoteRail(
    [
      { ...item("open", 100, 100, 0), shift: Number.NaN },
      item("after", 300, 50, 1),
    ],
    { gap: 12, top: 12 },
  );
  assert.equal(positions.open, 100);
  assert.equal(positions.after, 300);
});
