// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Better Auth instance.
 *
 * Phase 2 scope: real account lifecycle — email verification, password reset,
 * database sessions, roles, disabled accounts and auth rate limiting — on top
 * of the phase-1 proof that Better Auth, Fastify, Prisma 7 and PostgreSQL work
 * together on the pinned versions.
 *
 * One addition after phase 2: passwordless sign-in by six-digit email code
 * (`emailOTP` plugin, sign-in purpose only). Registration still verifies by
 * link and password reset still arrives as a link.
 *
 * Deliberately NOT enabled:
 *  - the OTP plugin for anything except sign-in: there is no code-based
 *    registration, verification or password reset, so those plugin endpoints
 *    are mounted but never fed a code;
 *  - any social/OAuth provider (not in the phase-2 deliverable);
 *  - Better Auth's admin plugin. Its schema shape (role / banned / banReason /
 *    banExpires, all `input: false`) is what `schema.prisma` mirrors, but the
 *    plugin also mounts impersonation endpoints that cannot be switched off,
 *    and it does not check `banned` per request — only when a session is
 *    created. Since a per-request check is mandatory for the "禁用账号及时拒绝
 *    受保护请求" gate, the plugin would add attack surface without removing
 *    work. See `plugins/session.ts` for the enforcement that is actually used.
 *  - `requireEmailVerification`. See the comment on it below.
 */

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import type { BetterAuthRateLimitOptions } from "better-auth";
import type { AppPrisma } from "./db.js";
import type { NodeEnv } from "./env.js";
import type { Mailer } from "./lib/mail/mailer.js";
import type { PhoneOtpService } from "../../modules/phone-otp-kit/src/otp/service.js";
import { phoneAuthPlugin, PHONE_EMAIL_DOMAIN } from "./lib/phone/plugin.js";

/** Verification links are valid for one hour. */
export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60;

/** Reset links are valid for 30 minutes. */
export const RESET_TOKEN_EXPIRES_IN_SECONDS = 60 * 30;

/** Login codes are valid for 10 minutes. */
export const SIGN_IN_OTP_EXPIRES_IN_SECONDS = 60 * 10;

/** Wrong guesses allowed against a single code before it is burned. */
export const SIGN_IN_OTP_MAX_ATTEMPTS = 5;

export interface AuthConfig {
  prisma: AppPrisma;
  secret: string;
  /** Public origin used for cookie scoping and origin checks. */
  baseURL: string;
  nodeEnv: NodeEnv;
  trustedOrigins?: string[];
  /** Composes and hands off verification / reset messages. */
  mail: Mailer;
  /**
   * Phone verification service. Present when the SMS runtime was configured;
   * absent only in the small in-process harnesses that build an auth instance
   * without a database-backed phone flow (the production mail gate test).
   * When absent, the phone endpoints are not mounted at all rather than
   * mounted and failing at request time.
   */
  phone?: PhoneOtpService;
  /** Built by `lib/rate-limit.ts`. */
  rateLimit: BetterAuthRateLimitOptions;
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(config: AuthConfig) {
  return betterAuth({
    appName: "gloss",
    secret: config.secret,
    baseURL: config.baseURL,
    database: prismaAdapter(config.prisma, { provider: "postgresql" }),

    emailAndPassword: {
      enabled: true,

      // Kept false on purpose, and the gate lives elsewhere.
      //
      // The phase-2 gate is "验证邮箱后才能使用 AI 入口", not "验证邮箱后才能登录".
      // Turning this on makes sign-in fail with 403 for unverified accounts and
      // makes sign-up return no session cookie at all — which would both break
      // the frozen phase-1 acceptance run and remove the state the UI needs to
      // say "邮箱未验证，去验证". Instead, an unverified account can sign in and
      // read, and `createRequireVerifiedSession` rejects the AI entry with
      // `EMAIL_NOT_VERIFIED` until the address is verified.
      requireEmailVerification: false,

      autoSignIn: true,
      minPasswordLength: 8,

      sendResetPassword: async ({ user, url }) => {
        await config.mail.sendResetPassword({ user, url });
      },
      resetPasswordTokenExpiresIn: RESET_TOKEN_EXPIRES_IN_SECONDS,
      // Resetting a password invalidates every existing session, including the
      // one that requested the reset: a password change is how someone reacts
      // to a suspected compromise.
      revokeSessionsOnPasswordReset: true,
    },

    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await config.mail.sendVerificationEmail({ user, url });
      },
      sendOnSignUp: true,
      // Left false: re-sending on every sign-in turns a legitimate user's inbox
      // into noise. The account page offers an explicit resend.
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
    },

    // Email-code sign-in. Deliberately scoped to the `sign-in` purpose only:
    // registration keeps the link flow above (`overrideDefaultEmailVerification`
    // is NOT set), and password reset keeps its link flow below.
    //
    // Three properties come from the plugin and are load-bearing:
    //   - `storeOTP: "hashed"`: the six-digit code is stored as a SHA-256 hash,
    //     so a database read does not hand out a live credential;
    //   - `allowedAttempts`: wrong guesses burn the code after five tries;
    //   - `disableSignUp: true`: a code proves control of a mailbox that is
    //     already registered. Unknown addresses get the same `{ success: true }`
    //     and no mail, so the send endpoint is not an account-existence oracle.
    //
    // The callback therefore only sends for `type === "sign-in"`. The plugin
    // also mounts OTP endpoints for the other purposes; they stay inert
    // because nothing sends those codes, and no UI calls them.
    // The phone endpoints live in `lib/phone/plugin.ts`. They are mounted only
    // when the SMS runtime was assembled, and they inherit everything above:
    // the origin check, the request limiter and the session-creation ban hook.
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: SIGN_IN_OTP_EXPIRES_IN_SECONDS,
        allowedAttempts: SIGN_IN_OTP_MAX_ATTEMPTS,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: true,
        sendVerificationOnSignUp: false,
        changeEmail: { enabled: false },
        rateLimit: { window: 60, max: 3 },
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return;
          await config.mail.sendSignInOtp({ user: { email }, otp });
        },
      }),
      ...(config.phone ? [phoneAuthPlugin({ service: config.phone })] : []),
    ],

    // Declaring these here is what makes the auth layer return them from
    // `getSession` and what makes them impossible to set from a request:
    // `input: false` means a client-supplied value is dropped on create and
    // rejected on update. The Prisma columns alone would not be enough.
    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "user", input: false },
        banned: { type: "boolean", required: false, defaultValue: false, input: false },
        banReason: { type: "string", required: false, input: false },
        banExpires: { type: "date", required: false, input: false },
        /**
         * Phone identity. Declared with `input: false` so neither field can be
         * set by any request body — the phone endpoints are the only writers,
         * and they set both together. `unique` mirrors the Prisma index, which
         * is what makes "one number, one account" a database guarantee.
         */
        phoneNumber: { type: "string", required: false, unique: true, input: false },
        phoneNumberVerified: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // Load-bearing: a cookie cache would serve `role`, `emailVerified` and
      // `banned` from a signed cookie for up to its maxAge, so disabling an
      // account or demoting an administrator would take minutes to apply
      // instead of taking effect on the next request. The promptness
      // assertions in the phase-2 acceptance run are the tripwire if anyone
      // turns this on.
      cookieCache: { enabled: false },
    },

    // Rejecting session creation is what stops a disabled account from signing
    // in at all. Per-request rejection for accounts disabled while already
    // signed in lives in `plugins/session.ts`. Mirrors the official admin
    // plugin's own hook, including the lazy clearing of an expired ban so the
    // stored flag stays truthful.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // A phone account stores a synthetic address in a reserved,
            // unroutable domain. If the email form were allowed to claim one,
            // whoever typed `8613800138000@phone.invalid` first would block the
            // real owner of that number from registering — a denial of service
            // on an identity, bought with a free sign-up. The domain is
            // therefore reserved outright, for every creation path.
            const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
            const phoneNumber = (user as Record<string, unknown>).phoneNumber;
            // A phone account is created with `phoneNumber` already set (the
            // phone endpoints are the only writers of that column, and it is
            // `input: false` everywhere else), so this hook can tell the two
            // creation paths apart without trusting the request.
            if (email.endsWith(`@${PHONE_EMAIL_DOMAIN}`) && typeof phoneNumber !== "string") {
              throw APIError.from("BAD_REQUEST", {
                message: `该邮箱域名保留给手机号账号，不能注册：${PHONE_EMAIL_DOMAIN}`,
                code: "RESERVED_EMAIL_DOMAIN",
              });
            }
            return { data: user };
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            if (!context) return;
            const raw = await context.context.internalAdapter.findUserById(session.userId);
            // The adapter's own type does not include fields declared via
            // `user.additionalFields`, so this read is defensive: the values
            // are the same columns the session-create gate inspects on every
            // request, and a missing one is treated as "not banned".
            const user = raw as unknown as {
              banned?: boolean;
              banReason?: string | null;
              banExpires?: string | Date | null;
            };
            if (!user.banned) return;

            const banExpires = user.banExpires;
            if (banExpires && new Date(banExpires).getTime() < Date.now()) {
              await context.context.internalAdapter.updateUser(session.userId, {
                banned: false,
                banReason: null,
                banExpires: null,
              });
              return;
            }

            const reason = typeof user.banReason === "string" ? user.banReason : "";
            throw APIError.from("FORBIDDEN", {
              message:
                reason.length > 0
                  ? `账号已被停用：${reason}`
                  : "账号已被停用，请联系管理员。",
              code: "ACCOUNT_DISABLED",
            });
          },
        },
      },
    },

    rateLimit: config.rateLimit,

    advanced: {
      // Cookies must be usable over plain http on loopback during local
      // acceptance, but must never be sent without TLS in production.
      useSecureCookies: config.nodeEnv === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      // Explicit, and deliberately false. Better Auth would otherwise skip
      // origin and Fetch-Metadata checks whenever NODE_ENV=test, which would
      // make every origin assertion in the acceptance run vacuous.
      disableOriginCheck: false,
      ipAddress: {
        // Rate-limit keys and session metadata are derived from the client IP.
        // Behind the local Caddy proxy the address arrives in X-Forwarded-For;
        // a production deployment must additionally configure `trustedProxies`
        // with the real proxy addresses, otherwise a spoofed header can move a
        // caller into a different bucket. Recorded as phase-6 work.
        ipv6Subnet: 64,
      },
    },

    trustedOrigins: config.trustedOrigins,

    telemetry: { enabled: false },
  });
}

/** Hosts whose origin may talk to the auth endpoints. Loopback only. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"] as const;

/**
 * Origins allowed to call the auth endpoints.
 *
 * Beyond `BETTER_AUTH_URL`, this adds its loopback alias: an operator who opens
 * `http://localhost:8080` while the configured URL says `127.0.0.1` would
 * otherwise get an unexplained 403 on every sign-in, because the origin check
 * compares origins literally and does not treat the two names as equal.
 *
 * Extra origins come from `TRUSTED_ORIGINS` (comma-separated) and must be
 * loopback: phase 2 refuses to bind anything else, so accepting a public origin
 * here would only hide a misconfiguration. Phase 6 replaces this with the real
 * deployment origin.
 */
export function resolveTrustedOrigins(
  baseURL: string,
  raw: string | undefined,
): string[] {
  const origins = new Set<string>([baseURL]);

  for (const host of LOOPBACK_HOSTS) {
    const alias = new URL(baseURL);
    alias.hostname = host;
    alias.pathname = "";
    alias.search = "";
    alias.hash = "";
    origins.add(alias.origin);
  }

  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim().replace(/\/+$/, "");
    if (value.length === 0) continue;

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(
        `TRUSTED_ORIGINS contains a value that is not a URL: ${JSON.stringify(entry)}`,
      );
    }
    if (!LOOPBACK_HOSTS.includes(parsed.hostname as (typeof LOOPBACK_HOSTS)[number])) {
      throw new Error(
        `TRUSTED_ORIGINS may only contain loopback origins in phase 2 ` +
          `(got ${JSON.stringify(value)}). Configuring a public origin belongs to the deployment phase.`,
      );
    }
    origins.add(parsed.origin);
  }

  return [...origins].filter((origin) => origin.length > 0);
}
