// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fake OpenAI-compatible provider for the BYOK suites.
 *
 * Every BYOK test needs the *real* path: the real `@ai-sdk/openai-compatible`
 * model, the real `streamText`, the real HTTP client. Only the far end is
 * fake. So this is a small HTTP server that speaks the SSE subset the SDK
 * consumes, binds `127.0.0.1:0` (a fresh dynamic port per instance, so the
 * browser suites' fixed ports are never touched), and records what the SDK
 * actually sent — which is how "the key only travels to the selected
 * vendor" is proven rather than asserted from the client side.
 *
 * No network access: loopback only, and `validateSettings` allows loopback
 * HTTP for exactly this reason.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeResponse = {
  /** HTTP status for the stream response. Default 200. */
  status?: number;
  /** Raw SSE frames, written in order. */
  frames?: string[];
  /** Milliseconds to wait before the response headers are sent. */
  headerDelayMs?: number;
  /** Milliseconds between frames. */
  frameDelayMs?: number;
  /** Destroy the socket right after this many frames (truncated response). */
  destroyAfter?: number;
  /** Non-SSE body, used for error payloads. */
  body?: string;
  contentType?: string;
  /** Extra response headers. */
  headers?: Record<string, string>;
  /**
   * Omit the CORS headers. From a browser this is what "the vendor does not
   * support direct browser access" looks like on the wire.
   */
  omitCors?: boolean;
};

export type CapturedRequest = {
  method: string;
  url: string;
  /** Value of the Authorization header, or null when the request had none. */
  authorization: string | null;
  body: unknown;
};

export type FakeProvider = {
  /** `http://127.0.0.1:<port>/v1` — what goes into settings.baseURL. */
  baseURL: string;
  origin: string;
  port: number;
  /** One entry per POST /chat/completions, in arrival order. */
  requests: CapturedRequest[];
  /** One entry per CORS preflight, in arrival order. */
  preflights: string[];
  close: () => Promise<void>;
};

/** One OpenAI-compatible SSE chunk. */
export function chunkFrame(
  delta: { content?: string; role?: string },
  finishReason: string | null = null,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached?: number },
): string {
  const payload: Record<string, unknown> = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) {
    payload.usage = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      prompt_tokens_details: usage.cached === undefined ? undefined : { cached_tokens: usage.cached },
    };
  }
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The final chunk of a well-formed stream. */
export function finishFrame(
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached?: number },
): string {
  return chunkFrame({}, "stop", usage);
}

export const DONE_FRAME = "data: [DONE]\n\n";

/**
 * A complete, successful text stream. `text` is split into one frame per
 * character so the cancel/timeout tests have something to interrupt.
 */
export function successFrames(
  text = "你好，世界",
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached?: number },
): string[] {
  return [
    chunkFrame({ role: "assistant", content: "" }),
    ...[...text].map((c) => chunkFrame({ content: c })),
    finishFrame(usage),
    DONE_FRAME,
  ];
}

/** The OpenAI-compatible in-stream error frame. */
export function errorFrame(message: string): string {
  return `data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`;
}

/** A non-OK JSON error body, which is what a 401/429 usually returns. */
export function errorBody(message: string, type = "invalid_request_error"): string {
  return JSON.stringify({ error: { message, type, code: null, param: null } });
}

export async function startFakeProvider(
  responses: FakeResponse[] = [{}],
): Promise<FakeProvider> {
  const requests: CapturedRequest[] = [];
  const preflights: string[] = [];
  let served = 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const corsHeaders: Record<string, string> = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "0",
    };

    if (req.method === "OPTIONS") {
      // A browser preflight never carries the credential — the spec strips
      // it — so recording these separately from the POSTs is what makes the
      // "the key was only ever sent to the chosen vendor" claim meaningful.
      preflights.push(req.url ?? "");
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const raw = await readBody(req);
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep the raw string */
    }
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: (req.headers["authorization"] as string | undefined) ?? null,
      body: parsed,
    });

    const script = responses[Math.min(served, responses.length - 1)] ?? {};
    served += 1;

    const headers: Record<string, string> = {
      ...(script.omitCors ? {} : corsHeaders),
      ...(script.headers ?? {}),
    };

    if (script.body !== undefined) {
      headers["content-type"] = script.contentType ?? "application/json";
      res.writeHead(script.status ?? 200, headers);
      res.end(script.body);
      return;
    }

    headers["content-type"] = "text/event-stream";
    headers["cache-control"] = "no-cache";
    headers["connection"] = "keep-alive";
    if (script.headerDelayMs) await sleep(script.headerDelayMs);
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(script.status ?? 200, headers);

    const frames = script.frames ?? successFrames();
    for (let i = 0; i < frames.length; i += 1) {
      if (script.frameDelayMs) await sleep(script.frameDelayMs);
      if (res.destroyed || res.writableEnded) return;
      if (script.destroyAfter !== undefined && i >= script.destroyAfter) {
        res.socket?.destroy();
        return;
      }
      res.write(frames[i]);
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    preflights,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * In-memory `localStorage`, installed on `globalThis` before the settings
 * store is imported. Zustand's `createJSONStorage(() => window.localStorage)`
 * silently disables persistence when `window` is missing, so both have to
 * exist for these tests to exercise the real persist middleware.
 */
export function installLocalStorage(): Map<string, string> {
  const memory = new Map<string, string>();
  const polyfill = {
    getItem: (k: string): string | null => memory.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      memory.set(k, v);
    },
    removeItem: (k: string): void => {
      memory.delete(k);
    },
    clear: (): void => {
      memory.clear();
    },
    key: (i: number): string | null => Array.from(memory.keys())[i] ?? null,
    get length(): number {
      return memory.size;
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: polyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: polyfill,
    configurable: true,
    writable: true,
  });
  return memory;
}

/** Let the persist middleware's microtask chain settle. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function readPersistedSettings(
  memory: Map<string, string>,
): { version: number; state: Record<string, unknown> } {
  const raw = memory.get("gloss-settings");
  if (!raw) throw new Error("gloss-settings was never written");
  return JSON.parse(raw) as { version: number; state: Record<string, unknown> };
}
