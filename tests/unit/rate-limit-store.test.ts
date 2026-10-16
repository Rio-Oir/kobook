// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The anonymous-route limiter, and the boot assertion that keeps it wired.
 *
 * The defect this file exists to make unrepeatable: the anonymous
 * extraction route declared `config: { rateLimit: ... }` and nothing
 * enforced it, so the endpoint looked protected in review while being
 * wide open at runtime. `assertRateLimitedRoutesWired` now fails the boot
 * if the declaration and the enforcement drift apart; the tests below pin
 * both halves.
 *
 * The two gates are tested separately because they stop different abuse:
 * the fixed window bounds request *rate*, the in-flight counter bounds
 * *concurrency*, and a burst of slow fetches passes the first while
 * failing the second.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  ANON_RATE_LIMIT_DEFAULTS,
  assertRateLimitedRoutesWired,
  createRateLimitStore,
  getRateLimitRelease,
  loadAnonRateLimitConfig,
  normalizeRouteRateLimit,
  registerRateLimitPlugin,
} from "../../server/src/lib/rate-limit-store.js";

const baseConfig = {
  enabled: true,
  defaultWindowSeconds: 60,
  defaultMax: 20,
  defaultMaxConcurrent: 4,
  globalMaxConcurrent: 16,
};

test("a fixed window admits max requests and refuses the next one", () => {
  const store = createRateLimitStore();
  for (let i = 0; i < 3; i += 1) {
    const d = store.hit("k", 3, 60_000, 1_000);
    assert.equal(d.allowed, true, `request ${i + 1} of 3 must be allowed`);
  }
  const refused = store.hit("k", 3, 60_000, 1_000);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1, "a refusal must tell the caller when to retry");
});

test("the window rolls over and the counter resets", () => {
  const store = createRateLimitStore();
  for (let i = 0; i < 3; i += 1) store.hit("k", 3, 1_000, 0);
  assert.equal(store.hit("k", 3, 1_000, 500).allowed, false, "still inside the window");
  assert.equal(store.hit("k", 3, 1_000, 1_000).allowed, true, "a fresh window starts over");
});

test("two clients get independent buckets", () => {
  const store = createRateLimitStore();
  for (let i = 0; i < 3; i += 1) store.hit("k:1.2.3.4", 3, 60_000, 0);
  assert.equal(store.hit("k:1.2.3.4", 3, 60_000, 0).allowed, false);
  assert.equal(store.hit("k:5.6.7.8", 3, 60_000, 0).allowed, true, "another client is unaffected");
});

test("the per-client in-flight ceiling refuses the request past it", () => {
  const store = createRateLimitStore();
  assert.equal(store.enter("k", 2, 16).ok, true);
  assert.equal(store.enter("k", 2, 16).ok, true);
  const third = store.enter("k", 2, 16);
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.scope, "client");
  store.leave("k");
  assert.equal(store.enter("k", 2, 16).ok, true, "releasing a slot frees the ceiling again");
  assert.equal(store.inFlight("k"), 2);
});

test("the process-wide ceiling stops a caller that stays under its own", () => {
  // The bypass this exists for: a client reconnecting, or many clients
  // behind one address, each individually within the per-client limit
  // while the process accumulates unbounded concurrent upstream work.
  const store = createRateLimitStore();
  assert.equal(store.enter("a", 100, 2).ok, true);
  assert.equal(store.enter("b", 100, 2).ok, true);
  const third = store.enter("c", 100, 2);
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.scope, "global");
  assert.equal(store.totalInFlight(), 2);
  store.leave("a");
  assert.equal(store.enter("c", 100, 2).ok, true);
});

test("leaving more times than entering cannot make the counter negative", () => {
  const store = createRateLimitStore();
  store.enter("k", 2, 16);
  store.leave("k");
  store.leave("k");
  assert.equal(store.inFlight("k"), 0);
  assert.equal(store.totalInFlight(), 0);
  assert.equal(store.enter("k", 2, 16).ok, true);
});

test("expired window buckets are reclaimed instead of accumulating", () => {
  // A window map keyed by client address, never evicted, is a slow leak
  // an attacker controls the key of.
  const store = createRateLimitStore();
  for (let i = 0; i < 40; i += 1) store.hit("client-" + i, 5, 1_000, 0);
  assert.equal(store.trackedWindows(), 40);
  const removed = store.sweepExpired(2_000, 1_000);
  assert.equal(removed, 40);
  assert.equal(store.trackedWindows(), 0, "an elapsed window must not be retained");
});

test("a live window is not swept away", () => {
  const store = createRateLimitStore();
  store.hit("k", 5, 1_000, 500);
  assert.equal(store.sweepExpired(900, 1_000), 0);
  assert.equal(store.trackedWindows(), 1);
  // And the counter still refuses past the max, proving the sweep did
  // not reset a live bucket.
  for (let i = 0; i < 4; i += 1) store.hit("k", 5, 1_000, 900);
  assert.equal(store.hit("k", 5, 1_000, 900).allowed, false);
});

test("the map is swept automatically so it cannot grow without bound", () => {
  const store = createRateLimitStore();
  // Each call uses a fresh key and a window that has already elapsed by
  // the time the next call arrives, so every bucket is reclaimable.
  for (let i = 0; i < 600; i += 1) {
    store.hit("client-" + i, 5, 1, i * 10);
  }
  assert.ok(
    store.trackedWindows() < 600,
    "expected the opportunistic sweep to reclaim buckets, still tracking " +
      String(store.trackedWindows()),
  );
});

test("a route's declared limit is normalised, not silently defaulted", () => {
  const limit = normalizeRouteRateLimit(
    { key: "anon", max: 5, timeWindow: "1 minute" },
    "/fallback",
    baseConfig,
  );
  assert.equal(limit.key, "anon");
  assert.equal(limit.max, 5);
  assert.equal(limit.windowSeconds, 60);
  assert.equal(limit.windowMs, 60_000);
  assert.equal(limit.maxConcurrent, Math.min(baseConfig.defaultMaxConcurrent, 5));
});

test("a timeWindow string in units other than seconds is parsed", () => {
  const hour = normalizeRouteRateLimit({ max: 1, timeWindow: "1 hour" }, "/x", baseConfig);
  assert.equal(hour.windowSeconds, 3_600);
  const seconds = normalizeRouteRateLimit({ max: 1, timeWindow: "30 seconds" }, "/x", baseConfig);
  assert.equal(seconds.windowSeconds, 30);
});

test("an unparseable timeWindow throws instead of defaulting", () => {
  assert.throws(
    () => normalizeRouteRateLimit({ max: 1, timeWindow: "soon" }, "/x", baseConfig),
    /not a supported duration/,
  );
});

test("a non-object rateLimit declaration throws", () => {
  assert.throws(() => normalizeRouteRateLimit("yes", "/x", baseConfig), /must be an object/);
});

test("the config loader defaults to off outside production and on inside it", () => {
  assert.equal(loadAnonRateLimitConfig("development", {}).enabled, false);
  assert.equal(loadAnonRateLimitConfig("test", {}).enabled, false);
  assert.equal(loadAnonRateLimitConfig("production", {}).enabled, true);
  assert.equal(loadAnonRateLimitConfig("test", { ANON_RATE_LIMIT_ENABLED: "1" }).enabled, true);
  assert.equal(loadAnonRateLimitConfig("production", { ANON_RATE_LIMIT_ENABLED: "0" }).enabled, false);
});

test("a malformed limiter value fails startup rather than silently disabling", () => {
  assert.throws(
    () => loadAnonRateLimitConfig("production", { ANON_RATE_LIMIT_MAX: "lots" }),
    /positive integer/,
  );
  assert.throws(
    () => loadAnonRateLimitConfig("production", { ANON_RATE_LIMIT_ENABLED: "maybe" }),
    /must be 1\/0 or true\/false/,
  );
});

test("defaults are the documented ones", () => {
  assert.equal(ANON_RATE_LIMIT_DEFAULTS.defaultMax, 20);
  assert.equal(ANON_RATE_LIMIT_DEFAULTS.defaultWindowSeconds, 60);
  assert.ok(ANON_RATE_LIMIT_DEFAULTS.defaultMaxConcurrent > 0);
});

test("a declared route that is not mounted fails the boot assertion", () => {
  const app = Fastify();
  assert.throws(
    () =>
      assertRateLimitedRoutesWired(
        app,
        [{ method: "POST", url: "/api/anonymous/extract" }],
        true,
      ),
    /declares a rate limit but is not mounted/,
  );
});

test("a mounted declared route passes the boot assertion", async () => {
  const app = Fastify();
  app.post("/api/anonymous/extract", () => ({ ok: true }));
  await app.ready();
  const verified = assertRateLimitedRoutesWired(
    app,
    [{ method: "POST", url: "/api/anonymous/extract" }],
    true,
  );
  assert.deepEqual(verified, ["POST /api/anonymous/extract"]);
  await app.close();
});

test("the boot assertion refuses a hook registered after the routes", () => {
  const app = Fastify();
  assert.throws(
    () => assertRateLimitedRoutesWired(app, [], false),
    /must be registered on the root instance before the route block/,
  );
});

// ── End-to-end through a real Fastify instance ──────────────────────────

let hold: Promise<void> | null = null;

async function buildLimitedApp(overrides: Partial<typeof baseConfig> = {}) {
  const app = Fastify();
  const config = { ...baseConfig, ...overrides };
  const store = registerRateLimitPlugin(app, config);
  app.post(
    "/api/anonymous/extract",
    { config: { rateLimit: { key: "anon", max: 2, windowSeconds: 60, maxConcurrent: 2 } } },
    async (req) => {
      // Mimic the real route: release when the *work* is done.
      try {
        if (hold !== null) await hold;
        return { document: { blocks: [] } };
      } finally {
        getRateLimitRelease(req)?.();
      }
    },
  );
  app.get("/api/health/live", async () => ({ ok: true }));
  await app.ready();
  return { app, store };
}

test("the plugin answers 429 with the shared error envelope", async () => {
  const { app } = await buildLimitedApp();
  const first = await app.inject({ method: "POST", url: "/api/anonymous/extract" });
  const second = await app.inject({ method: "POST", url: "/api/anonymous/extract" });
  const third = await app.inject({ method: "POST", url: "/api/anonymous/extract" });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  const body = third.json() as { error: { code: string; message: string; requestId: string } };
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.match(body.error.message, /请求过于频繁/);
  assert.ok(body.error.requestId.length > 0);
  assert.ok(third.headers["retry-after"], "a 429 must carry Retry-After");
  await app.close();
});

test("routes with no declaration are not limited", async () => {
  const { app } = await buildLimitedApp({ defaultMax: 1 });
  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({ method: "GET", url: "/api/health/live" });
    assert.equal(res.statusCode, 200, "an undeclared route must stay unlimited");
  }
  await app.close();
});

test("a disabled limiter lets everything through and counts nothing", async () => {
  const { app, store } = await buildLimitedApp({ enabled: false });
  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({ method: "POST", url: "/api/anonymous/extract" });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(store.totalInFlight(), 0);
  await app.close();
});

test("the slot is held for as long as the work, not as long as a reply", async () => {
  // The ceiling a client could otherwise escape: disconnecting while the
  // server is still fetching. Here the handler does not resolve until
  // `hold` does, and the slot must stay taken in the meantime.
  const { app, store } = await buildLimitedApp({ defaultMaxConcurrent: 1 });
  let release: () => void = () => {};
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const inflight = app.inject({ method: "POST", url: "/api/anonymous/extract" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.totalInFlight(), 1, "an unfinished handler must still hold its slot");

  release();
  hold = null;
  const res = await inflight;
  assert.equal(res.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.totalInFlight(), 0, "the slot must be released once the work is done");
  await app.close();
});

test("every configured ceiling is reachable from the environment", () => {
  const config = loadAnonRateLimitConfig("production", {
    ANON_RATE_LIMIT_MAX: "7",
    ANON_RATE_LIMIT_WINDOW: "90",
    ANON_RATE_LIMIT_MAX_CONCURRENT: "3",
    ANON_RATE_LIMIT_GLOBAL_CONCURRENT: "11",
  });
  assert.equal(config.defaultMax, 7);
  assert.equal(config.defaultWindowSeconds, 90);
  assert.equal(config.defaultMaxConcurrent, 3);
  assert.equal(config.globalMaxConcurrent, 11);
});

test("a route that declares only a key inherits the configured limits", () => {
  // This is what the anonymous route does on purpose: hardcoding limits
  // at the route makes the environment variables silently ineffective.
  const config = loadAnonRateLimitConfig("production", { ANON_RATE_LIMIT_MAX: "9" });
  const limit = normalizeRouteRateLimit({ key: "anon" }, "/api/anonymous/extract", config);
  assert.equal(limit.max, 9, "the configured maximum must win, not a route literal");
  assert.equal(limit.key, "anon");
});
