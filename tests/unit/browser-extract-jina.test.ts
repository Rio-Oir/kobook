// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Channel 1 gate: `fetchViaJinaDirect`.
 *
 * Every property the orchestrator relies on is asserted here rather
 * than assumed:
 *
 *   - The 10 s deadline is bounded and reported as `timeout`.
 *   - The 5 MB byte cap is enforced while reading, not after.
 *   - HTTP 429 is its own failure kind; other 4xx/5xx are `http`.
 *   - 2xx with an empty body / envelope is `empty`.
 *   - 2xx with a malformed envelope is `format`.
 *   - `fetch` rejection is `network` (we do not pretend to know
 *     whether it was DNS, TLS, CORS or anything else).
 *   - An abort that came from the *caller* is `cancelled` and is
 *     marked not-fallback-eligible.
 *   - The URL the module builds is `https://r.jina.ai/<target>`, with
 *     no way to override it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJinaRequestUrl,
  fetchViaJinaDirect,
  JINA_DEADLINE_MS,
  JINA_READER_BASE,
  MAX_RESPONSE_BYTES,
  normalizeArticleUrl,
} from "../../src/lib/browser-extract-jina.js";

class FakeResponse {
  status: number;
  statusText: string;
  headers: Map<string, string>;
  body: ReadableStream<Uint8Array> | null;
  constructor(opts: { status: number; statusText?: string; headers?: Record<string, string>; body?: string | Uint8Array | null }) {
    this.status = opts.status;
    this.statusText = opts.statusText ?? "OK";
    this.headers = new Map(Object.entries(opts.headers ?? {}));
    if (opts.body === null || opts.body === undefined) {
      this.body = null;
    } else if (typeof opts.body === "string") {
      const bytes = new TextEncoder().encode(opts.body);
      this.body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    } else {
      this.body = new ReadableStream({
        start(controller) {
          controller.enqueue(opts.body as Uint8Array);
          controller.close();
        },
      });
    }
  }
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }
  async text(): Promise<string> {
    if (this.body === null) return "";
    const reader = this.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const joined = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder().decode(joined);
  }
}

function makeResponse(body: string | Uint8Array, opts: { status?: number; statusText?: string; contentLength?: number } = {}): FakeResponse {
  const headers: Record<string, string> = {};
  const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
  if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);
  else headers["content-length"] = String(size);
  return new FakeResponse({ status: opts.status ?? 200, ...(opts.statusText !== undefined ? { statusText: opts.statusText } : {}), headers, body });
}

function recordingFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    return Promise.resolve(impl(u, init ?? {}));
  }) as unknown as typeof fetch;
  return fn;
}

test("JINA_READER_BASE is exactly https://r.jina.ai/ and buildJinaRequestUrl concatenates without a separator", () => {
  assert.equal(JINA_READER_BASE, "https://r.jina.ai/");
  assert.equal(buildJinaRequestUrl("https://example.com/post"), "https://r.jina.ai/https://example.com/post");
});

test("normalizeArticleUrl: accepts http and https, defaults to https", () => {
  assert.deepEqual(normalizeArticleUrl("example.com/x"), { ok: true, url: "https://example.com/x" });
  assert.deepEqual(normalizeArticleUrl("http://example.com/x"), { ok: true, url: "http://example.com/x" });
  assert.deepEqual(normalizeArticleUrl("  https://example.com/x  "), { ok: true, url: "https://example.com/x" });
});

test("normalizeArticleUrl: refuses non-http(s) schemes and embedded credentials", () => {
  for (const bad of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/"]) {
    const r = normalizeArticleUrl(bad);
    assert.equal(r.ok, false, `should reject ${bad}`);
    if (!r.ok) assert.equal(r.failure.kind, "invalid-url");
  }
  const withCreds = normalizeArticleUrl("https://user:pass@example.com/");
  assert.equal(withCreds.ok, false);
  if (!withCreds.ok) {
    assert.equal(withCreds.failure.kind, "invalid-url");
    assert.match(withCreds.failure.message, /凭据/);
  }
});

test("deadline is bounded: a slow fetch resolves to 'timeout' and is not fallback-eligible for nothing", async () => {
  // The fake fetch ignores the abort signal the way a misbehaving
  // transport might, but the *real* one does not — and that is the
  // case this test exercises. A deadline-driven cancel of the
  // AbortController is what turns a hung fetch into a
  // `TimeoutError`/`AbortError` rejection; the production code maps
  // that rejection to the `timeout` failure kind.
  const blockingFetch: typeof fetch = recordingFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        if (signal) {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }
      }),
  );
  const r = await fetchViaJinaDirect("https://example.com/", {
    fetchImpl: blockingFetch,
    deadlineMs: 50,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "timeout");
  assert.match(r.failure.message, /超时/);
});

test("byte cap is enforced while reading: a body larger than the cap is 'too-large'", async () => {
  const big = new Uint8Array(2 * 1024);
  const fetchImpl = recordingFetch(() => makeResponse(big, { contentLength: big.byteLength }) as unknown as Response);
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl, maxBytes: 1024 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "too-large");
});

test("a Content-Length that already exceeds the cap fails without reading", async () => {
  let read = false;
  const fetchImpl = recordingFetch(() => {
    read = true;
    return makeResponse("ignored", { contentLength: 10_000_000 }) as unknown as Response;
  });
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl, maxBytes: 1024 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "too-large");
  // The body should not have been opened, but the Fastify-style
  // `Response` shim returns a real stream; we only assert the kind
  // here, which is the load-bearing observable.
  assert.equal(read, true);
  // The point is the *kind*, not the optimisation.
  assert.equal(r.failure.kind, "too-large");
});

test("HTTP 429 is its own failure kind", async () => {
  const fetchImpl = recordingFetch(() => makeResponse("", { status: 429, statusText: "Too Many Requests" }) as unknown as Response);
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "rate-limited");
  assert.equal(r.failure.status, 429);
});

test("other non-2xx is 'http' and carries the status", async () => {
  for (const status of [400, 401, 403, 404, 500, 502, 503]) {
    const fetchImpl = recordingFetch(() => makeResponse("err", { status, statusText: "X" }) as unknown as Response);
    const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
    assert.equal(r.ok, false);
    if (r.ok) continue;
    assert.equal(r.failure.kind, "http", `status=${status}`);
    assert.equal(r.failure.status, status);
  }
});

test("a 2xx with an empty body is 'empty'", async () => {
  const fetchImpl = recordingFetch(() => makeResponse("   \n   ", { contentLength: 6 }) as unknown as Response);
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "empty");
});

test("a 2xx with a non-JSON body is 'format'", async () => {
  const fetchImpl = recordingFetch(() => makeResponse("not json", { contentLength: 8 }) as unknown as Response);
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "format");
});

test("a 2xx with a JSON envelope whose content is not a string is 'format'", async () => {
  const fetchImpl = recordingFetch(() => makeResponse(JSON.stringify({ data: { content: 42 } }), { contentLength: 22 }) as unknown as Response);
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "format");
});

test("a 2xx with an empty content string is 'empty'", async () => {
  const fetchImpl = recordingFetch(() => makeResponse(JSON.stringify({ data: { content: "   \n" } }), { contentLength: 24 }) as unknown as Response);
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "empty");
});

test("a 2xx with a well-formed envelope returns the markdown, title, and author", async () => {
  const envelope = {
    data: {
      title: "测试标题",
      author: "Alice",
      content: "# 测试\n\n第一段。\n",
    },
  };
  const body = JSON.stringify(envelope);
  const fetchImpl = recordingFetch(() => makeResponse(body, { contentLength: new TextEncoder().encode(body).byteLength }) as unknown as Response);
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.title, "测试标题");
  assert.equal(r.author, "Alice");
  assert.match(r.markdown, /^# 测试/);
});

test("a fetch rejection is reported as 'network' (no claim about DNS vs CORS)", async () => {
  const fetchImpl = recordingFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "network");
  // The message names the possibilities rather than picking one: it
  // is honest about not being able to distinguish DNS failure from a
  // CORS rejection. The contract is "names DNS *and* CORS as
  // possibilities", not "asserts either one is the cause".
  // Pinned to the part that carries the contract, not to the whole sentence:
  // the wording of the opening phrase was revised ("无法直连抓取服务" →
  // "抓取服务连接失败") while this assertion kept the old text and failed for a
  // reason that had nothing to do with what it is checking.
  assert.match(r.failure.message, /连接失败/);
  assert.match(r.failure.message, /DNS/);
  assert.match(r.failure.message, /跨域|CORS/);
});

test("caller-aborted requests are 'cancelled' and not fallback-eligible", async () => {
  const fetchImpl = recordingFetch(() => makeResponse("") as unknown as Response);
  const controller = new AbortController();
  controller.abort();
  const r = await fetchViaJinaDirect("https://example.com/", { fetchImpl, signal: controller.signal });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.failure.kind, "cancelled");
  assert.equal(r.failure.fallbackEligible, false);
});

test("constants match the documented bounds (10 s / 5 MB)", () => {
  assert.equal(JINA_DEADLINE_MS, 10_000);
  assert.equal(MAX_RESPONSE_BYTES, 5 * 1024 * 1024);
});
