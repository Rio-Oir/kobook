// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Colour maths for the palette preview.
 *
 * Shared by the browser preview (`index.html`) and the Node measurement
 * script (`contrast-report.mjs`) so the numbers shown on screen and the
 * numbers in the report come from one implementation.
 *
 * Everything here works on `[r, g, b]` arrays of 0–255 integers.
 * Relative luminance and the contrast ratio follow WCAG 2.x:
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */

/** `#rrggbb` → `[r, g, b]`. Throws on anything else so a typo is loud. */
export function hex(value) {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`not a 6-digit hex colour: ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `[r, g, b]` → `"#rrggbb"`. */
export function toHex(rgb) {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** Space-separated channel triplet, the form the app's CSS variables use. */
export function triplet(rgb) {
  return rgb.map((c) => Math.round(c)).join(" ");
}

/** `rgb(r g b)` / `rgb(r g b / a)` — the CSS form the app writes. */
export function css(rgb, alpha) {
  return alpha === undefined
    ? `rgb(${triplet(rgb)})`
    : `rgb(${triplet(rgb)} / ${alpha})`;
}

/** Linearise one 0–255 sRGB channel (WCAG 2.x definition). */
function linear(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an `[r, g, b]`. */
export function luminance(rgb) {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours. Order does not matter. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Linear interpolation in sRGB space. Used only for the few tokens a source
 * palette does not define (a `surface2` step, a control outline) — every such
 * value is labelled "适配" in the research record rather than presented as an
 * official colour.
 */
export function mix(a, b, t) {
  return a.map((c, i) => c + (b[i] - c) * t);
}

/** Contrast of `fg` over `bg` composited at `alpha` — for highlight washes. */
export function over(fg, bg, alpha) {
  return mix(bg, fg, alpha);
}

/** Ratio rounded to two decimals, for reporting. */
export function ratio(a, b) {
  return Math.round(contrast(a, b) * 100) / 100;
}

/**
 * Smallest step from `from` toward `toward` that reaches `target` contrast
 * against `ref`, by bisection.
 *
 * Used to derive the tokens a reader palette does not define — the chrome
 * steps and the control outline — from the two values it *does* define (its
 * paper and its ink). Mixing paper into ink keeps the derived greys on the
 * paper's own hue, which is what stops a chrome plane from looking like a
 * different theme bolted on.
 */
export function solveMix(from, toward, ref, target, epsilon = 0.002) {
  if (contrast(from, ref) >= target) return from.slice();
  let lo = 0;
  let hi = 1;
  if (contrast(mix(from, toward, hi), ref) < target) return null;
  while (hi - lo > epsilon) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(from, toward, mid), ref) >= target) hi = mid;
    else lo = mid;
  }
  return mix(from, toward, hi);
}

/**
 * The *most faded* step from `from` toward `toward` that still clears
 * `target` against `ref` — the opposite end of the same search.
 *
 * Used for the secondary text tone: a de-emphasis colour should sit as far
 * from the body colour as the threshold allows, not as close to it as
 * possible, or it is not de-emphasis at all.
 */
export function fadeTo(from, toward, ref, target, epsilon = 0.002) {
  if (contrast(from, ref) < target) return null;
  let lo = 0;
  let hi = 1;
  while (hi - lo > epsilon) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(from, toward, mid), ref) >= target) lo = mid;
    else hi = mid;
  }
  return mix(from, toward, lo);
}

/**
 * Nudge `color` until it clears `target` against `ref`, moving toward
 * whichever of black / white gets there in fewer steps. Returns the original
 * if it already passes, and the best available attempt if neither pole
 * reaches the target.
 */
export function ensureContrast(color, ref, target) {
  if (contrast(color, ref) >= target) return { color: color.slice(), step: 0 };
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  const candidates = [];
  for (const pole of [black, white]) {
    for (let t = 0; t <= 1.0001; t += 0.005) {
      const c = mix(color, pole, t);
      if (contrast(c, ref) >= target) {
        candidates.push({ color: c, step: t });
        break;
      }
    }
  }
  if (candidates.length === 0) {
    const best = contrast(mix(color, black, 1), ref) > contrast(mix(color, white, 1), ref)
      ? black
      : white;
    return { color: best.slice(), step: 1 };
  }
  candidates.sort((a, b) => a.step - b.step);
  return candidates[0];
}


