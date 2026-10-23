// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Server configuration.
 *
 * Rules enforced here (phase 2):
 *  - binds to loopback and refuses anything else. There is no opt-out flag:
 *    public deployment is the deployment phase's job, and a flag that silently
 *    widens the bind address is exactly the kind of switch nobody remembers
 *    setting. (Phase 1's header claimed an `ALLOW_NON_LOOPBACK` override that
 *    no code ever read; the claim is gone rather than left as documentation
 *    for behaviour that does not exist.)
 *  - the auth secret must be supplied in production, but a clearly-labelled
 *    virtual development secret is used locally so the samples are runnable
 *    without any real credential on disk;
 *  - rate-limit values and the administrator whitelist are parsed strictly, so
 *    a typo fails startup instead of quietly weakening a control;
 *  - no value read here is ever logged.
 */

import process from "node:process";
import { parseAdminEmails } from "./lib/admin-bootstrap.js";
import { loadMailSettings, type MailSettings } from "./lib/mail/config.js";
import { loadPhoneSettings, type PhoneSettings } from "./lib/phone/config.js";

export type NodeEnv = "development" | "test" | "production";

export interface ServerEnv {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  databaseUrl: string;
  authSecret: string;
  /** Public origin the auth handler issues cookies for. */
  authBaseUrl: string;
  logLevel: string;
  /** True when authSecret is the built-in development placeholder. */
  usingVirtualSecret: boolean;
  /**
   * Extra origins allowed to call the auth endpoints, raw from the
   * environment. Resolved (and validated) by `auth.ts`, which is where the
   * loopback rule lives.
   */
  trustedOriginsRaw: string;
  /**
   * Administrator whitelist. Granted on startup, idempotently; never revokes
   * and never creates accounts — see `lib/admin-bootstrap.ts`.
   */
  adminEmails: string[];
  /**
   * Mail delivery mode and, for "smtp", the validated transport settings.
   * Parsed strictly by `lib/mail/config.ts`: production refuses the in-memory
   * outbox, cleartext SMTP and an unauthenticated relay.
   */
  mail: MailSettings;
  /**
   * Phone verification delivery and its HMAC key. Parsed strictly by
   * `lib/phone/config.ts`: production refuses the in-process outbox and the
   * development secret, and a half-configured Aliyun account is a boot error.
   */
  phone: PhoneSettings;
  /** Jina API key. Empty string means "no key configured" and the URL
   *  importer falls back to direct Readability fetching. */
  jinaApiKey: string;
  /** Override for the Jina base URL. Empty string means the production
   *  `https://r.jina.ai` endpoint. The integration test points this at
   *  a local fake so it can assert the Jina path without a real key. */
  jinaBaseUrl: string;
}

/**
 * Virtual development secret. This is intentionally obvious and intentionally
 * not usable in production — `loadEnv` refuses to start when NODE_ENV is
 * "production" and no real secret is configured.
 */
export const VIRTUAL_DEV_SECRET =
  "virtual-development-secret-not-for-production-0000000000000000";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

let envFileLoaded = false;

/** Best-effort .env load; absence is not an error. */
export function loadEnvFileOnce(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;

  // Tests must be hermetic. A developer's `.env` may point mail at a real
  // SMTP account; letting the integration suites read it
  // would make them send real mail and would make the in-memory outbox
  // assertions depend on whatever is on disk. The test harness passes every
  // value it needs explicitly, and `NODE_ENV=test` is set before this runs.
  if ((process.env["NODE_ENV"] ?? "").toLowerCase() === "test") return;

  try {
    process.loadEnvFile();
  } catch {
    // No .env present — every value then comes from the real environment.
  }
}

function readNodeEnv(): NodeEnv {
  const raw = (process.env["NODE_ENV"] ?? "development").toLowerCase();
  if (raw === "production" || raw === "test") return raw;
  return "development";
}

export function loadEnv(): ServerEnv {
  loadEnvFileOnce();

  const nodeEnv = readNodeEnv();

  const host = process.env["SERVER_HOST"]?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind to non-loopback host "${host}". ` +
        "This build is a local development service; public deployment is not configured.",
    );
  }

  const portRaw = process.env["SERVER_PORT"]?.trim() || "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SERVER_PORT is not a valid port: ${JSON.stringify(portRaw)}`);
  }

  const databaseUrl = process.env["DATABASE_URL"]?.trim() ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (no default is provided).");
  }

  const configuredSecret = process.env["BETTER_AUTH_SECRET"]?.trim() ?? "";
  const usingVirtualSecret = configuredSecret.length === 0;
  if ((usingVirtualSecret || configuredSecret === VIRTUAL_DEV_SECRET || configuredSecret.startsWith("phase1-test-only")) && nodeEnv === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET must be set when NODE_ENV=production; the virtual " +
        "development secret is not an acceptable production credential.",
    );
  }

  const authBaseUrl =
    process.env["BETTER_AUTH_URL"]?.trim() || `http://${host}:${port}`;

  return {
    nodeEnv,
    host,
    port,
    databaseUrl,
    authSecret: configuredSecret || VIRTUAL_DEV_SECRET,
    authBaseUrl,
    logLevel: process.env["SERVER_LOG_LEVEL"]?.trim() || "info",
    usingVirtualSecret,
    trustedOriginsRaw: process.env["TRUSTED_ORIGINS"]?.trim() ?? "",
    adminEmails: parseAdminEmails(process.env["ADMIN_EMAILS"]),
    mail: loadMailSettings(nodeEnv, process.env),
    phone: loadPhoneSettings(nodeEnv, process.env),
    // Empty value means "use the read-only Readability fallback". A real
    // Jina key turns the URL importer into the production-grade
    // primary path; slice 2 ships without a key by default.
    jinaApiKey: process.env["JINA_API_KEY"]?.trim() ?? "",
    jinaBaseUrl: process.env["JINA_BASE_URL"]?.trim() ?? "",
  };
}
