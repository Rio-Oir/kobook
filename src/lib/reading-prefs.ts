// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading typography preferences — the reader's font, size, line height,
 * measure and paragraph spacing.
 *
 * ## Why this is its own store
 *
 * The obvious alternative was to put these fields on `lib/store.ts`, which
 * already holds two reading-surface preferences (`outlineOpen`,
 * `highlightColor`) and would have inherited its persistence for free. That
 * was rejected for one concrete reason: `gloss-storage` is the blob
 * `lib/local-backup.ts` imports and exports, and its shape is a frozen
 * contract. Adding fields there would have made a typography tweak part of
 * the backup format. This store writes to its own key (`gloss-reading`),
 * which the backup format does not mention, so neither direction of the
 * backup contract moves.
 *
 * ## Why it is not owner-stamped
 *
 * `gloss-theme` and `gloss-settings` carry an `ownerUserId` stamp and are
 * reset by `applyOwnership` when a different account signs in, because those
 * values are *picks* — a theme or a model choice belongs to the person who
 * made it. Font size, line height and measure are the other kind of
 * preference: a device-level comfort setting, closer to the operating
 * system's text size than to a colour scheme. Someone who has settled on
 * 20px / 1.8 on this machine has settled on it for this machine, and having
 * a sign-in silently put them back to 18px would be the surprising
 * behaviour. So this store keeps one value per browser and no owner stamp.
 *
 * ## Why the defaults are "auto"
 *
 * The agreed first-version defaults are 20px on desktop and 18px on a phone.
 * One stored number cannot express both, so `fontSizePx: null` means "the
 * responsive default" and the actual value comes from CSS (a media query in
 * `index.css`). Picking a size in the settings panel stores a number, which
 * then applies at every width — an explicit choice should not be quietly
 * overridden by a breakpoint. `reset()` returns to `null`, not to 20.
 *
 * Everything here is pure except the store itself, so the fallback rules for
 * a corrupt or outdated blob are unit-testable without a DOM.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The two font *categories* the reader offers. */
export type ReadingFont = "sans" | "serif";

export const READING_FONTS: ReadingFont[] = ["sans", "serif"];

/**
 * Labels name the category, not a typeface.
 *
 * The reader does not download a webfont and does not bundle one, so a label
 * like "思源宋体" would claim a specific face that the device may not have.
 * "（系统）" says where the glyphs come from and leaves the actual face to
 * whatever the platform's serif/sans-serif resolution picks.
 */
export const READING_FONT_LABEL: Record<ReadingFont, string> = {
  sans: "无衬线（系统）",
  serif: "衬线（系统）",
};

/**
 * System font stacks — no webfont, no external font service.
 *
 * Latin faces come first and the CJK faces follow, which is the order that
 * gives mixed Chinese/Latin text the better result: the Latin font renders
 * the Latin runs, and the browser falls through to the CJK face for every
 * Han character. Listing a font here is not a claim that the device has it —
 * these are the families each platform ships, and the stack degrades to
 * `sans-serif` / `serif` if none of them resolve.
 */
export const READING_FONT_STACK: Record<ReadingFont, string> = {
  sans: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "Source Han Sans SC",
    "Noto Sans CJK SC",
    "sans-serif",
  ]
    .map((name) => (name.includes(" ") ? `"${name}"` : name))
    .join(", "),
  serif: [
    "Georgia",
    "Times New Roman",
    "Songti SC",
    "STSong",
    "SimSun",
    "Source Han Serif SC",
    "Noto Serif CJK SC",
    "serif",
  ]
    .map((name) => (name.includes(" ") ? `"${name}"` : name))
    .join(", "),
};

/**
 * The values the settings panel offers.
 *
 * Discrete options rather than a free number field or a slider: the point of
 * the first version is to compare a handful of candidates one at a time, and
 * a list also makes every stored value something the UI can display as
 * selected. The set is deliberately small — a control that offers forty sizes
 * is a control nobody finishes using.
 */
export const FONT_SIZE_OPTIONS: number[] = [16, 17, 18, 19, 20, 21, 22, 24];
export const LINE_HEIGHT_OPTIONS: number[] = [1.65, 1.8, 1.95];
/** Paragraph gap, in `em` of the body font size. */
export const PARAGRAPH_GAP_OPTIONS: number[] = [0.6, 0.8, 1.0];

/**
 * The width at which a side rail's content stops being readable.
 *
 * Below it the rail is on its way out: the outline's entries and the note
 * cards are hidden rather than squeezed into an unreadable column, and what
 * is left is the handle's lane. Above it the rail is drawn normally, however
 * narrow that is — the reader is the one who decided, and the width is the
 * only limit.
 *
 * This is a *display* threshold, not a layout one. It does not stop the drag
 * and it does not take width from anyone: the rail's track is wherever the
 * balance puts it, and this only decides whether there is anything drawn in
 * it. `index.css` applies it with a container query, so a rail that the
 * window shrank is handled the same way as one the reader dragged.
 *
 * 140 rather than something rounder because it has to sit below the narrowest
 * the rails get on their own: at 1024 the default 30-character article
 * leaves 164px each, and a threshold above that would hide a rail nobody had
 * touched.
 */
export const RAIL_MIN_PX = 140;

/**
 * The narrowest a rail's track may be, in CSS pixels.
 *
 * Not zero, because the drag handle lives in the rail's own grid track
 * (`index.css`). A track of zero would put the handle half off the edge of
 * the viewport, and the reader would have no way to pull the rail back —
 * the one gesture that has to keep working is the one that undoes the last
 * one. The lane is invisible at rest; what shows is the handle, which
 * `ColumnGrip` draws differently once its rail is shut.
 */
export const RAIL_LANE_PX = 12;

/**
 * Whether a rail of this width has anything to draw.
 *
 * One predicate rather than a `<` at each call site, because the same answer
 * decides three things that have to agree: whether the drag flips the rail's
 * toggle, whether the toolbar button reads as pressed, and what the stylesheet
 * does with the rail's content. If they disagreed the button would claim a
 * rail that is not drawn, or the content would render into a lane.
 */
export function railCollapsed(widthPx: number): boolean {
  return widthPx < RAIL_MIN_PX;
}


export const FONT_SIZE_LABEL = (px: number): string => `${px}px`;
export const LINE_HEIGHT_LABEL = (value: number): string => value.toFixed(2);
export const MEASURE_LABEL = (chars: number): string => `${chars} 字`;
export const PARAGRAPH_GAP_LABEL = (em: number): string => `${em.toFixed(1)} 字高`;

/** The full preference set, with every field resolved to a usable value. */
export type ReadingPrefs = {
  /** Retained for stored preference compatibility; no longer applied to text. */
  font: ReadingFont;
  /** `null` = responsive default (desktop 20px, phone 18px). */
  fontSizePx: number | null;
  lineHeight: number;
  measure: number;
  paragraphGap: number;
  /**
   * How the space left over by the article is split between the two rails.
   *
   * `0.5` is centred, which is what the layout did before the column edge
   * was draggable and is still the default. `0` gives every spare pixel to
   * the notes rail, `1` to the outline. It is a *share of the slack* —
   * what remains after the article and the two `RAIL_MIN_PX` floors —
   * rather than a width, so it survives a window resize and a change of
   * font size without pinning the rails to a number that no longer fits.
   */
  railBalance: number;
  /**
   * Whether the notes rail is on screen.
   *
   * `false` means the reader has pushed it out of the way — by dragging the
   * right edge of the article across it, or by the toggle. The rail then
   * keeps only `RAIL_LANE_PX` of track, so its handle is still there to
   * pull it back, and the article takes the room.
   *
   * Default `true`, which is what the layout did before the rail was
   * dismissible. (The field existed before this and defaulted to `false`,
   * but nothing read it — the rail was drawn at every width — so a stored
   * `false` was not a choice anyone made. `version: 2` migrates it.)
   */
  notesOpen: boolean;
};

export const DEFAULT_READING_PREFS: ReadingPrefs = {
  font: "sans",
  fontSizePx: null,
  lineHeight: 1.8,
  measure: 30,
  paragraphGap: 0.8,
  railBalance: 0.5,
  notesOpen: true,
};

/** Sane bounds for a persisted number, before snapping to an option. */
const FONT_SIZE_RANGE: [number, number] = [12, 40];
const LINE_HEIGHT_RANGE: [number, number] = [1.2, 2.4];
const PARAGRAPH_GAP_RANGE: [number, number] = [0, 3];
const RAIL_BALANCE_RANGE: [number, number] = [0, 1];

/**
 * The whole characters a column may be set to.
 *
 * Exported because the drag handle reports it as its `aria-valuemin` /
 * `aria-valuemax`: a separator with a value has to say what the ends of
 * its range are, and the two must be the same numbers the drag clamps to
 * or the announcement would describe a range the control does not have.
 */
export const MEASURE_RANGE: [number, number] = [20, 60];

/**
 * The option closest to `value`; `options[0]` when `options` is empty.
 *
 * The comparison is strict, so a value exactly between two options keeps the
 * earlier (smaller) one — a tie has to resolve somewhere, and resolving it
 * towards the smaller size is the conservative direction for a reading
 * preference. `options` must be ascending for that to mean anything.
 */
function nearest(value: number, options: number[]): number {
  return options.reduce(
    (best, option) =>
      Math.abs(option - value) < Math.abs(best - value) ? option : best,
    options[0]!,
  );
}

/**
 * Coerce one persisted number onto the option list.
 *
 * Two failure modes, one answer. A value outside the range is not a size
 * anyone chose — it is a corrupt blob, a hand-edited localStorage entry, or a
 * field from a build that used different units — so it falls back to
 * `fallback`. A value *inside* the range but not on the list is a real
 * preference from an earlier or later version of the option list, and
 * snapping it to the nearest current option keeps the panel showing something
 * selected instead of an empty `<select>`.
 */
function normalizeOption(
  raw: unknown,
  options: number[],
  range: [number, number],
  fallback: number,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  if (raw < range[0] || raw > range[1]) return fallback;
  return nearest(raw, options);
}

/**
 * Coerce one persisted number onto a continuous range, rounded.
 *
 * The same two failure modes as `normalizeOption`, with the opposite answer
 * for the second one. A value outside the range still falls back — it is a
 * corrupt blob, not a choice. A value *inside* the range is kept, because
 * for a field whose domain is continuous there is no "current option list"
 * for it to be stale against: the column edge can be dragged to any whole
 * character, and snapping 41 back onto 34 on the next reload would undo a
 * drag the reader made on purpose.
 *
 * `step` is the granularity to land on, and it also absorbs float drift —
 * a value that arrived from a drag as 30.000000004 stores as 30.
 */
function normalizeContinuous(
  raw: unknown,
  range: [number, number],
  fallback: number,
  step = 1,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  if (raw < range[0] || raw > range[1]) return fallback;
  const snapped = Math.round(raw / step) * step;
  return Math.min(range[1], Math.max(range[0], snapped));
}

/**
 * Turn anything at all into a complete, valid preference set.
 *
 * Called on every rehydrate, so a blob written by another build, a partially
 * written object, or a value someone edited in devtools lands on the reader's
 * defaults field by field rather than producing an unstyled page or a
 * `<select>` with nothing selected.
 */
export function normalizeReadingPrefs(raw: unknown): ReadingPrefs {
  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const font = source["font"];
  const fontSizePx = source["fontSizePx"];
  return {
    font:
      font === "sans" || font === "serif"
        ? font
        : DEFAULT_READING_PREFS.font,
    // `null` is a real value here, not a missing one: it is "use the
    // responsive default". Anything else non-numeric is treated the same way,
    // because "auto" is the only size that cannot be wrong on a device the
    // user has not picked a size for yet.
    fontSizePx:
      fontSizePx === null || fontSizePx === undefined
        ? null
        : typeof fontSizePx === "number" &&
            Number.isFinite(fontSizePx) &&
            fontSizePx >= FONT_SIZE_RANGE[0] &&
            fontSizePx <= FONT_SIZE_RANGE[1]
          ? nearest(fontSizePx, FONT_SIZE_OPTIONS)
          : null,
    lineHeight: normalizeOption(
      source["lineHeight"],
      LINE_HEIGHT_OPTIONS,
      LINE_HEIGHT_RANGE,
      DEFAULT_READING_PREFS.lineHeight,
    ),
    measure: normalizeContinuous(
      source["measure"],
      MEASURE_RANGE,
      DEFAULT_READING_PREFS.measure,
    ),
    paragraphGap: normalizeOption(
      source["paragraphGap"],
      PARAGRAPH_GAP_OPTIONS,
      PARAGRAPH_GAP_RANGE,
      DEFAULT_READING_PREFS.paragraphGap,
    ),
    // Not rounded to nothing: 0 and 1 are both real choices (all the slack
    // to one rail), and `RAIL_BALANCE_RANGE` accepts them.
    //
    // Four decimals, not two, and the reason is not precision for its own
    // sake. The balance is a share of the slack, so its quantum is a
    // *length*: at 0.01 and 640px of slack the stored position can sit 3px
    // away from the one the reader dragged to, and — because the far rail is
    // the remainder — that error lands on the rail the reader did not touch.
    // Four decimals is a third of a pixel at any realistic slack.
    railBalance: normalizeContinuous(
      source["railBalance"],
      RAIL_BALANCE_RANGE,
      DEFAULT_READING_PREFS.railBalance,
      0.0001,
    ),
    notesOpen:
      typeof source["notesOpen"] === "boolean"
        ? source["notesOpen"]
        : DEFAULT_READING_PREFS.notesOpen,
  };
}

/**
 * The CSS custom properties one preference set contributes.
 *
 * Returned as a map rather than a style string so the Reader can spread it
 * into `style` and a test can assert the mapping without parsing CSS. The
 * *defaults* for these properties live in `index.css` (`:root`, plus the
 * desktop media query); this only emits the ones the user has overridden.
 * `--reading-font-size` is therefore absent under "auto" on purpose —
 * emitting it would pin the phone and the desktop to one number and defeat
 * the responsive default.
 */
export function readingCssVars(
  prefs: ReadingPrefs,
  options: { outlineOpen?: boolean } = {},
): Record<string, string> {
  const outlineOpen = options.outlineOpen ?? true;
  const vars: Record<string, string> = {
    "--reading-line-height": String(prefs.lineHeight),
    "--reading-measure": String(prefs.measure),
    "--reading-para-gap": `${prefs.paragraphGap}em`,
    ...railVars(prefs.railBalance, outlineOpen, prefs.notesOpen),
  };
  if (prefs.fontSizePx !== null) {
    vars["--reading-font-size"] = `${prefs.fontSizePx}px`;
  }
  return vars;
}

/**
 * The custom property that places the article between the rails.
 *
 * A bare number, not a pair of `fr` track sizes, and that is the whole
 * point. The obvious encoding was `minmax(200px, N fr)` on each rail with
 * N and 1−N — but `fr` distributes the *free* space and then clamps to the
 * track's minimum, and Chromium does not give the clamped-away space back
 * to the other track. The row then comes up short: with a 826px article in
 * a 1440px row and a 0.2/0.8 split, the rails came out 200px and 331px and
 * the 82px the left rail could not use simply vanished.
 *
 * So `index.css` computes the left rail's width from this number instead —
 * floor + balance × slack — and lets the right rail take the remainder
 * with a plain `1fr`. That is the same arithmetic `railBalanceFor` inverts,
 * which is what keeps the handle and the track from disagreeing.
 *
 * 0.5 is the identity: equal rails, article centred, which is what the
 * layout did before the edge was draggable — and it is what a reader who
 * has never dragged gets at *every* width, whether or not the outline is
 * drawn. That matters: the position is not something the outline's presence
 * is allowed to move.
 *
 * ## What else rides along
 *
 * `--reading-rail-left-content` / `--reading-rail-right-content` are the
 * `visibility` each rail's own child is drawn with — the toolbar buttons'
 * "hide this rail" state. A property rather than a `display: none` because
 * the subtree has to stay mounted: the outline keeps its place at the active
 * heading and the notes rail keeps its scroll position across a gesture the
 * reader can undo with the next pixel. A property rather than an attribute
 * because the drag flips it mid-flight the same way it writes every other
 * rail number.
 *
 * Note what is *not* here: no floors, and no override of the balance. The
 * two tracks are `lane + balance × slack` and `lane + (1 − balance) × slack`
 * — symmetric, both computed, neither clamped — so a rail's width is exactly
 * what the balance says and nothing about the article's width depends on
 * which rails happen to be drawn. Hiding a rail moves nothing; only a drag
 * does.
 */
export function railVars(
  balance: number,
  outlineOpen: boolean,
  notesOpen: boolean,
): {
  "--reading-rail-balance": string;
  "--reading-rail-left-content": string;
  "--reading-rail-right-content": string;
} {
  const clamped = Math.min(1, Math.max(0, balance));
  return {
    "--reading-rail-balance": clamped.toFixed(4),
    "--reading-rail-left-content": outlineOpen ? "visible" : "hidden",
    "--reading-rail-right-content": notesOpen ? "visible" : "hidden",
  };
}

/**
 * The width of the article's grid column, in CSS pixels.
 *
 * The column is the *box*, not the text: it carries the paragraph-number
 * gutter on both sides (the left one holds the numbers, the right one keeps
 * the text optically centred instead of 2rem off) plus one `sidePad` of
 * breathing room on each side, which is what the `4rem` in `index.css` has
 * always been (2 × the 32px `md:px-8`). Measuring the text instead would make
 * the edge the reader drags sit a padding away from the edge they can see.
 */
export function columnWidthFor(
  measure: number,
  fontSizePx: number,
  gutterPx: number,
  sidePadPx: number,
): number {
  return measure * fontSizePx + 2 * gutterPx + 2 * sidePadPx;
}

/**
 * The whole number of characters a column of this width can hold.
 *
 * The inverse of `columnWidthFor`, rounded because the measure is stored
 * as whole characters — the column edge tracks the pointer continuously
 * during a drag and lands on a character when the pointer is released.
 * Clamped to `MEASURE_RANGE` so a drag past either end of the range stops
 * changing the stored value rather than writing something the reader
 * could not have meant.
 */
export function measureForColumnWidth(
  widthPx: number,
  fontSizePx: number,
  gutterPx: number,
  sidePadPx: number,
): number {
  const characters = (widthPx - 2 * gutterPx - 2 * sidePadPx) / fontSizePx;
  return Math.min(
    MEASURE_RANGE[1],
    Math.max(MEASURE_RANGE[0], Math.round(characters)),
  );
}

/**
 * The share of the slack the left rail currently holds.
 *
 * Slack is what is left of the row once the article and the two lanes are
 * accounted for. Lanes rather than a rail floor: the stylesheet measures
 * both rails from `RAIL_LANE_PX`, so this has to invert the same expression
 * or the handle and the track would disagree by the difference.
 *
 * When there is no slack — a viewport barely wide enough for the article
 * and the two lanes — there is no position to express and the answer is the
 * centred one, because that is the only arrangement the grid can produce
 * anyway.
 */
export function railBalanceFor(
  leftRailPx: number,
  columnWidthPx: number,
  viewportPx: number,
): number {
  const slack = viewportPx - columnWidthPx - 2 * RAIL_LANE_PX;
  if (slack <= 0) return DEFAULT_READING_PREFS.railBalance;
  const share = (leftRailPx - RAIL_LANE_PX) / slack;
  return Math.min(1, Math.max(0, share));
}

/**
 * The widest the article's column may be drawn, for any reason.
 *
 * One limit, and it is the window: the article stops where the two handles'
 * lanes begin, so there is always something to grab hold of. There is
 * deliberately **no readability cap** — the reader decides how wide their
 * own line is, and a guard that overrode a width they had dragged to would
 * be rewriting a decision they made. The measure's own range
 * (`MEASURE_RANGE`) is the only thing that bounds the *stored* value, and
 * that is the same range the settings slider offers.
 *
 * This is the same expression `index.css` uses to cap `--reading-column-w`.
 * If the two ever disagree the handle would keep moving after the column had
 * already stopped.
 */
export function maxColumnWidth(viewportPx: number): number {
  return viewportPx - 2 * RAIL_LANE_PX;
}

/** Which of the article's two edges a gesture is moving. */
export type ColumnSide = "left" | "right";

/**
 * The three track widths for one frame of a drag.
 *
 * The gesture is one sentence: **the edge the reader is dragging follows the
 * pointer, the far rail does not move, and the article is whatever is
 * between them.** Nothing else bends it, and that is deliberate — an earlier
 * version let the article's readability cap push the overflow onto the far
 * rail, which meant dragging the left edge visibly widened the notes panel.
 * Two constraints were fighting for one number and the wrong one won.
 *
 * So the only limits are:
 *
 *   - the article's own narrowest, from `MEASURE_RANGE` — a line of two
 *     characters is not a reading width;
 *   - the window, less the two lanes, so both handles stay on screen.
 *
 * A rail below `RAIL_MIN_PX` is on its way out: its content is hidden (by
 * `index.css`, from the width itself) but its *track* keeps following the
 * pointer, because the article is entitled to every pixel the reader is
 * asking for. There is no snap in the width, which would leave the reader
 * dragging through a hundred and forty pixels of nothing.
 *
 * The far rail is a plain number in and a plain number out. It cannot move,
 * so there is nothing to converge on and no second pass.
 */
export function dragColumnLayout(input: {
  side: ColumnSide;
  /** The dragged rail's width as the pointer asks for it. */
  draggedRailPx: number;
  /** The far rail's width when the drag began. It does not move. */
  farRailPx: number;
  viewportPx: number;
  /** The article's narrowest, from `MEASURE_RANGE`. */
  minColumnPx: number;
}): {
  leftRailPx: number;
  columnPx: number;
  rightRailPx: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
} {
  const farRail = Math.max(RAIL_LANE_PX, input.farRailPx);
  // The rail cannot grow past the room the article's own minimum leaves.
  // Without this a long drag would hand the grid a track wider than the row
  // and the three would stop filling it. The pointer is past the end of the
  // gesture; the edge stops.
  const draggedRail = Math.min(
    Math.max(RAIL_LANE_PX, input.viewportPx - input.minColumnPx - farRail),
    Math.max(RAIL_LANE_PX, input.draggedRailPx),
  );
  const column = Math.min(
    maxColumnWidth(input.viewportPx),
    Math.max(input.minColumnPx, input.viewportPx - draggedRail - farRail),
  );
  const leftRailPx = input.side === "left" ? draggedRail : farRail;
  const rightRailPx = input.side === "right" ? draggedRail : farRail;
  return {
    leftRailPx,
    columnPx: column,
    rightRailPx,
    leftCollapsed: railCollapsed(leftRailPx),
    rightCollapsed: railCollapsed(rightRailPx),
  };
}

export type ReadingPrefsState = ReadingPrefs & {
  update: (patch: Partial<ReadingPrefs>) => void;
  /** Back to the responsive defaults, including the closed notes panel. */
  reset: () => void;
};

export const useReadingPrefs = create<ReadingPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_READING_PREFS,

      // Every write goes through `normalizeReadingPrefs`, so a caller cannot
      // store a value the reader would refuse to load — the panel's options
      // and the blob's contents cannot drift apart.
      update: (patch) =>
        set((state) => normalizeReadingPrefs({ ...state, ...patch })),

      reset: () => set({ ...DEFAULT_READING_PREFS }),
    }),
    {
      name: "gloss-reading",
      version: 2,
      /**
       * v1 stored `notesOpen` but nothing read it — the notes rail was
       * drawn at every width — so a stored `false` is the old default, not
       * a choice. v2 is where the field became the rail's visibility, and
       * treating that `false` as a real preference would make the notes
       * panel vanish for everyone who had ever opened the reader. The
       * migration says so out loud rather than hiding it behind a changed
       * default that a persisted blob would override anyway.
       */
      migrate: (persisted, version) => {
        if (version >= 2 || !persisted || typeof persisted !== "object") {
          return persisted;
        }
        return { ...(persisted as Record<string, unknown>), notesOpen: true };
      },
      merge: (persisted, current) => ({
        ...current,
        ...normalizeReadingPrefs(persisted),
      }),
    },
  ),
);

/** Snapshot helper for non-React call sites. */
export function readReadingPrefs(): ReadingPrefsState {
  return useReadingPrefs.getState();
}
