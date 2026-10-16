// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Body-schema strictness, verified rather than assumed.
 *
 * The anonymous extraction route's body schema declares
 * `additionalProperties: false`, and the comment next to it claimed that
 * this makes "the browser names the proxy" *unrepresentable* — a request
 * with an extra key would be a 400.
 *
 * That claim was wrong. Fastify's default AJV configuration sets
 * `removeAdditional: true`, so an unknown property is silently **stripped**
 * and the request proceeds. The protection the route actually needs (no
 * caller may choose the outbound destination) still holds — the handler only
 * ever reads server-side configuration, so a stripped key could not have
 * influenced it either way — but "unrepresentable" and "stripped" are
 * different statements, and a comment that says the stronger one is the
 * kind of thing a later change quietly relies on.
 *
 * This file pins the real behaviour so the comment cannot drift back, and so
 * the service boundary tests measure the thing they claim to measure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

/** The exact shape the anonymous route declares. */
const bodySchema = {
  type: "object",
  required: ["kind", "content"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: ["text", "html", "url"] },
    content: { type: "string", minLength: 1 },
    title: { type: "string", maxLength: 512 },
  },
} as const;

async function buildProbe() {
  const app = Fastify();
  app.post(
    "/api/anonymous/extract",
    {
      schema: { body: bodySchema },
    },
    async (req) => ({ keys: Object.keys((req.body ?? {}) as object) }),
  );
  await app.ready();
  return app;
}

test("an unknown body property is stripped, not rejected", async () => {
  const app = await buildProbe();
  const res = await app.inject({
    method: "POST",
    url: "/api/anonymous/extract",
    payload: {
      kind: "text",
      content: "正文",
      // The field a browser would send if it were allowed to choose the
      // upstream proxy.
      jinaBaseUrl: "http://127.0.0.1:9/",
      jinaApiKey: "attacker",
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { keys: string[] };
  assert.deepEqual(
    body.keys.sort(),
    ["content", "kind"],
    "Fastify strips additional properties by default (removeAdditional)",
  );
  assert.ok(
    !body.keys.includes("jinaBaseUrl"),
    "a client-supplied proxy field must not reach the handler",
  );
  await app.close();
});

test("required fields and enum bounds are still enforced", async () => {
  const app = await buildProbe();
  const missing = await app.inject({
    method: "POST",
    url: "/api/anonymous/extract",
    payload: { kind: "text" },
  });
  assert.equal(missing.statusCode, 400, "a missing required field is still a 400");

  const badEnum = await app.inject({
    method: "POST",
    url: "/api/anonymous/extract",
    payload: { kind: "socket", content: "x" },
  });
  assert.equal(badEnum.statusCode, 400, "an out-of-enum kind is still a 400");

  const empty = await app.inject({
    method: "POST",
    url: "/api/anonymous/extract",
    payload: { kind: "text", content: "" },
  });
  assert.equal(empty.statusCode, 400, "minLength is still enforced");
  await app.close();
});

test("a non-object body is rejected", async () => {
  const app = await buildProbe();
  const res = await app.inject({
    method: "POST",
    url: "/api/anonymous/extract",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(["not", "an", "object"]),
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});
