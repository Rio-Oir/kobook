// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Highlight vocabulary — colours and shapes, in one place.
 *
 * Both the selection toolbar and the manage-popover render the same
 * two rows (four colours, three shapes) and the renderer needs the
 * same "what does an unknown/legacy value mean" answer, so the tables
 * live here rather than inside `Reader.tsx`.
 *
 * The CSS that turns these values into a look is in `index.css`
 * (`.gloss-mark[data-color]` / `[data-style]`); adding a shape means
 * one entry here plus one rule there.
 */

import type { HighlightColor, HighlightStyle } from "./types";

/** The four highlight colours, in swatch order. */
export const HIGHLIGHT_COLORS: HighlightColor[] = [
  "yellow",
  "green",
  "blue",
  "red",
];

export const HIGHLIGHT_COLOR_LABEL: Record<HighlightColor, string> = {
  yellow: "黄色",
  green: "绿色",
  blue: "蓝色",
  red: "红色",
};

/** The three mark shapes, in picker order. */
export const HIGHLIGHT_STYLES: HighlightStyle[] = [
  "watercolor",
  "line",
  "curve",
];

export const HIGHLIGHT_STYLE_LABEL: Record<HighlightStyle, string> = {
  watercolor: "水彩",
  line: "直线",
  curve: "曲线",
};

/**
 * What a highlight with no `style` renders as. `Highlight.style` is
 * optional because rows written before shapes shipped have no value
 * for it and the store deliberately stays at version 2 (see the type
 * comment). Watercolour is the look those rows were drawn with, so an
 * unmigrated highlight keeps the appearance it had.
 */
export const DEFAULT_HIGHLIGHT_STYLE: HighlightStyle = "watercolor";

/**
 * Resolve a possibly-missing style to a renderable one. Written as a
 * runtime membership check rather than `?? default` so a value that
 * is *not* one of the three (a hand-edited localStorage blob, a
 * future name that was rolled back) cannot produce a `<mark>` with no
 * matching CSS rule — that renders as an invisible highlight, which
 * looks like data loss.
 */
export function resolveHighlightStyle(
  style: string | undefined,
): HighlightStyle {
  return HIGHLIGHT_STYLES.includes(style as HighlightStyle)
    ? (style as HighlightStyle)
    : DEFAULT_HIGHLIGHT_STYLE;
}

/**
 * Same idea for colour: `Highlight.color` is a required field, but it
 * still comes out of localStorage, where anything can have been
 * typed.
 */
export function resolveHighlightColor(color: string): HighlightColor {
  return HIGHLIGHT_COLORS.includes(color as HighlightColor)
    ? (color as HighlightColor)
    : "yellow";
}
