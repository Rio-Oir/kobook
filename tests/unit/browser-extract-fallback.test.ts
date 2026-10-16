// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Channel 2 gate: `fetchViaServerFallback`.
 *
 * The whole point of channel 2 is to be a *bounded* replacement when
 * channel 1 has given up, so its tests are mostly about what it must
 * *not* do:
 *
 *   - never accept a request body with a non-whitelisted field;
 *   - never leak the upstream Jina address, key or proxy hint;
 *   - never claim success on a non-2xx;
 *   - never follow a 200 whose `document` is not the agreed shape.
 *
 * Plus the cross-channel assertion: a successful channel 2 is what
 * the orchestrator turns into `source: "server-jina"` /
 * `"server-readability"`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES } from "../../shared/contracts/index.js";
import {
  EXTRACT_FIELD_WHITELIST,
  fetchViaServerFallback,
  pickExtractFields,
  SERVER_FALLBACK_DEADLINE_MS,
} from "../../src/lib/browser-extract-server.js";

class FakeResponse {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  body: string;
  constructor(opts: { status: number; statusText?: string; body?: string; contentType?: string }) {
    this.status = opts.status;
    this.statusText = opts.statusText ?? "OK";
    this.headers = new Map();
    if (opts.contentType) this.headers.set("content-type", opts.contentType);
    this.body = opts.body ?? "";
  }
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  async text(): Promise<string> {
    return this.body;
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.body);
  }
}

function makeResponse(status: number, body: string, contentType = "application/json"): FakeResponse {
  return new FakeResponse({ status, body, contentType });
}

function recordingFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const captured = init ?? {};
    calls.push({ url: u, init: captured });
    return Promise.resolve(impl(u, captured));
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

test("pickExtractFields builds a request with the agreed fields only", () => {
  const req = pickExtractFields({ kind: "text", content: "hello", title: "T" });
  assert.equal(req.kind, "text");
  assert.equal(req.content, "hello");
  assert.equal(req.title, "T");
  assert.deepEqual(Object.keys(req).sort(), ["content", "kind", "title"]);
});

test("pickExtractFields omits the title when none was given", () => {
  const req = pickExtractFields({ kind: "text", content: "hello" });
  assert.equal("title" in req, false);
});

test("pickExtractFields throws on a non-whitelisted field", () => {
  // @ts-expect-error — intentionally adding a key.
  assert.throws(() => pickExtractFields({ kind: "text", content: "x", apiKey: "sk-x" }), /额外的/);
  // @ts-expect-error — extra key.
  assert.throws(() => pickExtractFields({ kind: "text", content: "x", jinaBase: "https://evil.test" }), /额外的/);
});

test("EXTRACT_FIELD_WHITELIST is the closed set { kind, content, title }", () => {
  assert.deepEqual([...EXTRACT_FIELD_WHITELIST].sort(), ["content", "kind", "title"]);
});

test("fetchViaServerFallback: a 2xx with a usable document returns source by extractor", async () => {
  const document = {
    title: "x",
    author: null,
    blocks: [{ id: "b1-aaaaaaaaaaaaaaaa", index: 1, type: "paragraph", text: "hi", hash: "aaaaaaaaaaaaaaaa" }],
    source: "markdown-remark",
    extractorVersion: "phase1.2",
    textHash: "abcd",
  };
  const { fetch, calls } = recordingFetch((_url, _init) =>
    makeResponse(200, JSON.stringify({ extractor: "jina", document })) as unknown as Response,
  );
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.extractor, "jina");
  assert.equal(calls.length, 1);
  // The route is the agreed one; the test has no override.
  assert.equal(calls[0]?.url, ROUTES.anonymousExtract);
  // The body is JSON containing only whitelisted fields.
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.deepEqual(Object.keys(body).sort(), ["content", "kind"]);
});

test("fetchViaServerFallback: a 2xx with extractor 'html-readability' is passed through", async () => {
  const document = {
    title: "x",
    author: null,
    blocks: [{ id: "b1-bbbbbbbbbbbbbbbb", index: 1, type: "paragraph", text: "hi", hash: "bbbbbbbbbbbbbbbb" }],
    source: "markdown-remark",
    extractorVersion: "phase1.2",
    textHash: "abcd",
  };
  const { fetch } = recordingFetch(() => makeResponse(200, JSON.stringify({ extractor: "html-readability", document })) as unknown as Response);
  const r = await fetchViaServerFallback({ kind: "url", content: "https://example.com/" }, { fetchImpl: fetch });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.extractor, "html-readability");
});

test("fetchViaServerFallback: 4xx carries the server's own message when it has one", async () => {
  const { fetch } = recordingFetch(() =>
    makeResponse(404, JSON.stringify({ error: { code: "NOT_FOUND", message: "No such endpoint." } })) as unknown as Response,
  );
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "http");
  assert.equal(r.failure.status, 404);
  assert.equal(r.failure.message, "No such endpoint.");
});

test("fetchViaServerFallback: 500 falls through as 'http' and is not 'network'", async () => {
  const { fetch } = recordingFetch(() => makeResponse(500, JSON.stringify({ error: { message: "boom" } })) as unknown as Response);
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "http");
  assert.equal(r.failure.status, 500);
});

test("fetchViaServerFallback: 429 is its own kind", async () => {
  const { fetch } = recordingFetch(() => makeResponse(429, JSON.stringify({ error: { message: "限流" } })) as unknown as Response);
  const r = await fetchViaServerFallback({ kind: "url", content: "https://example.com/" }, { fetchImpl: fetch });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "rate-limited");
  assert.equal(r.failure.status, 429);
});

test("fetchViaServerFallback: a fetch rejection is 'network'", async () => {
  const { fetch } = recordingFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "network");
});

test("fetchViaServerFallback: a 2xx whose body is not JSON is 'format'", async () => {
  const { fetch } = recordingFetch(() => makeResponse(200, "<html>nope</html>", "text/html") as unknown as Response);
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "format");
});

test("fetchViaServerFallback: a 2xx with an unknown extractor is 'format'", async () => {
  const document = {
    title: "x",
    author: null,
    blocks: [{ id: "b1-cccccccccccccccc", index: 1, type: "paragraph", text: "hi", hash: "cccccccccccccccc" }],
    source: "markdown-remark",
    extractorVersion: "phase1.2",
    textHash: "abcd",
  };
  const { fetch } = recordingFetch(() => makeResponse(200, JSON.stringify({ extractor: "telepathy", document })) as unknown as Response);
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "format");
});

test("fetchViaServerFallback: a 2xx with a malformed document is 'format'", async () => {
  const { fetch } = recordingFetch(() => makeResponse(200, JSON.stringify({ extractor: "jina", document: { title: 42 } })) as unknown as Response);
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "format");
});

test("fetchViaServerFallback: a caller abort before dispatch is 'cancelled'", async () => {
  const { fetch } = recordingFetch(() => makeResponse(200, "{}") as unknown as Response);
  const controller = new AbortController();
  controller.abort();
  const r = await fetchViaServerFallback({ kind: "text", content: "hello" }, { fetchImpl: fetch, signal: controller.signal });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "cancelled");
});

test("fetchViaServerFallback: a slow fetch that exceeds the deadline is 'timeout'", async () => {
  const { fetch: blockingFetch } = recordingFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        if (signal) {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }
      }),
  );
  const r = await fetchViaServerFallback(
    { kind: "text", content: "hello" },
    { fetchImpl: blockingFetch, deadlineMs: 30 },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "timeout");
});

test("SERVER_FALLBACK_DEADLINE_MS is longer than the route's own 20 s budget", () => {
  // The number is asserted, not the route's, so a tightening of the
  // route does not silently flip the outer safety net.
  assert.equal(SERVER_FALLBACK_DEADLINE_MS, 30_000);
  assert.ok(SERVER_FALLBACK_DEADLINE_MS > 20_000);
});
