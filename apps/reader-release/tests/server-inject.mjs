// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Service boundary tests (inject + one child-process launch).
 *
 * These assert what the service is *capable* of, not what the UI happens to
 * show. The claim under test is that a deployment mounts only the controlled
 * extractor and a health probe — so a request for a cloud route, a session,
 * an account or an admin surface is answered by the generic 404 handler and
 * not by a route that could touch data.
 *
 * Run from the repository root:
 *   node --import tsx --import ./tests/fixtures/direct-http-preload.mjs \
 *     apps/reader-release/tests/server-inject.mjs
 *
 * The preload fixture resolves `example.com` to a public address and answers
 * over https with a fixture article. It gives the positive extraction path a
 * real upstream without touching a real network — and, importantly, without
 * relaxing the SSRF guard, which is what the negative cases below prove still
 * bites.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { evidenceDir } from "../../../scripts/evidence-dir.mjs";

// Evidence lands under `artifacts/`, which the repository ignores, unless
// `EVIDENCE_DIR` points the run elsewhere. See `scripts/evidence-dir.mjs`.
const EVIDENCE = evidenceDir("base-acceptance");

const checks = [];
function check(name, detail) {
  checks.push(detail === undefined ? name : `${name} — ${detail}`);
  console.log(`  ✔ ${name}`);
}

// The service must not require a database or an auth secret, so every
// credential-shaped variable is removed from the environment rather than
// merely unset in the shell. The pattern is anchored on word boundaries: the
// point is that this process reads none of them, whatever a deployment
// happens to export, and that the assertion below still holds if a variable
// is renamed.
const CREDENTIAL_ENV = /(^|_)(DATABASE_URL|DB_URL|DSN|SECRET|TOKEN|PASSWORD|CREDENTIALS?|API_KEY)($|_)/i;
for (const name of Object.keys(process.env)) {
  if (CREDENTIAL_ENV.test(name)) delete process.env[name];
}

const { buildReaderService } = await import("../server.ts");

/**
 * The limiter is disabled on the main instance and exercised separately
 * below. It runs in `onRequest`, i.e. *before* schema validation, so leaving
 * it on here would make the strict-schema assertions depend on how many
 * requests the earlier sections happened to send — a flaky test that fails
 * for the wrong reason.
 */
const { app, rateLimitedRoutes } = await buildReaderService({
  nodeEnv: "test",
  logLevel: "silent",
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
  // A reverse proxy on the same host may supply the client address, and only
  // a loopback peer may do so.
  for (const trusted of [false, true]) {
    const probe = await buildReaderService({ nodeEnv: "test", logLevel: "silent", serveStatic: false,
      trustLoopbackProxy: trusted, rateLimit: { enabled: true, defaultWindowSeconds: 60,
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
  // ── 1. Boot with no database ───────────────────────────────────────────
  assert.deepEqual(rateLimitedRoutes, ["POST /api/anonymous/extract"]);
  check("boots with no database or auth credentials present, and rate-limits the extract route");

  // ── 2. Health ──────────────────────────────────────────────────────────
  {
    const r = await inject({ method: "GET", url: "/api/health/live" });
    assert.equal(r.statusCode, 200);
    const body = json(r);
    assert.equal(body.status, "ok");
    assert.equal(body.service, "kobook");
    assert.equal(r.headers["x-robots-tag"], "noindex");
    check("GET /api/health/live answers without a database, API responses are noindex");
  }
  {
    // Readiness is a database question; this process has no database, so it
    // must not claim readiness.
    const r = await inject({ method: "GET", url: "/api/health/ready" });
    assert.equal(r.statusCode, 404);
    check("GET /api/health/ready is absent rather than answered without a database");
  }

  // ── 3. No cloud / account / admin surface ──────────────────────────────
  {
    // Representative paths, not an inventory: each one is the shape a client
    // for a service this process does not mount would ask for. The assertion
    // is about the answer — a generic 404 envelope — rather than about the
    // list, so adding another probe is always safe.
    const cloudRoutes = [
      { method: "GET", url: "/api/me" },
      { method: "POST", url: "/api/auth/sign-in/email", payload: { email: "a@b.c", password: "x" } },
      { method: "GET", url: "/api/auth/get-session" },
      { method: "GET", url: "/api/articles" },
      { method: "POST", url: "/api/articles", payload: {} },
      { method: "GET", url: "/api/articles/abc/notes" },
      { method: "POST", url: "/api/ai/entry" },
      { method: "GET", url: "/api/admin/users" },
      { method: "POST", url: "/api/sample/echo", payload: {} },
      { method: "GET", url: "/api/quota" },
    ];
    for (const route of cloudRoutes) {
      const r = await inject(route);
      assert.equal(
        r.statusCode,
        404,
        `${route.method} ${route.url} must not be mounted (got ${r.statusCode})`,
      );
      const body = json(r);
      assert.equal(body.error.code, "NOT_FOUND");
      assert.ok(typeof body.error.requestId === "string");
    }
    check(`no cloud/account/admin route is mounted (${cloudRoutes.length} probed → 404)`);
  }

  // ── 4. Extract body schema is strict ───────────────────────────────────
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

  // ── 5. SSRF / scheme / credentials still fail closed ───────────────────
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

  // ── 6. Positive extraction, via the existing test transport fixture ────
  {
    const r = await inject({
      method: "POST",
      url: "/api/anonymous/extract",
      payload: { kind: "url", content: "https://example.com/post" },
    });
    assert.equal(r.statusCode, 200, `expected a successful extraction, got ${r.statusCode}: ${r.body}`);
    const body = json(r);
    // `html-readability` is the wire value the shared contract uses; the
    // browser maps it to the `server-readability` provenance it records
    // locally (see `sourceForServerExtractor` in src/lib/browser-extract.ts).
    assert.equal(body.extractor, "html-readability");
    assert.ok(body.document.blocks.length >= 2);
    assert.ok(body.document.blocks.some((b) => b.type === "paragraph"));
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
    const body = json(r);
    assert.equal(body.extractor, "local");
    assert.ok(body.document.blocks.length >= 2, "short Chinese paragraphs must survive");
    check("text extraction parses locally and keeps short Chinese paragraphs");
  }

  // ── 7. Rate limit actually bites ───────────────────────────────────────
  {
    const limited = await buildReaderService({
      nodeEnv: "test",
      logLevel: "silent",
      serveStatic: false,
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
      // A GET on the same path is a different method: it must still 404 rather
      // than being swallowed by the limiter's bucket.
      const wrongMethod = await limited.app.inject({ method: "GET", url: "/api/anonymous/extract" });
      assert.equal(wrongMethod.statusCode, 404);
      check("the extract route returns 429 once its declared limit is exceeded");
    } finally {
      await limited.app.close();
    }
  }

  // ── 8. Static shell ────────────────────────────────────────────────────
  {
    const shell = await inject({ method: "GET", url: "/reader/" });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.headers["content-type"], /text\/html/);
    assert.equal(shell.headers["cache-control"], "no-cache");
    assert.ok(String(shell.headers["content-security-policy"]).includes("connect-src 'self' https:"));
    assert.ok(!shell.body.includes("fonts.googleapis.com"), "the built shell must not link remote fonts");
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
    check("shell, worker, base redirect and SPA fallback are served with the base CSP");
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
      assert.ok(!r.body.includes('"name": "kobook"'), `${url} leaked a file outside dist`);
    }
    const notAllowed = await inject({ method: "GET", url: "/reader/../package.json" });
    assert.ok(notAllowed.statusCode === 404 || !notAllowed.body.includes("kobook"));
    check("static serving cannot escape dist (encoded and plain traversal both contained)");
  }

  const summary = { pass: true, checks, rateLimitedRoutes };
  writeFileSync(path.join(EVIDENCE, "server-inject.json"), JSON.stringify(summary, null, 2));
  console.log(`\nPASS ${checks.length} service boundary checks`);
} catch (err) {
  writeFileSync(path.join(EVIDENCE, "server-inject-failure.txt"), String(err?.stack ?? err));
  throw err;
} finally {
  await app.close();
}
