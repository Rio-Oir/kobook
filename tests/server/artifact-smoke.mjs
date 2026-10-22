// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The compiled server artifact has to load and work — checked by loading it.
 *
 * ## Why this exists
 *
 * `npm run build:server` used to produce JavaScript that Node could not import:
 * Prisma's generated client is written for bundler resolution, `tsc` does not
 * rewrite specifiers, and nothing noticed because the only verification was
 * `--noEmit`. Type-checking passed while the artifact was dead on arrival.
 *
 * So this runs **the emitted files**, in a plain `node` process (no `tsx`, no
 * TypeScript loader), with no database and no network:
 *
 *   1. the emitted module graph loads at all — which is the failure that was
 *      reported, and it fails at `import` if a single specifier in it is
 *      unresolvable;
 *   2. `buildApp` assembles the real route table out of the compiled files and
 *      answers through `inject`, with a stub session and no Prisma client, so
 *      the boot path — including the assertion that the limiter is wired to
 *      the route that declares it — is exercised for real;
 *   3. the routes that must work with no database answer, and the ones that
 *      need one fail closed rather than reporting success.
 *
 * What it deliberately does not do is pretend to have a database. A route that
 * needs one is expected to report itself unavailable; stubbing Prisma
 * thoroughly enough to answer would mean the test was measuring the stub.
 *
 * Run it after `npm run build:server`:
 *   node tests/server/artifact-smoke.mjs
 */

import assert from "node:assert/strict";

const DIST = new URL("../../server/dist/", import.meta.url);

const { buildApp } = await import(new URL("server/src/app.js", DIST));
const { ROUTES } = await import(new URL("shared/contracts/index.js", DIST));

const checks = [];
function pass(name) {
  checks.push(name);
  console.log(`  PASS  ${name}`);
}

/**
 * A Better Auth stand-in.
 *
 * `registerAuthBridge` mounts the handler at `/api/auth/*` and the session
 * pre-handlers call `auth.api.getSession`. Both are answered here, and neither
 * answer is the point of this file: the point is that the *compiled* bridge and
 * the *compiled* route modules load and register.
 */
const stubAuth = {
  handler: async () => new Response("{}", { status: 200 }),
  api: { getSession: async () => null },
};

// `prisma` is an empty object on purpose: `isDatabaseReachable` catches the
// resulting TypeError and reports "down", which is the behaviour under test.
const { app } = await buildApp({
  prisma: {},
  auth: stubAuth,
  nodeEnv: "test",
  logLevel: "silent",
});

try {
  // ── 1. The route table assembled from the compiled files ────────────────
  const live = await app.inject({ method: "GET", url: ROUTES.healthLive });
  assert.equal(live.statusCode, 200);
  assert.equal(live.json().status, "ok");
  pass("compiled app boots and answers liveness");

  // ── 2. A route with a dependency fails closed, not optimistically ───────
  const ready = await app.inject({ method: "GET", url: ROUTES.healthReady });
  assert.equal(ready.statusCode, 503, "readiness must not claim ok with no database");
  assert.equal(ready.json().checks.database, "down");
  pass("readiness reports the database down rather than answering ok");

  // ── 3. The extractor pipeline is really in the artifact ─────────────────
  const extracted = await app.inject({
    method: "POST",
    url: ROUTES.anonymousExtract,
    payload: {
      kind: "text",
      content:
        "深度学习模型的训练需要大量计算资源，许多团队因此选择使用云端 GPU 集群。\n\n第二段用于确认短中文段落不会被词数门槛拒绝。",
    },
  });
  assert.equal(extracted.statusCode, 200, extracted.body);
  const body = extracted.json();
  assert.equal(body.extractor, "local");
  assert.ok(body.document.blocks.length >= 2, "short Chinese paragraphs must survive");
  assert.ok(typeof body.document.textHash === "string");
  pass("compiled app extracts text through the real parse pipeline");

  // ── 4. The account surface is mounted *and* gated ───────────────────────
  // Both halves matter: a 404 would mean the artifact was built without the
  // account routes, and a 200 would mean they answered without a session.
  for (const url of [ROUTES.me, "/api/articles", "/api/notes/anything"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(
      response.statusCode,
      401,
      `${url} must be mounted and must refuse an anonymous caller (got ${response.statusCode})`,
    );
  }
  pass("account routes are present in the artifact and refuse an anonymous caller");

  // ── 5. The billing surface is not in this artifact at all ───────────────
  // The paths are written out rather than read from `ROUTES`: the whole claim
  // is that no constant for them exists on this line, so reading one would be
  // circular. A 404 here is the boundary holding at the artifact level.
  for (const url of [
    "/api/billing/catalogue",
    "/api/billing/entitlements",
    "/api/billing/orders",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(
      response.statusCode,
      404,
      `${url} must not exist in the open-source artifact (got ${response.statusCode})`,
    );
  }
  pass("no billing route exists in the compiled artifact");
} finally {
  await app.close();
}

console.log(`\n[artifact-smoke] all ${checks.length} checks passed`);
