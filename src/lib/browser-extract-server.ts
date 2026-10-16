// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Channel 2: the controlled backend fallback, `POST /api/anonymous/extract`.
 *
 * Used **only** after channel 1 has failed, and it is the second choice by
 * construction: the browser must not be able to redirect the request. Where
 * the backend gets its content from — and with what credentials — is fixed by
 * the deployment, never by the caller, so this module sends the *target URL*
 * (or the pasted text) and nothing about how to fetch it: no proxy base, no
 * key, no fetch options. The route's body schema has
 * `additionalProperties: false` on the server side too, so a request carrying
 * such a field is a 400 rather than a silently ignored override.
 *
 * ## The payload is built by whitelist, never by spread
 *
 * `pickExtractFields` names each field it forwards. Two things follow, and both
 * are the point:
 *
 *   - an object that has picked up extra properties cannot leak them —
 *     `{...article}` or `{...settings}` reaching this function does not put an
 *     AI key, an endpoint or an account id into the request body; and
 *   - an unexpected *own* key is an error, not a silent drop. Spreading a
 *     settings object in here is a bug somebody should see in development, not
 *     a credential that quietly travels once and is never noticed.
 *
 * Any other authenticated write in the product applies the same rule to its own
 * payload, and the two are deliberately not shared code: this one guards an
 * unauthenticated extraction request, that one guards an authenticated write.
 * They differ in what they may carry, so they change for different reasons.
 */

import { ROUTES } from "../../shared/contracts/index.js";
import type {
  AnonymousExtractRequest,
  AnonymousExtractResponse,
  ArticleImportKind,
  ParsedDocument,
} from "../../shared/contracts/index.js";
import { extractFailure, type ExtractFailure } from "./browser-extract-errors.js";

/**
 * Deadline for the fallback request.
 *
 * Longer than the route's own 20 s whole-request budget on purpose: the server
 * should be the one to time out, because it can say *why* ("匿名抓取超时。")
 * and a client-side abort would replace that with a generic message. This is
 * the outer net for a request that somehow stalls below that budget.
 */
export const SERVER_FALLBACK_DEADLINE_MS = 30_000;

/** Fields the extract route accepts, in the order they are written. */
export const EXTRACT_FIELD_WHITELIST = ["kind", "content", "title"] as const;

export interface ServerFallbackInput {
  kind: ArticleImportKind;
  content: string;
  title?: string;
}

export interface ServerFallbackOptions {
  /** Transport seam for tests; see `browser-extract-jina.ts` for the rationale. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Overrides the route. Exists for tests; the production value is `ROUTES`. */
  route?: string;
}

export interface ServerFallbackSuccess {
  ok: true;
  document: ParsedDocument;
  extractor: AnonymousExtractResponse["extractor"];
  /** Present when the server itself fell back off Jina. */
  fallbackReason?: string;
}

export type ServerFallbackOutcome = ServerFallbackSuccess | { ok: false; failure: ExtractFailure };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Copy the allowed fields out of `input`, refusing anything else.
 *
 * Throws rather than dropping: see the module note. The error text names the
 * offending keys so the fix is obvious at the call site.
 */
export function pickExtractFields(input: ServerFallbackInput): AnonymousExtractRequest {
  const allowed = new Set<string>(EXTRACT_FIELD_WHITELIST);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `提取请求只允许字段 ${EXTRACT_FIELD_WHITELIST.join(" / ")}，收到额外的：${unexpected.join(", ")}`,
    );
  }
  const request: AnonymousExtractRequest = { kind: input.kind, content: input.content };
  if (input.title !== undefined) request.title = input.title;
  return request;
}

/** Shape check strong enough that downstream code cannot crash on it. */
function isParsedDocument(value: unknown): value is ParsedDocument {
  if (!isRecord(value)) return false;
  if (typeof value["title"] !== "string") return false;
  if (typeof value["textHash"] !== "string") return false;
  if (!Array.isArray(value["blocks"])) return false;
  return value["blocks"].every(
    (block) =>
      isRecord(block) &&
      typeof block["id"] === "string" &&
      typeof block["index"] === "number" &&
      typeof block["type"] === "string" &&
      typeof block["text"] === "string" &&
      typeof block["hash"] === "string",
  );
}

/**
 * Read the server's own error message out of a failure response.
 *
 * The shared envelope is `{ error: { code, message, requestId } }`. Its
 * messages are user-facing Chinese written for exactly these cases, so they
 * beat anything this module could invent — and returning one is how the UI
 * avoids the `Failed to fetch` dead end. The body is still
 * parsed defensively: a proxy or an old build can answer with HTML.
 */
async function readServerMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (text.trim().length === 0) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    const error = parsed["error"];
    if (isRecord(error) && typeof error["message"] === "string" && error["message"].trim().length > 0) {
      return error["message"];
    }
    if (typeof parsed["message"] === "string" && parsed["message"].trim().length > 0) {
      return parsed["message"];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ask the controlled backend to extract the content.
 *
 * Failure is a value, same as channel 1, so the orchestrator's policy lives in
 * one place.
 */
export async function fetchViaServerFallback(
  input: ServerFallbackInput,
  options: ServerFallbackOptions = {},
): Promise<ServerFallbackOutcome> {
  const deadlineMs = options.deadlineMs ?? SERVER_FALLBACK_DEADLINE_MS;
  const route = options.route ?? ROUTES.anonymousExtract;
  const callerSignal = options.signal;
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  // Throws on a non-whitelisted field, before any request exists. A caller
  // that leaked a settings object fails here rather than at the network.
  const body = pickExtractFields(input);

  if (callerSignal?.aborted) {
    return { ok: false, failure: extractFailure("cancelled") };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort);

  const abortFailure = (detail?: string): ExtractFailure =>
    callerSignal?.aborted === true
      ? extractFailure("cancelled", detail === undefined ? {} : { detail })
      : extractFailure("timeout", { deadlineMs, ...(detail === undefined ? {} : { detail }) });

  try {
    let response: Response;
    try {
      response = await doFetch(route, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        // The route is unauthenticated and writes nothing, so there is no
        // session for it to use. Sending the cookie anyway would only widen
        // where it travels.
        credentials: "omit",
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted || callerSignal?.aborted) {
        return { ok: false, failure: abortFailure(errorMessage(err)) };
      }
      return { ok: false, failure: extractFailure("network", { detail: errorMessage(err) }) };
    }

    if (controller.signal.aborted || callerSignal?.aborted) {
      return { ok: false, failure: abortFailure() };
    }

    if (!response.ok) {
      // The server's message wins when it has one: it knows whether this was
      // a URL the SSRF guard refused (422), a rate limit (429), a missing
      // route (404) or an upstream failure (502/504), and it is our own
      // backend, so its text is not untrusted input.
      const serverMessage = await readServerMessage(response);
      if (response.status === 429) {
        const failure = extractFailure("rate-limited", {
          status: 429,
          ...(serverMessage === null ? {} : { detail: serverMessage }),
        });
        return {
          ok: false,
          failure: serverMessage === null ? failure : { ...failure, message: serverMessage },
        };
      }
      const failure = extractFailure("http", {
        status: response.status,
        ...(serverMessage === null ? {} : { detail: serverMessage }),
      });
      return {
        ok: false,
        failure: serverMessage === null ? failure : { ...failure, message: serverMessage },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      return {
        ok: false,
        failure: extractFailure("format", { detail: `fallback body was not JSON: ${errorMessage(err)}` }),
      };
    }
    if (!isRecord(payload)) {
      return { ok: false, failure: extractFailure("format", { detail: "fallback body was not an object" }) };
    }

    const document = payload["document"];
    if (!isParsedDocument(document)) {
      return {
        ok: false,
        failure: extractFailure("format", { detail: "fallback body had no usable document" }),
      };
    }
    const extractor = payload["extractor"];
    if (extractor !== "local" && extractor !== "jina" && extractor !== "html-readability") {
      return {
        ok: false,
        failure: extractFailure("format", { detail: `unknown extractor ${String(extractor)}` }),
      };
    }

    const success: ServerFallbackSuccess = { ok: true, document, extractor };
    const fallbackReason = payload["fallbackReason"];
    if (typeof fallbackReason === "string" && fallbackReason.length > 0) {
      success.fallbackReason = fallbackReason;
    }
    return success;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
