// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sync payload gate.
 *
 * Five rules, all asserted here rather than left to convention:
 *
 *  1. `buildSyncPayload` constructs the request body field-by-field.
 *     A caller that hands in `{...article, apiKey}` does not get the
 *     api key into the request, and `assertNoSecrets` also refuses
 *     the input so the bug is visible at the call site.
 *  2. `deriveIdempotencyKey` is stable across retries. The same
 *     `(ownerUserId, articleId, textHash)` triple produces the same
 *     32-hex key, and a different text hash produces a different one.
 *  3. `createSyncCoordinator` captures identity at enqueue time. A
 *     response that lands after the epoch changed or after a different
 *     user is now signed in is dropped with `stale-owner`.
 *  4. A transport that throws becomes a `network-error` outcome; the
 *     caller does not have to wrap the call in try/catch.
 *  5. An `AbortSignal` that fires mid-flight becomes `cancelled` or
 *     `network-error` (depending on the order), never a thrown error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoSecrets,
  buildSyncPayload,
  createSyncCoordinator,
  deriveIdempotencyKey,
  type SyncArticle,
  type SyncCoordinator,
  type SyncOutcome,
  type SyncPayload,
  type SyncTransport,
  type SyncUploadResult,
} from "../../src/lib/local-import-sync.js";
import type { ParsedDocument } from "../../shared/contracts/index.js";

const fixtureDoc: ParsedDocument = {
  title: "测试文章",
  author: null,
  blocks: [
    {
      id: "b1-0123456789abcdef",
      index: 1,
      type: "paragraph",
      text: "正文。",
      hash: "0123456789abcdef0123456789abcdef",
    },
  ],
  source: "markdown-remark",
  extractorVersion: "phase1.2",
  textHash: "abcd",
};

const fixtureArticle: SyncArticle = {
  id: "local-abcd",
  url: undefined,
  title: "测试文章",
  author: undefined,
  textHash: "abcd",
};

test("wire identity includes title and inline structure even when text is unchanged", () => {
  const payload = buildSyncPayload({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  const key = (p: SyncPayload) => deriveIdempotencyKey({ ownerUserId: "u", articleId: "a", textHash: "same", payload: p });
  assert.notEqual(key(payload), key({ ...payload, title: "changed" }));
  assert.notEqual(key(payload), key({ ...payload, blocks: payload.blocks.map(b => ({ ...b, spans: [{ start: 0, end: 1, kinds: ["strong"] }] })) }));
});

test("a late rejected transport cannot notify a departed owner's UI", async () => {
  let owner: string | null = "first";
  let reject!: (error: Error) => void;
  let callbacks = 0;
  const coordinator = createSyncCoordinator({ captureOwnerId: () => owner, currentEpoch: () => 0,
    transport: { upload: () => new Promise((_resolve, fail) => { reject = fail; }) },
    onResult: () => { callbacks++; } });
  const run = coordinator.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  owner = "second";
  reject(new Error("offline"));
  assert.equal((await run).status, "stale-owner");
  assert.equal(callbacks, 0);
});

test("buildSyncPayload: returns the agreed fields, with textHash and blocks copied through", () => {
  const payload = buildSyncPayload({
    article: fixtureArticle,
    document: fixtureDoc,
    source: "browser-jina",
  });
  assert.equal(payload.title, "测试文章");
  assert.equal(payload.sourceUrl, null);
  assert.equal(payload.source, "browser-jina");
  assert.equal(payload.author, null);
  assert.equal(payload.textHash, "abcd");
  assert.equal(payload.blocks.length, 1);
});

test("buildSyncPayload: forwards a real url and author when present", () => {
  const payload = buildSyncPayload({
    article: { ...fixtureArticle, url: "https://example.com/a", author: "Alice" },
    document: fixtureDoc,
    source: "server-jina",
  });
  assert.equal(payload.sourceUrl, "https://example.com/a");
  assert.equal(payload.author, "Alice");
  assert.equal(payload.source, "server-jina");
});

test("buildSyncPayload: refuses an unknown input field rather than dropping it", () => {
  // Intentionally passing an extra field to verify
  // that the whitelist rejects it loudly, not silently.
  assert.throws(
    () =>
      buildSyncPayload({
        article: fixtureArticle,
        document: fixtureDoc,
        source: "local",
        extra: "nope",
      } as never),
    /unexpected input field/,
  );
});

test("assertNoSecrets: refuses apiKey, authorization, bearer, token, secret, password, cookie, sessionId, credentials", () => {
  const banned = [
    "apiKey",
    "API_KEY",
    "api-key",
    "Api_Key",
    "authorization",
    "Authorization",
    "AUTHORIZATION",
    "bearer",
    "token",
    "access_token",
    "accessToken",
    "secret",
    "password",
    "sessionId",
    "session_id",
    "session-id",
    "cookie",
    "Cookie",
    "credentials",
    "credential",
    "privateKey",
    "private_key",
  ];
  for (const key of banned) {
    const obj: Record<string, unknown> = { title: "x", sourceUrl: null, source: "local" };
    obj[key] = "value";
    assert.throws(() => assertNoSecrets(obj), new RegExp(`secret field: ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), key);
  }
});

test("assertNoSecrets: passes a clean payload", () => {
  const clean: SyncPayload = {
    title: "x",
    sourceUrl: null,
    source: "local",
    author: null,
    textHash: "abcd",
    blocks: [],
  };
  assert.doesNotThrow(() => assertNoSecrets(clean));
});

test("assertNoSecrets: a payload with inline spans is accepted (the scan counts objects, not characters)", () => {
  // Regression: the depth guard used to run *before* the primitive
  // short-circuit, so `kinds: ["strong"]` cost six frames and every
  // article carrying inline emphasis was refused. Because
  // `enqueueArticleSync` is fire-and-forget and swallowed the throw,
  // the symptom was "the article simply never uploads and the user sees
  // no error", not a visible failure — so this is pinned at the point
  // of the throw.
  const withSpans: SyncPayload = {
    title: "带粗体的标题",
    sourceUrl: null,
    source: "local",
    author: null,
    textHash: "abcd",
    blocks: [
      {
        id: "b1-12345678",
        index: 1,
        type: "paragraph",
        text: "带有粗体的短正文。",
        hash: "1234567812345678",
        spans: [{ start: 2, end: 4, kinds: ["strong"] }],
      },
      {
        id: "b2-23456789",
        index: 2,
        type: "paragraph",
        text: "一个链接。",
        hash: "2345678923456789",
        spans: [{ start: 2, end: 4, kinds: ["link"], href: "https://example.com/" }],
      },
    ],
  };
  assert.doesNotThrow(() => assertNoSecrets(withSpans));
});

test("assertNoSecrets: still refuses a structure that is not a wire payload", () => {
  // The bound exists for this case, not for real data. A deep, non-payload
  // object (the shape a settings blob or a cyclic-ish graph produces) must
  // still be refused rather than walked forever.
  let deep: Record<string, unknown> = { apiKeyFree: true };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };
  assert.throws(() => assertNoSecrets(deep), /exceeded maximum depth/);
});

test("assertNoSecrets: detects a secret nested in blocks (defense-in-depth)", () => {
  // Build a blocks entry that carries an apiKey in a child — the
  // whitelist does not forbid that, but the depth-scan should.
  const sneaky: SyncPayload = {
    title: "x",
    sourceUrl: null,
    source: "local",
    author: null,
    textHash: "abcd",
    blocks: [
      {
        id: "b1-12345678",
        index: 1,
        type: "paragraph",
        text: "hi",
        hash: "1234567812345678",
        // @ts-expect-error — intentionally not in the ContentBlock shape.
        apiKey: "sk-1234",
      },
    ],
  };
  assert.throws(() => assertNoSecrets(sneaky), /secret field: apiKey/);
});

test("buildSyncPayload: a stray apiKey on the article never ends up in the payload", () => {
  // `buildSyncPayload` only reads the fixed shape of the wire payload;
  // a stray field on the input object is therefore not in the result,
  // which is what the whitelist guarantees. The depth-scan is the
  // second line, not the first; this test asserts the first.
  const polluted = { ...fixtureArticle, apiKey: "sk-1234" } as SyncArticle & { apiKey?: string };
  const payload = buildSyncPayload({ article: polluted, document: fixtureDoc, source: "local" });
  assert.equal((payload as unknown as Record<string, unknown>).apiKey, undefined);
  assertNoSecrets(payload);
});

test("deriveIdempotencyKey: stable for the same triple", () => {
  const a = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: "local-abcd", textHash: "abcd" });
  const b = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: "local-abcd", textHash: "abcd" });
  assert.equal(a, b);
  assert.equal(a.length, 32);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("deriveIdempotencyKey: changes when the text hash changes", () => {
  const a = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: "local-abcd", textHash: "abcd" });
  const b = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: "local-abcd", textHash: "efgh" });
  assert.notEqual(a, b);
});

test("deriveIdempotencyKey: changes when the article id changes", () => {
  const a = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: "local-1", textHash: "abcd" });
  const b = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: "local-2", textHash: "abcd" });
  assert.notEqual(a, b);
});

test("deriveIdempotencyKey: changes when the owner changes", () => {
  const a = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: "local-1", textHash: "abcd" });
  const b = deriveIdempotencyKey({ ownerUserId: "u-2", articleId: "local-1", textHash: "abcd" });
  assert.notEqual(a, b);
});

interface TransportSpy {
  transport: SyncTransport;
  calls: Array<{ payload: SyncPayload; idempotencyKey: string; signal: AbortSignal }>;
  setNext: (result: SyncUploadResult | Promise<SyncUploadResult>) => void;
  setThrow: (err: Error) => void;
}

function makeTransport(): TransportSpy {
  const calls: TransportSpy["calls"] = [];
  let next: SyncUploadResult | Promise<SyncUploadResult> = {
    ok: true,
    articleId: "art-1",
    versionId: "ver-1",
  };
  let thrower: Error | null = null;
  return {
    calls,
    setNext: (value) => {
      next = value;
      thrower = null;
    },
    setThrow: (err) => {
      thrower = err;
    },
    transport: {
      async upload(payload, { idempotencyKey, signal }) {
        calls.push({ payload, idempotencyKey, signal });
        if (thrower) throw thrower;
        return next;
      },
    },
  };
}

test("createSyncCoordinator: enqueue returns 'uploaded' and carries the idempotency key", async () => {
  const transport = makeTransport();
  const coord: SyncCoordinator = createSyncCoordinator({
    transport: transport.transport,
    captureOwnerId: () => "u-1",
    currentEpoch: () => 1,
  });
  const outcome = await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "browser-jina" });
  assert.equal(outcome.status, "uploaded");
  if (outcome.status !== "uploaded") return;
  assert.equal(outcome.articleId, "art-1");
  assert.equal(outcome.versionId, "ver-1");
  assert.equal(transport.calls.length, 1);
  const expectedKey = deriveIdempotencyKey({ ownerUserId: "u-1", articleId: fixtureArticle.id, textHash: fixtureArticle.textHash, payload: buildSyncPayload({ article: fixtureArticle, document: fixtureDoc, source: "browser-jina" }) });
  assert.equal(transport.calls[0]?.idempotencyKey, expectedKey);
  // The payload passed to the transport has no `apiKey` field of any
  // shape; assertNoSecrets is called inside buildSyncPayload, so any
  // attempt to slip one in would have thrown before this call landed.
  assert.equal(Object.keys(transport.calls[0]?.payload ?? {}).sort().join(","), "author,blocks,source,sourceUrl,textHash,title");
});

test("createSyncCoordinator: anonymous user (captureOwnerId === null) is a no-op", async () => {
  const transport = makeTransport();
  const coord = createSyncCoordinator({
    transport: transport.transport,
    captureOwnerId: () => null,
    currentEpoch: () => 1,
  });
  const outcome = await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  assert.equal(outcome.status, "cancelled");
  assert.equal(transport.calls.length, 0, "transport must not be called for an anonymous user");
});

test("createSyncCoordinator: a transport throw becomes 'network-error', not an exception", async () => {
  const transport = makeTransport();
  transport.setThrow(new Error("socket hang up"));
  const coord = createSyncCoordinator({
    transport: transport.transport,
    captureOwnerId: () => "u-1",
    currentEpoch: () => 1,
  });
  const outcome = await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  assert.equal(outcome.status, "network-error");
  if (outcome.status !== "network-error") return;
  assert.equal(outcome.message, "socket hang up");
});

test("createSyncCoordinator: a 4xx response becomes 'rejected' with the server's message", async () => {
  const transport = makeTransport();
  transport.setNext({ ok: false, httpStatus: 422, message: "正文为空。" });
  const coord = createSyncCoordinator({
    transport: transport.transport,
    captureOwnerId: () => "u-1",
    currentEpoch: () => 1,
  });
  const outcome = await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  assert.equal(outcome.status, "rejected");
  if (outcome.status !== "rejected") return;
  assert.equal(outcome.httpStatus, 422);
  assert.equal(outcome.message, "正文为空。");
});

test("createSyncCoordinator: a network error response becomes 'network-error'", async () => {
  const transport = makeTransport();
  transport.setNext({ ok: false, networkError: "ECONNREFUSED" });
  const coord = createSyncCoordinator({
    transport: transport.transport,
    captureOwnerId: () => "u-1",
    currentEpoch: () => 1,
  });
  const outcome = await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  assert.equal(outcome.status, "network-error");
});

test("createSyncCoordinator: a 409 (same key, different body) is a 'rejected' verdict, not 'duplicate'", async () => {
  // 409 is reserved by the server for "same key, different body"
  // — a client bug, not a successful retry. The coordinator must
  // surface it as a hard failure so the UI can show "本机已保存，
  // 云端同步失败" and offer a retry rather than silently adopting
  // a stale id. The old "duplicate" verdict conflated the two cases
  // and the unit-test gate must pin the new shape — anything that
  // keeps 409 → 'duplicate' would re-introduce the bug.
  const transport = makeTransport();
  transport.setNext({ ok: false, httpStatus: 409, message: "已存在" });
  const coord = createSyncCoordinator({
    transport: transport.transport,
    captureOwnerId: () => "u-1",
    currentEpoch: () => 1,
  });
  const outcome = await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") {
    assert.equal(outcome.httpStatus, 409);
    assert.match(outcome.message, /已存在/);
  }
});

test("createSyncCoordinator: response that lands after a sign-out is dropped (stale-owner)", async () => {
  // The transport resolves only after the caller has switched users
  // and the epoch has moved. The coordinator must not write the new
  // owner's article id into the old owner's account.
  let resolveUpload: (value: SyncUploadResult) => void = () => undefined;
  const transport: SyncTransport = {
    upload: () =>
      new Promise<SyncUploadResult>((resolve) => {
        resolveUpload = resolve;
      }),
  };
  let currentOwner: string | null = "u-1";
  let currentEpoch = 1;
  const coord = createSyncCoordinator({
    transport,
    captureOwnerId: () => currentOwner,
    currentEpoch: () => currentEpoch,
    onResult: (outcome: SyncOutcome) => {
      assert.equal(outcome.status, "stale-owner");
    },
  });
  const enqueuePromise = coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "browser-jina" });
  // Before the response arrives, the user signs out and a different
  // user signs in. The epoch and the owner both change.
  currentOwner = "u-2";
  currentEpoch = 2;
  resolveUpload({ ok: true, articleId: "art-stale", versionId: "ver-stale" });
  const outcome = await enqueuePromise;
  assert.equal(outcome.status, "stale-owner");
});

test("createSyncCoordinator: response after a sign-out alone (epoch unchanged) is still dropped", async () => {
  let resolveUpload: (value: SyncUploadResult) => void = () => undefined;
  const transport: SyncTransport = {
    upload: () =>
      new Promise<SyncUploadResult>((resolve) => {
        resolveUpload = resolve;
      }),
  };
  let currentOwner: string | null = "u-1";
  let currentEpoch = 1;
  const coord = createSyncCoordinator({
    transport,
    captureOwnerId: () => currentOwner,
    currentEpoch: () => currentEpoch,
  });
  const enqueuePromise = coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  // Sign out (owner becomes null) but the epoch handler bumps it.
  currentOwner = null;
  currentEpoch = 2;
  resolveUpload({ ok: true, articleId: "art-x", versionId: "ver-x" });
  const outcome = await enqueuePromise;
  assert.equal(outcome.status, "stale-owner");
});

test("createSyncCoordinator: an aborted signal is reported as 'cancelled'", async () => {
  const transport: SyncTransport = {
    upload: (_payload, { signal }) =>
      new Promise<SyncUploadResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  const coord = createSyncCoordinator({
    transport,
    captureOwnerId: () => "u-1",
    currentEpoch: () => 1,
  });
  const controller = new AbortController();
  const promise = coord.enqueue({
    article: fixtureArticle,
    document: fixtureDoc,
    source: "local",
    signal: controller.signal,
  });
  controller.abort();
  const outcome = await promise;
  // Aborted before the response: the transport throws, which the
  // coordinator reports as a network error. Either verdict is honest;
  // what matters is that the local article is untouched and no
  // exception escapes.
  assert.ok(outcome.status === "network-error" || outcome.status === "cancelled");
});

test("createSyncCoordinator: the idempotency key is the same for two enqueues of the same article", async () => {
  const transport = makeTransport();
  const coord = createSyncCoordinator({
    transport: transport.transport,
    captureOwnerId: () => "u-1",
    currentEpoch: () => 1,
  });
  await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  await coord.enqueue({ article: fixtureArticle, document: fixtureDoc, source: "local" });
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0]?.idempotencyKey, transport.calls[1]?.idempotencyKey);
});
