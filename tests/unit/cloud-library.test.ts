// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The account library client: request shapes, and the server→local mapping.
 *
 * ## What this covers and why it is worth covering
 *
 * `pages/CloudLibrary.tsx` is the only way a user gets an article that exists
 * *only* in their account onto a device that has never opened it, so the two
 * things that can silently break it are pinned here:
 *
 *  1. **The wire.** Each action must hit the route the server actually serves,
 *     with the right method, and with no credential attached. A regression that
 *     dropped the cursor, used `GET` for a delete, or put a BYOK key in a
 *     header would look completely fine in the UI.
 *  2. **The mapping.** `serverToLocalArticle` is what turns a server row into
 *     the local `Article` the store and the Reader consume. If it loses the
 *     block id, a note can no longer name the exact occurrence of a duplicated
 *     paragraph; if it loses `versionId`, a note anchors to the wrong version;
 *     if it renamed the id to `local-<hash>`, the row would stop matching the
 *     account's own article and its notes would be parked forever.
 *
 * `fetch` is a stub, so the file needs no network and no database — and the
 * assertions are about the exact request, which a real server would make
 * harder to state precisely rather than easier.
 */

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let fetchCalls: FetchCall[] = [];
let routes: { test: (url: string, method: string) => boolean; reply: () => Response }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BLOCK = {
  id: "b1-aaaaaaaa",
  index: 1,
  type: "heading" as const,
  text: "第一章",
  hash: "abcdef0123456789",
  level: 2,
  spans: [{ start: 0, end: 2, kind: "bold" as const }],
};

const DETAIL = {
  article: {
    id: "art-server-1",
    title: "云端文章",
    source: "text",
    sourceUrl: "https://example.test/post",
    importedAt: "2026-10-01T00:00:00.000Z",
  },
  version: {
    id: "ver-1",
    articleId: "art-server-1",
    version: 1,
    source: "text",
    importedAt: "2026-10-01T00:00:00.000Z",
    paragraphs: [
      BLOCK,
      { id: "b2-bbbbbbbb", index: 2, type: "listItem" as const, text: "第一项", hash: "0123456789abcdef", ordered: true },
    ],
  },
};

before(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      fetchCalls.push({
        url,
        method,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      for (const route of routes) {
        if (route.test(url, method)) return route.reply();
      }
      throw new Error(`unstubbed fetch: ${method} ${url}`);
    },
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  fetchCalls = [];
  routes = [];
});

async function load() {
  return import("../../src/lib/account-articles.js");
}

test("listArticles reads /api/articles and passes the cursor through", async () => {
  const { listArticles } = await load();
  routes = [
    {
      test: (url, m) => url.endsWith("/api/articles") && m === "GET",
      reply: () => json({ articles: [DETAIL.article], nextCursor: "c2" }),
    },
    {
      test: (url, m) => url.endsWith("/api/articles?cursor=c2") && m === "GET",
      reply: () => json({ articles: [], nextCursor: null }),
    },
  ];

  const first = await listArticles();
  assert.equal(first.nextCursor, "c2");
  const second = await listArticles("c2");
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    fetchCalls.map((c) => `${c.method} ${c.url}`),
    ["GET /api/articles", "GET /api/articles?cursor=c2"],
  );
});

test("getArticle, deleteArticle and exportArticle address one article by id", async () => {
  const { getArticle, deleteArticle, exportArticle } = await load();
  routes = [
    { test: (url, m) => url.endsWith("/api/articles/art-9") && m === "GET", reply: () => json(DETAIL) },
    { test: (url, m) => url.endsWith("/api/articles/art-9") && m === "DELETE", reply: () => json({ deletedId: "art-9" }) },
    { test: (url, m) => url.endsWith("/api/articles/art-9/export") && m === "GET", reply: () => json({ ...DETAIL, exportedAt: "2026-10-02T00:00:00.000Z" }) },
  ];

  await getArticle("art-9");
  await deleteArticle("art-9");
  const exported = await exportArticle("art-9");

  assert.equal(exported.exportedAt, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(
    fetchCalls.map((c) => `${c.method} ${new URL(c.url, "http://x").pathname}`),
    ["GET /api/articles/art-9", "DELETE /api/articles/art-9", "GET /api/articles/art-9/export"],
  );
});

test("no account-library request carries a credential", async () => {
  const { listArticles, getArticle, deleteArticle, exportArticle } = await load();
  routes = [
    { test: () => true, reply: () => json(DETAIL) },
    { test: (url, m) => url.endsWith("/api/articles") && m === "GET", reply: () => json({ articles: [], nextCursor: null }) },
    { test: (url, m) => url.endsWith("/api/articles/a/export") && m === "GET", reply: () => json({ ...DETAIL, exportedAt: "x" }) },
    { test: (url, m) => m === "DELETE", reply: () => json({ deletedId: "a" }) },
  ];

  await listArticles();
  await getArticle("a");
  await deleteArticle("a");
  await exportArticle("a");

  for (const call of fetchCalls) {
    const headerNames = Object.keys(call.headers).map((h) => h.toLowerCase());
    assert.equal(headerNames.includes("authorization"), false, `Authorization on ${call.url}`);
    assert.equal(
      JSON.stringify(call).toLowerCase().includes("apikey"),
      false,
      `an API key on ${call.url}`,
    );
  }
});

test("a server error keeps the shared envelope's message and code", async () => {
  const { getArticle } = await load();
  routes = [
    {
      test: () => true,
      reply: () =>
        json({ error: { code: "NOT_FOUND", message: "资源不存在。", requestId: "req-1" } }, 404),
    },
  ];

  const { ApiRequestError } = await import("../../src/lib/api-error.js");
  await assert.rejects(
    () => getArticle("nope"),
    (err: unknown) =>
      err instanceof ApiRequestError &&
      err.status === 404 &&
      err.code === "NOT_FOUND" &&
      err.message === "资源不存在。",
  );
});

test("serverToLocalArticle keeps the identity, the version and the block detail", async () => {
  const { serverToLocalArticle } = await load();

  // Two values, not one: the storage format keeps the record and the text
  // apart, so this returns the pair the store's `saveArticle` takes.
  const { article, paragraphs } = serverToLocalArticle(DETAIL as never);

  // The local id *is* the server id: the row came from the account, and a
  // `local-<hash>` id here would stop it matching the account's own article.
  assert.equal(article.id, "art-server-1");
  // The account binding travels with the record: `remoteId` is what edit
  // uploads, delete-both-ends and the sync badge read. Without it a pulled
  // article looks local-only for the rest of its life.
  assert.equal(article.remoteId, "art-server-1");
  assert.equal(article.remoteVersionId, "ver-1");
  // The version the paragraphs were parsed from, so a note anchors to the
  // version on screen rather than to whatever is current later.
  assert.equal(article.versionId, "ver-1");
  assert.equal(article.title, "云端文章");
  assert.equal(article.url, "https://example.test/post");
  assert.equal(article.createdAt, Date.parse("2026-10-01T00:00:00.000Z"));
  // Derived here, where the blocks are still in hand — once they are a body the
  // record has no way back to them, and this is what lets a later pull of the
  // same document be recognised as the same one.
  assert.equal(typeof article.blocksDigest, "string");
  assert.equal(paragraphs.length, 2);

  const [heading, item] = paragraphs;
  // The block id is what lets a note name the exact occurrence of a
  // duplicated paragraph; the kind and level are what let the Reader render a
  // heading as a heading.
  assert.equal(heading!.blockId, "b1-aaaaaaaa");
  assert.equal(heading!.type, "heading");
  assert.equal(heading!.level, 2);
  assert.deepEqual(heading!.spans, BLOCK.spans);
  // The **full** digest, not a prefix. A truncated one fails the sync route's
  // `sha256(text) === hash` check, which would make a pulled-down article
  // permanently un-uploadable — so the wire value is kept verbatim.
  assert.equal(heading!.hash, "abcdef0123456789");
  assert.equal(item!.ordered, true);
  assert.equal(item!.type, "listItem");
  // The account binding is explicit even though the id already is the server
  // id: edit uploads, delete-both-ends and the sync badge all key off
  // `remoteId`, so a pulled row without it would behave as local-only.
  assert.equal(article.remoteId, "art-server-1");
});

test("fetchAccountProfile reads /api/me, trims the name and degrades to null", async () => {
  const { fetchAccountProfile } = await import("../../src/lib/account-profile.js");

  routes = [
    {
      test: (url, m) => url.endsWith("/api/me") && m === "GET",
      reply: () => json({ user: { id: "u1", email: "u@example.test", name: "  小明  ", emailVerified: true, role: "user" } }),
    },
  ];
  assert.deepEqual(await fetchAccountProfile(), { name: "小明", phoneNumber: null });

  // A bound number is surfaced for the account page; it is the only profile
  // field besides the name that base's session shape deliberately omits.
  routes = [
    {
      test: (url, m) => url.endsWith("/api/me") && m === "GET",
      reply: () =>
        json({
          user: {
            id: "u2",
            email: "8613800138000@phone.invalid",
            name: "手机用户",
            emailVerified: true,
            role: "user",
            phoneNumber: "+8613800138000",
          },
        }),
    },
  ];
  assert.deepEqual(await fetchAccountProfile(), {
    name: "手机用户",
    phoneNumber: "+8613800138000",
  });

  // A blank name is "no label", not an empty label.
  routes = [
    { test: () => true, reply: () => json({ user: { id: "u1", email: "u@example.test", name: "   ", emailVerified: true, role: "user" } }) },
  ];
  assert.equal(await fetchAccountProfile(), null);

  // A signed-out device must not turn a 401 into an error state on the page.
  routes = [
    { test: () => true, reply: () => json({ error: { code: "UNAUTHORIZED", message: "未登录或会话已失效。" } }, 401) },
  ];
  assert.equal(await fetchAccountProfile(), null);

  const headerNames = fetchCalls.flatMap((c) => Object.keys(c.headers).map((h) => h.toLowerCase()));
  assert.equal(headerNames.includes("authorization"), false, "the cookie is the authorisation");
});
