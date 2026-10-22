// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Channel 1: the browser fetches `r.jina.ai` directly, then parses the
 * returned Markdown locally. This is the *preferred* path — the plan's
 * "浏览器直连 Jina 优先" — and when it succeeds the backend is never called.
 *
 * Three properties are structural rather than conventional, because a
 * convention is exactly what a later edit breaks:
 *
 * 1. **The Jina address is not a parameter.** `JINA_READER_BASE` is a module
 *    constant and no option, argument or environment value can replace it. The
 *    plan requires it ("浏览器不得提交任意代理或抓取服务地址"); a browser cannot
 *    be trusted to name its own proxy, so the ability is removed rather than
 *    validated. Tests point at a local fake by **injecting `fetch`**, which is
 *    a seam on the transport, not on the destination — the module still builds
 *    the same `https://r.jina.ai/...` URL and a test double decides what to do
 *    with it.
 * 2. **The request is bounded twice.** A 10 s deadline and a 5 MB byte
 *    cap. The byte cap is enforced *while reading* rather than by
 *    checking a `Content-Length`, because an upstream is free to send a
 *    small header and then stream forever. (The deadline used to be
 *    described as "matching `JINA_TIMEOUT_MS` on the server"; since
 *    2026-10-15 the server makes no Jina request at all, so there is no
 *    server-side value left to match. The 10 s is now simply this
 *    module's own bound.)
 * 3. **Cancellation is terminal.** An abort from the caller returns
 *    `cancelled` and is marked not-fallback-eligible, so an orchestration layer
 *    cannot turn "the user navigated away" into a second HTTP request against
 *    the project's backend.
 */

import {
  extractFailure,
  type ExtractFailure,
  type FailureContext,
} from "./browser-extract-errors.js";

/**
 * The Jina Reader endpoint. A constant on purpose — see the module note.
 *
 * Trailing slash matters: the target URL is appended verbatim, so
 * `https://r.jina.ai/https://example.com/` is what reaches the service, the
 * same shape `server/src/lib/url-import.ts` builds from its operator-configured
 * base.
 */
export const JINA_READER_BASE = "https://r.jina.ai/";

/** Bounded deadline for the direct channel. Mirrors the server's Jina timeout. */
export const JINA_DEADLINE_MS = 10_000;

/** Hard cap on bytes read from the response body. Mirrors the server's cap. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface JinaFetchOptions extends FailureContext {
  /**
   * Transport seam for tests.
   *
   * Deliberately `fetch` and not a base URL: injecting the transport lets a
   * test serve a fixture without the module gaining any ability to address a
   * different host. Production callers omit it and get the ambient `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Caller cancellation. Aborting this cancels the whole import. */
  signal?: AbortSignal;
}

export interface JinaSuccess {
  ok: true;
  /** The article body Jina returned, already trimmed. */
  markdown: string;
  /** Metadata from Jina's envelope, when present. */
  title?: string;
  author?: string;
  publishedTime?: string;
  /** Body bytes actually read, for logging. */
  bytes: number;
}

export type JinaOutcome = JinaSuccess | { ok: false; failure: ExtractFailure };

interface JinaEnvelope {
  data?: {
    title?: unknown;
    author?: unknown;
    publishedTime?: unknown;
    content?: unknown;
  };
}

/** The absolute Jina URL for a target. Exported so tests can assert the shape. */
export function buildJinaRequestUrl(target: string): string {
  return `${JINA_READER_BASE}${target}`;
}

export type UrlNormalization =
  | { ok: true; url: string }
  | { ok: false; failure: ExtractFailure };

/**
 * Trim, default the scheme, and refuse anything that is not http(s).
 *
 * "bun.com/blog" is accepted as `https://bun.com/blog`, matching the input
 * affordance the app has always offered. A bare `javascript:`/`file:`/`data:`
 * URL is refused before any request is built — not because Jina would run it,
 * but because `https://r.jina.ai/javascript:...` is a request we have no reason
 * to make and no way to interpret.
 *
 * Embedded credentials are refused too, which is a deliberate divergence from
 * the server (`ssrf-guard.ts` validates the scheme only). Appending a URL with
 * `user:pass@` to the Jina path would copy those credentials into a third
 * party's request log for no benefit — reader services do not use them — so the
 * honest move is to tell the user rather than to forward them. The cost is that
 * this case does not fall back, which is why the message names the problem.
 */
export function normalizeArticleUrl(raw: string): UrlNormalization {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, failure: extractFailure("invalid-url") };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, failure: extractFailure("invalid-url") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, failure: extractFailure("invalid-url") };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return {
      ok: false,
      failure: {
        ...extractFailure("invalid-url"),
        message: "链接中不能包含用户名或密码，请去掉凭据后重试。",
      },
    };
  }
  return { ok: true, url: parsed.toString() };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read at most `maxBytes` from a response body.
 *
 * Streaming rather than `response.text()` so the cap is a real bound: the
 * caller's `fetch` may have received headers for a 500 MB body, and buffering
 * it before measuring would defeat the point. `Content-Length` is consulted
 * first only as a fast path — when it is present and over the cap there is no
 * reason to start reading at all.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; failure: ExtractFailure }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, failure: extractFailure("too-large", { maxBytes }) };
  }

  const body = response.body;
  if (body === null) return { ok: true, text: "", bytes: 0 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Stop pulling: the point of the cap is not to hold the excess in
        // memory while deciding to reject it.
        await reader.cancel().catch(() => undefined);
        return { ok: false, failure: extractFailure("too-large", { maxBytes }) };
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    return {
      ok: false,
      failure: extractFailure("network", { detail: `body read failed: ${errorMessage(err)}` }),
    };
  }

  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined), bytes };
}

/**
 * Fetch the article Markdown from Jina.
 *
 * Returns a `JinaOutcome` rather than throwing, because every failure here is
 * a case the orchestrator has a *policy* for (fall back or not) and an
 * exception would push that policy into a `try/catch` the compiler cannot
 * check for completeness.
 */
export async function fetchViaJinaDirect(
  target: string,
  options: JinaFetchOptions = {},
): Promise<JinaOutcome> {
  const deadlineMs = options.deadlineMs ?? JINA_DEADLINE_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const callerSignal = options.signal;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  // Cancelled before we started: do not open a socket to find that out.
  if (callerSignal?.aborted) {
    return { ok: false, failure: extractFailure("cancelled") };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort);

  /** Decide which of the two abort causes this was, from the *caller's* view. */
  const abortFailure = (detail?: string): ExtractFailure =>
    callerSignal?.aborted === true
      ? extractFailure("cancelled", detail === undefined ? {} : { detail })
      : extractFailure("timeout", { deadlineMs, ...(detail === undefined ? {} : { detail }) });

  try {
    let response: Response;
    try {
      response = await doFetch(buildJinaRequestUrl(target), {
        method: "GET",
        headers: {
          accept: "application/json",
          "X-Return-Format": "markdown",
        },
        // No cookies to a third party, and nothing this app would need back.
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted || callerSignal?.aborted) {
        return { ok: false, failure: abortFailure(errorMessage(err)) };
      }
      // DNS failure, TLS failure, connection refused and a CORS rejection are
      // all this same opaque TypeError (see browser-extract-errors.ts).
      return { ok: false, failure: extractFailure("network", { detail: errorMessage(err) }) };
    }

    // The timeout can fire while the body is streaming, so re-check before
    // trusting what we read.
    const read = await readBounded(response, maxBytes);
    if (controller.signal.aborted || callerSignal?.aborted) {
      return { ok: false, failure: abortFailure() };
    }
    // A cap breach propagates as `too-large` — the abort used to stop the read
    // is an implementation detail the user should not be told about.
    if (!read.ok) return { ok: false, failure: read.failure };

    if (response.status === 429) {
      return { ok: false, failure: extractFailure("rate-limited", { status: 429 }) };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        failure: extractFailure("http", {
          status: response.status,
          detail: `Jina returned ${response.status} ${response.statusText}`,
        }),
      };
    }

    const text = read.text.trim();
    if (text.length === 0) return { ok: false, failure: extractFailure("empty") };

    let envelope: JinaEnvelope;
    try {
      envelope = JSON.parse(text) as JinaEnvelope;
    } catch {
      return {
        ok: false,
        failure: extractFailure("format", { detail: "Jina response was not valid JSON" }),
      };
    }
    if (typeof envelope !== "object" || envelope === null) {
      return { ok: false, failure: extractFailure("format", { detail: "Jina envelope was not an object" }) };
    }

    const data = envelope.data ?? {};
    if (data.content !== undefined && typeof data.content !== "string") {
      return {
        ok: false,
        failure: extractFailure("format", { detail: "Jina envelope content was not a string" }),
      };
    }
    const markdown = (typeof data.content === "string" ? data.content : "").trim();
    if (markdown.length === 0) return { ok: false, failure: extractFailure("empty") };

    const success: JinaSuccess = { ok: true, markdown, bytes: read.bytes };
    if (typeof data.title === "string" && data.title.trim().length > 0) {
      success.title = data.title.trim();
    }
    if (typeof data.author === "string" && data.author.trim().length > 0) {
      success.author = data.author.trim();
    }
    if (typeof data.publishedTime === "string" && data.publishedTime.trim().length > 0) {
      success.publishedTime = data.publishedTime.trim();
    }
    return success;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
