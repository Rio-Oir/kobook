// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The dual-channel front door: browser-direct Jina first, controlled backend
 * only if that fails.
 *
 * ```text
 * importFromUrlDual(url)
 *   ├─ normalize the URL  ──────────────── invalid → stop, no request at all
 *   ├─ channel 1: browser → r.jina.ai → parse Markdown locally
 *   │    └─ success → source "browser-jina", backend never contacted
 *   └─ channel 1 failed
 *        ├─ cancelled or invalid → stop (no fallback)
 *        └─ channel 2: POST /api/anonymous/extract
 *             ├─ success → source "server-jina" / "server-readability"
 *             └─ failure → both reasons, "请手动粘贴文章正文后导入"
 * ```
 *
 * Four rules are enforced here rather than left to the caller to remember,
 * because each one is a way the feature can be wrong *while appearing to work*:
 *
 *   1. **Success means zero backend requests.** There is no code path from a
 *      channel-1 success to `fetchViaServerFallback`.
 *   2. **Cancellation never falls back.** `failure.fallbackEligible` is false
 *      for `cancelled`; turning a "user navigated away" into a backend request
 *      would contradict the cancellation and, on a metered route, spend the
 *      deployment's quota on work nobody is waiting for.
 *   3. **A local parse failure is a channel failure.** Jina can return Markdown
 *      that remark produces nothing usable from; that is the direct channel
 *      having failed, so the server gets a turn (it runs the same parser and
 *      can also reach for Readability).
 *   4. **The sources are recorded.** `browser-jina` / `server-jina` /
 *      `server-readability` / `local` travel with the document, so the library
 *      can say where an article came from without a second round trip.
 *
 * Pasted text is the other half and it is deliberately *not* symmetric:
 * `importFromText` has no network path at all. A paste must read without
 * waiting for a backend, so a local parse failure here returns a validation
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
import { parseLocalMarkdown } from "./local-import-parse.js";
import {
  importFromPastedText,
  type LocalImportOptions,
  type LocalImportResult,
} from "./local-import.js";

export interface DualExtractOptions {
  /** Transport seam for tests; production callers omit it. */
  fetchImpl?: typeof fetch;
  /** Overrides `JINA_DEADLINE_MS`. */
  jinaDeadlineMs?: number;
  /** Overrides `SERVER_FALLBACK_DEADLINE_MS`. */
  serverDeadlineMs?: number;
  /** Overrides `MAX_RESPONSE_BYTES`. */
  maxResponseBytes?: number;
  /** Cancels the whole import, both channels included. */
  signal?: AbortSignal;
  /**
   * Called just before the fallback request goes out.
   *
   * This is how the UI shows "正在尝试服务器备用抓取" *while* the wait is
   * happening — the failure messages carry the same wording for the
   * after-the-fact case, but a progress indication cannot wait for the result.
   */
  onFallback?: (notice: FallbackNotice) => void;
}

export interface FallbackNotice {
  /** Why channel 1 failed. */
  reason: ExtractFailureKind | "site-policy";
  /** The same sentence the user will see if the fallback also fails. */
  message: string;
}

export interface UrlImportSuccess {
  ok: true;
  source: ExtractSource;
  document: ParsedDocument;
  /** Present when the backend saved the day, describing why it was needed. */
  fallback?: FallbackNotice;
}

export interface UrlImportFailure {
  ok: false;
  /** What went wrong on channel 1. */
  failure: ExtractFailure;
  /** What went wrong on channel 2; absent when the fallback was not allowed. */
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
 * The override order is `title: data.title` into the parse, then the
 * envelope's title/author taking precedence over what remark derived. Both
 * the server and the browser run the same parser over the same block
 * vocabulary, so the same article fetched through either channel produces the
 * same `ParsedDocument` — which is what lets a note anchored by one validate
 * against the other.
 */
function documentFromJinaMarkdown(
  markdown: string,
  envelope: { title?: string; author?: string },
): { ok: true; document: ParsedDocument } | { ok: false; failure: ExtractFailure } {
  const parsed = parseLocalMarkdown(markdown, {
    ...(envelope.title === undefined ? {} : { title: envelope.title }),
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
  if (prefersServerExtraction(target)) {
    if (options.signal?.aborted) return { ok: false, failure: extractFailure("cancelled") };
    const notice: FallbackNotice = { reason: "site-policy", message: "正在通过服务器提取正文" };
    options.onFallback?.(notice);
    const result = await fetchViaServerFallback({ kind: "url", content: target }, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.serverDeadlineMs === undefined ? {} : { deadlineMs: options.serverDeadlineMs }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!result.ok) return { ok: false, failure: result.failure };
    const mapped = sourceForServerExtractor(result.extractor);
    return mapped.ok ? { ok: true, source: mapped.source, document: result.document, fallback: notice } : mapped;
  }


  const direct = await fetchViaJinaDirect(target, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.jinaDeadlineMs === undefined ? {} : { deadlineMs: options.jinaDeadlineMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxBytes: options.maxResponseBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let primaryFailure: ExtractFailure;
  if (direct.ok) {
    const built = documentFromJinaMarkdown(direct.markdown, {
      ...(direct.title === undefined ? {} : { title: direct.title }),
      ...(direct.author === undefined ? {} : { author: direct.author }),
    });
    if (built.ok) {
      // Channel 1 succeeded: the backend is not contacted, by construction.
      return { ok: true, source: "browser-jina", document: built.document };
    }
    primaryFailure = built.failure;
  } else {
    primaryFailure = direct.failure;
  }

  if (!primaryFailure.fallbackEligible) {
    // Cancellation and invalid input end here. `invalid-url` cannot reach this
    // branch (it returned above) but the shared predicate is what keeps the
    // rule in one place.
    return { ok: false, failure: primaryFailure };
  }

  const notice: FallbackNotice = {
    reason: primaryFailure.kind,
    message: primaryFailure.message,
  };
  options.onFallback?.(notice);

  const fallback = await fetchViaServerFallback(
    { kind: "url", content: target },
    {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.serverDeadlineMs === undefined ? {} : { deadlineMs: options.serverDeadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );

  if (!fallback.ok) {
    const failure: ExtractFailure = {
      ...fallback.failure,
      // The user-facing sentence covers both halves of the attempt; the
      // individual messages each promised a fallback that has now failed too.
      message: combinedFailureMessage(primaryFailure, fallback.failure),
    };
    return { ok: false, failure, fallbackFailure: fallback.failure };
  }

  const mapped = sourceForServerExtractor(fallback.extractor);
  if (!mapped.ok) {
    // `fallback` is `ServerFallbackSuccess` here (the `!fallback.ok` branch
    // returned earlier), so the failure to be reported is the mapping
    // failure alone — there was no second transport error.
    return { ok: false, failure: mapped.failure };
  }

  return { ok: true, source: mapped.source, document: fallback.document, fallback: notice };
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
