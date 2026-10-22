// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 抓来的图片地址要能真的加载出来。
 *
 * 三个地方需要同一条规则，所以它只有一份：网页图片块（HTML / Jina Markdown
 * 两条抓取路径）、封面（`og:image`）、以及从块里挑封面的兜底。
 *
 * 规则本身很短，但它解决的是三个真实故障：
 *
 *   1. **相对地址**。页面里的 `src="/img/hero.png"` 只有配上那个站点的
 *      origin 才成立。原样存下来，渲染时会被当成我们自己站点的图片，于是
 *      404 或更糟——显示成我们的某张图。所以相对地址必须按源 URL 解析，
 *      没有源 URL 就干脆不显示（宁缺勿错）。
 *   2. **`data:` / `blob:`**。抓取结果里偶尔会带内联图片。它们不能进正文
 *      存储（一篇文章多出几百 KB 的 base64，还会经同步传给账号），也不能
 *      作为封面写进记录。一律丢弃。
 *   3. **页面 chrome**。`logo`、`icon`、`avatar`、`sprite`、`1x1` 之类的
 *      地址不是内容图。拿它当封面比没有封面更糟，因为它看起来是“对的”。
 *
 * 纯函数，不碰 DOM 之外的任何东西，也不读配置。
 */

/** 一个图片地址的长度上限。超过它多半是内联数据或被拼坏了的字符串。 */
export const IMAGE_URL_MAX = 2048;

/**
 * 页面 chrome 的图片地址特征：logo / icon / 头像 / 精灵图 / 占位图 / 追踪
 * 像素。按路径分段匹配，所以 `/images/logo.svg` 和 `logo.png` 都命中，
 * 而 `/images/catalog.png` 不会（`catal` 不是分段）。
 *
 * 允许一个复数 `s`（`icons/`、`sprites.png`、`logos.svg`）：站点把它们放在
 * 目录里是常态，漏掉复数的代价是拿一张站点图标去当文章封面。
 */
export const CHROME_IMAGE_PATTERN =
  /(?:^|[/_\-.])(?:logo|icon|avatar|sprite|spinner|badge|pixel|blank|spacer|placeholder|1x1)s?(?:[/_\-.]|$)/i;

/**
 * 这个地址是否指向一张“内容图”。
 *
 * 只看地址形态，不看它是否真的能加载——加载是渲染层的事。
 */
export function isContentImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const value = url.trim();
  if (value.length === 0 || value.length > IMAGE_URL_MAX) return false;
  return !CHROME_IMAGE_PATTERN.test(value);
}

/**
 * 把抓到的图片地址归一化成可以放进 `<img src>` 的绝对 http(s) 地址。
 *
 * `baseUrl` 是**图片所在页面**的地址（不是我们的站点）。
 *
 * 返回 `undefined` 的四种情况，都是“显示出来只会更糟”：
 *   - 空地址、超长地址；
 *   - `data:` / `blob:` / `javascript:` 等非 http(s)、非相对地址；
 *   - 相对地址但没有 `baseUrl`；
 *   - `baseUrl` 本身不是合法的 http(s) 地址（浏览器里可能是 `about:blank`）。
 *
 * 同源判定交给调用方：这里不关心结果是不是本站资源。
 */
export function absolutizeImageUrl(
  raw: string | null | undefined,
  baseUrl?: string | null,
): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > IMAGE_URL_MAX) return undefined;
  // `data:`/`blob:` 单独挡掉，剩下的 http(s) 原样返回。
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  const base = (baseUrl ?? "").trim();
  if (base.length === 0 || !/^https?:\/\//i.test(base)) return undefined;
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

/**
 * 页面声明的分享图：`og:image` → `og:image:url` → `twitter:image` →
 * `twitter:image:src` → `<link rel="image_src">`。
 *
 * 顺序是刻意的。`og:image` 是 Open Graph 的标准位置，主流站点都会给；
 * Twitter 的字段是它在缺失时的替代，`image_src` 更老。第一个能解析成可用
 * 地址的就赢，全部失败返回 `undefined`（调用方再退回正文第一张图）。
 */
export function shareImageFromDocument(
  doc: Pick<Document, "querySelector">,
  baseUrl?: string | null,
): string | undefined {
  const candidates = [
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    doc.querySelector('meta[property="og:image:url"]')?.getAttribute("content"),
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content"),
    doc.querySelector('meta[name="twitter:image:src"]')?.getAttribute("content"),
    doc.querySelector('link[rel="image_src"]')?.getAttribute("href"),
  ];
  for (const candidate of candidates) {
    const resolved = absolutizeImageUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return undefined;
}
