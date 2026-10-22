// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deterministic cover art for text articles.
 *
 * The reader's library is full of pasted text and imported pages: there is
 * no photograph to put on a card, and a grid of identical placeholders is
 * exactly the "flat, no blocks" look this surface is trying to replace.
 *
 * So each article gets a small piece of generated art derived from its own
 * title: a two-tone wash from the current theme's palette plus the first
 * meaningful glyph of the title. It is deterministic (the same article
 * keeps the same cover after a reload and on a second device that has the
 * same title), and it has no image request, no storage and no licensing
 * question.
 *
 * ## 三条来源，顺序固定
 *
 * 1. **文章自己的图**：抓取时拿到的 `og:image` 或正文首图。URL 导入的文章
 *    绝大多数落在这里。
 * 2. **插画库**：`public/covers/` 里的 12 张画，按文章 id 挑一张。给没有
 *    网页图的文章一张“像封面”的图，比让它空着或只剩渐变要好读得多。
 * 3. **标题渐变 + 首字**：最后兜底。插画文件缺失、加载失败，或者构建里
 *    根本没带 `public/covers/` 时，仍然有一块属于这篇文章的图。
 *
 * 插画挑法是**按 id 确定**的，不是每次刷新重抽：同一篇文章在列表、阅读页、
 * 刷新后、第二台设备上都是同一张。看起来是“随机配图”，但不会在读者眼皮
 * 底下换一张——那种变化读起来像 bug，而不是设计。
 *
 * The background is a CSS string built from theme variables, never a
 * hard-coded colour, so all four palettes (light / dark / sepia / paper)
 * stay in step. `foreground` is only used for the glyph; the component
 * supplies its own type size.
 */

export type CoverArt = {
  /** Ready for `style.background`: stacked gradients over the surface. */
  background: string;
  /** Glyph colour; a theme-relative translucent ink. */
  foreground: string;
  /** One grapheme from the title, or "文" when the title has none. */
  glyph: string;
  /**
   * A picture to draw: the article's own (`og:image` / first content image)
   * or one painting from the bundled library, keyed by the article id.
   * Absent when neither exists — the wash is then the whole cover.
   */
  image?: string;
};

/** Number of paintings in `public/covers/` (`01.webp` … `12.webp`). */
export const COVER_IMAGE_COUNT = 12;

/**
 * The application's base path, with Vite's trailing slash: `/` in dev and
 * `/reader/` in the release build.
 *
 * The optional chain keeps the module importable in Node (unit tests), where
 * `import.meta.env` is undefined and a dev-style `/` is the right answer —
 * the same guard `lib/settings.ts` uses for its env reads.
 */
const viteEnv = (import.meta as { env?: { BASE_URL?: string } }).env ?? {};
const APP_BASE = viteEnv.BASE_URL ?? "/";

/**
 * Where a bundled painting lives, resolved against the application base.
 *
 * Not a hard-coded `/covers/…`: the release build is served from `/reader/`,
 * so `/covers/01.webp` asks the *site root* — a different site, which answers
 * 404 — and every article without a picture of its own fell back to the bare
 * wash. `import/pdf.ts` resolves the staged pdf.js files against the base for
 * this same reason.
 */
export function coverImagePath(index: number, base: string = APP_BASE): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}covers/${String(index).padStart(2, "0")}.webp`;
}

/**
 * Pick one painting from the default cover library.
 *
 * Deterministic: the same article keeps the same painting after a reload and
 * on a second device, which is what makes it read as *its* cover rather than
 * as decoration that reshuffles under the reader. The seed is the article id
 * (not the title) so two articles with the same title still differ.
 *
 * The files are addressed by convention rather than imported, so replacing
 * one is a file operation: drop `01.webp` … `12.webp` into `public/covers/`
 * and keep `COVER_IMAGE_COUNT` in step. `undefined` when the library is
 * empty, so the generated wash remains the fallback instead of a broken image.
 */
export function coverImageFor(seed: string): string | undefined {
  if (COVER_IMAGE_COUNT <= 0) return undefined;
  const index = (hashSeed(seed || "untitled") % COVER_IMAGE_COUNT) + 1;
  return coverImagePath(index);
}

/**
 * One colour family per cover: a top tint, a bottom tint and an angle.
 *
 * The triplets are fixed RGB channels, composited over the theme surface at
 * low alpha, rather than `--accent`/`--highlight`. Two reasons:
 *
 *  - the themes' accent and highlight are both warm, so every cover came out
 *    the same beige and the library read as one repeated placeholder;
 *  - a fixed hue at low alpha keeps its identity on the day and night
 *    palettes (it darkens or lightens with the surface under it) without
 *    needing a second colour table per theme.
 *
 * Alpha is tuned so day leaves a pale paper tint and night leaves a deep,
 * desaturated wash — both low enough that the glyph stays the brightest thing
 * on the tile.
 */
const PALETTES: ReadonlyArray<{
  angle: number;
  a: readonly [number, number, number];
  b: readonly [number, number, number];
}> = [
  // bronze / sutra paper
  { angle: 135, a: [178, 132, 84], b: [122, 86, 58] },
  // slate blue / technology
  { angle: 150, a: [82, 118, 168], b: [50, 78, 118] },
  // sage / nature and observation
  { angle: 120, a: [100, 140, 104], b: [62, 98, 74] },
  // stone / city and architecture
  { angle: 160, a: [128, 126, 132], b: [86, 84, 94] },
  // terracotta / humanities
  { angle: 140, a: [176, 112, 96], b: [124, 72, 64] },
  // muted violet / philosophy
  { angle: 130, a: [132, 114, 164], b: [86, 72, 116] },
  // teal / reading notes
  { angle: 145, a: [84, 136, 134], b: [54, 96, 96] },
  // warm grey / everything else
  { angle: 155, a: [150, 138, 118], b: [102, 92, 78] },
];

/** FNV-1a over UTF-16 code units. Stable across runs and platforms. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Opening punctuation and quotes a title often starts with. */
const LEADING_NOISE = /^[\s《》〈〉「」『』【】\[\]（）()、，。·—…“”‘’"'!！?？:：;；\-–—]+/u;

/**
 * Characters that carry no identity at cover size: a lone 一 is a horizontal
 * line, 第 is furniture, 的/是/在 are grammar. A title starting with one of
 * these gets its first two characters considered, so 一份关于注意力的产品笔记
 * shows 份 rather than a dash.
 */
const WEAK_GLYPHS = new Set(
  Array.from("一二三四五六七八九十第的了吗呢是在有我你他她它这那有和与之也就都而及或但很还又把被从对为以上中下大小"),
);

/**
 * The first visible character of a title, without its typographic wrapper:
 * 《金刚经》文白对照 becomes 金, not 《.
 */
export function coverGlyph(title: string): string {
  const stripped = title.replace(LEADING_NOISE, "").trim();
  const chars = Array.from(stripped);
  if (chars.length === 0) return "文";
  // Look at the first three characters for one with visual identity, but
  // never skip past a whole short title.
  const candidate =
    chars.slice(0, Math.min(3, chars.length)).find((char) => !WEAK_GLYPHS.has(char)) ??
    chars[0]!;
  return /[a-z]/.test(candidate) ? candidate.toUpperCase() : candidate;
}

/**
 * Cover art for an article.
 *
 * `seed` (normally the title) decides the palette and the glyph, so the tile
 * is stable: the same article looks the same after a reload and on a second
 * device.
 *
 * `imageSeed` (normally the article id) decides which painting from the
 * bundled library is used when the article has no picture of its own. It is
 * the id rather than the title so two articles with the same title still get
 * different pictures — and it is a seed rather than a random draw so a cover
 * never changes under the reader.
 *
 * `articleImage` is the article's own picture — the scraped page's share image
 * or its first content image. It wins when present; the bundled painting is
 * the fallback for articles that have none (pasted text, pages without a
 * picture), and the wash is the last resort when even that file is missing.
 */
export function coverArtFor(
  seed: string,
  imageSeed: string = seed,
  articleImage?: string,
): CoverArt {
  const hash = hashSeed(seed || "untitled");
  const palette = PALETTES[hash % PALETTES.length]!;
  const angle = palette.angle + (hash % 18);
  const [ar, ag, ab] = palette.a;
  const [br, bg, bb] = palette.b;
  // A low-alpha diagonal grain keeps the tile from looking like a flat
  // swatch on the light palettes without reading as a texture.
  const grain = `repeating-linear-gradient(${angle + 70}deg, rgb(var(--text) / 0.035) 0 1px, transparent 1px 7px)`;
  const wash = `linear-gradient(${angle}deg, rgb(${ar} ${ag} ${ab} / 0.46), rgb(${br} ${bg} ${bb} / 0.34))`;
  const glow = `radial-gradient(120% 90% at 15% 0%, rgb(255 255 255 / 0.12), transparent 62%)`;
  const own =
    articleImage && /^(?:https?:\/\/|\/)/i.test(articleImage) ? articleImage : undefined;
  const image = own ?? coverImageFor(imageSeed);
  return {
    background: `${grain}, ${glow}, ${wash}, rgb(var(--surface2))`,
    foreground: "rgb(var(--text) / 0.6)",
    glyph: coverGlyph(seed),
    ...(image ? { image } : {}),
  };
}
