// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * BYOK stream lifecycle gate (fake provider, real SDK).
 *
 * The defect this suite exists for: `streamChat` iterated `result.textStream`,
 * which forwards only `text-delta` and drops `{ type: "error" }` on the
 * floor. A provider that answered 401, 429, sent an error frame, or dropped
 * the socket mid-answer therefore looked like a clean, empty success and
 * fired `onDone` — the answer never arrived and the note was recorded as
 * successful. Everything here goes through the real
 * `@ai-sdk/openai-compatible` client and a real loopback HTTP server, so the
 * assertions are about the actual wire behaviour rather than about a stub.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach, after } from "node:test";
import {
  DONE_FRAME,
  chunkFrame,
  errorBody,
  errorFrame,
  finishFrame,
  installLocalStorage,
  startFakeProvider,
  successFrames,
  type FakeProvider,
} from "./byok-fake-provider.js";

const memory = installLocalStorage();

let settings: typeof import("../../src/lib/settings.js");
let ai: typeof import("../../src/lib/ai.js");

before(async () => {
  settings = await import("../../src/lib/settings.js");
  ai = await import("../../src/lib/ai.js");
});

beforeEach(() => {
  memory.clear();
  settings.useSettings.getState().reset();
});

/** Point the store at `baseURL` with a confirmed key (the normal, usable setup). */
function configure(baseURL: string, apiKey = "sk-fake-byok"): void {
  const s = settings.useSettings.getState();
  s.setApiKey(apiKey);
  s.setModel("fake-model");
  s.setBaseURL(baseURL);
  s.confirmEndpoint();
}

type Recorder = {
  chunks: string[];
  done: Array<{ usage?: unknown; modelName?: string }>;
  errors: Error[];
  cancelled: string[];
  interrupted: string[];
  order: string[];
};

function recorder(): Recorder {
  return { chunks: [], done: [], errors: [], cancelled: [], interrupted: [], order: [] };
}

/** Run a chat and resolve when every callback has had its chance to fire. */
function chat(
  rec: Recorder,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  } = {},
): Promise<void> {
  return ai.streamChat({
    messages: opts.messages ?? [{ role: "user", content: "你好" }],
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    onChunk: (t) => {
      rec.chunks.push(t);
      rec.order.push("chunk");
    },
    onDone: (usage, modelName) => {
      rec.done.push({ usage, modelName });
      rec.order.push("done");
    },
    onError: (err) => {
      rec.errors.push(err);
      rec.order.push("error");
    },
    onCancelled: (partial) => {
      rec.cancelled.push(partial);
      rec.order.push("cancelled");
    },
    onInterrupted: (partial) => {
      rec.interrupted.push(partial);
      rec.order.push("interrupted");
    },
  });
}

const servers: FakeProvider[] = [];
async function provider(...args: Parameters<typeof startFakeProvider>) {
  const p = await startFakeProvider(...args);
  servers.push(p);
  return p;
}

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

// ── the success path ──────────────────────────────────────────────────────

test("a complete stream delivers the text, then onDone exactly once with usage", async () => {
  const p = await provider([
    { frames: successFrames("你好，世界", { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }) },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.chunks.join(""), "你好，世界");
  assert.deepEqual(rec.errors, []);
  assert.deepEqual(rec.cancelled, []);
  assert.equal(rec.done.length, 1, "onDone must fire exactly once");
  assert.equal(rec.done[0]?.modelName, "fake-model");
  assert.deepEqual(rec.done[0]?.usage, {
    promptTokens: 11,
    completionTokens: 5,
    totalTokens: 16,
    cachedTokens: undefined,
  });
  assert.equal(rec.order[rec.order.length - 1], "done", "onDone is the last event");
  assert.equal(ai.inflightStreamCount(), 0, "the request must be deregistered");
  assert.equal(p.requests.length, 1);
});

test("a provider that reports no usage leaves it unknown rather than zero", async () => {
  const p = await provider([{ frames: successFrames("没有用量", undefined) }]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.chunks.join(""), "没有用量");
  assert.equal(rec.done.length, 1);
  assert.equal(
    rec.done[0]?.usage,
    undefined,
    "absent usage must stay undefined — rendering it as 0 would claim a real token count",
  );
});

test("no key configured ⇒ the clearly labelled demo path, never the network", async () => {
  const p = await provider([{ frames: successFrames("should not be called") }]);
  // No configure(): the store keeps apiKey "".
  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 1);
  assert.equal(rec.done[0]?.modelName, "mock");
  assert.match(rec.chunks.join(""), /演示模式/);
  assert.equal(p.requests.length, 0, "the demo path must not touch the provider");
});

// ── failures that must never look like success ────────────────────────────

test("HTTP 401 is a failure: no onDone, no chunks", async () => {
  const p = await provider([
    { status: 401, body: errorBody("Incorrect API key provided") },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 0, "an authentication failure is not a success");
  assert.deepEqual(rec.chunks, []);
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0]!.message, /401|Incorrect API key/);
  assert.deepEqual(rec.cancelled, []);
});

test("HTTP 429 is a failure and is not retried", async () => {
  const p = await provider([
    { status: 429, body: errorBody("Rate limit reached", "rate_limit_error") },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.errors.length, 1, "a rate limit must surface as an error");
  assert.equal(rec.done.length, 0);
  assert.equal(
    p.requests.length,
    1,
    "maxRetries must be 0: a request that may already have streamed is never silently re-sent",
  );
});

test("HTTP 500 is not retried either", async () => {
  const p = await provider([{ status: 500, body: errorBody("upstream exploded") }]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 0);
  assert.equal(rec.errors.length, 1);
  assert.equal(p.requests.length, 1, "no automatic retry");
});

test("an error SSE frame after partial text keeps the text and fails the call", async () => {
  const p = await provider([
    { frames: [chunkFrame({ role: "assistant", content: "半" }), chunkFrame({ content: "句" }), errorFrame("模型上游失败")] },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.chunks.join(""), "半句", "text that already arrived is kept");
  assert.equal(rec.done.length, 0, "the dropped error frame must not become a success");
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0]!.message, /模型上游失败/);
});

test("a malformed frame fails the call instead of ending an empty success", async () => {
  const p = await provider([
    { frames: ['data: {"id":"x","choices":[', DONE_FRAME] },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 0);
  assert.equal(rec.errors.length, 1);
  assert.equal(rec.chunks.join(""), "");
});

test("an empty response (finish with no content) is an error, not an empty answer", async () => {
  const p = await provider([{ frames: [chunkFrame({ role: "assistant" }), finishFrame(), DONE_FRAME] }]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 0);
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0]!.message, /空响应/);
});

test("a stream that dies before its finish marker is a truncated response", async () => {
  // The socket is destroyed while frames remain unsent, which is a cut
  // connection rather than a completed answer.
  const p = await provider([
    {
      frames: [
        chunkFrame({ role: "assistant", content: "前" }),
        chunkFrame({ content: "半" }),
        chunkFrame({ content: "句" }),
        finishFrame(),
        DONE_FRAME,
      ],
      destroyAfter: 1,
    },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec);

  assert.ok(
    rec.chunks.join("").length < 3,
    "the connection died before the answer was complete",
  );
  assert.equal(rec.done.length, 0, "a cut connection is not a completed answer");
  assert.equal(rec.errors.length, 1, "and it is reported as a failure");
});

test("an unreachable endpoint is a network error, and says delivery is unconfirmed", async () => {
  // Bind and immediately release a port so nothing is listening on it.
  const dead = await startFakeProvider([{}]);
  const baseURL = dead.baseURL;
  await dead.close();

  configure(baseURL);
  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 0);
  assert.equal(rec.errors.length, 1);
  const msg = rec.errors[0]!.message;
  assert.match(msg, /无法确认/, 'a transport failure says what it cannot know');
  assert.doesNotMatch(
    msg,
    /密钥未发送|密钥没有发出|密钥未送达/,
    'and never claims the key was withheld — a blocked response may hide a delivered request',
  );
});

// ── what a caller is allowed to receive back ──────────────────────────────

const ECHO_KEY = "sk-echoed-secret-value-1234";
const BODY_SENTINEL = "SENTINEL-REQUEST-BODY-9f3a";

/** Everything a vendor-crafted error must never hand to the caller. */
const SDK_PAYLOAD_PROPS = [
  "requestBodyValues",
  "responseHeaders",
  "responseBody",
  "cause",
  "data",
  "url",
  "statusCode",
];

test("a 401 that quotes the key comes back redacted and stripped of SDK payloads", async () => {
  const p = await provider([
    {
      status: 401,
      body: JSON.stringify({
        error: {
          message: `Incorrect API key provided: ${ECHO_KEY}. You can find your API key at https://example.com/keys`,
          type: "invalid_request_error",
        },
      }),
    },
  ]);
  configure(p.baseURL, ECHO_KEY);

  const rec = recorder();
  await chat(rec, {
    messages: [{ role: "user", content: `${BODY_SENTINEL} 请解释这一段。` }],
  });

  assert.equal(rec.errors.length, 1);
  const err = rec.errors[0]!;
  assert.equal(
    p.requests[0]?.authorization,
    `Bearer ${ECHO_KEY}`,
    "the vendor really did receive the key — which is why the echo has to be redacted",
  );
  assert.equal(err.message.includes(ECHO_KEY), false, "the key must not survive into the error");
  assert.match(err.message, /密钥已隐藏/, "and its place is marked");
  assert.match(err.message, /Incorrect API key provided/, "while the useful part is kept");
  assert.equal(
    err.message.includes(BODY_SENTINEL),
    false,
    "the request body (the article text) must not ride along",
  );
  for (const prop of SDK_PAYLOAD_PROPS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(err, prop),
      false,
      `the caller must not be handed \`${prop}\` — it is where the SDK keeps the raw payload`,
    );
  }
  assert.equal((err as { cause?: unknown }).cause, undefined);
});

test("an in-stream error frame that quotes a key is redacted as well", async () => {
  const p = await provider([
    {
      frames: [
        chunkFrame({ role: "assistant", content: "开" }),
        // A vendor that echoes the live key, and one that echoes a
        // *different* key-shaped token — the shape backstop covers it.
        errorFrame(`quota exceeded for ${ECHO_KEY} (also seen: sk-some-other-vendor-token-abc)`),
      ],
    },
  ]);
  configure(p.baseURL, ECHO_KEY);

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 0);
  assert.equal(rec.errors.length, 1);
  const msg = rec.errors[0]!.message;
  assert.equal(msg.includes(ECHO_KEY), false);
  assert.equal(msg.includes("sk-some-other-vendor-token-abc"), false);
  assert.match(msg, /quota exceeded/);
});

test("a provider failure is never written to the console", async () => {
  const p = await provider([
    { status: 500, body: errorBody(`upstream said ${ECHO_KEY}`) },
  ]);
  configure(p.baseURL, ECHO_KEY);

  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const rec = recorder();
    await chat(rec);
    assert.equal(rec.errors.length, 1);
  } finally {
    console.error = originalError;
  }
  const serialized = JSON.stringify(logged.map((entry) => entry.map(String)));
  assert.equal(logged.length, 0, "the error path must not log; the SDK's default logger is disabled");
  assert.equal(serialized.includes(ECHO_KEY), false);
});

// ── cancellation vs. timeout ──────────────────────────────────────────────

test("a caller abort cancels: partial text is reported and onDone never fires", async () => {
  const p = await provider([
    { frames: successFrames("一二三四五六七八九十"), frameDelayMs: 25 },
  ]);
  configure(p.baseURL);

  const controller = new AbortController();
  const rec = recorder();
  const run = chat(rec, { signal: controller.signal });

  // Wait for the first slice of text, then stop.
  await waitFor(() => rec.chunks.length > 0);
  controller.abort();
  await run;

  assert.equal(rec.done.length, 0, "aborted streams must not reach onDone");
  assert.deepEqual(rec.errors, [], "an abort is not an error");
  assert.equal(rec.cancelled.length, 1, "onCancelled fires exactly once");
  assert.ok(rec.cancelled[0]!.length > 0, "the partial text is handed back");
  assert.ok(
    rec.chunks.join("").startsWith(rec.cancelled[0]!),
    "the reported partial must be what actually arrived",
  );
  assert.equal(ai.inflightStreamCount(), 0);
});

test("abortAllStreams cancels the in-flight request and reports the partial", async () => {
  const p = await provider([
    { frames: successFrames("一二三四五六七八九十"), frameDelayMs: 25 },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  const run = chat(rec);
  await waitFor(() => rec.chunks.length > 0);

  assert.equal(ai.abortAllStreams(), 1, "the in-flight stream must be reachable");
  await run;

  assert.equal(rec.cancelled.length, 1);
  assert.equal(rec.done.length, 0);
  assert.deepEqual(rec.errors, []);
});

test("a timeout is reported as a failure, not as a cancellation", async () => {
  const p = await provider([
    { frames: successFrames("永远发不完"), frameDelayMs: 60 },
  ]);
  configure(p.baseURL);

  const rec = recorder();
  await chat(rec, { timeoutMs: 150 });

  assert.equal(
    rec.cancelled.length,
    0,
    "a slow provider must not look like the user pressed stop",
  );
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0]!.message, /超时|秒/);
  assert.equal(rec.done.length, 0);
  assert.equal(ai.inflightStreamCount(), 0);
});

test("a pre-cancelled signal reports cancellation and starts no request", async () => {
  const p = await provider([{ frames: successFrames("不该发生") }]);
  configure(p.baseURL);

  const controller = new AbortController();
  controller.abort();
  const rec = recorder();
  await chat(rec, { signal: controller.signal });

  assert.deepEqual(rec.cancelled, [""], "the caller is told the stream never ran");
  assert.deepEqual(rec.chunks, []);
  assert.deepEqual(rec.done, []);
  assert.deepEqual(rec.errors, []);
  assert.equal(p.requests.length, 0);
});

test("the environment aborting the fetch is reported as interrupted, not failed", async () => {
  configure("https://api.example.test/v1");
  const realFetch = globalThis.fetch;
  // What a page navigation looks like from inside the SDK: the fetch rejects
  // with AbortError even though nothing in this process called abort().
  globalThis.fetch = (() =>
    Promise.reject(new DOMException("The operation was aborted.", "AbortError"))) as typeof fetch;
  try {
    const rec = recorder();
    await chat(rec);

    assert.equal(rec.interrupted.length, 1, "a torn-down page is an interruption");
    assert.deepEqual(rec.errors, [], "and not a provider failure");
    assert.deepEqual(rec.done, []);
    assert.deepEqual(rec.cancelled, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── bookkeeping ───────────────────────────────────────────────────────────

test("the abort listener is removed and nothing is left in flight", async () => {
  const p = await provider([{ frames: successFrames("完成") }]);
  configure(p.baseURL);

  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const origAdd = controller.signal.addEventListener.bind(controller.signal);
  const origRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<typeof origAdd>) => {
    added += 1;
    return origAdd(...args);
  }) as typeof controller.signal.addEventListener;
  controller.signal.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
    removed += 1;
    return origRemove(...args);
  }) as typeof controller.signal.removeEventListener;

  const rec = recorder();
  await chat(rec, { signal: controller.signal });

  assert.equal(rec.done.length, 1);
  assert.equal(added, 1, "streamChat subscribes to the caller's signal");
  assert.equal(removed, added, "and unsubscribes on every exit path");
  assert.equal(ai.inflightStreamCount(), 0);

  // A late abort after a completed stream must not fire anything else.
  controller.abort();
  assert.equal(ai.abortAllStreams(), 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rec.done.length + rec.errors.length + rec.cancelled.length, 1);
});

test("an unconfirmed endpoint is refused before the key leaves the process", async () => {
  const p = await provider([{ frames: successFrames("不该发生") }]);
  const s = settings.useSettings.getState();
  s.setApiKey("sk-should-not-travel");
  s.setModel("fake-model");
  s.setBaseURL(p.baseURL);
  // Deliberately no confirmEndpoint(): the address changed but the user
  // never agreed to send the key to it.
  assert.equal(s.confirmedOrigin, "");

  const rec = recorder();
  await chat(rec);

  assert.equal(rec.done.length, 0);
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0]!.message, /确认/);
  assert.equal(p.requests.length, 0, "no request may carry the unconfirmed key");
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the stream");
    await new Promise((r) => setTimeout(r, 5));
  }
}
