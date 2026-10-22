// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The URL front door: server-side HTML + Readability, with the browser-direct
 * Jina channel available but **off unless asked for**.
 *
 * ```text
 * importFromUrlDual(url)
 *   ├─ normalize the URL  ──────────────── invalid → stop, no request at all
 *   ├─ channel 1: POST /api/anonymous/extract → guarded fetch + Readability
 *   │    └─ success → source "server-readability", Jina never contacted
 *   └─ channel 1 failed
 *        ├─ default: report the failure, and what to do about it
 *        └─ `jinaFallback: true` only
 *             ├─ cancelled, SSRF-blocked, rate-limited, or X/Twitter → stop
 *             └─ channel 2: browser → r.jina.ai → parse Markdown locally
 * ```
 *
 * **Why the second channel is opt-in (2026-10-22).** It was on by default and
 * cost every failure 7–10 seconds before the user saw a message: on a page the
 * server had already refused in 0.16s (an anti-bot 403), the browser then spent
 * 6.8s on a `r.jina.ai` attempt that failed too and reported "抓取失败" at 8.65s
 * after the click. It also sent the reader's URL to a third party from their
 * own browser, which the server channel deliberately never does. The channel
 * remains — it is the only thing that can reach a page whose HTML needs
 * scripting — but enabling it is now a caller's decision, and the tests that
 * exercise it pass the flag.
 *
 * Three rules are enforced here rather than left to the caller to remember,
 * because each one is a way the feature can be wrong *while appearing to work*:
 *
 *   1. **HTML extraction is primary.** A successful server parse returns
 *      immediately and makes no Jina request.
 *   2. **Cancellation never falls back.** `failure.fallbackEligible` is false
 *      for `cancelled`; turning a "user navigated away" into another request
 *      would contradict the cancellation.
 *   3. **The sources are recorded.** `browser-jina` / `server-jina` /
 *      `server-readability` / `local` travel with the document, which is what
 *      the plan asks to be stored per article.
 *
 * Pasted text is the other half and it is deliberately *not* symmetric:
 * `importFromText` has no network path at all, so a local parse failure here returns a validation
 * message to the user rather than quietly becoming a server request. That is
 * what makes the four acceptance cases (backend down, 404, 500, offline)
 * behave identically for a paste.
 */

import type { ParsedDocument } from "../../shared/contracts/index.js";
import {
  combinedFailureMessage,
  extractFailure,
  type ExtractFailure,
  type ExtractFailureKind,
  type ExtractSource,
} from "./browser-extract-errors.js";
import { fetchViaJinaDirect, normalizeArticleUrl } from "./browser-extract-jina.js";
import { fetchViaServerFallback } from "./browser-extract-server.js";
import { cleanJinaMarkdown } from "./clean-jina-markdown.js";
import { parseLocalMarkdown } from "./local-import-parse.js";
import {
  importFromPastedText,
  type LocalImportOptions,
  type LocalImportResult,
} from "./local-import.js";

export interface DualExtractOptions {
  /** Transport seam for tests; production callers omit it. */
  fetchImpl?: typeof fetch;
  /**
   * Whether the browser-direct Jina channel may run after the server channel
   * failed. Default `false`; see the module header for why it is opt-in.
   */
  jinaFallback?: boolean;
  /** Overrides `JINA_DEADLINE_MS`. */
  jinaDeadlineMs?: number;
  /** Overrides `SERVER_FALLBACK_DEADLINE_MS`. */
  serverDeadlineMs?: number;
  /** Overrides `MAX_RESPONSE_BYTES`. */
  maxResponseBytes?: number;
  /** Cancels the whole import, both channels included. */
  signal?: AbortSignal;
  /**
   * Called just before a secondary extraction request goes out.
   *
   * This is how the UI shows the active extraction route *while* the wait is
   * happening — the failure messages carry the same wording for the
   * after-the-fact case, but a progress indication cannot wait for the result.
   */
  onFallback?: (notice: FallbackNotice) => void;
}

export interface FallbackNotice {
  /** Why the primary extraction failed. */
  reason: ExtractFailureKind | "site-policy";
  /** Progress message for the secondary extraction. */
  message: string;
}

export interface UrlImportSuccess {
  ok: true;
  source: ExtractSource;
  document: ParsedDocument;
  /** Present when the secondary extraction succeeded, describing why it was needed. */
  fallback?: FallbackNotice;
}

export interface UrlImportFailure {
  ok: false;
  /** What went wrong on the primary extraction path. */
  failure: ExtractFailure;
  /** What went wrong on the secondary extraction path. */
  fallbackFailure?: ExtractFailure;
}

export type UrlImportResult = UrlImportSuccess | UrlImportFailure;

/**
 * Map the server's extractor label onto the shared source vocabulary.
 *
 * The two are not the same enum and are deliberately not merged here: the
 * server's `extractor` describes which extractor ran *on the server*, while
 * `ExtractSource` describes where the document the user is reading came from.
 * `"local"` is what collapses them — the server cannot have parsed a URL
 * locally, so receiving it for a URL request means the response is not about
 * the request we made, and saying `server-jina` would be a fabrication.
 */
function sourceForServerExtractor(
  extractor: "local" | "jina" | "html-readability",
): { ok: true; source: ExtractSource } | { ok: false; failure: ExtractFailure } {
  switch (extractor) {
    case "jina":
      return { ok: true, source: "server-jina" };
    case "html-readability":
      return { ok: true, source: "server-readability" };
    case "local":
      return {
        ok: false,
        failure: extractFailure("format", {
          detail: "fallback reported extractor 'local' for a URL request",
        }),
      };
    default: {
      const exhaustive: never = extractor;
      return {
        ok: false,
        failure: extractFailure("format", { detail: `unknown extractor ${String(exhaustive)}` }),
      };
    }
  }
}

/**
 * Run Markdown from Jina through the local parser, then let Jina's metadata
 * win where it has something to say.
 *
 * Mirrors `jinaFetch` in `server/src/lib/url-import.ts` — same parser, same
 * override order (`title: data.title` into the parse, then the envelope's
 * title/author taking precedence over what remark derived).
 *
 * The one deliberate difference is the `cleanJinaMarkdown` pass in front of
 * the parser: Jina's reader returns the page's own navigation and legal
 * footer along with the article, and on the browser channel we can trim
 * those two boundaries using the page title Jina already reported, and
 * merge adjacent strong-tag delimiters that otherwise leak into text. It runs
 * here and nowhere else — not on the server channel, not on pasted text or
 * files, and not on an article that is already stored — so the two channels
 * can now disagree about a page whose Markdown carried site chrome. The
 * cleanup is a no-op when neither artifact is present. It affects only new
 * imports: existing documents and their stored anchor offsets stay intact.
 */
function documentFromJinaMarkdown(
  markdown: string,
  envelope: { title?: string; author?: string },
  sourceUrl?: string,
): { ok: true; document: ParsedDocument } | { ok: false; failure: ExtractFailure } {
  const parsed = parseLocalMarkdown(cleanJinaMarkdown(markdown, envelope.title), {
    ...(envelope.title === undefined ? {} : { title: envelope.title }),
    ...(sourceUrl === undefined ? {} : { baseUrl: sourceUrl }),
  });
  if (!parsed.ok) {
    return {
      ok: false,
      // Not `empty`/`format`: the transport worked and the body was a well
      // formed envelope. What failed is turning the article text into blocks,
      // which is a distinct thing for an operator to look at.
      failure: extractFailure("parse", { detail: parsed.message }),
    };
  }
  const document: ParsedDocument = {
    title: envelope.title?.trim() || parsed.document.title,
    author: envelope.author?.trim() || parsed.document.author || null,
    blocks: parsed.document.blocks,
    source: parsed.document.source,
    extractorVersion: parsed.document.extractorVersion,
    textHash: parsed.document.textHash,
  };
  return { ok: true, document };
}

/**
 * Import a URL through both channels, in order.
 *
 * Never throws for an expected failure: every outcome is a value, so the UI
 * has exactly one place to branch and the compiler checks the branches.
 */
/**
 * Whether this URL's host is one where the browser must **not** try Jina,
 * because the target is known to refuse it (X/Twitter serve a
 * JavaScript shell or a login wall to a plain fetch, so a Jina attempt
 * would burn a request to learn nothing).
 *
 * The match is on the **parsed hostname**, not on the raw string:
 *
 *   - `x.com` and `twitter.com` themselves;
 *   - their DNS subdomains (`www.x.com`, `mobile.twitter.com`, and a
 *     trailing-dot FQDN like `X.COM.`);
 *   - and nothing else. `evilx.com` does not end with `.x.com`, and
 *     `x.com.evil.test` does not equal `x.com` nor end with `.x.com`,
 *     so neither matches. A substring test (`url.includes("x.com")`)
 *     would match both, which is exactly the bug this shape avoids.
 *
 * `t.co` is deliberately **not** on this list: it is an ordinary short
 * link, and its redirect target is unknown until it is fetched, so the
 * ordinary "try Jina first" path applies.
 *
 * Being on this list is not an access grant — it only says "skip the
 * Jina attempt". The server still runs the full SSRF / DNS-pinning /
 * TLS / redirect-gate path, and a login wall or a JS shell still fails.
 */
export function prefersServerExtraction(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    // Not a URL we can route by. Returning `false` sends it down the
    // ordinary path, where `normalizeArticleUrl` refuses it before any
    // request is built.
    return false;
  }
  return SERVER_EXTRACTION_HOSTS.some(
    (root) => host === root || host.endsWith(`.${root}`),
  );
}

/** Configured hosts whose subdomains also skip the browser Jina attempt. */
const SERVER_EXTRACTION_HOSTS = ["x.com", "twitter.com"] as const;

function mayTryJinaAfterServer(failure: ExtractFailure): boolean {
  // Do not bypass an explicit SSRF rejection or server rate limit through the
  // third-party reader service.
  return failure.fallbackEligible && failure.kind !== "rate-limited" && failure.status !== 422;
}

export async function importFromUrlDual(
  rawUrl: string,
  options: DualExtractOptions = {},
): Promise<UrlImportResult> {
  const normalized = normalizeArticleUrl(rawUrl);
  if (!normalized.ok) {
    // No request is built for a URL we will not fetch, on either channel.
    return { ok: false, failure: normalized.failure };
  }
  const target = normalized.url;
  const serverOnly = prefersServerExtraction(target);
  if (options.signal?.aborted) return { ok: false, failure: extractFailure("cancelled") };

  if (serverOnly) {
    options.onFallback?.({ reason: "site-policy", message: "正在通过服务器读取网页正文" });
  }
  const server = await fetchViaServerFallback(
    { kind: "url", content: target },
    {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.serverDeadlineMs === undefined ? {} : { deadlineMs: options.serverDeadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );

  let serverFailure: ExtractFailure;
  if (server.ok) {
    const mapped = sourceForServerExtractor(server.extractor);
    if (mapped.ok) return { ok: true, source: mapped.source, document: server.document };
    serverFailure = mapped.failure;
  } else {
    serverFailure = server.failure;
  }

  if (serverOnly || options.jinaFallback !== true || !mayTryJinaAfterServer(serverFailure)) {
    return { ok: false, failure: serverFailure };
  }

  const notice: FallbackNotice = {
    reason: serverFailure.kind,
    message: "服务器 HTML 提取未成功，正在尝试 Jina 备用抓取…",
  };
  options.onFallback?.(notice);

  const direct = await fetchViaJinaDirect(target, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.jinaDeadlineMs === undefined ? {} : { deadlineMs: options.jinaDeadlineMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxBytes: options.maxResponseBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let jinaFailure: ExtractFailure | undefined;
  let jinaDocument: ParsedDocument | undefined;
  if (direct.ok) {
    const built = documentFromJinaMarkdown(
      direct.markdown,
      {
        ...(direct.title === undefined ? {} : { title: direct.title }),
        ...(direct.author === undefined ? {} : { author: direct.author }),
      },
      // Jina returns Markdown, not the page's `<head>`, so there is no
      // `og:image` to read here. What we do have is the page's address — and
      // that is what relative image paths in the Markdown have to be resolved
      // against, or `/uploads/hero.jpg` would be requested from our own
      // origin and come back 404.
      target,
    );
    if (built.ok) jinaDocument = built.document;
    else jinaFailure = built.failure;
  } else {
    jinaFailure = direct.failure;
  }

  if (jinaDocument) {
    return { ok: true, source: "browser-jina", document: jinaDocument, fallback: notice };
  }

  const fallbackFailure = jinaFailure ?? extractFailure("parse");
  const failure: ExtractFailure = {
    ...serverFailure,
    message: combinedFailureMessage(serverFailure, fallbackFailure),
  };
  return { ok: false, failure, fallbackFailure };
}

/**
 * Import pasted text / Markdown. Local, synchronous, offline.
 *
 * The signature matches the URL path so a caller can treat them alike, but the
 * implementation shares nothing with it: no `fetch`, no fallback, no options
 * that could introduce one. Wiring this into the paste handler is what removes
 * the backend from the critical path of "paste and read".
 */
export function importFromText(raw: string, options: LocalImportOptions = {}): LocalImportResult {
  return importFromPastedText(raw, options);
}

/**
 * A bound instance, so a caller that always uses the same transport (the app's
 * fetch) does not repeat the plumbing at every call site.
 */
export interface DualExtractor {
  importFromUrl: (url: string, options?: Omit<DualExtractOptions, "fetchImpl">) => Promise<UrlImportResult>;
  importFromText: (raw: string, options?: LocalImportOptions) => LocalImportResult;
}

export function createDualExtractor(options: DualExtractOptions = {}): DualExtractor {
  const { fetchImpl, ...rest } = options;
  return {
    importFromUrl: (url, callOptions = {}) =>
      importFromUrlDual(url, { ...rest, ...callOptions, ...(fetchImpl === undefined ? {} : { fetchImpl }) }),
    // Synchronous on purpose: the paste path never waits on anything.
    importFromText: (raw, localOptions = {}) => importFromText(raw, localOptions),
  };
}

export type { ExtractSource, ExtractFailure, ExtractFailureKind } from "./browser-extract-errors.js";
export { combinedFailureMessage, extractFailure, failureMessage } from "./browser-extract-errors.js";
export {
  JINA_DEADLINE_MS,
  JINA_READER_BASE,
  MAX_RESPONSE_BYTES,
  buildJinaRequestUrl,
  normalizeArticleUrl,
} from "./browser-extract-jina.js";
export { SERVER_FALLBACK_DEADLINE_MS, fetchViaServerFallback, pickExtractFields } from "./browser-extract-server.js";
export { MAX_LOCAL_INPUT_BYTES, importFromPastedText, utf8ByteLength } from "./local-import.js";
export { parseLocalMarkdown } from "./local-import-parse.js";
