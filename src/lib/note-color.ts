// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { HighlightColor } from "./types";

/**
 * The colour a note wears when it has none of its own — the blue the
 * sidebar, the passage underline and the connector have all used since
 * before notes carried a colour. Kept as a literal rather than routed
 * through `--hl-blue` on purpose: the two are deliberately not the same
 * blue, and swapping a note's identity colour out from under every note
 * written so far is not a change this feature gets to make silently.
 */
export const NOTE_COLOR_FALLBACK_RGB = "100 133 220";

/**
 * A note's colour as an `rgb()` value at a given alpha.
 *
 * A note with its own colour resolves to the same `--hl-*` channel the
 * highlight in the article body uses, so "this passage is marked red" and
 * "this note is red" are literally the same colour and stay that way
 * across a theme change. A note without one falls back to the legacy
 * blue.
 *
 * Returned as a finished `rgb()` string rather than a bare channel so the
 * same helper can serve both the themed and the unthemed case: a bare
 * triplet would have to be interpolated into `rgb(… / α)` at every call
 * site, and the fallback is a hex, which cannot go inside that form.
 */
export function noteColorRgb(
  color: HighlightColor | undefined,
  alpha = 1,
): string {
  const channel =
    color === "yellow" || color === "green" || color === "blue" || color === "red"
      ? `var(--hl-${color})`
      : NOTE_COLOR_FALLBACK_RGB;
  return `rgb(${channel} / ${alpha})`;
}

/**
 * The same colour as an opaque value, for the one place that cannot take
 * an alpha: the inline `style` the connector's stroke is drawn with.
 */
export function noteColorSolid(color: HighlightColor | undefined): string {
  const channel =
    color === "yellow" || color === "green" || color === "blue" || color === "red"
      ? `var(--hl-${color})`
      : NOTE_COLOR_FALLBACK_RGB;
  return `rgb(${channel})`;
}