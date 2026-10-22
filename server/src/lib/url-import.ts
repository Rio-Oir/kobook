// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Server URL extraction: controlled HTTP + Readability only.
 *
 * 2026-10-15 rule: the server never calls Jina — not for anonymous
 * requests, not for signed-in ones, and not when a `JINA_API_KEY` is
 * configured. A key in the environment cannot re-enable it. The
 * `jina*` fields on {@link ImportFromUrlOptions} are accepted so
 * existing callers keep compiling, and are ignored.
 *
 * The browser is still allowed to call Jina directly
 * (`browser-jina`), which is why the wire vocabulary keeps that
 * source; the server writes `server-readability` for everything it
 * fetches itself.
 *
 * DNS pinning, TLS verification, per-hop redirect gating and the
 * streaming size cap are unchanged — this module only lost its
 * second extractor, not any of its protections.
 *
 * **Egress proxy fallback (2026-10-22).** A direct pinned request is still the
 * first attempt, but on a network whose direct egress is tampered with or
 * blocked, "connect to what the system resolver returned" is consistently
 * wrong rather than occasionally slow: measured here, `kevinkelly.substack.com`
 * resolved to a Dropbox address that hangs, `medium.com` to a Twitter address,
 * `www.nytimes.com` to a Facebook one, while the same pages came back through
 * the machine's local proxy in under half a second. When `EXTRACT_PROXY_URL`
 * (or `HTTPS_PROXY` / `HTTP_PROXY`) is set, a hop that fails at the network
 * level is retried once through that proxy; see `proxy-fetch.ts` for what this
 * costs (the address pin cannot survive a proxy) and why it is config-only and
 * fallback-only.
 */
import type { ParsedDocument, ExtractorId } from "../../../shared/contracts/index.js";
import { parseHtml, parseMarkdown } from "./parse/index.js";
import { extractWithSiteRule, requestHeadersFor } from "./site-rules.js";
import {
  CONNECT_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  SsrfBlockedError,
  SsrfTimeoutError,
  assertProxyEligibleHostname,
  parseUrlOrThrow,
  resolvePublicAddress,
} from "./ssrf-guard.js";
import {
  PinnedTimeoutError,
  PinnedTooLargeError,
  pinnedRequest,
  type PinnedResponse,
} from "./pinned-fetch.js";
import { proxiedRequest, proxyFromEnv } from "./proxy-fetch.js";

/**
 * How long the direct attempt gets when an egress proxy is configured.
 *
 * A tampered DNS answer *hangs* instead of refusing, so waiting the full
 * `CONNECT_TIMEOUT_MS` before falling back to the proxy would add five seconds
 * to every blocked site. Three seconds is enough for an honest route to answer
 * and short enough that the fallback still fits inside the route's budget.
 */
const PROXY_DIRECT_BUDGET_MS = 3_000;

/**
 * Attempts per hop on the proxied path, and the pause between them.
 *
 * Measured against the local proxy on the Substack URL: 18/20 and 19/20
 * attempts succeeded, each failure being an immediate reset during the tunnel's
 * TLS handshake ("client network socket disconnected before secure TLS
 * connection was established") — the proxy's own upstream dial racing, not a
 * property of the target, and the same URL succeeded moments later. Three
 * attempts at ~350 ms put that below one failure in a thousand; a real outage
 * still fails fast, because a failed attempt costs ~100 ms, not the deadline.
 */
const PROXY_ATTEMPTS = 3;
const PROXY_RETRY_DELAY_MS = 80;

/**
 * How long a host stays "known to need the proxy" after one direct failure.
 *
 * Without this, every import pays the direct attempt first, and on this network
 * that attempt *hangs* rather than refuses: measured 3.3–4.5 s per import for
 * `kevinkelly.substack.com` even though the proxy answered in 330 ms. The
 * memory is deliberately short and process-local: it is a routing hint, not
 * configuration, and a proxy that goes away must not strand a host for long.
 */
const PROXY_PREFERENCE_TTL_MS = 10 * 60_000;

/** hostname → epoch ms until which the proxy should be tried first. */
const proxyPreferredUntil = new Map<string, number>();

function proxyPreferred(hostname: string): boolean {
  const until = proxyPreferredUntil.get(hostname);
  if (until === undefined) return false;
  if (until < Date.now()) {
    proxyPreferredUntil.delete(hostname);
    return false;
  }
  return true;
}

function rememberEgress(hostname: string, needsProxy: boolean): void {
  if (!needsProxy) {
    proxyPreferredUntil.delete(hostname);
    return;
  }
  if (proxyPreferredUntil.size > 256) proxyPreferredUntil.clear();
  proxyPreferredUntil.set(hostname, Date.now() + PROXY_PREFERENCE_TTL_MS);
}

/**
 * Legacy: the reason the resolver used to fall back off Jina.
 *
 * Nothing produces these any more (the Jina path is gone). The type
 * survives because `ImportResult.fallbackReason` and the anonymous
 * extract response still carry the optional field, and dropping them
 * would be a wire change for no benefit.
 */
export type FallbackReason =
  | "no-jina-key"
  | "jina-http-error"
  | "jina-empty"
  | "jina-timeout"
  | "jina-parse-error";

export interface ImportResult {
  document: ParsedDocument;
  /**
   * Which extractor produced the document. `"html-readability"` for
   * every result this module now produces; `"jina"` stays in the union
   * because the anonymous-extract response contract still speaks it
   * (older response shapes are still readable by the client).
   */
  extractor: "jina" | "html-readability";
  /** Legacy; never set by the current implementation. */
  fallbackReason?: FallbackReason;
}

export class UrlImportNotReadyError extends Error {
  readonly statusCode = 501;
  constructor(message = "URL 导入尚未上线，请粘贴正文。") {
    super(message);
    this.name = "UrlImportNotReadyError";
  }
}

/**
 * The source answered, but with its own "this page is not available" status
 * instead of an article.
 *
 * This is deliberately a *different* error from the challenge shells
 * {@link detectInterstitial} describes, because the two need opposite
 * handling:
 *
 *   - a challenge page (login wall, JS shell, captcha) might still be readable
 *     through another extractor, so it stays a generic upstream failure and the
 *     browser's Jina fallback may try;
 *   - a status page says the content is gone (deleted, expired, refused,
 *     "参数错误"), so no extractor will produce it. That must reach the user as
 *     a definite refusal, not as "we failed, please retry".
 *
 * Carrying it as a typed error is what lets the routes keep the message while
 * still mapping the case to `422 EMPTY_ARTICLE` — the same code the text import
 * uses when nothing retainable was extracted. A 422 also tells the browser
 * client to stop: `mayTryJinaAfterServer` refuses to fall through on it, so the
 * user is not sent to a third party for a page that does not exist.
 */
export class ContentUnavailableError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "ContentUnavailableError";
  }
}

/**
 * The source answered, but with a challenge rather than the article: a login
 * wall, a JavaScript shell, or a verification endpoint it redirected us to.
 *
 * Retryable by design — the article exists, this client just is not allowed in
 * right now — which is why it is a different type from
 * {@link ContentUnavailableError}. Carrying the message in a typed error is what
 * lets the routes hand our own sentence to the user: the app-wide handler strips
 * messages from untyped 5xx responses, so without this the reader gets
 * "抓取失败，请稍后重试" for a page that would work in their browser, with no
 * hint that verification is what stood in the way.
 */
export class UpstreamChallengeError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = "UpstreamChallengeError";
  }
}

export interface ImportFromUrlOptions {
  /**
   * Legacy, ignored. Accepted so callers that still read the
   * environment keep compiling; a configured key does **not** cause
   * a Jina request. See the module header.
   */
  jinaApiKey?: string;
  /** Legacy, ignored (see `jinaApiKey`). */
  jinaBaseUrl?: string;
  /** Legacy, ignored (see `jinaApiKey`). */
  jinaResolvedAddress?: string;
  /** Override the User-Agent the fetch sends. */
  userAgent?: string;
  /**
   * Extra trusted CA bundle (PEM) for the upstream connection.
   *
   * Set only by the controlled test fixture, which stands up a local
   * HTTPS upstream signed by a private CA. It adds a trust anchor; it
   * does not disable verification (see `lib/pinned-fetch.ts`), and no
   * request body can reach it.
   */
  tlsCa?: string;
  /** Aborts the whole resolver. */
  signal?: AbortSignal;
}

/**
 * Resolves a URL into the same `ParsedDocument` shape the text path
 * produces. The `source` field on the document is one of the
 * `ExtractorId` values, so downstream code (the import route, the
 * Reader) does not need to know which extractor ran.
 */
export async function importFromUrl(
  rawUrl: string,
  options: ImportFromUrlOptions = {},
): Promise<ImportResult> {
  // 1. Parse + DNS gate the user-supplied URL. The strict gate runs first; only
  //    when it fails because the *local resolver's* answer is unusable and a
  //    proxy is configured does the proxied path take over (see
  //    `resolveFirstHop`).
  const url = parseUrlOrThrow(rawUrl);
  const address = await resolveFirstHop(url);

  // 2. 2026-10-15: controlled direct HTTP only. `options.jinaApiKey` /
  //    `jinaBaseUrl` / `jinaResolvedAddress` are deliberately not read:
  //    a configured key must not be able to reintroduce a Jina egress.
  const doc = await directReadabilityFetch(url, address, options);
  return { document: doc, extractor: "html-readability" };
}

/**
 * The address the next hop may be pinned to, or `null` when only the egress
 * proxy can reach it.
 *
 * The strict gate is tried first and wins whenever it can: a public answer means
 * a pinned direct request, which is the strongest form. It fails in two very
 * different situations, and only the second one is allowed to continue:
 *
 *   - the name really does point inside the network → refuse, proxy or not;
 *   - the name resolves to something unusable because the resolver is tampered
 *     with (measured on this deployment: Dropbox addresses for Substack, Twitter
 *     addresses for Medium, Teredo tunnels for the same host on a later lookup)
 *     → `assertProxyEligibleHostname` decides whether the *name* is safe to hand
 *     to the proxy.
 */
async function resolveFirstHop(url: URL): Promise<string | null> {
  const proxy = proxyFromEnv();
  if (proxy !== null && proxyPreferred(url.hostname)) {
    // Learned earlier: the direct path does not work for this host. The safety
    // question still gets asked, because the hint is about routing, not trust.
    await assertProxyEligibleHostname(url.hostname);
    return null;
  }
  try {
    return await resolvePublicAddress(url.hostname);
  } catch (err) {
    if (proxy === null) throw err;
    await assertProxyEligibleHostname(url.hostname);
    return null;
  }
}

interface FetchOptions {
  tlsCa?: string;
  userAgent?: string;
  signal?: AbortSignal;
}

/**
 * Whether the response came from a site's "complete the verification" endpoint
 * rather than from the page the user asked for.
 *
 * Checked on the **final URL** because that is the one signal the source itself
 * gives us, and it is exact: WeChat answers an automated client with a redirect
 * to `/mp/wappoc_appmsgcaptcha?poc_token=…`, whose body is captcha chrome and
 * site-footer words ("视频", "小程序", "赞", "在看"). Measured here: that body
 * contains no challenge *phrase* the text heuristics look for, so without this
 * check the reader imports nine blocks of that chrome as an article. Nothing in
 * the HTML is trustworthy; the redirect it took is.
 *
 * Exported for the unit test; the rule is not host-specific in principle, but
 * WeChat is the one host where we have the observed endpoint.
 */
export function isVerificationEndpoint(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "mp.weixin.qq.com") return false;
  return url.pathname.startsWith("/mp/wappoc_appmsgcaptcha") || url.searchParams.has("poc_token");
}

async function directReadabilityFetch(
  target: URL,
  address: string | null,
  options: FetchOptions,
): Promise<ParsedDocument> {
  // The first request is pinned to the resolved address so the second
  // DNS lookup (the one `fetch` would do internally) cannot return a
  // different IP. For HTTPS, the TLS identity stays the original
  // hostname: the connection goes to `address`, but SNI and the
  // certificate check use `target.hostname`, so a real HTTPS origin
  // validates normally and verification is never weakened.
  const { response, finalUrl } = await fetchWithRedirects(target, address, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`直接抓取失败：${response.status} ${response.statusText}`);
  }
  if (isVerificationEndpoint(finalUrl)) {
    // Retryable on purpose: this is the site asking for a browser, not a
    // statement that the article is gone (that is `ContentUnavailableError`).
    throw new UpstreamChallengeError("网页需要完成验证才能读取，无法直接提取，请稍后重试或粘贴正文。");
  }
  const interstitial = detectInterstitial(response.body);
  if (interstitial) {
    throw new UpstreamChallengeError(`${interstitial}，请粘贴正文。`);
  }
  // A page the source itself declares unavailable is terminal: there is no
  // text to extract, and Readability would happily turn the status line into a
  // one-paragraph "article" the reader cannot tell from real content.
  const unavailable = detectUnavailableContent(response.body);
  if (unavailable) {
    throw new ContentUnavailableError(unavailable);
  }
  // `baseUrl` lets the walker turn relative `<img src>` values in the fetched
  // markup into absolute URLs. It is a resolution origin only — nothing is
  // fetched from it here.
  //
  // A known host gets its own container first (`site-rules.ts`): for WeChat,
  // Zhihu, QQ/163 news and a few others, Readability's failure mode is "keeps
  // the site chrome", which a single reviewed CSS selector removes. Anything
  // the table does not know — and any rule that matched a page without an
  // article in it — falls through to the generic extraction below.
  const site = extractWithSiteRule(response.body, target);
  if (site !== null) {
    const fromRule =
      site.kind === "html"
        ? parseHtml(site.content, {
            remoteArticle: true,
            baseUrl: target.toString(),
            ...(site.title === undefined ? {} : { title: site.title }),
          })
        : parseMarkdown(site.content, site.title === undefined ? {} : { title: site.title });
    if (fromRule.ok) return fromRule.document;
  }
  const parsed = parseHtml(response.body, {
    remoteArticle: true,
    baseUrl: target.toString(),
  });
  if (!parsed.ok) {
    throw new Error(`Readability 解析失败：${parsed.message}`);
  }
  return parsed.document;
}

/**
 * The page's visible text: scripts, styles and tags removed, whitespace
 * collapsed.
 *
 * Shared by both shell detectors so "what the reader would see" has one
 * definition. Stripping `<script>` first matters: a page whose text lives in a
 * JSON bootstrap still has no *visible* text, and both rules would otherwise
 * read the payload as prose.
 */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The user-facing reason a fetched body is an interstitial rather than
 * an article — or `null` when it looks like real content.
 *
 * Exported and pure so the rule is unit-testable without standing up a
 * TLS upstream. The wording it returns is the *first half* of the
 * message the route ends up showing; the caller appends "，请粘贴正文。".
 *
 * Two rules, deliberately loose in different directions:
 *
 *   - A **title** that is a bare challenge phrase ("Sign in", "Just a
 *     moment", "验证码") is decisive on its own, because a real article
 *     is not titled that way.
 *   - Otherwise the body has to *both* be short and contain a
 *     recognizable challenge phrase. Requiring both is what keeps the
 *     check from misfiring on a genuinely short article — the rule is
 *     "this is a challenge page", not "this is under N words". There is
 *     **no word-count or language floor**: a two-sentence Chinese
 *     paragraph is an article, and an earlier revision of this area
 *     dropped short Chinese paragraphs precisely by measuring length.
 */
export function detectInterstitial(html: string): string | null {
  const visible = visibleText(html);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  if (
    /^(?:\s*)(?:sign in|log in|login|just a moment|access denied|verify you are human|登录|验证码)/i.test(
      title,
    )
  ) {
    return "网页需要登录、验证或浏览器脚本，无法直接提取";
  }
  if (
    visible.length < 700 &&
    /enable javascript|javascript is not available|verify you are human|sign in to (?:x|twitter)|登录后查看|请启用.*javascript|完成验证码|环境异常|访问过于频繁|请完成验证/i.test(
      visible,
    )
  ) {
    return "网页需要登录、验证或浏览器脚本，无法直接提取";
  }
  if (visible.length === 0) {
    // A body with no visible text at all produced nothing to read; it
    // is not an article and must not be saved as one.
    return "网页没有可读取的正文";
  }
  return null;
}

/**
 * Status phrases a site uses when the page itself is unavailable — deleted,
 * expired, withdrawn, or refused to this visitor. Each is the site's own
 * wording, so it is quoted back rather than translated.
 *
 * "环境异常" is deliberately **not** here: it is WeChat's wording for "your
 * environment looks automated, complete the verification", which is a challenge
 * (`detectInterstitial`) and not a statement about the content. Filing it as
 * unavailable told the user their article had been deleted when it had not.
 */
const UNAVAILABLE_STATUS_PHRASES = [
  "参数错误",
  "系统错误",
  "页面不存在",
  "内容不存在",
  "内容已被删除",
  "该内容已被发布者删除",
  "此内容因违规无法查看",
  "该公众号已迁移",
  "链接已过期",
] as const;

/**
 * WeChat's WeUI message component, which every one of its error pages uses:
 * `<div class="weui-msg__title warn">参数错误</div>`. Matched structurally so
 * the phrase is read from the banner rather than from wherever it happens to
 * fall in the page's chrome.
 */
const WEUI_STATUS_BANNER = /<[^>]*class="[^"]*\bweui-msg__title\b[^"]*"[^>]*>([\s\S]{0,200}?)<\//i;

/**
 * A page whose visible text is nothing but the site's own status line is worth
 * less than a short article: it has no title, no paragraphs and no content, and
 * Readability turns it into one block of that phrase. Importing it produces a
 * "fake article" the reader cannot tell apart from real reading material.
 */
const STATUS_PAGE_VISIBLE_LIMIT = 300;

/**
 * The user-facing reason a fetched page is the site saying "this is not
 * available", or `null` when it is ordinary content.
 *
 * Kept separate from {@link detectInterstitial} because the outcomes differ:
 * this one is terminal (see {@link ContentUnavailableError}), while a challenge
 * shell may still be bypassed.
 *
 * Three rules, each anchored on something a real article does not have:
 *
 *   - the **status banner** of the site's message component (WeUI's
 *     `weui-msg__title`) carries one of the phrases;
 *   - the **page title is exactly** one of them — a real article is not titled
 *     "参数错误". Exact, not prefix, so a legitimate title like
 *     “内容不存在时的用户体验” is not refused;
 *   - the **visible text starts with** one of them *and* the whole page is
 *     short. This is the shape the WeChat error page has once its app chrome is
 *     stripped: `参数错误 ： ， ， … 视频 小程序 赞 …`. Requiring the phrase to
 *     come first (and a separator after it, so “参数错误率…” does not count) is
 *     what keeps a technical article that merely discusses "参数错误" from being
 *     refused — there the phrase sits in the body, and the page is longer than
 *     the limit besides.
 *
 * Exported and pure for the same reason as `detectInterstitial`: the rule is
 * testable without a network.
 */
export function detectUnavailableContent(html: string): string | null {
  const banner = WEUI_STATUS_BANNER.exec(html)?.[1];
  const bannerPhrase = banner === undefined ? null : matchStatusPhrase(banner, "leading");
  if (bannerPhrase !== null) return unavailableMessage(bannerPhrase);

  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
  const titlePhrase = matchStatusPhrase(title, "exact");
  if (titlePhrase !== null) return unavailableMessage(titlePhrase);

  const visible = visibleText(html);
  if (visible.length === 0 || visible.length > STATUS_PAGE_VISIBLE_LIMIT) return null;
  const leadingPhrase = matchStatusPhrase(visible, "leading");
  return leadingPhrase === null ? null : unavailableMessage(leadingPhrase);
}

/**
 * What may follow a status phrase that starts a text.
 *
 * The WeUI banner and the stripped WeChat page both put punctuation after it
 * (`参数错误 ：`), and a bare phrase ends the string. Requiring one of these is
 * what separates a status line from a sentence that merely begins with the same
 * characters.
 */
const STATUS_PHRASE_BOUNDARY = /^(?:$|[\s:：·、，,。.!！?？\-—])/;

/**
 * The status phrase `text` carries, if any.
 *
 * `exact` demands the whole text be the phrase; `leading` accepts the phrase at
 * the front followed by a boundary. Leading decorations are stripped first, so
 * a status line's own punctuation does not hide the match.
 */
function matchStatusPhrase(text: string, mode: "exact" | "leading"): string | null {
  const cleaned = visibleText(text).replace(/^[\s:：·、，,。.!！?？\-—]+/, "");
  if (cleaned.length === 0) return null;
  for (const phrase of UNAVAILABLE_STATUS_PHRASES) {
    if (mode === "exact") {
      if (cleaned === phrase) return phrase;
      continue;
    }
    if (cleaned.startsWith(phrase) && STATUS_PHRASE_BOUNDARY.test(cleaned.slice(phrase.length))) {
      return phrase;
    }
  }
  return null;
}

/** The sentence the client shows for an unavailable source page. */
function unavailableMessage(phrase: string): string {
  return `原文不可用：源站返回「${phrase}」，这篇内容可能已被删除、过期，或不允许网页直接访问。请确认链接是否有效，或粘贴正文导入。`;
}

/** One hop through the configured proxy, retried once (see `PROXY_ATTEMPTS`). */
async function fetchViaProxy(
  proxy: URL,
  url: URL,
  headers: Record<string, string>,
  options: FetchOptions,
): Promise<PinnedResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PROXY_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw lastError ?? new Error("请求已取消。");
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, PROXY_RETRY_DELAY_MS));
    try {
      return await proxiedRequest({
        url,
        proxyUrl: proxy,
        timeoutMs: CONNECT_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
        headers,
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Follow the redirect chain, returning the response **and** the URL it finally
 * came from.
 *
 * The final URL is not diagnostic detail: it is the only trustworthy signal a
 * source gives when it reroutes an automated client to a verification endpoint
 * (see `isVerificationEndpoint`), and the redirect target is exactly what the
 * fetch layer already knows and the parser cannot recover from the body.
 */
async function fetchWithRedirects(
  initial: URL,
  initialAddress: string | null,
  options: FetchOptions,
): Promise<{ response: PinnedResponse; finalUrl: URL }> {
  let url = initial;
  let address = initialAddress;
  // Read per import, not at module load: an operator can change the value, and
  // a test can set it for one call.
  const proxy = proxyFromEnv();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Per hop, because a redirect can cross into a host with its own profile.
    const siteHeaders = requestHeadersFor(url);
    const requestHeaders: Record<string, string> = {
      accept: "text/html,application/xhtml+xml",
      // A host that needs a particular identity gets it from its rule; every
      // other host sees the importer's own UA.
      "User-Agent": siteHeaders["User-Agent"] ?? "gloss-server/0.3 (URL importer)",
      ...siteHeaders,
    };
    // An explicit caller override (tests, a deployment that needs to identify
    // itself) still wins, so a site rule cannot trap a caller.
    if (options.userAgent !== undefined) requestHeaders["User-Agent"] = options.userAgent;
    let response: PinnedResponse;
    let viaProxy = address === null;
    if (address === null) {
      // No usable address for this hop: `resolveFirstHop` already established
      // that the name is safe to hand to the proxy and that the local answer
      // could not be pinned (see its note). Trying the direct path anyway would
      // only wait for the deadline.
      if (proxy === null) {
        throw new SsrfBlockedError(`无法为 ${url.hostname} 解析出可直连的公网地址。`);
      }
      try {
        response = await fetchViaProxy(proxy, url, requestHeaders, options);
      } catch (err) {
        // The hint said "this host needs the proxy"; it just failed. Drop the
        // hint and give the direct path one chance, so a proxy that went away
        // does not take the importer with it.
        rememberEgress(url.hostname, false);
        let pinned: string | null = null;
        try {
          pinned = await resolvePublicAddress(url.hostname);
        } catch {
          throw err;
        }
        if (options.signal?.aborted) throw err;
        response = await pinnedRequest({
          url,
          address: pinned,
          timeoutMs: CONNECT_TIMEOUT_MS,
          maxBytes: MAX_RESPONSE_BYTES,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.tlsCa ? { ca: options.tlsCa } : {}),
          headers: requestHeaders,
        });
        viaProxy = false;
      }
    } else {
      try {
        response = await pinnedRequest({
          url,
          address,
          // With a proxy configured, the direct attempt gets a shorter leash:
          // a tampered DNS answer hangs rather than refuses, and there is no
          // point paying the full deadline before asking the proxy.
          timeoutMs:
            proxy === null ? CONNECT_TIMEOUT_MS : Math.min(CONNECT_TIMEOUT_MS, PROXY_DIRECT_BUDGET_MS),
          maxBytes: MAX_RESPONSE_BYTES,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.tlsCa ? { ca: options.tlsCa } : {}),
          headers: requestHeaders,
        });
      } catch (err) {
        if (err instanceof PinnedTooLargeError || err instanceof SsrfBlockedError) {
          // A body over the cap is an upstream problem, not a refusal of the
          // URL, and both are real answers rather than a path that is blocked —
          // neither may be re-attempted through the proxy.
          throw err;
        }
        if (options.signal?.aborted) throw err;
        if (proxy === null) {
          if (err instanceof PinnedTimeoutError) throw new SsrfTimeoutError(err.message);
          throw err;
        }
        // Direct egress failed at the network level: the address the system
        // resolver gave us is unreachable or tampered with (measured on this
        // deployment — see `proxy-fetch.ts`). Try the configured egress proxy
        // for the same hop before reporting a failure.
        try {
          response = await fetchViaProxy(proxy, url, requestHeaders, options);
          viaProxy = true;
        } catch {
          // Report the direct failure: it is the one that describes this
          // deployment's problem ("timeout"/"connection reset"), while a proxy
          // error would only add a second layer of indirection.
          if (err instanceof PinnedTimeoutError) throw new SsrfTimeoutError(err.message);
          throw err;
        }
      }
    }
    // Remember which egress worked for this host, so the next import does not
    // pay the direct attempt again (see `PROXY_PREFERENCE_TTL_MS`).
    rememberEgress(url.hostname, viaProxy);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) {
        // No `Location` header on a 3xx is the server's bug, but
        // treating it as the final response is the safer choice.
        return { response, finalUrl: url };
      }
      const next = new URL(response.location, url);
      // Every hop re-runs the same DNS / range gate, so a redirect into
      // loopback or the metadata service is refused mid-chain.
      address = await resolveFirstHop(next);
      url = next;
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new SsrfBlockedError(`重定向超过 ${MAX_REDIRECTS} 跳上限。`);
}

// Re-exported so callers that took `ExtractorId` from this module keep
// compiling; it is a shared-contract type, not this module's own.
export type { ExtractorId };
