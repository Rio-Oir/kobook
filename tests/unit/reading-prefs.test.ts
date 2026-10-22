// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading-preference tests.
 *
 * Two things are worth testing here and they are not the same thing.
 *
 * The first is the *store*: that a choice is written to `gloss-reading`,
 * that it survives a rehydrate, and that `reset` returns to the responsive
 * default rather than to a hard-coded 20px.
 *
 * The second — and the reason this file is longer than the store — is the
 * *fallback*. A preference blob is the one piece of state a user can edit
 * by hand, that an older build can have written, and that a newer build has
 * to read without producing a 4px article or an empty `<select>`. So
 * `normalizeReadingPrefs` is tested against the values that actually turn up:
 * a missing field, a string where a number belongs, a number from a
 * different option list, and a size outside any sane range.
 *
 * The localStorage polyfill follows `theme-store.test.ts`: seed the map,
 * then call `persist.rehydrate()`. Re-importing the module does NOT give a
 * fresh instance (Node caches ESM), so the explicit rehydrate is what makes
 * the persistence assertions mean anything.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";

const memory = new Map<string, string>();
const localStoragePolyfill = {
  getItem: (k: string): string | null => memory.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    memory.set(k, v);
  },
  removeItem: (k: string): void => {
    memory.delete(k);
  },
  clear: (): void => {
    memory.clear();
  },
  key: (i: number): string | null => Array.from(memory.keys())[i] ?? null,
  get length(): number {
    return memory.size;
  },
};

before(() => {
  // zustand's persist middleware reads `window.localStorage` *when the store
  // is created*, and bails out of the middleware entirely — no `.persist`,
  // no writes — if it cannot. So `window` has to exist before the first
  // `import`, not merely before the first assertion. Same shape as
  // `theme-store.test.ts`.
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStoragePolyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStoragePolyfill,
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  memory.clear();
});

async function loadModule() {
  return import("../../src/lib/reading-prefs.js");
}

/** Put the store back to its defaults without writing a blob. */
async function resetStore() {
  const mod = await loadModule();
  mod.useReadingPrefs.getState().reset();
  return mod;
}

test("defaults: system sans-serif, responsive size, 1.8 / 30 / 0.8, notes open", async () => {
  const mod = await resetStore();
  const s = mod.useReadingPrefs.getState();
  assert.equal(s.font, "sans");
  // `null` is the point: the size is the responsive default (20px desktop,
  // 18px phone), not a number baked into the store.
  assert.equal(s.fontSizePx, null);
  assert.equal(s.lineHeight, 1.8);
  assert.equal(s.measure, 30);
  assert.equal(s.paragraphGap, 0.8);
  // Both rails are on screen until the reader pushes one aside. The notes
  // rail's field used to default to `false` while nothing read it; now that
  // it is the rail's visibility, "open" is the default and `version: 2`
  // migrates the old blobs — see the migration test below.
  assert.equal(s.notesOpen, true);
  assert.equal(s.railBalance, 0.5);
});

test("update writes the chosen values and reset restores the responsive default", async () => {
  const mod = await resetStore();
  const store = mod.useReadingPrefs.getState();

  store.update({ font: "serif", fontSizePx: 22, lineHeight: 1.95, measure: 34, paragraphGap: 1 });
  const chosen = mod.useReadingPrefs.getState();
  assert.equal(chosen.font, "serif");
  assert.equal(chosen.fontSizePx, 22);
  assert.equal(chosen.lineHeight, 1.95);
  assert.equal(chosen.measure, 34);
  assert.equal(chosen.paragraphGap, 1);

  mod.useReadingPrefs.getState().reset();
  const reset = mod.useReadingPrefs.getState();
  assert.equal(reset.fontSizePx, null, "reset returns to the responsive default, not to 20px");
  assert.equal(reset.font, "sans");
  assert.equal(reset.lineHeight, 1.8);
  assert.equal(reset.measure, 30);
  assert.equal(reset.paragraphGap, 0.8);
  assert.equal(reset.notesOpen, true);
});

test("update refuses a value the reader would not load", async () => {
  const mod = await resetStore();
  // A caller that bypasses the panel cannot store 400px or a negative line
  // height: every write runs through the same normaliser the loader uses, so
  // the panel's option list and the blob cannot drift apart.
  mod.useReadingPrefs.getState().update({ fontSizePx: 400, lineHeight: -3 });
  const s = mod.useReadingPrefs.getState();
  assert.equal(s.fontSizePx, null);
  assert.equal(s.lineHeight, 1.8);
});

test("persistence: a choice is written to gloss-reading and survives a rehydrate", async () => {
  const mod = await resetStore();
  mod.useReadingPrefs.getState().update({ font: "serif", measure: 26, notesOpen: true });

  const raw = memory.get("gloss-reading");
  assert.ok(raw, "persist must write the blob");
  const parsed = JSON.parse(raw) as {
    state: { font: string; measure: number; notesOpen: boolean };
    version: number;
  };
  assert.equal(parsed.state.font, "serif");
  assert.equal(parsed.state.measure, 26);
  assert.equal(parsed.state.notesOpen, true);
  assert.equal(parsed.version, 2);

  // A fresh page load reads the same values back. The blob is put back by
  // hand because `reset()` below is itself a write — every mutation goes
  // through persist, so resetting first would have replaced the very blob
  // this assertion is about.
  mod.useReadingPrefs.getState().reset();
  memory.set("gloss-reading", raw);
  await mod.useReadingPrefs.persist.rehydrate();
  const s = mod.useReadingPrefs.getState();
  assert.equal(s.font, "serif");
  assert.equal(s.measure, 26);
  assert.equal(s.notesOpen, true);
});

test("a blob of the wrong shape falls back field by field", async () => {
  const mod = await loadModule();
  memory.set(
    "gloss-reading",
    JSON.stringify({
      state: {
        // A font name, not a category — written by hand, or by a build that
        // offered named faces.
        font: "Source Han Serif SC",
        fontSizePx: "22",
        lineHeight: "1.8",
        measure: null,
        paragraphGap: -4,
        notesOpen: "yes",
      },
      version: 1,
    }),
  );
  await mod.useReadingPrefs.persist.rehydrate();
  const s = mod.useReadingPrefs.getState();
  assert.equal(s.font, "sans", "an unknown font category falls back to the default");
  assert.equal(s.fontSizePx, null, "a string size is not a size");
  assert.equal(s.lineHeight, 1.8, "a string line height falls back to the default");
  assert.equal(s.measure, 30);
  assert.equal(s.paragraphGap, 0.8);
  assert.equal(s.notesOpen, true);
});

test("a valid number outside the option list snaps to the nearest option", async () => {
  const mod = await loadModule();
  memory.set(
    "gloss-reading",
    JSON.stringify({
      state: { fontSizePx: 23, lineHeight: 1.7, measure: 33, paragraphGap: 0.95 },
      version: 1,
    }),
  );
  await mod.useReadingPrefs.persist.rehydrate();
  const s = mod.useReadingPrefs.getState();
  // 23 sits exactly between 22 and 24, and a tie resolves to the smaller
  // option; 1.7 is closer to 1.65; 0.95 is closer to 1.0. Every one of them
  // stays usable rather than silently becoming the default — the value was
  // a real preference from a build with a different option list.
  assert.equal(s.fontSizePx, 22);
  assert.equal(s.lineHeight, 1.65);
  assert.equal(s.paragraphGap, 1);
  // The measure is the exception, and deliberately so: its domain is now
  // continuous (the column edge is draggable), so 33 is a value the reader
  // could have dragged to and there is no option list for it to be stale
  // against. Snapping it to 34 would undo a drag on the next reload.
  assert.equal(s.measure, 33);
});

test("a missing blob leaves the defaults in place", async () => {
  const mod = await loadModule();
  await mod.useReadingPrefs.persist.rehydrate();
  const s = mod.useReadingPrefs.getState();
  assert.equal(s.font, "sans");
  assert.equal(s.fontSizePx, null);
  assert.equal(s.notesOpen, true);
});

test("corrupt JSON does not throw", async () => {
  const mod = await loadModule();
  memory.set("gloss-reading", "{not json");
  // zustand's persist swallows the parse error and keeps the current state;
  // what matters here is that reading preferences can never be the reason
  // the reader fails to open.
  await mod.useReadingPrefs.persist.rehydrate();
  assert.equal(mod.useReadingPrefs.getState().measure, 30);
});

test("readingCssVars omits the font size under the responsive default", async () => {
  const { readingCssVars, DEFAULT_READING_PREFS } = await loadModule();
  const auto = readingCssVars(DEFAULT_READING_PREFS);
  // Emitting a px value here would pin the phone and the desktop to one
  // number and defeat the responsive default.
  assert.equal("--reading-font-size" in auto, false);
  assert.equal(auto["--reading-measure"], "30");
  assert.equal(auto["--reading-line-height"], "1.8");
  assert.equal(auto["--reading-para-gap"], "0.8em");
  assert.equal("--reading-font-family" in auto, false);
  const legacyFont = readingCssVars({ ...DEFAULT_READING_PREFS, font: "serif" });
  assert.deepEqual(legacyFont, auto, "a stored font choice must not replace document typography");

  const chosen = readingCssVars({ ...DEFAULT_READING_PREFS, fontSizePx: 22, measure: 26 });
  assert.equal(chosen["--reading-font-size"], "22px");
  assert.equal(chosen["--reading-measure"], "26");
});

test("the two font categories are distinct system stacks and load nothing", async () => {
  const { READING_FONT_STACK, READING_FONTS } = await loadModule();
  assert.deepEqual([...READING_FONTS], ["sans", "serif"]);
  assert.notEqual(READING_FONT_STACK.sans, READING_FONT_STACK.serif);
  assert.ok(READING_FONT_STACK.sans.includes("sans-serif"));
  assert.ok(READING_FONT_STACK.serif.includes("serif"));

  for (const font of READING_FONTS) {
    const stack = READING_FONT_STACK[font];
    // No webfont and no font service: this build ships neither a font file
    // nor a request to a CDN, so a stack naming a host would be a lie.
    assert.doesNotMatch(stack, /url\(|https?:|\/\//, `${font} stack must not reference a font service`);
    // The Chinese faces have to be in the stack, or "中文衬线" would resolve
    // to whatever the platform's generic serif happens to be.
    assert.ok(
      /PingFang SC|Microsoft YaHei|Noto Sans CJK SC|Source Han Sans SC/.test(stack) ||
        /Songti SC|SimSun|Noto Serif CJK SC|Source Han Serif SC/.test(stack),
      `${font} stack must name a system CJK face`,
    );
    // Multi-word family names need quoting or the browser reads them as a
    // list of single-word families that match nothing.
    assert.doesNotMatch(stack, /(^|, )(PingFang SC|Microsoft YaHei|Source Han Sans SC|Noto Sans CJK SC|Songti SC|Source Han Serif SC|Noto Serif CJK SC|Times New Roman)(,|$)/);
  }
});

test("every option list is sorted, unique, and contains the default", async () => {
  const mod = await loadModule();
  // The measure is absent on purpose: it is a continuous range now, not an
  // option list. `MEASURE_RANGE` is asserted separately below.
  const lists: [string, number[], number][] = [
    ["fontSize", mod.FONT_SIZE_OPTIONS, 20],
    ["lineHeight", mod.LINE_HEIGHT_OPTIONS, mod.DEFAULT_READING_PREFS.lineHeight],
    ["paragraphGap", mod.PARAGRAPH_GAP_OPTIONS, mod.DEFAULT_READING_PREFS.paragraphGap],
  ];
  for (const [name, options, expected] of lists) {
    assert.ok(options.length > 0, `${name} needs options`);
    assert.deepEqual(
      [...options].sort((a, b) => a - b),
      [...options],
      `${name} must be ascending`,
    );
    assert.equal(new Set(options).size, options.length, `${name} must not repeat`);
    // A default that is not an option is a `<select>` that shows nothing on
    // first open, and a value `nearest` would silently rewrite.
    assert.ok(options.includes(expected), `${name} must contain its default (${expected})`);
  }
  // The desktop default the media query uses has to be selectable, or the
  // panel would show a size the user cannot re-pick after changing it.
  assert.ok(mod.FONT_SIZE_OPTIONS.includes(20));
  assert.ok(mod.FONT_SIZE_OPTIONS.includes(18));
});

test("the measure range is ascending and contains the default", async () => {
  const mod = await loadModule();
  const [min, max] = mod.MEASURE_RANGE;
  assert.ok(min < max, "MEASURE_RANGE must be ascending");
  assert.ok(
    mod.DEFAULT_READING_PREFS.measure >= min &&
      mod.DEFAULT_READING_PREFS.measure <= max,
    "the default measure must be inside the range the drag clamps to",
  );
  // The handle reports these as its aria-valuemin/max, so a default
  // outside them would announce a range the control does not have.
  assert.equal(min, 20);
  assert.equal(max, 60);
});

test("columnWidthFor is measure × font size, plus both gutters and both paddings", async () => {
  const { columnWidthFor } = await loadModule();
  // 30 full-width characters at 20px is 600px of *text*. The 2rem gutter is
  // counted twice — the left one holds the paragraph numbers, the right one
  // mirrors it so the text stays centred in the column — and the article's
  // own 32px padding on each side is added on top: the gutter keeps a
  // "30 character" column from actually being 28 characters wide, and the
  // padding is the distance between the text and the edge the reader drags,
  // which has to be inside the number the drag moves.
  assert.equal(columnWidthFor(30, 20, 32, 32), 728);
  assert.equal(columnWidthFor(30, 20, 32, 0), 664);
  assert.equal(columnWidthFor(26, 20, 32, 32), 648);
});

test("measureForColumnWidth is the inverse of columnWidthFor", async () => {
  const { columnWidthFor, measureForColumnWidth } = await loadModule();
  for (const measure of [20, 26, 30, 41, 60]) {
    const width = columnWidthFor(measure, 20, 32, 32);
    assert.equal(measureForColumnWidth(width, 20, 32, 32), measure);
  }
});

test("measureForColumnWidth rounds, and clamps to the range", async () => {
  const { measureForColumnWidth } = await loadModule();
  // A pointer does not land on a whole character. Half a character rounds
  // down (30.4 → 30) and half rounds up (30.6 → 31), which is the bounce
  // the reader sees on release. 128 is two 2rem gutters plus the two 32px
  // side paddings — the non-text part of the column.
  assert.equal(measureForColumnWidth(30.4 * 20 + 128, 20, 32, 32), 30);
  assert.equal(measureForColumnWidth(30.6 * 20 + 128, 20, 32, 32), 31);
  // Past either end of the range the stored value stops rather than
  // following the pointer somewhere the reader could not have meant.
  assert.equal(measureForColumnWidth(5 * 20 + 128, 20, 32, 32), 20);
  assert.equal(measureForColumnWidth(200 * 20 + 128, 20, 32, 32), 60);
});

test("railBalanceFor reports the centred value when there is no slack", async () => {
  const { railBalanceFor, DEFAULT_READING_PREFS } = await loadModule();
  // A viewport barely wide enough for the article and the two lanes has no
  // position to express; the centred answer is the only arrangement the
  // grid can produce anyway.
  assert.equal(railBalanceFor(12, 1000, 1024), DEFAULT_READING_PREFS.railBalance);
  assert.equal(railBalanceFor(12, 1200, 1024), DEFAULT_READING_PREFS.railBalance);
});

test("railBalanceFor maps the left rail onto the slack", async () => {
  const { railBalanceFor } = await loadModule();
  // 1440 viewport, 700px article, 12px lanes: 716px of slack.
  const viewport = 1440;
  const column = 700;
  assert.equal(railBalanceFor(12, column, viewport), 0);
  assert.equal(railBalanceFor(370, column, viewport), 0.5);
  assert.equal(railBalanceFor(728, column, viewport), 1);
  // And it does not run off the ends if a caller passes a rail wider than
  // the slack allows.
  assert.equal(railBalanceFor(900, column, viewport), 1);
  assert.equal(railBalanceFor(0, column, viewport), 0);
});

test("railCollapsed is the one place the threshold is applied", async () => {
  const mod = await loadModule();
  // The threshold itself is drawn — a rail only loses its content *below*
  // it, which is what makes a drag back out land on a usable width rather
  // than on the boundary of one.
  assert.equal(mod.railCollapsed(mod.RAIL_MIN_PX - 1), true);
  assert.equal(mod.railCollapsed(mod.RAIL_MIN_PX), false);
  // The lane is never zero: the drag handle is a grid item in the rail's
  // own track, so a zero-width track would put the one gesture that undoes
  // the last one off the edge of the viewport.
  assert.ok(mod.RAIL_LANE_PX > 0);
  assert.ok(mod.RAIL_LANE_PX < mod.RAIL_MIN_PX);
  // And it has to sit below the narrowest the rails get on their own, or a
  // reader who has dragged nothing opens an article to two rails with
  // nothing drawn in them. At 1024 the default 30-character article is
  // 728px (600px of text, two 2rem gutters, two 32px paddings), which leaves
  // the rails 148 each.
  const defaultColumn = mod.columnWidthFor(
    mod.DEFAULT_READING_PREFS.measure,
    20,
    32,
    32,
  );
  const railAt1024 =
    mod.RAIL_LANE_PX + 0.5 * (1024 - defaultColumn - 2 * mod.RAIL_LANE_PX);
  assert.ok(
    railAt1024 >= mod.RAIL_MIN_PX,
    `the default rails at 1024 are ${railAt1024}px, below the ${mod.RAIL_MIN_PX}px threshold`,
  );
});

test("railVars emits the balance and each rail's visibility", async () => {
  const { railVars } = await loadModule();
  // A single unitless number for the position: `index.css` does the
  // arithmetic, because `minmax(lane, N fr)` on each rail loses the space a
  // clamped track could not use. See the comment on `railVars`.
  assert.deepEqual(railVars(0.5, true, true), {
    "--reading-rail-balance": "0.5000",
    "--reading-rail-left-content": "visible",
    "--reading-rail-right-content": "visible",
  });
  assert.equal(railVars(7, true, true)["--reading-rail-balance"], "1.0000", "clamped");
  assert.equal(railVars(-2, true, true)["--reading-rail-balance"], "0.0000");

  // Hiding a rail is only about whether it is drawn, and the balance is
  // passed through untouched. That is the whole point: the outline's
  // presence is not allowed to move the reading area, so a reader who keeps
  // it closed still gets a centred article rather than one shoved against
  // the left edge.
  const shutLeft = railVars(0.25, false, true);
  assert.equal(shutLeft["--reading-rail-balance"], "0.2500");
  assert.equal(shutLeft["--reading-rail-left-content"], "hidden");
  assert.equal(shutLeft["--reading-rail-right-content"], "visible");

  const shutRight = railVars(0.25, true, false);
  assert.equal(shutRight["--reading-rail-balance"], "0.2500");
  assert.equal(shutRight["--reading-rail-right-content"], "hidden");
  assert.equal(shutRight["--reading-rail-left-content"], "visible");
});

test("maxColumnWidth is the window, less the two handles' lanes", async () => {
  const { maxColumnWidth, RAIL_LANE_PX } = await loadModule();
  // The same expression `index.css` uses to cap `--reading-column-w`. If
  // these two ever disagree the handle would keep moving after the column
  // had already stopped.
  //
  // There is deliberately no readability cap any more. An 800px guard used
  // to bind here and it did two things nobody asked for: it re-capped a
  // width the reader had dragged to, and — because the tracks have to fill
  // the row — it pushed the room it refused to give the article onto the
  // *other* rail.
  assert.equal(maxColumnWidth(1024), 1024 - 2 * RAIL_LANE_PX);
  assert.equal(maxColumnWidth(1440), 1440 - 2 * RAIL_LANE_PX);
  assert.equal(maxColumnWidth(2560), 2560 - 2 * RAIL_LANE_PX);
});

test("dragColumnLayout moves the dragged edge and leaves the far rail alone", async () => {
  const { dragColumnLayout } = await loadModule();
  // The gesture in one line: the left edge went out by 80px, so the left
  // rail grew by 80 and the article gave up 80. The notes rail has no
  // opinion.
  const next = dragColumnLayout({
    side: "left",
    draggedRailPx: 452,
    farRailPx: 372,
    viewportPx: 1440,
    minColumnPx: 496,
  });
  assert.equal(next.leftRailPx, 452);
  assert.equal(next.rightRailPx, 372);
  assert.equal(next.columnPx, 616);
  assert.equal(next.leftCollapsed, false);
  assert.equal(next.rightCollapsed, false);
  // And the three still fill the row.
  assert.equal(next.leftRailPx + next.columnPx + next.rightRailPx, 1440);
});

test("dragColumnLayout never moves the far rail, however far the drag goes", async () => {
  const { dragColumnLayout } = await loadModule();
  // The property the whole gesture rests on, and the one an earlier version
  // got wrong. The article used to stop at a readability cap and the
  // leftover was handed to the far rail, so dragging the left edge visibly
  // widened the notes panel. The article takes all of it now.
  const next = dragColumnLayout({
    side: "left",
    draggedRailPx: 12,
    farRailPx: 372,
    viewportPx: 1440,
    minColumnPx: 496,
  });
  assert.equal(next.leftRailPx, 12);
  assert.equal(next.leftCollapsed, true);
  assert.equal(next.rightRailPx, 372, "the far rail did not move");
  assert.equal(next.columnPx, 1440 - 12 - 372);
  assert.equal(next.leftRailPx + next.columnPx + next.rightRailPx, 1440);
});

test("dragColumnLayout stops the edge where the article's minimum is", async () => {
  const { dragColumnLayout } = await loadModule();
  // A long drag past the end of the gesture has to stop the *rail*, not
  // only the article: a track wider than the row would leave the three
  // tracks no longer filling it, and the grid would overflow or squeeze
  // the `1fr` instead.
  const next = dragColumnLayout({
    side: "left",
    draggedRailPx: 5000,
    farRailPx: 372,
    viewportPx: 1440,
    minColumnPx: 496,
  });
  assert.equal(next.leftRailPx, 1440 - 496 - 372);
  assert.equal(next.columnPx, 496);
  assert.equal(next.leftRailPx + next.columnPx + next.rightRailPx, 1440);
});

test("dragColumnLayout hides a rail's content below the threshold, not at it", async () => {
  const mod = await loadModule();
  const at = (draggedRailPx: number) =>
    mod.dragColumnLayout({
      side: "right",
      draggedRailPx,
      farRailPx: 372,
      viewportPx: 1440,
      minColumnPx: 496,
    });
  assert.equal(at(mod.RAIL_MIN_PX).rightCollapsed, false);
  assert.equal(at(mod.RAIL_MIN_PX - 1).rightCollapsed, true);
  // The width keeps following the pointer through the threshold — there is
  // no snap, which would leave the reader dragging through a hundred and
  // forty pixels of nothing — so one pixel under the threshold is a real,
  // drawn track that happens to have nothing in it.
  assert.equal(at(mod.RAIL_MIN_PX - 1).rightRailPx, mod.RAIL_MIN_PX - 1);
  assert.equal(at(250).columnPx, 1440 - 372 - 250);
  // The lane is the narrowest the dragged rail goes.
  assert.equal(at(-50).rightRailPx, mod.RAIL_LANE_PX);
});

test("dragColumnLayout at 1024: the rails are all that is between", async () => {
  const mod = await loadModule();
  // With no cap the rails are the only thing between the article and the
  // window, so at 1024 the default 30 characters (696px) leaves 164 each.
  // Dismissing one is worth 152px of line, and the far rail stays put.
  const next = mod.dragColumnLayout({
    side: "left",
    draggedRailPx: 12,
    farRailPx: 164,
    viewportPx: 1024,
    minColumnPx: 496,
  });
  assert.equal(next.columnPx, 1024 - 12 - 164);
  assert.equal(next.leftCollapsed, true);
  assert.equal(next.rightRailPx, 164, "the notes rail did not move");
  assert.equal(next.leftRailPx + next.columnPx + next.rightRailPx, 1024);
});

test("readingCssVars carries the rail balance and each rail's visibility", async () => {
  const { readingCssVars, DEFAULT_READING_PREFS } = await loadModule();
  const vars = readingCssVars(DEFAULT_READING_PREFS);
  assert.equal(vars["--reading-rail-balance"], "0.5000");
  const dragged = readingCssVars({
    ...DEFAULT_READING_PREFS,
    railBalance: 0.25,
  });
  assert.equal(dragged["--reading-rail-balance"], "0.2500");
  // The outline lives in the other store, so its half of the rail state
  // comes in as an argument. Hiding it changes exactly one property — the
  // visibility — and nothing about the layout, which is what keeps the
  // reading area where the reader put it whether or not the outline is
  // drawn.
  const shut = readingCssVars(DEFAULT_READING_PREFS, { outlineOpen: false });
  assert.equal(shut["--reading-rail-balance"], "0.5000");
  assert.equal(shut["--reading-rail-left-content"], "hidden");
  // The notes rail's half is a field of its own.
  const notesShut = readingCssVars({
    ...DEFAULT_READING_PREFS,
    notesOpen: false,
  });
  assert.equal(notesShut["--reading-rail-right-content"], "hidden");
  // The column width is deliberately absent: it is derived from the
  // measure in `index.css`, and emitting it here would pin the article to
  // a pixel width that could not follow a change of font size.
  assert.equal("--reading-column-w" in vars, false);
  // And so is any readability cap — there is none any more. See
  // `maxColumnWidth`.
  assert.equal("--reading-column-max" in vars, false);
});

test("a v1 blob's notesOpen was not a choice, so it comes back open", async () => {
  const mod = await loadModule();
  // v1 stored the field and nothing read it — the notes rail was drawn at
  // every width — so a `false` in an old blob is the old default, not
  // something the reader picked. Reading it as a choice would make the
  // notes panel disappear for everyone who had ever opened the reader.
  memory.set(
    "gloss-reading",
    JSON.stringify({ state: { measure: 26, notesOpen: false }, version: 1 }),
  );
  await mod.useReadingPrefs.persist.rehydrate();
  const migrated = mod.useReadingPrefs.getState();
  assert.equal(migrated.notesOpen, true);
  assert.equal(migrated.measure, 26, "the migration must not disturb anything else");

  // From v2 on it is a real choice and survives.
  memory.set(
    "gloss-reading",
    JSON.stringify({ state: { notesOpen: false }, version: 2 }),
  );
  await mod.useReadingPrefs.persist.rehydrate();
  assert.equal(mod.useReadingPrefs.getState().notesOpen, false);
});

test("railBalance survives a round trip and falls back when corrupt", async () => {
  const mod = await loadModule();
  mod.useReadingPrefs.getState().update({ railBalance: 0.75 });
  const written = JSON.parse(memory.get("gloss-reading")!) as {
    state: { railBalance: number };
  };
  assert.equal(written.state.railBalance, 0.75);

  await mod.useReadingPrefs.persist.rehydrate();
  assert.equal(mod.useReadingPrefs.getState().railBalance, 0.75);

  // Out of range is a corrupt blob, not a position — same convention as
  // every other field. A missing one lands on centred.
  memory.set(
    "gloss-reading",
    JSON.stringify({ state: { railBalance: 4 }, version: 2 }),
  );
  await mod.useReadingPrefs.persist.rehydrate();
  assert.equal(mod.useReadingPrefs.getState().railBalance, 0.5);

  memory.set("gloss-reading", JSON.stringify({ state: {}, version: 2 }));
  await mod.useReadingPrefs.persist.rehydrate();
  assert.equal(mod.useReadingPrefs.getState().railBalance, 0.5);
});
