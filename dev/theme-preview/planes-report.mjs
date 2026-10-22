// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { PALETTES, hexToRgb } from "./palettes.js";
import { ratio, luminance } from "./color.js";

/** CIE L* — perceptual lightness, 0..100. */
function lstar(rgb) {
  const y = luminance(rgb);
  const e = 216 / 24389, k = 24389 / 27;
  return y > e ? 116 * Math.cbrt(y) - 16 : k * y;
}

const f = (n) => n.toFixed(1).padStart(5);
console.log("面与面之间的落差：对比度（现用指标）vs ΔL*（人眼实际能分辨的指标）\n");
console.log("候选/实现            bg→surface   surface→surface2   bg→surface2   text→bg");
console.log("─".repeat(84));
for (const p of PALETTES) {
  const t = p.tokens;
  const bg = hexToRgb(t.bg), s = hexToRgb(t.surface), s2 = hexToRgb(t.surface2), tx = hexToRgb(t.text);
  const dl = (a, b) => Math.abs(lstar(a) - lstar(b));
  console.log(
    `${(p.name + (p.kind === "current" ? "（对照）" : "")).padEnd(20)}` +
      `${f(ratio(s, bg))}:1 / ΔL* ${f(dl(bg, s))}   ` +
      `${f(ratio(s2, s))}:1 / ΔL* ${f(dl(s, s2))}   ` +
      `${f(ratio(s2, bg))}:1 / ΔL* ${f(dl(bg, s2))}   ` +
      `ΔL* ${f(dl(tx, bg))}`,
  );
}
console.log("\nΔL* 经验门槛：< 2 基本看不出是两个面；2–3 边缘可辨；3–6 清楚是两块；> 6 像浮起来的另一层。");
