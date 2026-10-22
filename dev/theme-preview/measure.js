// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The contrast checks a candidate palette has to clear, in one place.
 *
 * Imported by both the Node report (`contrast-report.mjs`) and the browser
 * preview (`preview.js`), so the table on screen and the table in the
 * research record are the same measurement.
 *
 * See `contrast-report.mjs` for what each row means.
 */

import { hexToRgb, THRESHOLDS } from "./palettes.js";
import { contrast, mix, ratio } from "./color.js";

/** Composite `fg` at `alpha` over `bg`, then measure `text` on the result. */
function textOverWash(text, fg, bg, alpha) {
  return ratio(text, mix(bg, fg, alpha));
}

const HIGHLIGHT_SLOTS = [
  ["yellow", "hlYellow"],
  ["green", "hlGreen"],
  ["blue", "hlBlue"],
  ["red", "hlRed"],
];

/** Every row the review reports, with its measured value and its threshold. */
export function measure(palette) {
  const t = palette.tokens;
  const bg = hexToRgb(t.bg);
  const surface = hexToRgb(t.surface);
  const surface2 = hexToRgb(t.surface2);
  const text = hexToRgb(t.text);
  const textDim = hexToRgb(t.textDim);
  const accent = hexToRgb(t.accent);
  const outline = hexToRgb(t.outline);
  const border = hexToRgb(t.border);
  const highlight = hexToRgb(t.highlight);

  const rows = [
    { key: "body", label: "正文 / 阅读面", value: ratio(text, bg), min: THRESHOLDS.body },
    { key: "body-chrome", label: "正文 / chrome", value: ratio(text, surface), min: THRESHOLDS.body },
    { key: "dim", label: "次级文字 / 阅读面", value: ratio(textDim, bg), min: THRESHOLDS.body },
    { key: "dim-chrome", label: "次级文字 / chrome", value: ratio(textDim, surface), min: THRESHOLDS.body },
    { key: "link", label: "链接 / 阅读面", value: ratio(accent, bg), min: THRESHOLDS.body },
    { key: "link-chrome", label: "链接 / chrome", value: ratio(accent, surface), min: THRESHOLDS.body },
    { key: "outline", label: "控件描边 / 控件底", value: ratio(outline, surface2), min: THRESHOLDS.control },
    { key: "outline-bg", label: "控件描边 / 阅读面", value: ratio(outline, bg), min: THRESHOLDS.control },
    { key: "border", label: "装饰描边 / 阅读面", value: ratio(border, bg), min: null },
    { key: "step", label: "chrome 与阅读面的落差", value: ratio(surface, bg), min: null },
    {
      key: "code",
      label: "行内代码文字",
      value: textOverWash(text, highlight, bg, palette.codeAlpha),
      min: THRESHOLDS.body,
    },
  ];

  for (const [slot, key] of HIGHLIGHT_SLOTS) {
    const c = hexToRgb(t[key]);
    rows.push({
      key: `mark-${slot}`,
      label: `划线底（${slot}）上的文字`,
      value: textOverWash(text, c, bg, palette.markAlpha),
      min: THRESHOLDS.body,
    });
    rows.push({
      key: `line-${slot}`,
      label: `划线线色（${slot}）`,
      value: ratio(mix(bg, c, palette.lineAlpha), bg),
      min: THRESHOLDS.control,
    });
  }

  const failures = rows.filter((r) => r.min !== null && r.value < r.min);
  return { rows, failures };
}
