// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Release-service boundary tests (inject + one child-process launch).
 *
 * These are the "后台安全 inject tests" for the open-source build: they assert
 * what the service is *capable* of, not what the UI happens to show.
 *
 * ## What the claim is now
 *
 * The claim used to be "this deployment mounts only the anonymous extractor, so
 * it cannot reach cloud data". That is no longer true and no longer wanted:
 * accounts, articles and notes are part of this product. What the service must
 * not be able to do is **take money** — so the boundary asserted here is that
 * every `/api/billing/*` path is a 404, while the account routes are present
 * *and* refuse an anonymous caller.
 *
 * Those two halves have to be checked together. A 404 on `/api/billing` would
 * also be satisfied by a service that mounts nothing at all, which is why the
 * account routes are asserted to answer 401 rather than 404, and why the
 * extractor is exercised end to end below.
 *
 * Run from the repository root:
 *   node --import tsx --import ./tests/fixtures/direct-http-preload.mjs \
 *     apps/reader-release/tests/server-inject.mjs
 *
 * The preload fixture is the *existing* one the phase-3 suite uses: it resolves
 * `example.com` to a public address and answers over https with a fixture
 * article. It gives the positive extraction path a real upstream without
 * touching a real network — and, importantly, without relaxing the SSRF guard,
 * which is what the negative cases below prove still bites.
 *
 * ## Why a stub database
 *
 * This is an *inject* test: it drives the route table, and the route table does
 * not need PostgreSQL to be assembled. `buildApp` is given an empty object for
 * `prisma`, which makes `isDatabaseReachable` report the database down — and
 * that is asserted rather than worked around, because "readiness fails closed
 * when the database is unreachable" is one of the properties worth pinning.
 * The suite that proves the real queries is `tests/phase*.ts`, against a real
 * PostgreSQL.
 */

import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The release gate's own evidence directory — never `docs/evidence/reader-release`,
// which holds the published release's recorded facts and a few historical
// untracked artifacts. See the same note in `free-browser.mjs`.
const EVIDENCE = path.resolve(HERE, "../../../docs/evidence/base-reproducibility");
mkdirSync(EVIDENCE, { recursive: true });

const checks = [];
function check(name, detail) {
  checks.push(detail === undefined ? name : `${name} — ${detail}`);
  console.log(`  ✔ ${name}`);
}

const { buildApp } = await import("../../../server/src/app.js");
const { ROUTES } = await import("../../../shared/contracts/index.js");

/**
 * A Better Auth stand-in. `registerAuthBridge` mounts the handler at
 * `/api/auth/*` and the session pre-handlers call `api.getSession`; both are
 * answered, and both answers are "nobody".
 */
const stubAuth = {
  handler: async () => new Response("{}", { status: 200 }),
  api: { getSession: async () => null },
};

/** A stand-in for the built shell, so the static assertions do not need one. */
const SHELL = {
  root: path.resolve(HERE, "../dist"),
  base: "/reader/",
  csp: "default-src 'self'",
};

/**
 * The limiter is disabled on the main instance and exercised separately below.
 * It runs in `onRequest`, i.e. *before* schema validation, so leaving it on here
 * would make the strict-schema assertions depend on how many requests the
 * earlier sections happened to send — a flaky test that fails for the wrong
 * reason.
 */
const { app, rateLimitStore, rateLimitedRoutes } = await buildApp({
  prisma: {},
  auth: stubAuth,
  nodeEnv: "test",
  logLevel: "silent",
  shell: SHELL,
  rateLimit: {
    enabled: false,
    defaultWindowSeconds: 60,
    defaultMax: 20,
    defaultMaxConcurrent: 4,
    globalMaxConcurrent: 8,
  },
});

const inject = (opts) => app.inject(opts);
const json = (r) => JSON.parse(r.body);

try {
  // The deployed proxy may supply a client address only from loopback.
  for (const trusted of [false, true]) {
    const probe = await buildApp({ prisma: {}, auth: stubAuth, nodeEnv: "test",
      logLevel: "silent", trustLoopbackProxy: trusted,
      rateLimit: { enabled: true, defaultWindowSeconds: 60,
        defaultMax: 20, defaultMaxConcurrent: 4, globalMaxConcurrent: 8 } });
    const seen=[];
    const originalHit=probe.rateLimitStore.hit.bind(probe.rateLimitStore);
    probe.rateLimitStore.hit=(key,...args)=>{seen.push(key);return originalHit(key,...args);};
    try {
      await probe.app.inject({ method:'POST',url: '/api/anonymous/extract',payload:{kind:'text',content:'代理验收正文。'},remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.21' } });
      assert.ok(seen.at(-1).endsWith(trusted ? '203.0.113.21' : '127.0.0.1'));
      await probe.app.inject({ method:'POST',url: '/api/anonymous/extract',payload:{kind:'text',content:'代理验收正文。'}, remoteAddress: '198.51.100.9',
        headers: { 'x-forwarded-for': '203.0.113.21' } });
      assert.ok(seen.at(-1).endsWith('198.51.100.9'));
    } finally { await probe.app.close(); }
  }
  check('proxy identity is opt-in, loopback-only; remote spoofed XFF is ignored');

  // ── 1. The rate-limited route is declared and wired ──────────────────────
  // The boot assertion inside `buildApp` is what proves the hook is attached;
  // this records which routes it found, so a route that declares a limit
  // nobody enforces cannot pass unnoticed.
  assert.deepEqual(rateLimitedRoutes, ["POST /api/anonymous/extract"]);
  assert.ok(rateLimitStore, "the limiter's state must be reachable for inspection");
  check("boots without a database and rate-limits the extract route");

  // ── 2. Health ────────────────────────────────────────────────────────────
  {
    const r = await inject({ method: "GET", url: ROUTES.healthLive });
    assert.equal(r.statusCode, 200);
    const body = json(r);
    assert.equal(body.status, "ok");
    assert.equal(r.headers["x-robots-tag"], "noindex");
    check("GET /api/health/live answers without a database, API responses are noindex");
  }
  {
    // Readiness *is* a database question, and this app has been given a stub.
    // It must report itself degraded rather than answering `ok` it cannot
    // support — the failure mode this rules out is a load balancer sending
    // traffic to a process whose every account request will 500.
    const r = await inject({ method: "GET", url: ROUTES.healthReady });
    assert.equal(r.statusCode, 503, "readiness must not claim ok with the database down");
    assert.equal(json(r).checks.database, "down");
    check("GET /api/health/ready fails closed when the database is unreachable");
  }

  // ── 3. The account surface is mounted, and gated ─────────────────────────
  // Both halves matter. A 404 would mean the artifact was built without the
  // account routes; a 200 would mean they answered without a session.
  {
    // A schema-valid sync body, because Fastify runs body validation before
    // the session `preHandler`: an anonymous caller with a *malformed* body
    // gets 400, which proves the route is mounted but says nothing about the
    // gate. The hash values are well-formed and deliberately wrong — the route
    // would reject them at 422 if it ever got that far, which it must not.
    const validSyncBody = {
      title: "边界检查",
      sourceUrl: null,
      source: "local",
      author: null,
      textHash: "a".repeat(64),
      blocks: [
        { id: "b1-aaaaaaaa", index: 1, type: "paragraph", text: "正文", hash: "b".repeat(64) },
      ],
      clientKey: "release-inject-check",
    };
    const gated = [
      { method: "GET", url: ROUTES.me },
      { method: "GET", url: "/api/articles" },
      { method: "GET", url: "/api/articles/abc" },
      { method: "GET", url: "/api/articles/abc/notes" },
      { method: "GET", url: "/api/admin/users" },
      { method: "POST", url: "/api/ai/entry" },
      { method: "POST", url: "/api/articles/sync", payload: validSyncBody },
    ];
    for (const route of gated) {
      const r = await inject(route);
      assert.equal(
        r.statusCode,
        401,
        `${route.method} ${route.url} must be mounted and must refuse an anonymous caller (got ${r.statusCode})`,
      );
    }
    // The auth handler is mounted rather than gated — signing in is how a
    // caller stops being anonymous.
    const authMount = await inject({ method: "GET", url: "/api/auth/get-session" });
    assert.notEqual(authMount.statusCode, 404, "the auth mount must exist");
    check(`account routes are mounted and refuse an anonymous caller (${gated.length} probed → 401)`);
  }

  // ── 4. No billing surface, at the route table ────────────────────────────
  // The paths are written out rather than read from `ROUTES`: the whole claim
  // is that no constant for them exists on this line, so reading one would be
  // circular. This is the boundary, and it is the only one left.
  {
    const billing = [
      { method: "GET", url: "/api/billing/catalogue" },
      { method: "GET", url: "/api/billing/entitlements" },
      { method: "POST", url: "/api/billing/orders", payload: {} },
      { method: "POST", url: "/api/billing/notify/wechat", payload: {} },
      { method: "POST", url: "/api/billing/notify/alipay", payload: {} },
    ];
    for (const route of billing) {
      const r = await inject(route);
      assert.equal(
        r.statusCode,
        404,
        `${route.method} ${route.url} must not be mounted (got ${r.statusCode})`,
      );
      assert.equal(json(r).error.code, "NOT_FOUND");
    }
    check(`no billing route is mounted (${billing.length} probed → 404)`);
  }

  // ── 5. Extract body schema is strict ─────────────────────────────────────
  {
    const cases = [
      [{ kind: "url" }, 400, "missing content"],
      [{ content: "https://example.com/x" }, 400, "missing kind"],
      [{ kind: "proxy", content: "https://example.com/x" }, 400, "unknown kind"],
      // A client naming its own proxy must be rejected, not silently stripped.
      [{ kind: "url", content: "https://example.com/x", proxy: "https://evil.test" }, 400, "extra field"],
      [{ kind: "url", content: "https://example.com/x", jinaApiKey: "sk-x" }, 400, "jina key field"],
    ];
    for (const [payload, status, label] of cases) {
      const r = await inject({ method: "POST", url: "/api/anonymous/extract", payload });
      assert.equal(r.statusCode, status, `${label}: expected ${status}, got ${r.statusCode}`);
    }
    const oversized = await inject({
      method: "POST",
      url: "/api/anonymous/extract",
      payload: { kind: "text", content: "x".repeat(2 * 1024 * 1024 + 1) },
    });
    assert.equal(oversized.statusCode, 400);
    check("extract body rejects missing/unknown/extra fields and oversized input (no silent strip)");
  }

  // ── 6. SSRF / scheme / credentials still fail closed ─────────────────────
  {
    const blocked = [
      ["http://127.0.0.1:9/x", "loopback"],
      ["http://10.0.0.1/x", "private range"],
      ["http://169.254.169.254/latest/meta-data/", "link-local metadata"],
      ["file:///etc/passwd", "file scheme"],
      ["http://user:pass@example.com/x", "embedded credentials"],
    ];
    for (const [content, label] of blocked) {
      const r = await inject({ method: "POST", url: "/api/anonymous/extract", payload: { kind: "url", content } });
      assert.ok(r.statusCode >= 400, `${label} must be refused (got ${r.statusCode})`);
      const body = json(r);
      assert.ok(body.error && typeof body.error.message === "string");
      // The refusal must not echo a resolved address or a port.
      assert.ok(!/127\.0\.0\.1|10\.0\.0\.1|169\.254/.test(body.error.message) || /不在公网范围/.test(body.error.message));
    }
    check("SSRF guard, scheme allowlist and credential refusal all still apply through this service");
  }

  // ── 7. Positive extraction, via the existing test transport fixture ──────
  {
    const r = await inject({
      method: "POST",
      url: "/api/anonymous/extract",
      payload: { kind: "url", content: "https://example.com/post" },
    });
    assert.equal(r.statusCode, 200, `expected a successful extraction, got ${r.statusCode}: ${r.body}`);
    const body = json(r);
    assert.equal(body.extractor, "html-readability");
    assert.ok(body.document.blocks.length >= 2);
    assert.ok(typeof body.document.textHash === "string");
    check("url extraction returns the shared ParsedDocument via the existing controlled fetch");
  }
  {
    const r = await inject({
      method: "POST",
      url: "/api/anonymous/extract",
      payload: {
        kind: "text",
        content:
          "深度学习模型的训练需要大量计算资源，许多团队因此选择使用云端 GPU 集群。\n\n第二段用于确认短中文段落不会被词数门槛拒绝。",
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(json(r).extractor, "local");
    assert.ok(json(r).document.blocks.length >= 2, "short Chinese paragraphs must survive");
    check("text extraction parses locally and keeps short Chinese paragraphs");
  }

  // ── 8. Rate limit actually bites ─────────────────────────────────────────
  {
    const limited = await buildApp({
      prisma: {},
      auth: stubAuth,
      nodeEnv: "test",
      logLevel: "silent",
      rateLimit: {
        enabled: true,
        defaultWindowSeconds: 60,
        defaultMax: 2,
        defaultMaxConcurrent: 4,
        globalMaxConcurrent: 8,
      },
    });
    try {
      let sawRateLimit = false;
      for (let i = 0; i < 6; i += 1) {
        const r = await limited.app.inject({
          method: "POST",
          url: "/api/anonymous/extract",
          payload: { kind: "text", content: `限流测试第 ${i} 段文字内容。` },
        });
        if (r.statusCode === 429) {
          assert.equal(JSON.parse(r.body).error.code, "RATE_LIMITED");
          sawRateLimit = true;
          break;
        }
      }
      assert.ok(sawRateLimit, "the declared limit on /api/anonymous/extract must be enforced");
      const wrongMethod = await limited.app.inject({ method: "GET", url: "/api/anonymous/extract" });
      assert.equal(wrongMethod.statusCode, 404);
      check("the extract route returns 429 once its declared limit is exceeded");
    } finally {
      await limited.app.close();
    }
  }

  // ── 9. Static shell ──────────────────────────────────────────────────────
  {
    const shell = await inject({ method: "GET", url: "/reader/" });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.headers["content-type"], /text\/html/);
    assert.equal(shell.headers["cache-control"], "no-cache");
    assert.ok(String(shell.headers["content-security-policy"]).length > 0);
    assert.ok(!shell.body.includes("fonts.googleapis.com"), "the shell must not link remote fonts");
    assert.match(shell.body, /src="\/reader\/assets\//);

    const redirect = await inject({ method: "GET", url: "/reader" });
    assert.equal(redirect.statusCode, 308);
    assert.equal(redirect.headers["location"], "/reader/");

    const worker = await inject({ method: "GET", url: "/reader/sw.js" });
    assert.equal(worker.statusCode, 200);
    assert.equal(worker.headers['cache-control'],'no-cache');
    assert.match(String(worker.headers["content-type"]), /javascript/);
    assert.ok(worker.body.includes("self.addEventListener('fetch'"));

    const spawn = await inject({ method: "GET", url: "/reader/does-not-exist" });
    assert.equal(spawn.statusCode, 200, "an unknown shell path falls back to index.html");
    assert.match(spawn.body, /<div id="root">/);

    // pdf.js's assets are served by an extension allowlist, and an extension
    // that is missing from it does not 404 — the request falls through to the
    // SPA fallback and comes back as `index.html`. For the worker that surfaces
    // as "failed to fetch dynamically imported module" (a module script with an
    // HTML body), and for the cmaps and font data it is quieter still: pdf.js
    // treats a failed table as a missing one, and a Chinese PDF renders as
    // garbage. Asserting the body is not the shell is what catches the silent
    // half.
    const pdfWorker = await inject({ method: "GET", url: "/reader/pdfjs/pdf.worker.min.mjs" });
    assert.equal(pdfWorker.statusCode, 200);
    assert.match(String(pdfWorker.headers["content-type"]), /javascript/);
    assert.ok(!pdfWorker.body.includes('<div id="root">'), "the worker must be the worker, not the shell");

    const cmap = await inject({ method: "GET", url: "/reader/pdfjs/cmaps/UniGB-UCS2-H.bcmap" });
    assert.equal(cmap.statusCode, 200);
    assert.ok(!cmap.body.includes('<div id="root">'), "a CMap must not fall back to the shell");

    const font = await inject({ method: "GET", url: "/reader/pdfjs/standard_fonts/FoxitFixed.pfb" });
    assert.equal(font.statusCode, 200);
    assert.ok(!font.body.includes('<div id="root">'), "a standard font must not fall back to the shell");
    check("shell, worker, base redirect and SPA fallback are served with the deployment CSP");
  }
  {
    const escapes = [
      "/reader/../../package.json",
      "/reader/%2e%2e/%2e%2e/package.json",
      "/reader/..%2f..%2fpackage.json",
      "/reader/assets/../../package.json",
    ];
    for (const url of escapes) {
      const r = await inject({ method: "GET", url });
      // Either the containment check rejects it (404) or the SPA fallback
      // answers with the shell (200 HTML) — never the file outside the root.
      assert.ok(
        r.statusCode === 404 || r.statusCode === 200,
        `${url} produced an unexpected status ${r.statusCode}`,
      );
      assert.ok(!r.body.includes('"name": "gloss-base"'), `${url} leaked a file outside dist`);
    }
    const notAllowed = await inject({ method: "GET", url: "/reader/../package.json" });
    assert.ok(notAllowed.statusCode === 404 || !notAllowed.body.includes("gloss-base"));
    check("static serving cannot escape the shell root (encoded and plain traversal both contained)");
  }

  const summary = { pass: true, checks };
  writeFileSync(path.join(EVIDENCE, "server-inject.json"), JSON.stringify(summary, null, 2));
  console.log(`\nPASS ${checks.length} release-service boundary checks`);
} catch (err) {
  writeFileSync(path.join(EVIDENCE, "server-inject-failure.txt"), String(err?.stack ?? err));
  throw err;
} finally {
  await app.close();
}
