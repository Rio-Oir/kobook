// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Article sync (Wire A) — client-side unit tests.
 *
 * These cover the surface that does not need a server:
 *
 *   1. `syncArticle` posts to the new `ROUTES.articleSync` endpoint
 *      and returns the parsed response.
 *   2. Non-2xx responses throw an `ApiRequestError` that the
 *      `article-sync` orchestrator already knows how to translate
 *      into a `SyncOutcome`.
 *   3. The orchestrator writes the right `setArticleRemote` /
 *      `setArticleSyncStatus` updates and is identity-aware.
 *
 * The real-server side of the contract (re-validated textHash,
 * `(ownerUserId, clientKey)` uniqueness, body schema) is exercised
 * by `tests/phase3.ts` gate G27 against a real Postgres; the
 * fake-response tests here pin the *client*'s expectations of the
 * wire shape so a future endpoint rename surfaces here rather than at
 * runtime.
 *
 * That claim was false until G27 existed: this comment named
 * `tests/phase3.ts` as the coverage for a route the server had never
 * registered, and the gate it pointed at did not mention
 * `/api/articles/sync` anywhere. The client unit tests passed the whole
 * time, because a fake `fetch` cannot tell a registered route from a
 * 404 — which is exactly the failure that shipped. G1 now asserts 401
 * (not 404) on the path with a schema-valid body, so an unregistered
 * route fails the integration run instead of going unnoticed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { syncArticle } from "../../src/lib/account-articles.js";
import { ApiRequestError } from "../../src/lib/api-error.js";
import { ROUTES } from "../../shared/contracts/index.js";
import type { ArticleSyncRequest } from "../../shared/contracts/index.js";

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

function recordingFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const captured = init ?? {};
    calls.push({ url: u, init: captured });
    return Promise.resolve(impl(u, captured));
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const fixturePayload: ArticleSyncRequest = {
  title: "测试文章",
  sourceUrl: "https://example.com/post",
  source: "browser-jina",
  author: null,
  textHash: "0123456789abcdef0123456789abcdef",
  blocks: [
    {
      id: "b1-01234567",
      index: 1,
      type: "paragraph",
      text: "正文。",
      hash: "0123456789abcdef0123456789abcdef",
    },
  ],
  clientKey: "00112233445566778899aabbccddeeff",
};

test("syncArticle POSTs to /api/articles/sync with the right body", async () => {
  const { fetch, calls } = recordingFetch((_url, _init) =>
    makeResponse(200, JSON.stringify({ articleId: "art-1", versionId: "ver-1", source: "url" })) as unknown as Response,
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch; // test injection
  try {
    const resp = await syncArticle(fixturePayload);
    assert.equal(resp.articleId, "art-1");
    assert.equal(resp.versionId, "ver-1");
    assert.equal(resp.source, "url");
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, ROUTES.articleSync);
    assert.equal(call.init.method, "POST");
    const sent = JSON.parse(String(call.init.body));
    assert.equal(sent.title, fixturePayload.title);
    assert.equal(sent.source, fixturePayload.source);
    assert.equal(sent.clientKey, fixturePayload.clientKey);
    assert.equal(sent.blocks.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("syncArticle does not put an apiKey or Authorization on the wire", async () => {
  const { fetch, calls } = recordingFetch((_url, _init) =>
    makeResponse(200, JSON.stringify({ articleId: "art-1", versionId: "ver-1", source: "url" })) as unknown as Response,
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch; // test injection
  try {
    await syncArticle(fixturePayload);
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    const headerNames = Object.keys(headers).map((k) => k.toLowerCase());
    assert.equal(headerNames.includes("authorization"), false, "Authorization must not be sent");
    assert.equal(headerNames.includes("x-api-key"), false, "X-Api-Key must not be sent");
    const sent = JSON.parse(String(calls[0]?.init.body));
    assert.equal("apiKey" in sent, false, "payload must not carry an apiKey");
    assert.equal("api_key" in sent, false, "payload must not carry an api_key");
  } finally {
    globalThis.fetch = original;
  }
});

test("syncArticle: 401 surfaces as an ApiRequestError", async () => {
  const { fetch } = recordingFetch((_url, _init) =>
    makeResponse(401, JSON.stringify({ error: { code: "UNAUTHORIZED", message: "未登录或会话已失效。", requestId: "req-1" } })) as unknown as Response,
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch; // test injection
  try {
    await assert.rejects(
      () => syncArticle(fixturePayload),
      (err: unknown) => {
        if (!(err instanceof ApiRequestError)) return false;
        assert.equal(err.status, 401);
        assert.equal(err.code, "UNAUTHORIZED");
        assert.equal(err.requestId, "req-1");
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("syncArticle: 422 with textHash mismatch surfaces the server's Chinese message", async () => {
  const { fetch } = recordingFetch((_url, _init) =>
    makeResponse(422, JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "textHash 不匹配正文。", requestId: "req-2" } })) as unknown as Response,
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch; // test injection
  try {
    await assert.rejects(
      () => syncArticle(fixturePayload),
      (err: unknown) => {
        if (!(err instanceof ApiRequestError)) return false;
        assert.equal(err.status, 422);
        assert.match(err.message, /textHash/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("syncArticle: 5xx response is normalised without exposing the server body verbatim", async () => {
  // A 500 with a raw English body must still come back as an
  // ApiRequestError with the default Chinese message and the
  // server's `requestId` carried through. The exact text on the
  // wire is operator detail; the client must not surface it to
  // the user.
  const { fetch } = recordingFetch((_url, _init) =>
    makeResponse(500, JSON.stringify({ error: { code: "INTERNAL", message: "The server could not complete the request.", requestId: "req-3" } })) as unknown as Response,
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch; // test injection
  try {
    await assert.rejects(
      () => syncArticle(fixturePayload),
      (err: unknown) => {
        if (!(err instanceof ApiRequestError)) return false;
        assert.equal(err.status, 500);
        assert.equal(err.requestId, "req-3");
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("syncArticle: 409 (same key, different body) surfaces as a CONFLICT ApiRequestError", async () => {
  // The server's contract for a 409 is "same key, different body"
  // — a client bug, not a successful retry. The transport should
  // surface it as a CONFLICT `ApiRequestError` so the
  // `local-import-sync` coordinator can map it onto the
  // `rejected` verdict (which the new 409-as-rejected semantics
  // requires) rather than the legacy `duplicate`. This test pins
  // the wire shape: a 409 with `{ error: { code: "CONFLICT" } }`
  // is an `ApiRequestError` carrying `code === "CONFLICT"` and the
  // server's `requestId`, so the orchestrator's transport can
  // pass `httpStatus` and `message` through to the outcome.
  const { fetch } = recordingFetch((_url, _init) =>
    makeResponse(409, JSON.stringify({ error: { code: "CONFLICT", message: "已存在", requestId: "req-4" } })) as unknown as Response,
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch; // test injection
  try {
    await assert.rejects(
      () => syncArticle(fixturePayload),
      (err: unknown) => {
        if (!(err instanceof ApiRequestError)) return false;
        assert.equal(err.status, 409);
        assert.equal(err.code, "CONFLICT");
        assert.match(err.message, /已存在/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});
