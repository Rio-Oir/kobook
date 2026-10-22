// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Measure every candidate palette against the contrast thresholds the
 * review has to clear, and print a table.
 *
 *   node dev/theme-preview/contrast-report.mjs            # human table
 *   node dev/theme-preview/contrast-report.mjs --json     # machine output
 *
 * The numbers here are the ones quoted in
 * `docs/配色研究记录-2026-10-19.md`. They are *measured*, not asserted —
 * the point of the exercise is that a palette which merely looks fine
 * cannot pass this table by inspection.
 *
 * What each row means:
 *
 *   body        `--text` on `--bg` — WCAG AA normal text, 4.5:1
 *   body/chrome `--text` on `--surface` — same text, on the chrome plane
 *   dim         `--textDim` on `--bg` — secondary text
 *   dim/chrome  `--textDim` on `--surface`
 *   link        `--accent` on `--bg` — links are text, so AA applies
 *   link/chrome `--accent` on `--surface`
 *   outline     `--outline` on `--surface2` — a control border, WCAG 1.4.11, 3:1
 *   outline/bg  `--outline` on `--bg` — e.g. a focused field on the page
 *   border      `--border` on `--bg` — decorative hairline, no threshold
 *   step        `--surface` vs `--bg` — the depth step, no threshold
 *   code        `--text` over the inline-code tint composited on `--bg`
 *   mark:<c>    `--text` over the highlight wash composited on `--bg`
 *   line:<c>    the highlight rule colour against `--bg` (non-text, 3:1)
 */

import { PALETTES, cssVars } from "./palettes.js";
import { measure } from "./measure.js";

const asJson = process.argv.includes("--json");

if (asJson) {
  console.log(
    JSON.stringify(
      PALETTES.map((p) => ({
        id: p.id,
        mode: p.mode,
        name: p.name,
        sourceName: p.sourceName,
        kind: p.kind,
        tokens: p.tokens,
        vars: cssVars(p),
        ...measure(p),
      })),
      null,
      2,
    ),
  );
} else {
  for (const p of PALETTES) {
    const { rows, failures } = measure(p);
    const tag = p.kind === "current" ? "对照" : "候选";
    console.log(`\n${"═".repeat(72)}`);
    console.log(`${p.mode === "day" ? "日间" : "夜间"} · ${p.name}（${p.sourceName}）  [${tag}]`);
    console.log("═".repeat(72));
    for (const r of rows) {
      const flag = r.min === null ? "  ·  " : r.value >= r.min ? "  ✔  " : "  ✘  ";
      const target = r.min === null ? "" : `  (需 ≥ ${r.min})`;
      console.log(`${flag}${r.label.padEnd(24, "　")} ${String(r.value).padStart(6)}${target}`);
    }
    if (failures.length) {
      console.log(`  → ${failures.length} 项未达标：${failures.map((f) => f.label).join("、")}`);
    } else {
      console.log("  → 全部达标");
    }
  }
  console.log("");
}
