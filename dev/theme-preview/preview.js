// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Review harness for the candidate palettes.
 *
 * Three jobs:
 *   1. turn `palettes.js` into `[data-theme="<id>"]` blocks and inject them,
 *      so the whole page flips through the app's own token contract;
 *   2. drive the mode / candidate controls;
 *   3. render the measured contrast table and the token inventory, from the
 *      same `measure()` the Node report uses.
 *
 * The only state it keeps is which candidate is selected for each mode, in
 * `localStorage["gloss-theme-preview"]` — a preview-only key, deliberately
 * not `gloss-theme`, so opening this page cannot disturb the app's own
 * saved theme.
 */

import {
  PALETTES,
  candidatesFor,
  currentFor,
  cssVars,
  hexToRgb,
} from "./palettes.js";
import { measure } from "./measure.js";
import { toHex } from "./color.js";

const STORE_KEY = "gloss-theme-preview";

/** `[data-theme="id"] { --bg: 253 253 252; ... }` for one palette. */
function blockFor(palette) {
  const vars = cssVars(palette);
  const body = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  const scheme = palette.mode === "day" ? "light" : "dark";
  return `[data-theme="${palette.id}"] {\n  color-scheme: ${scheme};\n${body}\n}`;
}

function injectPaletteCss() {
  const style = document.createElement("style");
  style.id = "rv-palette-css";
  style.textContent = PALETTES.map(blockFor).join("\n\n");
  document.head.appendChild(style);
}

function loadState() {
  const fallback = { day: candidatesFor("day")[0].id, night: candidatesFor("night")[0].id };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    // An unknown id — a palette removed since the last visit — falls back
    // rather than leaving the page on a theme block that does not exist.
    const valid = (mode) =>
      PALETTES.some((p) => p.id === parsed?.[mode] && p.mode === mode)
        ? parsed[mode]
        : fallback[mode];
    return { day: valid("day"), night: valid("night") };
  } catch {
    return fallback;
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Private modes can refuse writes; the preview still works in-session.
  }
}

export function start() {
  injectPaletteCss();

  const state = loadState();
  let mode = "day";
  let showingBaseline = false;

  const chips = document.getElementById("rv-chips");
  const chipsLabel = document.getElementById("rv-candidates-label");
  const modeButtons = Array.from(document.querySelectorAll("[data-mode]"));
  const contrastToggle = document.getElementById("rv-toggle-contrast");
  const contrastBody = document.getElementById("rv-contrast-body");
  const tokensBody = document.getElementById("rv-tokens");

  /** The palette currently painted on the page. */
  function activePalette() {
    if (showingBaseline) return currentFor(mode);
    return PALETTES.find((p) => p.id === state[mode]);
  }

  function apply() {
    const palette = activePalette();
    document.documentElement.setAttribute("data-theme", palette.id);
    document.documentElement.style.colorScheme = palette.mode === "day" ? "light" : "dark";
    document
      .getElementById("app-mode-toggle")
      .setAttribute(
        "title",
        palette.mode === "day" ? "主题：日间（点击切换到夜间）" : "主题：夜间（点击切换到日间）",
      );
    document.getElementById("app-mode-toggle").textContent = palette.mode === "day" ? "☀" : "☾";
  }

  function renderChips() {
    chipsLabel.textContent = `${mode === "day" ? "日间" : "夜间"}配色`;
    chips.textContent = "";

    const entries = [
      ...candidatesFor(mode).map((p) => ({ palette: p, baseline: false })),
      { palette: currentFor(mode), baseline: true },
    ];

    for (const { palette, baseline } of entries) {
      const selected = showingBaseline === baseline && state[mode] === palette.id;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `rv-chip${selected ? " is-active" : ""}`;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(selected));
      button.title = `${palette.name} · ${palette.sourceName}`;

      const dot = document.createElement("span");
      dot.className = "rv-chip__dot";
      dot.style.background = palette.tokens.bg;
      dot.style.boxShadow = `inset 0 0 0 1px rgb(${hexToRgb(palette.tokens.outline).join(" ")})`;

      const label = document.createElement("span");
      label.textContent = palette.name;

      const tag = document.createElement("span");
      tag.className = "rv-chip__tag";
      // Name the reading app the paper and ink came from — that is the
      // thing being compared here, so it belongs on the chip.
      tag.textContent = baseline ? "对照" : palette.sourceName.split(/[ ·]/)[0];

      button.append(dot, label, tag);
      button.addEventListener("click", () => {
        showingBaseline = baseline;
        if (!baseline) {
          state[mode] = palette.id;
          saveState(state);
        }
        apply();
        renderChips();
        renderReport();
      });
      chips.appendChild(button);
    }
  }

  function renderReport() {
    const palette = activePalette();
    const { rows, failures } = measure(palette);

    const table = document.createElement("table");
    table.className = "rv-table";
    table.innerHTML =
      "<thead><tr><th>检查项</th><th>阈值</th><th style='text-align:right'>实测</th><th style='text-align:right'>判定</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      const failed = row.min !== null && row.value < row.min;
      if (failed) tr.className = "is-fail";
      tr.innerHTML = `
        <td>${row.label}</td>
        <td class="is-value">${row.min === null ? "—" : `≥ ${row.min}`}</td>
        <td class="is-value">${row.value.toFixed(2)}:1</td>
        <td style="text-align:right" class="${failed ? "rv-fail" : "rv-ok"}">${
          row.min === null ? "·" : failed ? "✘" : "✔"
        }</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const summary = document.createElement("p");
    summary.className = "rv-section__hint";
    summary.innerHTML = failures.length
      ? `<strong>${palette.name}</strong>：${failures.length} 项未达标 — ${failures
          .map((f) => f.label)
          .join("、")}`
      : `<strong>${palette.name}</strong>：全部达标`;

    const notes = document.createElement("ul");
    notes.className = "rv-notes";
    for (const note of palette.notes) {
      const li = document.createElement("li");
      li.textContent = note;
      notes.appendChild(li);
    }

    const source = document.createElement("p");
    source.className = "rv-section__hint";
    source.innerHTML = `来源：${palette.source.label}　许可：${palette.license}`;

    contrastBody.textContent = "";
    contrastBody.append(source, summary, table, notes);

    tokensBody.textContent = "";
    const grid = document.createElement("div");
    grid.className = "rv-tokens";
    const origin = (name) => {
      if (name === "bg" || name === "text") return "源";
      if (palette.adaptedTokens?.includes(name)) return "适配";
      if (palette.carriedTokens?.includes(name)) return "沿用";
      return "";
    };
    for (const [name, value] of Object.entries(palette.tokens)) {
      const item = document.createElement("div");
      item.className = "rv-token";
      const swatch = document.createElement("span");
      swatch.className = "rv-token__swatch";
      swatch.style.background = value;
      const label = document.createElement("span");
      label.className = "rv-token__name";
      label.textContent = name;
      const hexLabel = document.createElement("span");
      const mark = origin(name);
      hexLabel.textContent = `${toHex(hexToRgb(value))}　rgb(${hexToRgb(value).join(" ")})${
        mark ? `　[${mark}]` : ""
      }`;
      item.append(swatch, label, hexLabel);
      grid.appendChild(item);
    }
    const scalars = document.createElement("div");
    scalars.className = "rv-token";
    scalars.textContent = `codeAlpha ${palette.codeAlpha}　markAlpha ${palette.markAlpha}　lineAlpha ${palette.lineAlpha}`;
    grid.appendChild(scalars);
    tokensBody.appendChild(grid);
  }

  function setMode(next) {
    mode = next;
    showingBaseline = false;
    for (const button of modeButtons) {
      button.classList.toggle("is-active", button.dataset.mode === next);
    }
    apply();
    renderChips();
    renderReport();
  }

  for (const button of modeButtons) {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  }

  // The app's own quick switch is a pure day/night flip, so the mock's
  // toggle is one too — it never walks through the candidates.
  document.getElementById("app-mode-toggle").addEventListener("click", () => {
    setMode(mode === "day" ? "night" : "day");
  });

  document.querySelector(".ctl__focus").classList.add("is-forced");

  contrastToggle.addEventListener("click", () => {
    const section = document.getElementById("rv-contrast");
    const hidden = section.style.display === "none";
    section.style.display = hidden ? "" : "none";
    contrastToggle.classList.toggle("is-active", hidden);
  });

  setMode("day");
}
