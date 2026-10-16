// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Service entry: the anonymous extraction API plus the built shell.
 *
 * ## What this is
 *
 * A *thin* Fastify service that mounts exactly two things:
 *
 *   - `server/src/routes/anonymous.ts` — the controlled extractor, unchanged.
 *     It is the same `importFromUrl` + `parseContent` pipeline the rest of the
 *     server uses, with the same SSRF/DNS/TLS/redirect/size/timeout guards.
 *   - the rate limiter from `server/src/lib/rate-limit-store.ts`, plus the
 *     same boot assertion that proves the limiter is actually wired to the
 *     route that declares a limit.
 *
 * The functional services a deployed product would add — accounts, a
 * database, cloud sync, billing, server-side model access — are deliberately
 * **absent**, not disabled by a flag. There is no database driver, no ORM, no
 * auth instance and no session handling in this process, so "this deployment
 * cannot reach account or cloud data" is a property of what is mounted rather
 * than of a conditional somewhere. `shared/contracts/api.ts` is the whole
 * route table, and it has two entries.
 *
 * It also serves the built shell from `dist/` under `/reader/`, so a single
 * process is a complete deployment. Static serving is restricted to a fixed
 * extension allowlist and a resolved-path containment check.
 *
 * ## Why the error mapping is restated
 *
 * The shared error envelope and its status mapping live in
 * `shared/contracts/errors.ts`, but applying them needs a route-level error
 * handler that every route here can be reached through. Rather than introduce
 * a database client this process must not have in order to reuse a larger
 * app factory, the handful of lines that map a thrown error to the envelope
 * are restated. They are pinned by
 * `apps/reader-release/tests/server-inject.mjs`, which asserts the envelope
 * shape and that 5xx messages are not leaked.
 *
 * Run (from the repository root; `tsx` resolves the `.js` specifiers the
 * server sources use to their `.ts` files):
 *   node --import tsx apps/reader-release/server.ts
 */

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_PREFIX,
  ROUTES,
  buildApiError,
  httpStatusForCode,
  type ApiErrorCode,
} from "../../shared/contracts/index.js";
import {
  ANONYMOUS_RATE_LIMITED_ROUTES,
  registerAnonymousRoutes,
} from "../../server/src/routes/anonymous.js";
import {
  assertRateLimitedRoutesWired,
  loadAnonRateLimitConfig,
  registerRateLimitPlugin,
  type AnonRateLimitConfig,
  type RateLimitStore,
} from "../../server/src/lib/rate-limit-store.js";
import { BASE_CSP, DEPLOY_BASE } from "./csp.js";

export const SERVICE_NAME = "kobook";
export const SERVICE_VERSION = "0.1.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_ROOT = path.join(HERE, "dist");

/** Whole-request body cap. The extract route's own schema caps `content` too. */
const BODY_LIMIT_BYTES = 3 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ReaderServiceOptions {
  nodeEnv?: string;
  logLevel?: string;
  rateLimit?: AnonRateLimitConfig;
  rateLimitStore?: RateLimitStore;
  /** Serve the built shell from disk. Off for an API-only probe. */
  serveStatic?: boolean;
  staticRoot?: string;
  /**
   * Trust `X-Forwarded-For` from a loopback peer.
   *
   * Off by default, because a caller-supplied header must not be able to name
   * its own rate-limit bucket. Turn it on only when a reverse proxy on the
   * same host is known to overwrite the header before it reaches this process.
   */
  trustLoopbackProxy?: boolean;
}

export interface BuiltReaderService {
  app: FastifyInstance;
  rateLimitStore: RateLimitStore;
  rateLimitedRoutes: string[];
}

/**
 * Resolve a request path to a file inside the static root.
 *
 * Returns `null` for anything that escapes the root or is not on the
 * extension allowlist — a containment check that compares resolved paths
 * (so `..`, encoded dots and absolute paths all fail the same way) rather
 * than trying to filter suspicious-looking input.
 */
async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
): Promise<{ file: string; ext: string } | null> {
  if (!pathname.startsWith(DEPLOY_BASE)) return null;
  const rest = pathname.slice(DEPLOY_BASE.length);
  if (rest.includes("\0")) return null;

  const rootResolved = path.resolve(staticRoot);
  const candidate = rest.length === 0 ? "index.html" : decodeURIComponent(rest);
  const resolved = path.resolve(rootResolved, candidate);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;

  const ext = path.extname(resolved);
  if (!Object.prototype.hasOwnProperty.call(CONTENT_TYPES, ext)) return null;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  return { file: resolved, ext };
}

export async function buildReaderService(
  options: ReaderServiceOptions = {},
): Promise<BuiltReaderService> {
  const nodeEnv = options.nodeEnv ?? process.env["NODE_ENV"] ?? "production";
  const serveStatic = options.serveStatic ?? true;
  const staticRoot = options.staticRoot ?? DEFAULT_STATIC_ROOT;

  const app = Fastify({
    logger: { level: options.logLevel ?? process.env["SERVER_LOG_LEVEL"] ?? "info" },
    // Origin comes from configured deployment URLs; caller-supplied proxy
    // headers must not be trusted (same decision as the full app).
    trustProxy:
      options.trustLoopbackProxy === true || process.env["TRUST_LOOPBACK_PROXY"] === "1"
        ? ["127.0.0.1", "::1"]
        : false,
    bodyLimit: BODY_LIMIT_BYTES,
    ajv: {
      customOptions: {
        // Fastify's default sets `removeAdditional: true`, which turns an
        // `additionalProperties: false` schema into a silent strip. Keeping
        // it off means a client that tries to name a proxy URL on the
        // extract route gets a 400 it can see.
        removeAdditional: false,
      },
    },
  });

  // ── Uniform error contract (mirrors server/src/app.ts) ──────────────────
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(buildApiError("NOT_FOUND", "No such endpoint.", String(req.id)));
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as { statusCode?: number; message?: string; code?: string };
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    const message = typeof err.message === "string" ? err.message : "Request failed.";

    const KNOWN_CODES = new Set<ApiErrorCode>([
      "VALIDATION_FAILED",
      "EMPTY_ARTICLE",
      "UNAUTHORIZED",
      "EMAIL_NOT_VERIFIED",
      "ACCOUNT_DISABLED",
      "FORBIDDEN",
      "NOT_FOUND",
      "UNSUPPORTED_INPUT",
      "RATE_LIMITED",
      "UPSTREAM_FAILED",
      "CONFLICT",
      "NOT_IMPLEMENTED",
      "INTERNAL",
    ]);

    const code: ApiErrorCode =
      err.code && KNOWN_CODES.has(err.code as ApiErrorCode)
        ? (err.code as ApiErrorCode)
        : status === 400
          ? "VALIDATION_FAILED"
          : status === 404
            ? "NOT_FOUND"
            : status === 413
              ? "VALIDATION_FAILED"
              : status === 415
                ? "UNSUPPORTED_INPUT"
                : status === 429
                  ? "RATE_LIMITED"
                  : status >= 500
                    ? "INTERNAL"
                    : "VALIDATION_FAILED";

    if (status >= 500) {
      req.log.error({ requestId: req.id }, "request failed (internal details suppressed)");
      reply
        .code(status)
        .send(buildApiError("INTERNAL", "The server could not complete the request.", String(req.id)));
      return;
    }

    reply
      .code(status >= 400 && status < 600 ? status : httpStatusForCode(code))
      .send(buildApiError(code, message, String(req.id)));
  });

  // API responses are never indexable and never cached.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith(API_PREFIX)) {
      reply.header("x-robots-tag", "noindex");
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  // ── Limiter, then routes ────────────────────────────────────────────────
  // The hook must be on the root instance *before* the route block; a hook
  // added afterwards does not apply to routes registered earlier. The boot
  // assertion below fails loudly if that ordering ever breaks.
  const rateLimitConfig = options.rateLimit ?? loadAnonRateLimitConfig(nodeEnv);
  const rateLimitStore = registerRateLimitPlugin(app, rateLimitConfig, options.rateLimitStore);

  await app.register(async (instance) => {
    instance.get(ROUTES.healthLive, async () => ({
      status: "ok" as const,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    }));
    // No `/health/ready`: readiness is a database question, and this process
    // has no database. Answering "ready" without one would be a lie.
    registerAnonymousRoutes(instance);
  });

  const rateLimitedRoutes = assertRateLimitedRoutesWired(app, ANONYMOUS_RATE_LIMITED_ROUTES, true);

  if (serveStatic) {
    // `/reader` (no trailing slash) must not be served as a file relative to
    // the root, or every relative asset reference in the shell would resolve
    // one level too high.
    app.get("/reader", async (_req, reply) => reply.redirect(`${DEPLOY_BASE}`, 308));

    app.get(`${DEPLOY_BASE}*`, async (req, reply) => {
      const url = new URL(req.url, "http://localhost");
      const resolved = await resolveStaticFile(staticRoot, url.pathname);
      if (!resolved) {
        // SPA fallback: a client-side hash route never reaches the server,
        // but a hand-typed `/reader/somewhere` should render the app rather
        // than a 404 with an API envelope.
        const shell = await resolveStaticFile(staticRoot, `${DEPLOY_BASE}index.html`);
        if (!shell) return reply.code(404).send("Not found");
        return sendFile(reply, shell.file, shell.ext, true);
      }
      const isShell = resolved.ext === ".html";
      return sendFile(reply, resolved.file, resolved.ext, isShell);
    });
  }

  await app.ready();
  return { app, rateLimitStore, rateLimitedRoutes };
}

function sendFile(reply: FastifyReply, file: string, ext: string, isShell: boolean): FastifyReply {
  reply.header("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  if (isShell) {
    // The shell must never be cached: it names the hashed assets, and a
    // stale shell pointing at deleted hashes is a blank page.
    reply.header("cache-control", "no-cache");
    reply.header("content-security-policy", BASE_CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  } else {
    reply.header("cache-control", file.endsWith("sw.js") ? "no-cache" : "public, max-age=31536000, immutable");
  }
  return reply.send(createReadStream(file));
}

// ── CLI ──────────────────────────────────────────────────────────────────

const isEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js|mjs)$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.(ts|js|mjs)$/, "");

if (isEntry) {
  // `SERVICE_PORT` first; `PORT` is accepted as the conventional fallback for
  // a host that supplies one. See `.env.example`.
  const port = Number(process.env["SERVICE_PORT"] ?? process.env["PORT"] ?? 8790);
  const host = process.env["SERVER_HOST"] ?? "127.0.0.1";
  const { app, rateLimitedRoutes } = await buildReaderService();
  try {
    await app.listen({ port, host });
    app.log.info(
      { service: SERVICE_NAME, rateLimitedRoutes },
      `kobook service on http://${host}:${port}${DEPLOY_BASE}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
