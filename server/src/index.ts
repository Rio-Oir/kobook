// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Server entrypoint.
 *
 * Phase 2 starts the Fastify app with a real mail pipeline (the dev outbox),
 * bootstraps the administrator whitelist, and hands everything to the
 * `buildApp` factory. The factory is what the acceptance tests reuse, so the
 * server only owns startup concerns.
 *
 * This line carries no billing host. Payment, entitlements and the merchant
 * configuration live in the value-added line, which composes them around the
 * same `buildApp`; the seam is that `buildApp` takes no billing option at all
 * here, so "this deployment cannot take money" is a property of the route
 * table rather than of a flag inside a handler.
 *
 * ## Why the assembly is exported
 *
 * `buildFullServer` is what the process is made of; `main` is only what a
 * *terminal* does with it. The release deployment
 * (`apps/reader-release/server.ts`) needs the same environment loading, the
 * same Prisma client, the same Better Auth instance and the same admin
 * bootstrap, and then needs to add one thing on top: serving the built shell
 * from `/reader/`. Reassembling all of that there would mean two copies of the
 * startup path — and the failure mode of two copies is that one of them gets
 * the mail transport or the secret check and the other does not.
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, warnIfVirtualSecret } from "./app.js";
import {
  createAuth,
  resolveTrustedOrigins,
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  RESET_TOKEN_EXPIRES_IN_SECONDS,
  SIGN_IN_OTP_EXPIRES_IN_SECONDS,
} from "./auth.js";
import { createPrismaClient } from "./db.js";
import { loadEnv } from "./env.js";
import type { ShellOptions } from "./lib/static-shell.js";
import { syncAdminEmails } from "./lib/admin-bootstrap.js";
import { createMailer } from "./lib/mail/mailer.js";
import { resolveMail } from "./lib/mail/resolve.js";
import { createPhoneRuntime } from "./lib/phone/service.js";
import {
  loadAuthRateLimitConfig,
  toBetterAuthRateLimit,
} from "./lib/rate-limit.js";

export interface FullServer {
  app: FastifyInstance;
  /** The loaded environment, so a caller knows the host and port to listen on. */
  env: ReturnType<typeof loadEnv>;
  /**
   * Close the app and the database pool, once. Idempotent: a second signal
   * during shutdown is ignored rather than racing the first.
   */
  shutdown: (signal: string) => Promise<void>;
}

/** Everything the process is, before anything decides to listen. */
export async function buildFullServer(
  options: { shell?: ShellOptions; trustLoopbackProxy?: boolean } = {},
): Promise<FullServer> {
  const env = loadEnv();

  // Delivery is resolved from the environment: the in-memory outbox in
  // development/test, a real SMTP connection when configured (mandatory in
  // production). `resolveMail` cannot return the outbox in production —
  // `loadMailSettings` already refused that combination — so an unconfigured
  // production deployment still fails at boot, with the "cannot verify anyone"
  // gate now pointing at SMTP_* instead of at a missing provider.
  const mail = resolveMail(env.mail, env.nodeEnv);
  const mailer = createMailer({
    transport: mail.transport,
    verificationExpiresInSeconds: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
    resetExpiresInSeconds: RESET_TOKEN_EXPIRES_IN_SECONDS,
    signInOtpExpiresInSeconds: SIGN_IN_OTP_EXPIRES_IN_SECONDS,
  });

  const rateLimit = toBetterAuthRateLimit(loadAuthRateLimitConfig(env.nodeEnv));
  const prisma = createPrismaClient(env.databaseUrl);

  // Phone verification: a durable challenge table plus the outbox or Aliyun
  // transport, decided once from the environment. The endpoints live on the
  // auth instance (see `lib/phone/plugin.ts`), so the service is handed to
  // `createAuth` rather than mounted as a Fastify route.
  const phone = createPhoneRuntime({
    settings: env.phone,
    nodeEnv: env.nodeEnv,
    prisma,
  });

  const auth = createAuth({
    prisma,
    secret: env.authSecret,
    baseURL: env.authBaseUrl,
    nodeEnv: env.nodeEnv,
    trustedOrigins: resolveTrustedOrigins(env.authBaseUrl, env.trustedOriginsRaw),
    mail: mailer,
    phone: phone.service,
    rateLimit,
  });

  const adminSync = await syncAdminEmails(prisma, env.adminEmails);
  if (adminSync.granted.length > 0) {
    process.stderr.write(
      `ADMIN_EMAILS bootstrap granted admin to: ${adminSync.granted
        .map((entry) => entry.email)
        .join(", ")}\n`,
    );
  }
  if (adminSync.unknown.length > 0) {
    process.stderr.write(
      `ADMIN_EMAILS contains addresses with no account (left unchanged): ${adminSync.unknown.join(", ")}\n`,
    );
  }

  const { app } = await buildApp({
    prisma,
    auth,
    nodeEnv: env.nodeEnv,
    logLevel: env.logLevel,
    prettyLogs: env.nodeEnv === "development",
    // The dev inbox route is mounted only when a transport actually keeps
    // messages in-process. Under SMTP the links really leave the host, so
    // there is no inbox to expose (and none of these links may be readable
    // back from an endpoint).
    mail: mail.outbox ?? undefined,
    sms: phone.outbox,
    ...(options.shell ? { shell: options.shell } : {}),
    ...(options.trustLoopbackProxy ? { trustLoopbackProxy: true } : {}),
  });
  if (mail.outbox) {
    mail.outbox.attachLogger(app.log);
  } else {
    mail.transport.attachLogger?.(app.log);
  }
  phone.attachLogger(app.log);

  warnIfVirtualSecret(app, env.usingVirtualSecret);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      // Drain first, then release mail: an in-flight sign-up may still be
      // sending its verification message while SIGTERM arrives, and closing
      // the pooled SMTP socket underneath it would turn a graceful stop into
      // a failed request. `app.close()` waits for in-flight requests.
      await app.close();
      mail.transport.close?.();
      phone.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error("shutdown failed");
      process.exit(1);
    }
  };

  return { app, env, shutdown };
}

async function main(): Promise<void> {
  const { app, env, shutdown } = await buildFullServer();

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: env.host, port: env.port });
  app.log.info(
    { host: env.host, port: env.port, baseUrl: env.authBaseUrl },
    "gloss server listening",
  );
}

// Only when invoked as a script: the release deployment imports
// `buildFullServer` from here, and starting a second listener as an import
// side effect would be a trap.
const isEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js|mjs)$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.(ts|js|mjs)$/, "");

if (isEntry) {
  main().catch((err: unknown) => {
    // Startup failures print the message only; the environment loader is
    // written so that its messages never include credentials.
    process.stderr.write(
      "gloss server failed to start; check local configuration and dependency readiness.\n",
    );
    if (err instanceof Error) {
      process.stderr.write(`${err.message}\n`);
    }
    process.exit(1);
  });
}
