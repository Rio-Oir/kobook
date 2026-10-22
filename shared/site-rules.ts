// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-host article rules — one table, two consumers.
 *
 * Modelled on OmniBox's reader (`omnibox-wizard`'s `html_reader`), which is the
 * closest production implementation of this idea: a short table of
 * "host → container selector (+ headers)" that runs *before* the generic
 * extractor, with Readability as the fallback rather than the only path.
 *
 * Why it is shared rather than server-only: the same saved page can reach us
 * two ways. The server fetches it (and knows the URL, so it matches by host),
 * or the reader saves the page to disk and imports the file (where the file has
 * no URL, but the markup still has `#js_content`). Both want the same table;
 * only the matching differs — host match on the server, marker probe in the
 * browser. Keeping the table here is what stops the two from drifting.
 *
 * Nothing in this module touches a DOM or the network, so it is safe in both
 * bundles.
 */

/** Request headers a host needs before it will serve the article HTML. */
export interface SiteRequestHeaders {
  "User-Agent"?: string;
  Referer?: string;
  "Accept-Language"?: string;
}

/**
 * An embedded JSON state blob, for sites that ship the article inside the page
 * instead of in the DOM (RedNote's `__INITIAL_STATE__`, Zhihu's
 * `js-initialData`, Toutiao's `RENDER_DATA`).
 *
 * The mechanism is implemented and tested; no shipped rule uses it yet, because
 * the three platforms that need it return their state only to a signed-in
 * browser (cookie, or a `x-s` signature we would have to forge) — a rule added
 * without a real response to check against would be guesswork.
 */
export interface SiteStateRule {
  /** Over the raw HTML; capture group 1 is the JSON object. */
  pattern: RegExp;
  /** Key path into the parsed JSON that holds the text. */
  path: readonly string[];
  /** Whether that string is markup or Markdown. */
  format: "html" | "markdown";
}

export interface SiteRule {
  /** Registrable host this rule owns; its subdomains inherit it. */
  host: string;
  /** Article containers, tried in order. First match with text wins. */
  containers?: readonly string[];
  /**
   * The subset of `containers` distinctive enough to be found **without a URL**,
   * which is what the browser's saved-file path needs.
   *
   * Deliberately narrower than `containers`: a saved file has no host to match
   * on, so the selector is the only evidence. `#js_content` or `.Post-RichText`
   * is evidence; a bare `article`, or `#content`, is not — every CMS ships one
   * of those, and probing them would skip Readability for pages this table
   * knows nothing about. A rule with no entry here is host-match only.
   */
  probeContainers?: readonly string[];
  /** Title sources, tried in order. A `meta[...]` selector reads `content`. */
  titles?: readonly string[];
  headers?: SiteRequestHeaders;
  state?: SiteStateRule;
}

/**
 * A container whose text is shorter than this is treated as "the selector
 * matched the page's skeleton, not its article": the caller then falls through
 * to the generic extractor instead of returning an empty document.
 */
export const MIN_CONTAINER_TEXT = 20;

/**
 * WeChat's own WebView identity. Without `MicroMessenger` the article endpoint
 * answers with a verification page instead of the article; the Referer is
 * checked alongside it.
 */
const WECHAT_WEBVIEW_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003129) NetType/WIFI Language/zh_CN";

/**
 * The table. Ordered most-specific-host first, because host matching is by
 * suffix (`zhuanlan.zhihu.com` must win over `zhihu.com`).
 *
 * Every entry is a host whose HTML we have actually inspected; adding one
 * without that is how a selector table rots.
 */
export const SITE_RULES: readonly SiteRule[] = [
  {
    host: "mp.weixin.qq.com",
    containers: ["#js_content", "div.rich_media_content"],
    probeContainers: ["#js_content", "div.rich_media_content"],
    titles: ["#activity-name", ".rich_media_title", 'meta[property="og:title"]'],
    headers: {
      "User-Agent": WECHAT_WEBVIEW_UA,
      Referer: "https://mp.weixin.qq.com/",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  },
  {
    host: "zhuanlan.zhihu.com",
    containers: [".Post-RichText", "article.Post-Main"],
    probeContainers: [".Post-RichText"],
    titles: ["h1.Post-Title", ".Post-Title", 'meta[property="og:title"]'],
  },
  {
    host: "zhihu.com",
    containers: [".AnswerItem .RichText", ".QuestionAnswer-content", ".RichText"],
    probeContainers: [".AnswerItem .RichText", ".QuestionAnswer-content"],
    titles: [".QuestionHeader-title", "h1"],
  },
  {
    host: "news.qq.com",
    containers: ["div.content-article", "#Cnt-Main-Article-QQ"],
    probeContainers: ["div.content-article", "#Cnt-Main-Article-QQ"],
    titles: [".post_title", "h1"],
  },
  {
    host: "163.com",
    containers: ["div.post_body", ".post_text", "#content"],
    probeContainers: ["div.post_body", ".post_text"],
    titles: [".post_title", "h1"],
  },
  {
    host: "github.com",
    containers: ["article.markdown-body", ".markdown-body"],
    probeContainers: ["article.markdown-body", ".markdown-body"],
    titles: ["article h1", "h1"],
  },
  {
    host: "medium.com",
    containers: ["article"],
    titles: ["article h1", "h1"],
  },
  {
    host: "juejin.cn",
    containers: [".article-content", "#article-root"],
    titles: ["h1.article-title", "h1"],
  },
];

/** The host part of `url`, lower-cased, without a trailing dot. */
export function hostnameOf(url: string | URL): string {
  try {
    return (url instanceof URL ? url : new URL(url)).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** The rule that owns `url`, or `null` when the generic extractor should run. */
export function findSiteRule(url: string | URL): SiteRule | null {
  const host = hostnameOf(url);
  if (host.length === 0) return null;
  for (const rule of SITE_RULES) {
    // Suffix match on label boundaries: `evilzhihu.com` must not inherit the
    // `zhihu.com` rule, and `www.zhihu.com` must.
    if (host === rule.host || host.endsWith(`.${rule.host}`)) return rule;
  }
  return null;
}

/** The request headers `url`'s host needs, or `{}` when it has no rule. */
export function requestHeadersFor(url: string | URL): Record<string, string> {
  const rule = findSiteRule(url);
  if (rule?.headers === undefined) return {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rule.headers)) {
    if (typeof value === "string" && value.length > 0) headers[name] = value;
  }
  return headers;
}
