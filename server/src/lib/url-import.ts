// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Server URL extraction: controlled HTTP + Readability only.
 *
 * The server never calls a third-party reader service — not for anonymous
 * requests, and not when such a key is present in the environment. The
 * `jina*` fields on {@link ImportFromUrlOptions} are accepted so existing
 * callers keep compiling, and are ignored.
 *
 * The browser may still call one directly (`browser-jina`), which is why the
 * wire vocabulary keeps that source; the server writes `server-readability`
 * for everything it fetches itself.
 *
 * DNS pinning, TLS verification, per-hop redirect gating and the streaming
 * size cap are what make this path safe to expose, and all four are enforced
 * below.
 */
import type { ParsedDocument, ExtractorId } from "../../../shared/contracts/index.js";
import { parseHtml } from "./parse/index.js";
import {
  CONNECT_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  SsrfBlockedError,
  SsrfTimeoutError,
  gateUrl,
} from "./ssrf-guard.js";
import {
  PinnedTimeoutError,
  PinnedTooLargeError,
  pinnedRequest,
  type PinnedResponse,
} from "./pinned-fetch.js";

/**
 * Legacy: the reason the resolver used to fall back off a reader service.
 *
 * Nothing produces these any more. The type survives because
 * `ImportResult.fallbackReason` and the anonymous extract response still
 * carry the optional field, and dropping them would be a wire change for no
 * benefit.
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
   * every result this module produces; `"jina"` stays in the union
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

export interface ImportFromUrlOptions {
  /**
   * Legacy, ignored. Accepted so callers that still read such a
   * value keep compiling; a configured key does **not** cause an
   * outbound request. See the module header.
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
  // 1. Parse + DNS gate the user-supplied URL.
  const { url, address } = await gateUrl(rawUrl);

  // 2. Controlled direct HTTP only. `options.jinaApiKey` /
  //    `jinaBaseUrl` / `jinaResolvedAddress` are deliberately not read: a
  //    configured value must not be able to reintroduce an egress this
  //    module does not have.
  const doc = await directReadabilityFetch(url, address, options);
  return { document: doc, extractor: "html-readability" };
}

interface FetchOptions {
  tlsCa?: string;
  userAgent?: string;
  signal?: AbortSignal;
}

async function directReadabilityFetch(
  target: URL,
  address: string,
  options: FetchOptions,
): Promise<ParsedDocument> {
  // The first request is pinned to the resolved address so the second
  // DNS lookup (the one `fetch` would do internally) cannot return a
  // different IP. For HTTPS, the TLS identity stays the original
  // hostname: the connection goes to `address`, but SNI and the
  // certificate check use `target.hostname`, so a real HTTPS origin
  // validates normally and verification is never weakened.
  const response = await fetchWithRedirects(target, address, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`直接抓取失败：${response.status} ${response.statusText}`);
  }
  const interstitial = detectInterstitial(response.body);
  if (interstitial) {
    throw new Error(`${interstitial}，请粘贴正文。`);
  }
  const parsed = parseHtml(response.body, { title: undefined });
  if (!parsed.ok) {
    throw new Error(`Readability 解析失败：${parsed.message}`);
  }
  return parsed.document;
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
  const visible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    /enable javascript|javascript is not available|verify you are human|sign in to (?:x|twitter)|登录后查看|请启用.*javascript|完成验证码/i.test(
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

async function fetchWithRedirects(
  initial: URL,
  initialAddress: string,
  options: FetchOptions,
): Promise<PinnedResponse> {
  let url = initial;
  let address = initialAddress;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: PinnedResponse;
    try {
      response = await pinnedRequest({
        url,
        address,
        timeoutMs: CONNECT_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.tlsCa ? { ca: options.tlsCa } : {}),
        headers: {
          accept: "text/html,application/xhtml+xml",
          "User-Agent": options.userAgent ?? "kobook/0.1 (URL importer)",
        },
      });
    } catch (err) {
      if (err instanceof PinnedTimeoutError) {
        throw new SsrfTimeoutError(err.message);
      }
      if (err instanceof PinnedTooLargeError) {
        // A body over the cap is an upstream problem, not a refusal of
        // the URL, so it must not be reported as a SSRF block.
        throw err;
      }
      throw err;
    }
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) {
        // No `Location` header on a 3xx is the server's bug, but
        // treating it as the final response is the safer choice.
        return response;
      }
      const next = new URL(response.location, url);
      // Every hop re-runs the DNS / range gate, so a redirect into
      // loopback or the metadata service is refused mid-chain.
      address = (await gateUrl(next.toString())).address;
      url = next;
      continue;
    }
    return response;
  }
  throw new SsrfBlockedError(`重定向超过 ${MAX_REDIRECTS} 跳上限。`);
}

// Re-exported so callers that took `ExtractorId` from this module keep
// compiling; it is a shared-contract type, not this module's own.
export type { ExtractorId };
