// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fastify application assembly.
 *
 * `buildApp` is deliberately a factory: the acceptance tests construct an app
 * per test against the dedicated test database, and the server entrypoint
 * constructs one for `npm run dev`. Nothing here reads global state, so two
 * apps can coexist in one process.
 *
 * Phase 2 adds:
 *   - the verified-session AI-entry route, gated by a new pre-handler;
 *   - the minimum admin surface (list / role / disable / enable / audit);
 *   - a development mail inbox, mounted only outside production;
 *   - `X-Robots-Tag: noindex` on every `/api/*` response so the API cannot
 *     be indexed even if a future URL redesign exposes it (the bridge and the
 *     not-found handler both inherit this).
 */

import Fastify, { type FastifyInstance } from "fastify";
import type { ApiErrorCode } from "../../shared/contracts/index.js";
import { buildApiError, httpStatusForCode, API_PREFIX } from "../../shared/contracts/index.js";
import type { AppPrisma } from "./db.js";
import type { Auth } from "./auth.js";
import type { NodeEnv } from "./env.js";
import { VIRTUAL_DEV_SECRET } from "./env.js";
import { buildLoggerOptions } from "./lib/logger.js";
import type { OutboxTransport } from "./lib/mail/outbox.js";
import type { SmsOutboxTransport } from "./lib/phone/outbox.js";
import { StreamRegistry } from "./lib/stream-registry.js";
import { registerAuthBridge } from "./plugins/auth-bridge.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerArticleRoutes } from "./routes/articles.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { registerHighlightRoutes } from "./routes/highlights.js";
import { registerDevMailRoutes } from "./routes/dev-mail.js";
import { registerDevSmsRoutes } from "./routes/dev-sms.js";
import { registerSampleRoutes, MAX_PARSE_INPUT_BYTES } from "./routes/sample.js";
import { registerStreamRoutes } from "./routes/sample-stream.js";
import { registerAnonymousRoutes, ANONYMOUS_RATE_LIMITED_ROUTES } from "./routes/anonymous.js";
import { registerShellRoutes, type ShellOptions } from "./lib/static-shell.js";
import {
  assertRateLimitedRoutesWired,
  loadAnonRateLimitConfig,
  registerRateLimitPlugin,
  type AnonRateLimitConfig,
  type RateLimitStore,
} from "./lib/rate-limit-store.js";

export const SERVICE_NAME = "gloss-server";
export const SERVICE_VERSION = "0.3.0-phase3";

export interface BuildAppOptions {
  prisma: AppPrisma;
  auth: Auth;
  nodeEnv: NodeEnv;
  logLevel?: string;
  /** Pretty logging is a local convenience only. */
  prettyLogs?: boolean;
  /** Bounded history for the mock stream sample. */
  streamRegistry?: StreamRegistry;
  /**
   * In-memory mail outbox. When provided and `nodeEnv` is not "production",
   * `registerDevMailRoutes` is mounted so tests and local development can
   * read the verification / reset links.
   */
  mail?: OutboxTransport;
  /**
   * In-memory SMS outbox. When provided and `nodeEnv` is not "production",
   * `registerDevSmsRoutes` is mounted so tests and local development can read
   * the verification code that was "sent". Absent under the Aliyun transport,
   * where the message really leaves the host.
   */
  sms?: SmsOutboxTransport;
  /**
   * Anonymous-route limiter configuration. Defaults to the environment
   * (on in production, off elsewhere). Tests that must observe a real 429
   * pass an explicit config here or set `ANON_RATE_LIMIT_ENABLED=1` in the
   * child process environment.
   */
  rateLimit?: AnonRateLimitConfig;
  /** Shared limiter state, so a caller can inspect or reset it. */
  rateLimitStore?: RateLimitStore;
  /**
   * Serve the built reader shell from this process, so one deployment is both
   * the API and the app that calls it. Absent in the acceptance suites and in
   * local development, where Vite serves `index.html` instead — see
   * `lib/static-shell.ts` for why it is an option rather than a default.
   */
  shell?: ShellOptions;
  /**
   * Trust `X-Forwarded-For`, but only when the connection itself came from
   * loopback.
   *
   * Off by default, and the default is the safe one: a caller-supplied header
   * must not be able to name its own address, or the rate limiter's key — and
   * therefore its ceiling — is chosen by the caller. It exists for the one
   * deployment shape that needs it, a reverse proxy on the same host that
   * overwrites the header rather than appending to it, and it is restricted to
   * loopback so that turning it on cannot become "trust anything".
   */
  trustLoopbackProxy?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  streamRegistry: StreamRegistry;
  /** The limiter's counters, exposed so tests can assert on real state. */
  rateLimitStore: RateLimitStore;
  /** Route paths the boot assertion proved are actually rate limited. */
  rateLimitedRoutes: string[];
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const streamRegistry = options.streamRegistry ?? new StreamRegistry();

  const app = Fastify({
    logger: buildLoggerOptions(options.logLevel ?? "info", options.prettyLogs ?? false),
    // Origin comes from the configured Better Auth URL; a caller-supplied proxy
    // header is trusted only when `trustLoopbackProxy` says so, and then only
    // from loopback.
    trustProxy: options.trustLoopbackProxy === true ? ["127.0.0.1", "::1"] : false,
    bodyLimit: MAX_PARSE_INPUT_BYTES + 1024 * 1024,
    // Fastify's default AJV configuration sets `removeAdditional: true`,
    // which means `additionalProperties: false` in a route schema
    // *strips* unknown keys instead of rejecting them. Verified in
    // `tests/unit/route-body-strictness.test.ts`. Turning it off makes
    // every route's declared body shape enforceable: an unexpected field
    // is a 400 the caller can see, not a silently discarded value that
    // makes the request look like it was honoured.
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  // ── Uniform error contract ──────────────────────────────────────────────
  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .send(buildApiError("NOT_FOUND", "No such endpoint.", String(req.id)));
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    const err = error as { statusCode?: number; message?: string; code?: string };
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    const message = typeof err.message === "string" ? err.message : "Request failed.";

    // Routes may attach a more specific error code on the thrown error
    // (e.g. EMPTY_ARTICLE for a 422 that is genuinely "your input was
    // syntactically valid but produced no content"). Honour it when it
    // is one of the shared error codes; otherwise fall through to the
    // status-derived default.
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
          : status === 401
            ? "UNAUTHORIZED"
            : status === 403
              ? "FORBIDDEN"
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

    // Validation failures are caused by the client, so their message is
    // useful. Anything 5xx is logged in full but reported generically, so
    // SQL/driver text and stack traces never reach the client.
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

  // ── Headers ─────────────────────────────────────────────────────────────
  // Mark every API response as `noindex` so the surface can never be indexed,
  // even by a search engine following a leaked link. The SPA is served by
  // Caddy rather than Fastify, so this is a defence in depth that does not
  // affect the user-facing pages. Per-route page-level noindex waits on the
  // phase-3 decision about whether to ship a public article surface.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith(API_PREFIX)) {
      reply.header("x-robots-tag", "noindex");
    }
    return payload;
  });

  // ── Routes ──────────────────────────────────────────────────────────────
  //
  // The limiter's hook is registered on the *root* instance before the
  // route block below, because a Fastify hook added after a route is not
  // applied to it. `assertRateLimitedRoutesWired` at the bottom of this
  // function fails the boot if that ordering is ever broken.
  const rateLimitConfig =
    options.rateLimit ?? loadAnonRateLimitConfig(options.nodeEnv);
  const rateLimitStore = registerRateLimitPlugin(app, rateLimitConfig, options.rateLimitStore);

  await app.register(async (instance) => {
    await registerAuthBridge(instance, options.auth);
    await registerHealthRoutes(instance, {
      prisma: options.prisma,
      serviceName: SERVICE_NAME,
      version: SERVICE_VERSION,
    });
    registerAnonymousRoutes(instance);
    await registerMeRoutes(instance, options.auth);
    await registerAiRoutes(instance, options.auth);
    await registerAdminRoutes(instance, options.prisma, options.auth);
    await registerArticleRoutes(instance, options.prisma, options.auth);
    await registerNoteRoutes(instance, options.prisma, options.auth);
    await registerHighlightRoutes(instance, options.prisma, options.auth);
    if (options.mail && options.nodeEnv !== "production") {
      registerDevMailRoutes(instance, options.mail);
    }
    if (options.sms && options.nodeEnv !== "production") {
      registerDevSmsRoutes(instance, options.sms);
    }
    await registerSampleRoutes(instance, options.auth);
    await registerStreamRoutes(instance, options.auth, {
      registry: streamRegistry,
    });
  });

  // ── The built shell, when this process is also the web server ───────────
  // Registered on the root instance and before `ready()`, like every other
  // route. It is not inside the block above because that block is the API
  // surface; the shell is what calls it.
  if (options.shell) registerShellRoutes(app, options.shell);

  // ── Lifecycle ───────────────────────────────────────────────────────────
  // Registered *before* `ready()`: Fastify refuses `addHook` once the
  // instance has started listening, and the failure is a boot crash
  // rather than a silently missing hook.
  app.addHook("onClose", async () => {
    // A process that dies mid-stream leaves jobs in `running`; they are
    // reported as `interrupted` rather than looking alive forever. This is
    // the in-memory analogue of the phase 4 restart sweep — phase 4 will do
    // it against the durable job table instead.
    const affected = streamRegistry.markAllRunningInterrupted("process_restart");
    if (affected.length > 0) {
      app.log.warn({ count: affected.length }, "marked running stream jobs as interrupted");
    }
  });

  await app.ready();

  // Boot assertion: every route that declares `config.rateLimit` must
  // exist and must be covered by the hook registered above. A route that
  // declares a limit nobody enforces is worse than no declaration,
  // because it reads as protection during review.
  const rateLimitedRoutes = assertRateLimitedRoutesWired(
    app,
    ANONYMOUS_RATE_LIMITED_ROUTES,
    true,
  );

  return { app, streamRegistry, rateLimitStore, rateLimitedRoutes };
}

/** Warn (once) when the development placeholder secret is in use. */
export function warnIfVirtualSecret(app: FastifyInstance, secretIsVirtual: boolean): void {
  if (secretIsVirtual) {
    app.log.warn(
      "Using the built-in virtual development auth secret " +
        `(${VIRTUAL_DEV_SECRET.length} chars). This is not a production credential.`,
    );
  }
}
