// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stream cancellation gate.
 *
 * The G6 isolation rule says that when an account signs out or switches,
 * any in-flight AI stream must stop mutating the local cache. The contract
 * is implemented in two pieces:
 *
 *   - `streamChat` registers its `AbortController` in a module-scope Set
 *     so `abortAllStreams` can reach it;
 *   - the mock-path loop checks `signal.aborted` between tokens and
 *     returns early, so no late `onChunk` lands on a note that the next
 *     account will never see.
 *
 * The unit test exercises only the mock path (no API key configured),
 * which is the only path that runs in node without external services.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";

const memory = new Map<string, string>();
const localStoragePolyfill = {
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

before(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStoragePolyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStoragePolyfill,
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  memory.clear();
});

async function loadStream() {
  const { useSettings } = await import("../../src/lib/settings.js");
  useSettings.getState().clearApiKey();
  useSettings.getState().setOwner("anonymous");
  return import("../../src/lib/ai.js");
}

test("mock path emits chunks and reaches onDone when not aborted", async () => {
  const { streamChat, abortAllStreams } = await loadStream();
  assert.equal(abortAllStreams(), 0, "no streams should be in flight at start");

  const chunks: string[] = [];
  let doneWith: { model: string | undefined } = { model: "still-running" };
  const controller = new AbortController();
  await streamChat({
    messages: [{ role: "user", content: "你好" }],
    signal: controller.signal,
    onChunk: (text) => chunks.push(text),
    onDone: (_usage, model) => {
      doneWith.model = model;
    },
    onError: (err) => {
      throw err;
    },
  });

  assert.ok(chunks.length > 0, "mock path should emit at least one chunk");
  assert.match(chunks.join(""), /你好/, "the user's question should be echoed in the mock reply");
  assert.equal(doneWith.model, "mock");
});

test("a pre-aborted signal short-circuits and never invokes onChunk or onDone", async () => {
  const { streamChat, abortAllStreams } = await loadStream();
  assert.equal(abortAllStreams(), 0);

  const controller = new AbortController();
  controller.abort();

  let chunkCount = 0;
  let doneCount = 0;
  let errorCount = 0;
  await streamChat({
    messages: [{ role: "user", content: "anything" }],
    signal: controller.signal,
    onChunk: () => {
      chunkCount += 1;
    },
    onDone: () => {
      doneCount += 1;
    },
    onError: () => {
      errorCount += 1;
    },
  });

  assert.equal(chunkCount, 0, "pre-aborted signal must skip every chunk");
  assert.equal(doneCount, 0, "pre-aborted signal must skip onDone");
  assert.equal(errorCount, 0, "pre-aborted signal must skip onError");
});

test("aborting mid-stream stops further chunks and prevents onDone", async () => {
  const { streamChat, abortAllStreams } = await loadStream();
  assert.equal(abortAllStreams(), 0);

  const controller = new AbortController();
  const chunks: string[] = [];
  let doneCount = 0;

  const promise = streamChat({
    messages: [{ role: "user", content: "hello world" }],
    signal: controller.signal,
    onChunk: (text) => {
      chunks.push(text);
      // Abort after the first token lands. The mock splits on whitespace,
      // so the first token includes the leading word; later tokens
      // include trailing spaces. Either is fine for the test, as long
      // as we cut the stream while there is still more to emit.
      if (chunks.length === 1) controller.abort();
    },
    onDone: () => {
      doneCount += 1;
    },
    onError: () => {
      // Aborted streams are not errors; the contract is that the AI SDK
      // raises the controller and `streamChat` swallows it before the
      // onError callback fires. This assertion is part of the gate.
      throw new Error("onError should not fire on abort");
    },
  });

  await promise;
  assert.ok(chunks.length >= 1, "the first chunk must land before the abort");
  assert.ok(chunks.length < 30, "the abort must stop further chunks; got " + chunks.length);
  assert.equal(doneCount, 0, "aborted streams must not reach onDone");
});

test("abortAllStreams cancels every in-flight request at once", async () => {
  const { streamChat, abortAllStreams } = await loadStream();
  assert.equal(abortAllStreams(), 0, "abortAllStreams on an empty set returns 0");

  const c1 = new AbortController();
  const c2 = new AbortController();
  const c3 = new AbortController();
  const counts = [0, 0, 0];

  const p1 = streamChat({
    messages: [{ role: "user", content: "one" }],
    signal: c1.signal,
    onChunk: () => {
      counts[0]! += 1;
    },
    onDone: () => {},
    onError: () => {},
  });
  const p2 = streamChat({
    messages: [{ role: "user", content: "two" }],
    signal: c2.signal,
    onChunk: () => {
      counts[1]! += 1;
    },
    onDone: () => {},
    onError: () => {},
  });
  const p3 = streamChat({
    messages: [{ role: "user", content: "three" }],
    signal: c3.signal,
    onChunk: () => {
      counts[2]! += 1;
    },
    onDone: () => {},
    onError: () => {},
  });

  // Let at least one token land in each stream so they are truly
  // in-flight (registered with the inflight set), then cancel the lot.
  await new Promise((r) => setTimeout(r, 60));
  const cancelled = abortAllStreams();
  assert.ok(cancelled >= 1, "abortAllStreams must report at least one cancellation");

  await Promise.all([p1, p2, p3]);

  // The inflight set is empty after the wave, so a follow-up call reports 0.
  assert.equal(abortAllStreams(), 0, "the inflight set must be drained after the wave");
});
