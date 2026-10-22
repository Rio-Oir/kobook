// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Auth rate-limit configuration.
 *
 * The phase-2 gate is "注册、登录、验证邮件和重置邮件都设置速率限制". Better Auth's
 * built-in limiter already ships hardcoded special rules covering exactly those
 * four paths, so this module configures the built-in limiter rather than adding
 * a second limiter library: no non-auth route exists yet that the gate covers,
 * and a new dependency would mean re-triaging the dependency audit and the
 * licence baseline for no gate value. Phase 3/4 must add limiting for article
 * import and generation routes — recorded in the phase-2 report.
 *
 * Three behaviours of the built-in limiter drive the shape below:
 *
 *   - `enabled` defaults to *production only*. The limiter is therefore off
 *     under `npm run dev` and in tests. Tests that need to observe a real 429
 *     start their own server with `AUTH_RATE_LIMIT_ENABLED=1` and small maxima,
 *     instead of making the main test server trip its own limits.
 *   - The key is IP × path, with counters in memory: it does not survive a
 *     restart and does not coordinate across processes. Phase 2 is a single
 *     process. A multi-replica deployment needs `storage: "database"` (which
 *     needs a rate-limit table) or a shared store — phase 6 work.
 *   - Rule keys must be the *basePath-stripped* path (`/sign-in/email`, not
 *     `/api/auth/sign-in/email`), because the limiter normalises the pathname
 *     before matching.
 *
 * Every value is parsed strictly: a typo must fail startup rather than
 * silently leave the limiter off or wrong.
 */

import type { BetterAuthRateLimitOptions } from "better-auth";
import type { NodeEnv } from "../env.js";

export interface AuthRateLimitConfig {
  enabled: boolean;
  /** Default window in seconds, for paths without a specific rule. */
  window: number;
  /** Default maximum requests per window. */
  max: number;
  /** Sign-in / sign-up window and maximum. */
  loginWindow: number;
  loginMax: number;
  /** Verification-mail / reset-mail window and maximum. */
  mailWindow: number;
  mailMax: number;
}

/**
 * The flows the phase-2 gate names plus the code-sign-in pair and the phone
 * endpoints, keyed by normalised (basePath-stripped) path. Kept as data so the
 * tests can assert the exact key set.
 *
 * `/email-otp/send-verification-otp` is a mail-spending action (the same bucket
 * as the two link mails); `/sign-in/email-otp` verifies a six-digit secret and
 * belongs to the login bucket, so guessing is bounded both by the code's own
 * attempt counter and by the per-IP window. The `/phone/*` pair follows the
 * same split: `send-code` spends an SMS, the other three check a credential.
 */
export const RATE_LIMIT_RULES = {
  login: [
    "/sign-in/email",
    "/sign-in/email-otp",
    "/sign-up/email",
    // Phone + password / phone + code are credential checks, and the reset
    // endpoint checks a six-digit code, so all three share the login bucket.
    "/phone/sign-in-password",
    "/phone/sign-in-code",
    "/phone/sign-up",
    "/phone/reset-password",
  ],
  mail: [
    "/send-verification-email",
    "/request-password-reset",
    "/email-otp/send-verification-otp",
    // `send-code` spends money per message, exactly like the three above. The
    // kit also enforces its own per-number budgets; this rule is the per-IP
    // ceiling in front of them.
    "/phone/send-code",
  ],
} as const;

/** Defaults; the login/mail maxima match the library's own hardcoded rules. */
export const RATE_LIMIT_DEFAULTS = {
  window: 10,
  max: 100,
  loginWindow: 10,
  loginMax: 3,
  mailWindow: 60,
  mailMax: 3,
} as const;

function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
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

export function loadAuthRateLimitConfig(
  nodeEnv: NodeEnv,
  raw: Record<string, string | undefined> = process.env,
): AuthRateLimitConfig {
  return {
    // Off in development and test unless explicitly switched on, matching the
    // library default while keeping the decision in our own configuration.
    enabled: readFlag(
      raw["AUTH_RATE_LIMIT_ENABLED"],
      nodeEnv === "production",
      "AUTH_RATE_LIMIT_ENABLED",
    ),
    window: readPositiveInt(raw["AUTH_RATE_LIMIT_WINDOW"], RATE_LIMIT_DEFAULTS.window, "AUTH_RATE_LIMIT_WINDOW"),
    max: readPositiveInt(raw["AUTH_RATE_LIMIT_MAX"], RATE_LIMIT_DEFAULTS.max, "AUTH_RATE_LIMIT_MAX"),
    loginWindow: readPositiveInt(raw["AUTH_RATE_LIMIT_LOGIN_WINDOW"], RATE_LIMIT_DEFAULTS.loginWindow, "AUTH_RATE_LIMIT_LOGIN_WINDOW"),
    loginMax: readPositiveInt(raw["AUTH_RATE_LIMIT_LOGIN_MAX"], RATE_LIMIT_DEFAULTS.loginMax, "AUTH_RATE_LIMIT_LOGIN_MAX"),
    mailWindow: readPositiveInt(raw["AUTH_RATE_LIMIT_MAIL_WINDOW"], RATE_LIMIT_DEFAULTS.mailWindow, "AUTH_RATE_LIMIT_MAIL_WINDOW"),
    mailMax: readPositiveInt(raw["AUTH_RATE_LIMIT_MAIL_MAX"], RATE_LIMIT_DEFAULTS.mailMax, "AUTH_RATE_LIMIT_MAIL_MAX"),
  };
}

/**
 * Builds the `rateLimit` option.
 *
 * `storage` is deliberately fixed at "memory" and not exposed as an env var:
 * `storage: "database"` would require a rate-limit table that phase 2 does not
 * have, and shipping configuration that crashes at runtime is worse than not
 * offering it.
 */
export function toBetterAuthRateLimit(
  config: AuthRateLimitConfig,
): BetterAuthRateLimitOptions {
  const loginRule = { window: config.loginWindow, max: config.loginMax };
  const mailRule = { window: config.mailWindow, max: config.mailMax };

  return {
    enabled: config.enabled,
    window: config.window,
    max: config.max,
    storage: "memory",
    customRules: {
      ...Object.fromEntries(RATE_LIMIT_RULES.login.map((path) => [path, loginRule])),
      ...Object.fromEntries(RATE_LIMIT_RULES.mail.map((path) => [path, mailRule])),
    },
  };
}
