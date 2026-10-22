// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Candidate palettes for the 2026-10-19 colour review — second attempt.
 *
 * The first attempt was built on Radix (a UI component scale) and on
 * Solarized / Nord / Rosé Pine (terminal and code-editor themes). Those are
 * not reading palettes, and the result showed it: a purple-tinted body
 * colour, a teal link and an amber code tint all sitting on warm cream, i.e.
 * three unrelated hues on one page.
 *
 * This set is built on what open-source **reading** software actually
 * ships, and the three things they agree on are the whole design:
 *
 *   1. **Ink is near-neutral.** Thorium ships black and `#fff`; Foliate
 *      ships `#000`, `#ddd`, `#ccc`; Readium CSS's default text colour is
 *      `#121212`. The one tinted ink in either app is Foliate's Sepia
 *      `#5b4636`, a warm brown that follows the warm paper instead of
 *      fighting it.
 *   2. **Paper is low-chroma.** White, cream, oatmeal, near-black. Nothing
 *      saturated.
 *   3. **One hue per page.** A reader has no brand accent: Readium CSS
 *      defaults links to the web's `#0000EE`, and Foliate gives each theme
 *      exactly one link colour. Colour appears in *markers*, never in the
 *      reading surface.
 *
 * ## What comes from the readers, and what does not
 *
 *   paper / ink   taken verbatim from the named reader, used in the role
 *                 that reader uses it for. This is the part readers solve,
 *                 and the part the first attempt got wrong.
 *   chrome        **derived.** A reader needs two colours; this app needs
 *                 three surface steps and a control outline. They are
 *                 derived from the source's own paper and ink by
 *                 `deriveChrome()` — mixing paper into ink keeps every
 *                 derived grey on the paper's hue — and are labelled 适配.
 *   accent        **not from the readers.** The app spends its accent on
 *                 active states, note badges, focus rings and selection
 *                 borders, not just links, so a reader's single link colour
 *                 is not a substitute. The existing brand accent is carried
 *                 through unchanged so this round compares paper and ink.
 *   highlights    **not from the readers.** The four marker hues already
 *                 ship and are already tuned; carried through unchanged.
 *
 * Nothing here is called an official theme. Every derived or carried value
 * is named in `adaptedTokens` / `carriedTokens` and explained in `notes`.
 */

import { hex, mix, toHex } from "./color.js";
import { solveMix, fadeTo, ensureContrast } from "./color.js";

/** Thresholds the review checks each candidate against. */
export const THRESHOLDS = {
  /** WCAG 2.x AA for normal-size body text. */
  body: 4.5,
  /** WCAG 1.4.11 non-text contrast, applied to the control outline. */
  control: 3,
};

/**
 * The app's own depth model, read off `src/index.css`: the chrome steps are
 * deliberately small (≈1.12–1.4:1) and the separation is carried by the
 * hairline, because a large fill jump makes cards compete with the text.
 * Deriving the reader candidates against the same numbers is what keeps
 * them looking like this app rather than like a different one.
 */
const DEPTH = { surface: 1.12, surface2: 1.25, border: 1.4 };

const P = (value) => hex(value);

/**
 * Derive the tokens a reader palette does not define, from the two it does.
 *
 * `ink` is what everything is mixed toward, so a warm paper yields warm
 * greys and a neutral paper yields neutral ones — the chrome never
 * introduces a hue of its own.
 */
function deriveChrome(bgHex, inkHex) {
  const bg = P(bgHex);
  const ink = P(inkHex);
  const step = (target) => solveMix(bg, ink, bg, target);
  const surface = step(DEPTH.surface);
  const surface2 = step(DEPTH.surface2);
  const border = step(DEPTH.border);
  // The control outline has to clear 3:1 against the *recessed* plane it is
  // drawn on, which is the harder of the two references.
  const outline = solveMix(bg, ink, surface2, THRESHOLDS.control);
  // Secondary text is still text, so it is held to AA on the chrome plane —
  // and faded as far as that allows, so it actually reads as secondary.
  const textDim = fadeTo(ink, bg, surface, THRESHOLDS.body + 0.1);
  return {
    surface: toHex(surface),
    surface2: toHex(surface2),
    border: toHex(border),
    outline: toHex(outline ?? ink),
    textDim: toHex(textDim ?? ink),
  };
}

// ── what the open-source readers publish ────────────────────────────────
const THORIUM = {
  neutral: { bg: "#fefefe", ink: "black" },
  sepia: { bg: "#faf4e8", ink: "black" },
  paper: { bg: "#e9ddc8", ink: "#000000" },
  night: { bg: "#121212", ink: "#ffffff" },
  contrast: { bg: "#000000", ink: "#ffffff" },
};

const FOLIATE = {
  light: { ink: "#000000", bg: "#ffffff", link: "blue" },
  sepia: { ink: "#5b4636", bg: "#efe7dd", link: "darkcyan" },
  gray: { ink: "#cccccc", bg: "#555555", link: "skyblue" },
  dark: { ink: "#dddddd", bg: "#292929", link: "cornflowerblue" },
};

const READIUM = { bg: "#ffffff", ink: "#121212", link: "#0000ee" };

/** KOReader's reading background, from its `creme` theme. */
const KOREADER = { bg: "#f5f1e6", ink: "#000000" };

/** The app's existing brand accent and marker hues, carried through. */
const BRAND = {
  day: { accent: "#bb3c2f", highlight: "#d9a52e" },
  night: { accent: "#f06e62", highlight: "#f0c674" },
};

const MARKERS = {
  day: { hlYellow: "#f5c828", hlGreen: "#78c85a", hlBlue: "#5aaaf0", hlRed: "#f0786e" },
  night: { hlYellow: "#dcb43c", hlGreen: "#64b450", hlBlue: "#5096dc", hlRed: "#dc645a" },
};

/** The app's current palettes, copied verbatim from `src/index.css`. */
const CURRENT_DAY = {
  bg: "#fbfaf7",
  surface: "#f1eee8",
  surface2: "#e7e3db",
  border: "#dedad2",
  outline: "#8f8b83",
  text: "#181715",
  textDim: "#64605a",
  accent: "#bb3c2f",
  highlight: "#d9a52e",
  ...MARKERS.day,
};

const CURRENT_NIGHT = {
  bg: "#0c0c0c",
  surface: "#161616",
  surface2: "#1e1e1e",
  border: "#2a2a2a",
  outline: "#6e6b66",
  text: "#ebe9e6",
  textDim: "#a09d97",
  accent: "#f06e62",
  highlight: "#f0c674",
  ...MARKERS.night,
};

/** Build one candidate: source paper + source ink, everything else derived. */
function candidate({
  id,
  mode,
  name,
  sourceName,
  source,
  license,
  bg,
  ink,
  notes,
}) {
  const chrome = deriveChrome(bg, ink);
  // The brand accent keeps its hue but is nudged only as far as it must be
  // to clear AA on the chrome plane — a deeper chrome than the app's own
  // leaves the untouched value a few hundredths short on some papers.
  const accent = ensureContrast(P(BRAND[mode].accent), P(chrome.surface), THRESHOLDS.body + 0.1);
  const accentHex = toHex(accent.color);
  const accentNote =
    accent.step === 0
      ? `强调色沿用应用现有的 ${BRAND[mode].accent}，在 chrome 面上实测已达标，未改动。`
      : `强调色沿用应用现有色相，但从 ${BRAND[mode].accent} 微调到 ${accentHex}（朝${accent.color[0] > 128 ? "亮" : "暗"}方向走 ${Math.round(accent.step * 100)}%），因为原值在 ${chrome.surface} 的 chrome 面上差一点点不到 4.5:1。`;

  return {
    id,
    mode,
    name,
    sourceName,
    kind: "adapted",
    source,
    license,
    tokens: {
      bg,
      ...chrome,
      text: ink,
      accent: accentHex,
      highlight: BRAND[mode].highlight,
      ...MARKERS[mode],
    },
    codeAlpha: mode === "day" ? 0.12 : 0.18,
    markAlpha: mode === "day" ? 0.35 : 0.28,
    lineAlpha: 0.95,
    // `bg` and `text` are the source's own; every other token is either
    // derived from them or carried over from the app's existing palette.
    adaptedTokens: ["surface", "surface2", "border", "outline", "textDim", "accent"],
    carriedTokens: ["highlight", "hlYellow", "hlGreen", "hlBlue", "hlRed"],
    notes: [...notes, CHROME_NOTE, accentNote, CARRIED_NOTE],
  };
}

const CHROME_NOTE =
  "chrome 三阶（surface / surface2 / border）与控件描边 outline 是推导值：阅读器只有「纸 + 墨」两个颜色，没有这些 token。这里以源的纸色为基准、向源的字色方向取最小步长，分别取到 1.12:1 / 1.25:1 / 1.40:1（应用 index.css 既有的深度目标），outline 取到对控件底 3:1。混合方向是纸→墨，所以暖纸得到暖灰、中性纸得到中性灰，chrome 不会自己引入一个色相。次级文字 textDim 同理，取在 chrome 面上仍能过 AA 的最淡一档。";

const CARRIED_NOTE =
  "四色划线沿用应用现有值，未改动。开源阅读器基本不定义品牌强调色——Readium CSS 的默认链接色是网页默认蓝 #0000EE，Foliate 每个主题只给一个链接色——但本应用的强调色还要用在选中态、笔记类型标记、焦点环和卡片选中描边上，不能照搬阅读器的单一链接色。";

export const PALETTES = [
  // ── 日间 ──────────────────────────────────────────────────────────
  candidate({
    id: "neutral-day",
    mode: "day",
    name: "中性白",
    sourceName: "Thorium Neutral + Readium CSS",
    source: {
      label: "Thorium Reader · Neutral 主题；Readium CSS 默认色",
      url: "https://github.com/edrlab/thorium-reader/blob/develop/src/renderer/reader/components/ReaderSettings/Themes.tsx",
    },
    license: "BSD-3-Clause",
    bg: THORIUM.neutral.bg,
    ink: READIUM.ink,
    notes: [
      `纸色 #fefefe 取自 Thorium Reader 的 Neutral 主题，字色 #121212 取自 Readium CSS 的默认 --RS__textColor（Thorium 的 Neutral 只写 black，Readium CSS 给了这个更精确的值）。`,
      CHROME_NOTE,
      CARRIED_NOTE,
      "这是最接近「阅读系统出厂设置」的一套：中性白纸、近黑字，没有任何色偏。",
    ],
  }),
  candidate({
    id: "creme-day",
    mode: "day",
    name: "米纸",
    sourceName: "KOReader Creme",
    source: {
      label: "KOReader · creme 主题",
      url: "https://github.com/koreader/koreader",
    },
    license: "AGPL-3.0",
    bg: KOREADER.bg,
    ink: KOREADER.ink,
    notes: [
      "纸色 #f5f1e6 与字色 #000000 取自 KOReader 的 creme 主题（电子墨水设备上使用最广的阅读底色之一）。本机抓取被网络策略拦截，该色值来自搜索摘要对 frontend/ui/data/creme.lua 的引用，未能逐字核对源文件——如需确证请自行打开该文件。",
      CHROME_NOTE,
      CARRIED_NOTE,
      "暖米色纸 + 纯黑字：护眼底色，但字色不带任何色相，所以不会出现「暖纸上压紫字」那种对撞。",
    ],
  }),
  candidate({
    id: "sepia-day",
    mode: "day",
    name: "旧纸",
    sourceName: "Foliate Sepia",
    source: {
      label: "Foliate · Sepia 主题",
      url: "https://github.com/johnfactotum/foliate/blob/master/src/theme.js",
    },
    license: "GPL-3.0",
    bg: FOLIATE.sepia.bg,
    ink: FOLIATE.sepia.ink,
    notes: [
      "纸色 #efe7dd 与字色 #5b4636 取自 Foliate 的 Sepia 主题，逐字来自其 src/theme.js。",
      "这是本组里唯一一套**带色相的正文**——暖褐字压在暖灰纸上。它成立的原因是字色跟着纸色走（同为暖调），而不是跟纸色对抗。这一条正好是第一版失败的对照：同样的思路，色相选错了方向就整页发怪。",
      CHROME_NOTE,
      CARRIED_NOTE,
    ],
  }),

  // ── 夜间 ──────────────────────────────────────────────────────────
  candidate({
    id: "night-night",
    mode: "night",
    name: "中性夜",
    sourceName: "Thorium Night",
    source: {
      label: "Thorium Reader · Night 主题",
      url: "https://github.com/edrlab/thorium-reader/blob/develop/src/renderer/reader/components/ReaderSettings/Themes.tsx",
    },
    license: "BSD-3-Clause",
    bg: THORIUM.night.bg,
    ink: THORIUM.night.ink,
    notes: [
      "纸色 #121212、字色 #ffffff 逐字取自 Thorium Reader 的 Night 主题。",
      CHROME_NOTE,
      CARRIED_NOTE,
      "中性近黑，与现有夜间（#0c0c0c）方向一致、略亮一档。纯白字在近黑底上是阅读系统的常规做法（Thorium 的 Night 与 Contrast1 都这么写）。",
    ],
  }),
  candidate({
    id: "graphite-night",
    mode: "night",
    name: "石墨",
    sourceName: "Foliate Dark",
    source: {
      label: "Foliate · Dark 主题",
      url: "https://github.com/johnfactotum/foliate/blob/master/src/theme.js",
    },
    license: "GPL-3.0",
    bg: FOLIATE.dark.bg,
    ink: FOLIATE.dark.ink,
    notes: [
      "纸色 #292929、字色 #dddddd 逐字取自 Foliate 的 Dark 主题。",
      CHROME_NOTE,
      CARRIED_NOTE,
      "比「中性夜」软一档：底色不是近黑而是深石墨，字色也不是纯白。对比度仍有 9:1 上下，但夜里刺眼程度明显低一些。",
    ],
  }),
  candidate({
    id: "contrast-night",
    mode: "night",
    name: "纯黑",
    sourceName: "Thorium Contrast1",
    source: {
      label: "Thorium Reader · Contrast1 主题",
      url: "https://github.com/edrlab/thorium-reader/blob/develop/src/renderer/reader/components/ReaderSettings/Themes.tsx",
    },
    license: "BSD-3-Clause",
    bg: THORIUM.contrast.bg,
    ink: THORIUM.contrast.ink,
    notes: [
      "纸色 #000000、字色 #ffffff 逐字取自 Thorium Reader 的 Contrast1 主题。Thorium 把纯黑纯白单列成一个对比度主题，而不是把它当默认夜间。",
      CHROME_NOTE,
      CARRIED_NOTE,
      "OLED 屏幕上最省电、也最不发光的一套；代价是纯黑与纯白之间的切换在暗环境里最刺眼，长时间读容易疲劳。",
    ],
  }),

  // ── 对照基线（非候选）────────────────────────────────────────────
  {
    id: "current-day",
    mode: "day",
    name: "现有日间",
    sourceName: "当前实现",
    kind: "current",
    source: { label: "本仓库 src/index.css", url: "" },
    license: "本项目自有",
    tokens: CURRENT_DAY,
    codeAlpha: 0.12,
    markAlpha: 0.35,
    lineAlpha: 0.95,
    adaptedTokens: [],
    carriedTokens: [],
    notes: ["当前实现的日间配色，仅作对照，不是候选。"],
  },
  {
    id: "current-night",
    mode: "night",
    name: "现有夜间",
    sourceName: "当前实现",
    kind: "current",
    source: { label: "本仓库 src/index.css", url: "" },
    license: "本项目自有",
    tokens: CURRENT_NIGHT,
    codeAlpha: 0.18,
    markAlpha: 0.28,
    lineAlpha: 0.95,
    adaptedTokens: [],
    carriedTokens: [],
    notes: ["当前实现的夜间配色，仅作对照，不是候选。"],
  },
];

/** Candidates for one mode, in review order. */
export function candidatesFor(mode) {
  return PALETTES.filter((p) => p.mode === mode && p.kind !== "current");
}

/** The comparison baseline for one mode. */
export function currentFor(mode) {
  return PALETTES.find((p) => p.mode === mode && p.kind === "current");
}

/**
 * Turn one palette into the CSS custom properties `index.css` expects,
 * expressed as space-separated channel triplets — the form Tailwind's
 * `rgb(var(--bg) / <alpha-value>)` template needs.
 */
export function cssVars(palette) {
  const t = palette.tokens;
  const vars = {};
  for (const key of Object.keys(t)) vars[`--${key}`] = P(t[key]).join(" ");
  vars["--code-alpha"] = String(palette.codeAlpha);
  vars["--hl-mark-alpha"] = String(palette.markAlpha);
  vars["--hl-line-alpha"] = String(palette.lineAlpha);
  return vars;
}

export { P as hexToRgb, mix, toHex };
