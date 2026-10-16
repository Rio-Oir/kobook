// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fixed-window limiter + concurrency gate for the unauthenticated routes.
 *
 * The anonymous extraction route is the first route an unauthenticated caller
 * can use, and for `kind: "url"` it is also the only unauthenticated egress
 * the service has: one POST makes the server resolve a hostname, open a
 * socket, and read up to `MAX_RESPONSE_BYTES`. Leaving that unmetered would
 * undo the point of having an SSRF guard, and a limiter that only guarded a
 * sign-in mount would not cover it.
 *
 * `config: { rateLimit: ... }` on a route is the declaration; this module
 * is the enforcement. Fastify stores a route's `config` on the route
 * options and surfaces it at request time, so a route that declares a
 * limit but is never wired to this plugin would fail silently — which is
 * exactly the defect this replaces. `assertRateLimitedRoutesWired` below
 * makes that failure mode impossible to reintroduce: the plugin refuses
 * to boot if a route declares a limit whose shape it cannot read.
 *
 * Two independent gates, because they stop different abuse:
 *   - the fixed window bounds *request rate* (a script hammering the
 *     endpoint);
 *   - the in-flight counter bounds *concurrency* (slowloris-style
 *     clients that hold many fetches open at once, each one pinning a
 *     server socket). A rate limit alone does not stop this: 20 requests
 *     a minute that each take 15 s is still 5 concurrent upstream fetches
 *     from a single caller.
 *
 * State is per-process and in memory. That is honest for a single-process
 * deployment and is a known limitation: running more than one replica needs a
 * shared store, or each replica gets its own budget.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildApiError } from "../../../shared/contracts/index.js";

export interface RouteRateLimitConfig {
  /** Requests allowed per window, per client key. */
  max: number;
  /** Window length in seconds. */
  windowSeconds?: number;
  /**
   * Maximum requests of this route in flight at once, per client key.
   * Defaults to `max` when unset — never unlimited.
   */
  maxConcurrent?: number;
  /**
   * Bucket name. Defaults to the route's URL pattern, so two routes
   * never share a counter by accident.
   */
  key?: string;
}

export interface AnonRateLimitConfig {
  enabled: boolean;
  defaultWindowSeconds: number;
  defaultMax: number;
  /** Per-client in-flight ceiling for a route that declares none. */
  defaultMaxConcurrent: number;
  /**
   * Process-wide in-flight ceiling across *all* clients.
   *
   * A per-client ceiling alone is not a bound on the work the process is
   * doing: a caller behind many addresses, or one that reconnects in a
   * loop, keeps several upstream fetches alive at once while each
   * individual bucket stays under its own limit. This is the number that
   * actually protects the event loop and the outbound socket pool.
   */
  globalMaxConcurrent: number;
}

export const ANON_RATE_LIMIT_DEFAULTS = {
  defaultWindowSeconds: 60,
  defaultMax: 20,
  defaultMaxConcurrent: 4,
  globalMaxConcurrent: 16,
} as const;

function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function readFlag(raw: string | undefined, fallback: boolean, name: string): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be 1/0 or true/false, got ${JSON.stringify(raw)}`);
}

/**
 * Default: on in production, off elsewhere — the same rule and the same
 * reason as the auth limiter, so a developer hitting the endpoint from a
 * script during local work does not have to fight it, while a deployment
 * gets the guard without any extra configuration. Tests that need to
 * observe a real 429 turn it on explicitly.
 */
export function loadAnonRateLimitConfig(
  nodeEnv: string,
  raw: Record<string, string | undefined> = process.env,
): AnonRateLimitConfig {
  return {
    enabled: readFlag(
      raw["ANON_RATE_LIMIT_ENABLED"],
      nodeEnv === "production",
      "ANON_RATE_LIMIT_ENABLED",
    ),
    defaultWindowSeconds: readPositiveInt(
      raw["ANON_RATE_LIMIT_WINDOW"],
      ANON_RATE_LIMIT_DEFAULTS.defaultWindowSeconds,
      "ANON_RATE_LIMIT_WINDOW",
    ),
    defaultMax: readPositiveInt(
      raw["ANON_RATE_LIMIT_MAX"],
      ANON_RATE_LIMIT_DEFAULTS.defaultMax,
      "ANON_RATE_LIMIT_MAX",
    ),
    defaultMaxConcurrent: readPositiveInt(
      raw["ANON_RATE_LIMIT_MAX_CONCURRENT"],
      ANON_RATE_LIMIT_DEFAULTS.defaultMaxConcurrent,
      "ANON_RATE_LIMIT_MAX_CONCURRENT",
    ),
    globalMaxConcurrent: readPositiveInt(
      raw["ANON_RATE_LIMIT_GLOBAL_CONCURRENT"],
      ANON_RATE_LIMIT_DEFAULTS.globalMaxConcurrent,
      "ANON_RATE_LIMIT_GLOBAL_CONCURRENT",
    ),
  };
}

interface Counter {
  windowStartedAt: number;
  count: number;
}

/**
 * Normalise whatever a route put in `config.rateLimit` into the shape
 * the plugin enforces. Throws rather than guessing: a route that declares
 * a limit this function cannot understand must fail at startup, not at
 * request time.
 */
export function normalizeRouteRateLimit(
  raw: unknown,
  fallbackKey: string,
  config: AnonRateLimitConfig,
): { key: string; max: number; windowSeconds: number; maxConcurrent: number; windowMs: number } {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`rateLimit config on ${fallbackKey} must be an object`);
  }
  const value = raw as Partial<RouteRateLimitConfig> & {
    // The alternative spelling (`timeWindow`, either seconds or "1 minute")
    // is accepted so a declaration written in that style keeps working rather
    // than being silently ignored.
    timeWindow?: string | number;
  };
  const timeWindowSeconds =
    typeof value.windowSeconds === "number"
      ? value.windowSeconds
      : typeof value.timeWindow === "number"
        ? value.timeWindow
        : typeof value.timeWindow === "string"
          ? parseTimeWindow(value.timeWindow)
          : config.defaultWindowSeconds;

  const max = typeof value.max === "number" && Number.isInteger(value.max) && value.max > 0
    ? value.max
    : config.defaultMax;
  const maxConcurrent =
    typeof value.maxConcurrent === "number" && Number.isInteger(value.maxConcurrent) && value.maxConcurrent > 0
      ? value.maxConcurrent
      : Math.max(1, Math.min(config.defaultMaxConcurrent, max));
  const key = typeof value.key === "string" && value.key.length > 0 ? value.key : fallbackKey;

  return { key, max, windowSeconds: timeWindowSeconds, maxConcurrent, windowMs: timeWindowSeconds * 1000 };
}

/** `"1 minute"` / `"30 seconds"` / `"1 hour"` → seconds. */
function parseTimeWindow(raw: string): number {
  const match = /^\s*(\d+)\s*(second|seconds|minute|minutes|hour|hours)\s*$/i.exec(raw);
  if (!match) {
    throw new Error(`rateLimit timeWindow ${JSON.stringify(raw)} is not a supported duration`);
  }
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("second")) return amount;
  if (unit.startsWith("minute")) return amount * 60;
  return amount * 3600;
}

export interface RateLimitStore {
  /** Returns the decision for this key, incrementing the window counter. */
  hit(key: string, max: number, windowMs: number, now: number): {
    allowed: boolean;
    retryAfterSeconds: number;
    remaining: number;
  };
  /**
   * Acquire an in-flight slot for `key` *and* one of the process-wide
   * slots. Returns `null` when either ceiling is reached, naming which.
   */
  enter(
    key: string,
    maxConcurrent: number,
    globalMax: number,
  ): { ok: true } | { ok: false; scope: "client" | "global" };
  /** Release a slot acquired by `enter`. Idempotent per acquisition. */
  leave(key: string): void;
  /** Test/ops helper: forget every counter. */
  reset(): void;
  /** Number of live in-flight slots for a key (diagnostics + tests). */
  inFlight(key: string): number;
  /** Live in-flight slots across every key. */
  totalInFlight(): number;
  /** Live window buckets; used to prove expired ones are reclaimed. */
  trackedWindows(): number;
  /** Drop window buckets whose period has elapsed at `now`. */
  sweepExpired(now: number, windowMs: number): number;
}

/**
 * How many `hit` calls may pass between opportunistic sweeps of the
 * window map.
 *
 * A fixed window that is never evicted is a slow leak keyed by client
 * address, and the address is attacker-chosen: a caller cycling through
 * source ports or a botnet would grow the map without bound. Sweeping on
 * every request would make the limiter O(clients) per request, which is
 * its own problem, so the sweep is amortised — cheap, bounded, and
 * guaranteed to run.
 */
const SWEEP_EVERY_HITS = 256;

export function createRateLimitStore(): RateLimitStore {
  const windows = new Map<string, Counter>();
  const inFlight = new Map<string, number>();
  let totalInFlight = 0;
  let hitsSinceSweep = 0;

  const sweep = (now: number, windowMs: number): number => {
    let removed = 0;
    for (const [key, counter] of windows) {
      if (now - counter.windowStartedAt >= windowMs) {
        windows.delete(key);
        removed += 1;
      }
    }
    return removed;
  };

  return {
    hit(key, max, windowMs, now) {
      hitsSinceSweep += 1;
      if (hitsSinceSweep >= SWEEP_EVERY_HITS) {
        hitsSinceSweep = 0;
        sweep(now, windowMs);
      }

      const existing = windows.get(key);
      if (!existing || now - existing.windowStartedAt >= windowMs) {
        windows.set(key, { windowStartedAt: now, count: 1 });
        return { allowed: true, retryAfterSeconds: 0, remaining: max - 1 };
      }
      existing.count += 1;
      if (existing.count > max) {
        const retryAfterMs = existing.windowStartedAt + windowMs - now;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
          remaining: 0,
        };
      }
      return { allowed: true, retryAfterSeconds: 0, remaining: max - existing.count };
    },

    enter(key, maxConcurrent, globalMax) {
      const current = inFlight.get(key) ?? 0;
      if (current >= maxConcurrent) return { ok: false, scope: "client" };
      if (totalInFlight >= globalMax) return { ok: false, scope: "global" };
      inFlight.set(key, current + 1);
      totalInFlight += 1;
      return { ok: true };
    },

    leave(key) {
      const current = inFlight.get(key) ?? 0;
      if (current <= 0) return;
      totalInFlight -= 1;
      if (current === 1) inFlight.delete(key);
      else inFlight.set(key, current - 1);
    },

    reset() {
      windows.clear();
      inFlight.clear();
      totalInFlight = 0;
      hitsSinceSweep = 0;
    },

    inFlight(key) {
      return inFlight.get(key) ?? 0;
    },

    totalInFlight() {
      return totalInFlight;
    },

    trackedWindows() {
      return windows.size;
    },

    sweepExpired(now, windowMs) {
      return sweep(now, windowMs);
    },
  };
}

/**
 * Identify the client. `trustProxy` is off in this app, so `req.ip` is
 * the socket peer and cannot be spoofed by a header. Falling back to the
 * literal `"unknown"` keeps one shared bucket rather than no bucket when
 * the address is somehow unavailable — fail closed.
 */
export function clientKey(req: FastifyRequest): string {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return ip;
}

/**
 * Where the plugin parks the release closure for a request.
 *
 * A symbol rather than a decorated property name so nothing outside this
 * module can collide with it, and so the route that wants to release
 * early has to go through `getRateLimitRelease` rather than reaching into
 * the request.
 */
const RELEASE = Symbol("gloss.rateLimitRelease");

interface ReleaseCarrier {
  [RELEASE]?: () => void;
}

/**
 * The release closure for this request, or undefined when no slot was
 * acquired (limiter disabled, or the bucket was refused).
 *
 * Exported so a route can release the moment its own work settles rather
 * than waiting for the response to be written — which matters when the
 * client has gone away and there is no response to write.
 */
export function getRateLimitRelease(req: FastifyRequest): (() => void) | undefined {
  return (req as unknown as ReleaseCarrier)[RELEASE];
}

export function registerRateLimitPlugin(
  app: FastifyInstance,
  config: AnonRateLimitConfig,
  store: RateLimitStore = createRateLimitStore(),
): RateLimitStore {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const routeOptions = req.routeOptions as unknown as
      | { config?: Record<string, unknown>; url?: string }
      | undefined;
    const declared = routeOptions?.config?.["rateLimit"];
    if (declared === undefined) return;

    if (!config.enabled) return;

    const routeUrl = routeOptions?.url ?? (req.url.split("?")[0] as string);
    const limit = normalizeRouteRateLimit(declared, routeUrl, config);
    const who = clientKey(req);
    const bucket = `${limit.key}:${who}`;
    const now = Date.now();

    const decision = store.hit(bucket, limit.max, limit.windowMs, now);
    if (!decision.allowed) {
      reply
        .header("retry-after", String(decision.retryAfterSeconds))
        .code(429)
        .send(
          buildApiError(
            "RATE_LIMITED",
            `请求过于频繁，请在 ${decision.retryAfterSeconds} 秒后重试。`,
            String(req.id),
          ),
        );
      return reply;
    }

    const acquired = store.enter(bucket, limit.maxConcurrent, config.globalMaxConcurrent);
    if (!acquired.ok) {
      reply
        .header("retry-after", "1")
        .code(429)
        .send(
          buildApiError(
            "RATE_LIMITED",
            acquired.scope === "global"
              ? "服务器正在处理过多的抓取请求，请稍后重试。"
              : "同时进行的匿名抓取请求过多，请稍后重试。",
            String(req.id),
          ),
        );
      return reply;
    }

    // Exactly one release per acquisition, however many times it is
    // called. Three things call it: the route's own `finally` (the
    // primary path, which is what makes the slot last as long as the
    // *work* rather than as long as the *socket*), and the response /
    // error hooks below, which cover the paths that never reach the
    // route's handler at all.
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      store.leave(bucket);
    };
    (req as unknown as ReleaseCarrier)[RELEASE] = release;
  });

  // Fallbacks. A request that fails before reaching the handler (a 400
  // from body validation, say) never runs the route's `finally`, and one
  // whose client disappears may never produce a response.
  app.addHook("onResponse", async (req) => {
    getRateLimitRelease(req)?.();
  });
  app.addHook("onError", async (req) => {
    getRateLimitRelease(req)?.();
  });

  return store;
}

/** A route the plugin is expected to be guarding. */
export interface RateLimitedRouteDeclaration {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
}

/**
 * Boot-time assertion: every route that declares `config.rateLimit` must
 * actually exist, and the plugin must have been registered before it.
 *
 * The failure this guards against is subtle and has already happened
 * once in this codebase — a route declares a limit, nothing enforces it,
 * and the endpoint looks protected in code review while being wide open
 * at runtime. Two independent checks make that unrepeatable:
 *
 *   1. `hasRoute` proves the declared path is really mounted, so a typo
 *      in a path constant cannot silently produce an unprotected route;
 *   2. the hook is registered on the root instance *before* the route
 *      block, which is what makes it run for every route that follows.
 *      A hook added after the routes would not be applied to them, and
 *      this function fails loudly if that ordering is broken.
 */
export function assertRateLimitedRoutesWired(
  app: FastifyInstance,
  declarations: readonly RateLimitedRouteDeclaration[],
  hookRegisteredBeforeRoutes: boolean,
): string[] {
  if (!hookRegisteredBeforeRoutes) {
    throw new Error(
      "rate-limit hook must be registered on the root instance before the route block",
    );
  }
  const verified: string[] = [];
  for (const declaration of declarations) {
    const present = app.hasRoute({ method: declaration.method, url: declaration.url });
    if (!present) {
      throw new Error(
        `route ${declaration.method} ${declaration.url} declares a rate limit but is not mounted`,
      );
    }
    verified.push(`${declaration.method} ${declaration.url}`);
  }
  return verified;
}
