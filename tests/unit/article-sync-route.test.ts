// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `POST /api/articles/sync` — the two halves of it that need no database.
 *
 * The route was declared in the contract (`shared/contracts/api.ts`), posted to
 * by the client (`src/lib/account-articles.ts`), covered by client-side unit
 * tests — and never registered on the server. Fastify answered 404, the
 * transport turned that into a `rejected` verdict, and every article a signed-in
 * reader imported simply never reached the cloud. Nothing failed: the client
 * unit tests used a fake `fetch`, and a fake `fetch` cannot tell a registered
 * route from a 404.
 *
 * Two things would have caught it, and both run here without Postgres:
 *
 *   1. **The route is registered.** `hasRoute` on the real `registerArticleRoutes`
 *      output, with a deliberately non-existent path asserted *absent* as a
 *      control — an assertion that passes for any path would have been no
 *      assertion at all.
 *   2. **The body schema is enforced.** `additionalProperties: false` and the
 *      closed `enum`s are claims about what a client cannot send, and
 *      `route-body-strictness.test.ts` records that such a claim is false under
 *      Fastify's default AJV settings, which strip an unknown key instead of
 *      rejecting it. These cases drive the schema the route actually uses, on
 *      the route actually registered, so a later edit that loosens it fails
 *      here rather than in production.
 *
 * Validation runs before `preHandler` in Fastify's lifecycle, which is what
 * lets a request with no session reach the 400s below instead of the session
 * gate. The acceptance case uses a probe route instead, because the real route
 * would (correctly) reject a session-less request once the body validates.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ROUTES, type ArticleSyncRequest } from "../../shared/contracts/index.js";
import {
  ARTICLE_SYNC_BODY_SCHEMA,
  registerArticleRoutes,
} from "../../server/src/routes/articles.js";
import { documentTextHash, sha256Hex } from "../../server/src/lib/parse/blocks.js";
import type { AppPrisma } from "../../server/src/db.js";
import type { Auth } from "../../server/src/auth.js";

/**
 * The article routes on a bare Fastify instance.
 *
 * `prisma` and `auth` are only *closed over* at registration time — no route
 * touches either until a request reaches a handler — so placeholders are
 * enough to enumerate what got registered. That is the property being tested.
 */
async function buildArticleRoutes() {
  const app = Fastify({
    // The application's own AJV configuration (`server/src/app.ts`). Without
    // it this file would be testing Fastify's defaults, not the server's.
    ajv: { customOptions: { removeAdditional: false } },
  });
  registerArticleRoutes(app, {} as AppPrisma, {} as Auth);
  await app.ready();
  return app;
}

/** A probe that validates with the real schema and echoes what survived. */
async function buildSyncProbe() {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.post(
    ROUTES.articleSync,
    { schema: { body: ARTICLE_SYNC_BODY_SCHEMA } },
    async (req) => ({ body: req.body }),
  );
  await app.ready();
  return app;
}

/** A payload that passes the schema, built with the server's own hash helper. */
function validPayload(overrides: Partial<ArticleSyncRequest> = {}): ArticleSyncRequest {
  const text = "正文段落。";
  const hash = sha256Hex(text);
  const blocks = [
    { id: `b1-${hash.slice(0, 8)}`, index: 1, type: "paragraph" as const, text, hash },
  ];
  return {
    title: "标题",
    sourceUrl: null,
    source: "local",
    author: null,
    textHash: documentTextHash(blocks),
    blocks,
    clientKey: "a".repeat(32),
    ...overrides,
  };
}

test("the sync route the contract declares is registered on the article routes", async () => {
  const app = await buildArticleRoutes();
  try {
    assert.equal(
      app.hasRoute({ method: "POST", url: ROUTES.articleSync }),
      true,
      "POST /api/articles/sync must be registered — an unregistered path answers 404, " +
        "which is how every upload stayed silently rejected",
    );
    // Control: the assertion above must be able to fail. A path that was never
    // declared is absent, so `hasRoute` is measuring the route table and not
    // returning true unconditionally.
    assert.equal(app.hasRoute({ method: "POST", url: "/api/articles/definitely-not-a-route" }), false);
    // And the routes it sits beside are still there, so this gate is not
    // passing because the whole registration silently no-opped.
    for (const url of [ROUTES.articleImport, ROUTES.articleList]) {
      assert.equal(app.hasRoute({ method: url === ROUTES.articleImport ? "POST" : "GET", url }), true);
    }
  } finally {
    await app.close();
  }
});

test("a valid sync payload passes the route's own schema", async () => {
  const app = await buildSyncProbe();
  try {
    const response = await app.inject({
      method: "POST",
      url: ROUTES.articleSync,
      payload: validPayload(),
    });
    assert.equal(response.statusCode, 200, response.body);
    // Without this case every rejection below could be passing for the wrong
    // reason — a schema that rejects everything rejects these too.
    const echoed = response.json() as { body: ArticleSyncRequest };
    assert.equal(echoed.body.clientKey, "a".repeat(32));
  } finally {
    await app.close();
  }
});

test("the sync route rejects a body it should, through the registered route", async () => {
  const app = await buildArticleRoutes();
  const cases: Array<{ label: string; payload: unknown }> = [
    {
      label: "an undeclared field (the schema must reject, not strip)",
      payload: { ...validPayload(), apiKey: "sk-nope" },
    },
    { label: "an unknown source", payload: { ...validPayload(), source: "bogus" } },
    { label: "a missing required field", payload: (() => {
      const { textHash: _drop, ...rest } = validPayload();
      return rest;
    })() },
    { label: "an empty block list", payload: { ...validPayload(), blocks: [] } },
    {
      label: "a sourceUrl that is not http(s)",
      payload: { ...validPayload(), sourceUrl: "javascript:alert(1)" },
    },
    {
      label: "a clientKey past the column bound",
      payload: { ...validPayload(), clientKey: "a".repeat(33) },
    },
    { label: "an empty title", payload: { ...validPayload(), title: "" } },
    {
      label: "a block with an unknown type",
      payload: {
        ...validPayload(),
        blocks: [{ ...validPayload().blocks[0]!, type: "sidebar" }],
      },
    },
    {
      label: "a span with an unknown mark kind",
      payload: {
        ...validPayload(),
        blocks: [
          {
            ...validPayload().blocks[0]!,
            spans: [{ start: 0, end: 2, kinds: ["blink"] }],
          },
        ],
      },
    },
    {
      label: "a span carrying an undeclared field",
      payload: {
        ...validPayload(),
        blocks: [
          {
            ...validPayload().blocks[0]!,
            spans: [{ start: 0, end: 2, kinds: ["strong"], style: "red" }],
          },
        ],
      },
    },
    {
      label: "a textHash that is not hex",
      payload: { ...validPayload(), textHash: "zzzzzzzz" },
    },
  ];

  try {
    for (const { label, payload } of cases) {
      const response = await app.inject({
        method: "POST",
        url: ROUTES.articleSync,
        payload: payload as object,
      });
      // 400 is the schema; anything else means this case is not measuring the
      // schema (401/500 would mean it reached the session gate, 404 would mean
      // the route is gone).
      assert.equal(response.statusCode, 400, `${label}: got ${response.statusCode} — ${response.body}`);
    }
  } finally {
    await app.close();
  }
});
