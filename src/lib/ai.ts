// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Vercel AI SDK setup. Reads provider/key/baseURL/model from the user's
// settings store (which lives in localStorage). When no key is set, the
// UI runs in mock mode.
//
// `streamChat` accepts an optional `signal` and registers every in-flight
// request with `inflight`, so `abortAllStreams` (called on sign-out and on
// account switch) can cancel them. Without this, an in-flight request keeps
// spending the departed user's key and continues to call `appendToNote` on a
// note the next account will never see.
//
// Phase 4 makes the stream's *end states* honest:
//
//   - it iterates `fullStream`, not `textStream`. `textStream` forwards only
//     `text-delta` parts and silently drops `{ type: "error" }`, so a
//     provider that failed mid-stream (401, 429, an error SSE frame, a
//     truncated connection) used to look like a clean, empty success and
//     fire `onDone`. There is no way to observe the error through
//     `textStream` at all, which is why the fix is at the iteration site.
//   - success requires a `finish` part *and* non-empty text. A stream that
//     ends without a finish marker is a truncated response, not an answer.
//   - a timeout is a *failure* (`onError`), not a cancellation, so a slow
//     provider does not silently look like the user pressed stop.
//   - `maxRetries: 0`: a request that already streamed part of an answer is
//     never silently re-sent. Retrying would double-bill the user's key and
//     duplicate text that already landed in the note.
//   - every callback fires at most once, and the abort listener, the timeout
//     and the in-flight registration are all released on every exit path.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText } from "ai";
import { useShallow } from "zustand/react/shallow";
import {
  readSettings,
  useSettings,
  PROVIDER_PRESETS,
  validateSettings,
  assertEndpointConfirmed,
  endpointOrigin,
  endpointStatus,
} from "./settings";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Token counts as reported by the provider. Every counter is optional: a
 * provider is allowed to finish without reporting usage, and "unknown" must
 * stay unknown rather than being rendered as 0.
 */
export type StreamUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
};

export type StreamChatOptions = {
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  onDone: (usage?: StreamUsage, modelName?: string) => void;
  onError: (err: Error) => void;
  /**
   * The request was stopped on purpose (sign-out, account switch, a new
   * selection, `abortAllStreams`). `partialText` is everything that already
   * arrived, so the caller can keep it.
   */
  onCancelled?: (partialText: string) => void;
  /**
   * The request was ended by the environment rather than by the user — the
   * browser tore down the fetch (page navigation/reload) without anyone
   * calling `abort()`. Distinct from `onCancelled` so the note can be
   * recorded as `interrupted` instead of as a deliberate stop.
   */
  onInterrupted?: (partialText: string) => void;
  /** Override for the default 60s deadline. `0` disables the deadline. */
  timeoutMs?: number;
};

/**
 * Deadline for a whole stream. Long enough for a slow first token on a
 * large context, short enough that a hung socket cannot leave a note stuck
 * on "streaming" forever. Callers that know better (a long summarisation,
 * a test) pass `timeoutMs`.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = 60_000;

/**
 * The active BYOK model, or `null` when no key is configured.
 *
 * Exported for the background tagger (`lib/tagging.ts`), which needs the
 * same provider/key/endpoint rules as a chat stream — in particular the
 * "key only travels to a confirmed endpoint" refusal — without duplicating
 * them. It throws for a configured-but-unconfirmed endpoint exactly like
 * `streamChat`, so the tagger fails closed rather than sending a key
 * somewhere the user has not approved.
 */
export function getActiveModel() {
  const s = readSettings();
  if (!s.apiKey) return null;
  validateSettings({ apiKey: s.apiKey, baseURL: s.baseURL, model: s.model });
  // Fail closed: a key is only ever attached to the endpoint the user
  // confirmed. Editing `baseURL` (through the panel, the provider preset, or
  // devtools) cannot redirect the credential to a new origin.
  assertEndpointConfirmed(s);
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    apiKey: s.apiKey,
    baseURL: s.baseURL,
  });
  return { model: provider(s.model), name: s.model, providerId: s.provider, apiKey: s.apiKey };
}

/**
 * React hook: live snapshot of the current model. Components can use this
 * to show "mock mode" vs the active model name in the top bar.
 */
export function useModelInfo() {
  return useSettings(
    useShallow((s) => ({
      name: s.model,
      providerId: s.provider,
      providerLabel: PROVIDER_PRESETS[s.provider].label,
      hasKey: !!s.apiKey,
      baseURL: s.baseURL,
      endpointOrigin: endpointOrigin(s.baseURL),
      confirmedOrigin: s.confirmedOrigin,
      /** False while a key is set but its endpoint has not been confirmed. */
      endpointConfirmed: endpointStatus(s).confirmed,
    })),
  );
}

/**
 * In-flight stream controllers. The set is intentionally process-wide so
 * `abortAllStreams` is independent of which call site started the request.
 */
const inflight = new Set<AbortController>();

/** Abort every in-flight stream. Returns the count that were cancelled. */
export function abortAllStreams(): number {
  let count = 0;
  for (const controller of inflight) {
    controller.abort();
    count += 1;
  }
  inflight.clear();
  return count;
}

/** How many streams are registered right now (diagnostics/tests). */
export function inflightStreamCount(): number {
  return inflight.size;
}

export async function streamChat(opts: StreamChatOptions) {
  // Callbacks fire at most once each. A stream can fail *after* it already
  // emitted text, and the abort/timeout bookkeeping below can observe the
  // same stop from two places; this is what keeps a late second event from
  // overwriting a note whose answer was already recorded.
  let settled = false;
  const settle = (fn: (() => void) | undefined) => {
    if (settled) return;
    settled = true;
    fn?.();
  };

  if (opts.signal?.aborted) {
    // Cancelled before the request existed. Report it instead of returning
    // silently: a caller that just set `isStreaming: true` needs to hear
    // back, or the note stays spinning forever.
    settle(() => opts.onCancelled?.(""));
    return;
  }

  // One controller per request, so the caller (and `abortAllStreams`) can
  // cancel this specific stream without disturbing the others. The
  // controller is registered before the mock/real fork so `abortAllStreams`
  // cancels mock streams too — the mock path's own loop only checks the
  // signal, and without registration its controller is unreachable from
  // outside this call.
  const controller = new AbortController();
  const cancelListener = () => controller.abort();
  if (opts.signal) {
    // Link the caller's signal to our controller so either side can
    // cancel. The AI SDK accepts `AbortSignal` directly; for the mock
    // path, the inner loop reads `controller.signal.aborted`.
    opts.signal.addEventListener("abort", cancelListener, { once: true });
  }
  inflight.add(controller);

  let partialText = "";
  let timedOut = false;
  /**
   * The credential this request was actually made with, captured so an error
   * coming back from the vendor can be redacted against it even if the user
   * changed the key while the stream was running.
   */
  let requestKey = "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  // A stop that came from `abort()` is a cancellation — unless the abort was
  // ours, in which case it is a deadline failure and must be reported as
  // one. Reaching this twice (loop exit + catch) still notifies once.
  const reportAbort = () => {
    if (timedOut) {
      settle(() =>
        opts.onError(
          new Error(
            `请求超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成，已停止。已到达的部分内容会保留。`,
          ),
        ),
      );
      return;
    }
    settle(() => opts.onCancelled?.(partialText));
  };

  try {
    const active = getActiveModel();
    if (!active) {
      await mockStream({
        ...opts,
        signal: controller.signal,
        // Routed through `settle` so a late abort cannot stack a
        // `onCancelled` on top of an already-reported mock success.
        onDone: (usage, modelName) => settle(() => opts.onDone(usage, modelName)),
        // Same exit rule as the real path, so "what `onError` receives" does
        // not depend on which branch produced the failure.
        onError: (err) => settle(() => opts.onError(sanitizeError(err, [readSettings().apiKey]))),
        onChunk: (text) => {
          partialText += text;
          opts.onChunk(text);
        },
      });
      if (controller.signal.aborted) reportAbort();
      return;
    }

    const result = streamText({
      model: active.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
      // The AI SDK accepts `AbortSignal` directly. Linking the caller-supplied
      // signal to our controller means either side can cancel the request.
      abortSignal: controller.signal,
      // Never re-send a request that may already have streamed: the retry
      // would bill the user twice and duplicate text that landed in the note.
      maxRetries: 0,
      // The SDK's default `onError` is `console.error(error)`, and the error
      // object it prints carries the request body — i.e. the article text.
      // Errors are delivered to the caller through `onError` below and shown
      // in the note, so nothing is swallowed by quieting this one. This is
      // also the only place the SDK would log, and nothing here logs a
      // provider error at all.
      onError: () => {},
    });
    requestKey = active.apiKey;

    let sawFinish = false;
    let finishUsage: unknown;
    let stepMetadata: Record<string, unknown> | undefined;
    let sawAbortPart = false;

    for await (const part of result.fullStream) {
      if (controller.signal.aborted) break;
      switch (part.type) {
        case "text-delta":
          partialText += part.text;
          opts.onChunk(part.text);
          break;
        case "error":
          // The part `textStream` drops on the floor. Throwing here unwinds
          // the loop, which cancels the underlying reader.
          throw toError(part.error);
        case "abort":
          sawAbortPart = true;
          break;
        case "finish":
          sawFinish = true;
          finishUsage = part.totalUsage;
          break;
        case "finish-step":
          stepMetadata = part.providerMetadata as
            | Record<string, unknown>
            | undefined;
          break;
        default:
          // reasoning/tool/source/file/start/raw parts are not part of a
          // text answer; ignoring them is deliberate.
          break;
      }
      if (sawAbortPart) break;
    }

    if (controller.signal.aborted || sawAbortPart) {
      reportAbort();
      return;
    }
    if (!sawFinish) {
      // The reader ended without the provider's finish marker: the
      // connection was cut, not completed.
      throw new Error(
        "连接在响应完成前中断（未收到结束标记）。已到达的部分内容会保留，可以重试。",
      );
    }
    if (!partialText.trim()) {
      throw new Error("模型返回了空响应。");
    }

    settle(() => opts.onDone(toStreamUsage(finishUsage, stepMetadata), active.name));
  } catch (err) {
    if (controller.signal.aborted) {
      reportAbort();
      return;
    }
    const error = toError(err);
    if (isEnvironmentAbort(error)) {
      // Nobody in this process called `abort()`, yet the fetch came back
      // aborted: the page lifecycle ended the request.
      settle(() => opts.onInterrupted?.(partialText));
      return;
    }
    // Asked of the *raw* value as well as the normalised one: the AI SDK
    // wraps a transport failure in an `APICallError` and hides the original
    // `TypeError` in `cause`, which `toError` deliberately drops.
    const transport = isTransportFailure(err) || isTransportFailure(error);
    const safe = sanitizeError(error, [requestKey, readSettings().apiKey]);
    settle(() => opts.onError(transport ? withTransportHint(safe) : safe));
  } finally {
    if (timeout) clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", cancelListener);
    inflight.delete(controller);
  }
}

/** Shaped like an SDK error without being one. */
function looksLikeError(value: unknown): value is Error {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Normalise whatever the SDK surfaced into a plain Error.
 *
 * Deliberately does not hand back the object it was given, and does not
 * stringify one either: an `APICallError` carries `requestBodyValues` (the
 * whole prompt), `responseHeaders`, `responseBody` and a `cause` chain, and
 * a provider's error frame can carry anything the vendor chose to echo —
 * including the API key the request was made with. A caller that renders
 * `err.message` into a note, a log or a sync payload must not be handed that
 * payload by this module.
 */
function toError(value: unknown): Error {
  if (looksLikeError(value)) {
    const error = new Error(value.message);
    // The name is carried over deliberately: an `AbortError` raised by the
    // browser is a `DOMException`, which is an `Error` subclass in Node but
    // *not* in Chromium. Dropping the name here would make a torn-down page
    // read as a provider failure in exactly the environment that produces it.
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && name) error.name = name;
    return error;
  }
  if (typeof value === "string") return new Error(value);
  return new Error("模型请求失败（未提供错误详情）");
}

/**
 * True when the browser aborted a fetch that we never asked to abort, which
 * is how a navigation or reload surfaces: not as a kernel-level network
 * failure but as an `AbortError` raised from outside this module.
 */
function isEnvironmentAbort(error: Error): boolean {
  return error.name === "AbortError";
}

/**
 * Replace the credentials this call was made with, plus anything that looks
 * like one, with a marker.
 *
 * The provider is the other end of a request that carried the user's key, so
 * whatever it echoes back is under its control. Matching the live key
 * exactly covers the realistic case (a 401 that quotes the key it rejected);
 * the shape patterns are the backstop for a vendor that logs a key it was
 * never given, or a rotated one.
 */
export function redactSecrets(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    out = out.split(trimmed).join("[密钥已隐藏]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [密钥已隐藏]");
  out = out.replace(/\bsk-[A-Za-z0-9._\-]{8,}/g, "[密钥已隐藏]");
  return out;
}

/**
 * Build the Error a caller is allowed to keep.
 *
 * A fresh Error with a redacted message and nothing else: no `cause`, no
 * headers, no request body, no vendor object. `stack` is generated here, so
 * it points at this module instead of at a frame holding the request.
 */
function sanitizeError(error: Error, secrets: string[]): Error {
  const message = redactSecrets(error.message, secrets).trim();
  return new Error(message || "模型请求失败（未提供错误详情）");
}

/**
 * Whether this is the browser failing to complete the request at all, as
 * opposed to the provider answering with a problem.
 *
 * Walks the `cause` chain because the AI SDK wraps a failed `fetch` in an
 * `APICallError`: the reason sits one level down (a `TypeError: Failed to
 * fetch` in a browser, a `ECONNREFUSED` system error in Node), while the
 * wrapper's own name and message say nothing about it.
 */
const TRANSPORT_MESSAGE =
  /failed to fetch|networkerror|load failed|fetch failed|network request failed|err_connection_|cannot connect to api|socket hang up/i;
/** System-level failure codes that mean "never reached the provider". */
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isTransportFailure(value: unknown): boolean {
  let current: unknown = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const { message, code } = current as { message?: unknown; code?: unknown };
    if (typeof message === "string" && TRANSPORT_MESSAGE.test(message)) return true;
    if (typeof code === "string" && TRANSPORT_CODES.has(code.toUpperCase())) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Add a browser-direct-connection hint to a transport failure.
 *
 * The provider's own message is kept verbatim — a CORS rejection is not
 * rewritten into a guess — but "Failed to fetch" alone does not tell a
 * reader that the cause is on *this* side of the wire.
 *
 * It does not claim the key was withheld. A blocked CORS response means the
 * browser refused to *show us the answer*; when the preflight passed, the
 * request and the credential inside it already reached the vendor (the
 * browser suite pins that with a vendor that admits receiving it). Nothing
 * is proxied as a fallback, so all this can honestly say is that delivery
 * cannot be confirmed from here.
 */
function withTransportHint(error: Error): Error {
  return new Error(
    `${error.message}（浏览器无法读取该地址的响应：可能是网络不可达、服务商未开放浏览器直连（CORS 被拦），或地址/协议不正确。` +
      `被拦下的可能只是响应，因此无法确认请求是否已送达、密钥是否已经发出；本项目不会代为转发密钥。）`,
  );
}

/**
 * Build the usage payload, or `undefined` when the provider stayed quiet.
 *
 * The counters are copied only when the provider actually reported a
 * number: `{ promptTokens: 0, ... }` would be rendered as a real token
 * count on the note card.
 */
function toStreamUsage(
  rawUsage: unknown,
  providerMetadata: Record<string, unknown> | undefined,
): StreamUsage | undefined {
  const u = (rawUsage ?? {}) as Record<string, unknown>;
  const promptTokens = numberOrUndefined(u.inputTokens ?? u.promptTokens);
  const completionTokens = numberOrUndefined(u.outputTokens ?? u.completionTokens);
  const totalTokens = numberOrUndefined(u.totalTokens);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens:
      numberOrUndefined(u.cachedInputTokens) ??
      extractCachedTokens(providerMetadata),
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractCachedTokens(
  meta: Record<string, unknown> | undefined,
): number | undefined {
  if (!meta) return undefined;
  for (const value of Object.values(meta)) {
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      const candidates = [
        v.cachedTokens,
        v.cacheReadInputTokens,
        (v.usage as Record<string, unknown> | undefined)?.cached_tokens,
        (v.usage as Record<string, unknown> | undefined)
          ?.cache_read_input_tokens,
      ];
      for (const c of candidates) {
        if (typeof c === "number") return c;
      }
    }
  }
  return undefined;
}

async function mockStream(opts: {
  messages: ChatMessage[];
  signal?: AbortSignal;
  onChunk: (text: string) => void;
  onDone: (usage?: StreamUsage, modelName?: string) => void;
  onError: (err: Error) => void;
}) {
  const lastUser =
    [...opts.messages].reverse().find((m) => m.role === "user")?.content || "";
  const reply =
    "[演示模式：尚未配置 API 密钥。请打开右上角的设置，填写模型服务商的密钥后获取真实回答。]\n\n" +
    "你提出的问题是：" +
    lastUser.slice(0, 200) +
    "…";

  const tokens = reply.split(/(\s+)/);
  for (const tok of tokens) {
    if (opts.signal?.aborted) return;
    opts.onChunk(tok);
    await new Promise((r) => setTimeout(r, 18));
  }
  if (opts.signal?.aborted) return;
  opts.onDone(undefined, "mock");
}
