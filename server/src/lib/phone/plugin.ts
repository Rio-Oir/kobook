// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phone-number sign-up / sign-in / password-reset endpoints, mounted on the
 * Better Auth instance.
 *
 * ## Why these are Better Auth endpoints and not Fastify routes
 *
 * They issue sessions. Doing that outside the auth instance means re-implementing
 * the signed session cookie, its `__Secure-` prefix in production, its max-age
 * and the "clear a stale cookie that is being replaced" behaviour — four things
 * that already exist and are covered by the acceptance run through the vendor's
 * own sign-in path. Mounting the endpoints on the instance keeps every one of
 * them on that path, and it also inherits the origin check, the request rate
 * limiter and the `banned` session-creation hook.
 *
 * ## What the endpoints deliberately do not reveal
 *
 * - `send-code` answers the same shape for every valid number. For `sign-in`
 *   and `reset-password` a code is only actually sent to a registered number,
 *   so the endpoint is not an account-existence oracle — the same rule the
 *   email code endpoint follows.
 * - `sign-in-password` returns one error for "unknown number", "no password
 *   set" and "wrong password".
 * - `sign-in-code` and `reset-password` collapse "no challenge" and "wrong
 *   code" into one answer, because the kit does.
 *
 * ## What is not here
 *
 * No account binding, no number change, no international format. Binding
 * requires a trusted session plus a fresh proof of both channels; none of it is
 * part of this surface.
 */

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { assessPhone } from "../../../../modules/phone-otp-kit/src/shared/phone.js";
import type { PhoneOtpService } from "../../../../modules/phone-otp-kit/src/otp/service.js";
import type { PhoneOtpResponseCode } from "../../../../modules/phone-otp-kit/src/shared/errors.js";
import { isPhoneOtpPurpose } from "./config.js";

/** Header the Fastify bridge writes with a server-derived client identity. */
export const CLIENT_REF_HEADER = "x-dsh-client";

/** Password bounds. Mirrors `minPasswordLength` in `auth.ts` plus the cap the
 *  vendor applies, so a password that passes here cannot fail later. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/** Reserved domain for the synthetic address a phone account stores. */
export const PHONE_EMAIL_DOMAIN = "phone.invalid";

/**
 * The address a phone account gets so the core's required, unique `email`
 * column stays truthful and unroutable. The number's digits alone, so the
 * mapping is deterministic; `auth.ts` refuses that domain for any creation
 * path that is not a phone account, which is what stops someone from
 * squatting a number's placeholder through the email form.
 */
export function phonePlaceholderEmail(e164: string): string {
  return `${e164.replace(/^\+/u, "")}@${PHONE_EMAIL_DOMAIN}`;
}

interface PhoneUserRow {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role?: string | null;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean | null;
  banned?: boolean | null;
}

interface CredentialAccountRow {
  id: string;
  password?: string | null;
}

type ApiStatus =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "TOO_MANY_REQUESTS"
  | "BAD_GATEWAY"
  | "INTERNAL_SERVER_ERROR";

/** Build (do not throw) an API error; call sites `throw` it so control-flow
 *  narrowing keeps working for the value they just checked. */
function apiError(status: ApiStatus, code: string, message: string): Error {
  return APIError.from(status, { message, code });
}

/**
 * The kit's failure vocabulary, mapped to HTTP once.
 *
 * Every sentence is fixed here rather than built from the code, so a code that
 * is not in this table cannot reach a user as raw text.
 */
const FAILURES: Record<PhoneOtpResponseCode, { status: ApiStatus; message: string }> = {
  INVALID_PHONE: { status: "BAD_REQUEST", message: "手机号格式不正确。" },
  UNSUPPORTED_PHONE: { status: "BAD_REQUEST", message: "目前仅支持中国大陆手机号。" },
  INVALID_PURPOSE: { status: "BAD_REQUEST", message: "验证码用途无效。" },
  UNTRUSTED_CLIENT: { status: "FORBIDDEN", message: "请求来源无法识别，请刷新后重试。" },
  SEND_LIMITED: { status: "TOO_MANY_REQUESTS", message: "验证码发送过于频繁，请稍后再试。" },
  SMS_SEND_FAILED: { status: "BAD_GATEWAY", message: "短信发送失败，请稍后再试。" },
  VERIFY_LIMITED: { status: "TOO_MANY_REQUESTS", message: "验证码尝试次数过多，请稍后再试。" },
  CODE_EXPIRED: { status: "BAD_REQUEST", message: "验证码已过期，请重新获取。" },
  CODE_INVALID: { status: "BAD_REQUEST", message: "验证码不正确或已过期。" },
  TOO_MANY_ATTEMPTS: { status: "BAD_REQUEST", message: "验证码错误次数过多，请重新获取。" },
  INTERNAL: { status: "INTERNAL_SERVER_ERROR", message: "服务暂时不可用，请稍后再试。" },
};

function kitError(code: PhoneOtpResponseCode): Error {
  const mapped = FAILURES[code];
  return apiError(mapped.status, code, mapped.message);
}

/**
 * A phone assessment is refused with the code the service would have produced,
 * so the endpoint layer and the service layer answer the same vocabulary.
 */
function phoneError(reason: "EMPTY" | "MALFORMED" | "UNSUPPORTED_COUNTRY" | "NOT_MAINLAND_MOBILE"): Error {
  return reason === "EMPTY" || reason === "MALFORMED"
    ? kitError("INVALID_PHONE")
    : kitError("UNSUPPORTED_PHONE");
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/** Server-derived client identity. Missing means "refuse", not "share a bucket". */
function clientRefOf(headers: Headers | undefined): string | null {
  const value = headers?.get(CLIENT_REF_HEADER);
  if (typeof value !== "string") return null;
  // The kit's own pattern; repeated here so the endpoint refuses before the
  // service is called rather than reporting a configuration-shaped failure.
  return /^[A-Za-z0-9_.:~-]{8,128}$/u.test(value) ? value : null;
}

function publicUser(user: PhoneUserRow): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    role: user.role === "admin" ? "admin" : "user",
    phoneNumber: user.phoneNumber ?? null,
  };
}

async function findUserByPhone(
  ctx: { context: { adapter: unknown } },
  phoneNumber: string,
): Promise<PhoneUserRow | null> {
  const adapter = ctx.context.adapter as {
    findOne(input: {
      model: string;
      where: Array<{ field: string; value: string }>;
    }): Promise<unknown>;
  };
  const row = await adapter.findOne({
    model: "user",
    where: [{ field: "phoneNumber", value: phoneNumber }],
  });
  return (row as PhoneUserRow | null) ?? null;
}

interface SessionCtx {
  context: {
    internalAdapter: { createSession(userId: string): Promise<unknown> };
  };
  json(data: unknown): Response;
}

async function issueSession(ctx: SessionCtx, user: PhoneUserRow): Promise<Response> {
  const session = await ctx.context.internalAdapter.createSession(user.id);
  if (!session) {
    throw apiError("INTERNAL_SERVER_ERROR", "FAILED_TO_CREATE_SESSION", "登录失败，请稍后再试。");
  }
  await setSessionCookie(
    ctx as unknown as Parameters<typeof setSessionCookie>[0],
    { session, user } as unknown as Parameters<typeof setSessionCookie>[1],
  );
  return ctx.json({ status: true, user: publicUser(user) });
}

function readPassword(value: unknown): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw apiError("BAD_REQUEST", "PASSWORD_TOO_SHORT", `密码至少 ${MIN_PASSWORD_LENGTH} 位。`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw apiError("BAD_REQUEST", "PASSWORD_TOO_LONG", `密码不能超过 ${MAX_PASSWORD_LENGTH} 位。`);
  }
  return password;
}

export interface PhoneAuthPluginOptions {
  service: PhoneOtpService;
}

export function phoneAuthPlugin(options: PhoneAuthPluginOptions): BetterAuthPlugin {
  const service = options.service;

  return {
    id: "phone-auth",
    endpoints: {
      /**
       * Ask for a code. The response shape never depends on whether the number
       * has an account: `sign-in` and `reset-password` simply skip the send for
       * an unknown number, while `sign-up` and `sign-in-or-up` always send —
       * those two flows are allowed to create the account.
       */
      phoneSendCode: createAuthEndpoint("/phone/send-code", { method: "POST" }, async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const phoneNumber = readString(body.phoneNumber, 32);
        if (phoneNumber === null) throw kitError("INVALID_PHONE");
        if (!isPhoneOtpPurpose(body.purpose)) throw kitError("INVALID_PURPOSE");
        const purpose = body.purpose;

        const assessed = assessPhone(phoneNumber);
        if (!assessed.ok) throw phoneError(assessed.reason);

        // Anti-enumeration: only a code that can create an account is sent to
        // an unknown number (it will be refused after verification with
        // "already registered" for `sign-up`). The existing-account-only
        // flows stay silent.
        if (purpose !== "sign-up" && purpose !== "sign-in-or-up") {
          const user = await findUserByPhone(ctx as never, assessed.e164);
          if (user === null) {
            return ctx.json({
              ok: true,
              maskedPhone: assessed.masked,
              expiresInSeconds: 0,
              cooldownSeconds: 0,
            });
          }
        }

        const clientRef = clientRefOf(ctx.headers);
        if (clientRef === null) throw kitError("UNTRUSTED_CLIENT");

        const result = await service.requestCode({
          phone: assessed.e164,
          clientRef,
          purpose,
        });
        if (!result.ok) throw kitError(result.code);

        return ctx.json({
          ok: true,
          maskedPhone: result.maskedPhone,
          expiresInSeconds: result.expiresInSeconds,
          cooldownSeconds: result.cooldownSeconds,
        });
      }),

      /**
       * Registration: the code proves the number, the password becomes the
       * credential. The account's `emailVerified` is set because "one
       * ownership proof" is the rule for both channels.
       */
      phoneSignUp: createAuthEndpoint("/phone/sign-up", { method: "POST" }, async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const phoneNumber = readString(body.phoneNumber, 32);
        // Validate the password before consuming the code, so a rejected
        // password does not cost the user their verification code.
        const password = readPassword(body.password);

        if (phoneNumber === null) throw kitError("INVALID_PHONE");
        const code = readString(body.code, 32);
        if (code === null) throw kitError("CODE_INVALID");

        const assessed = assessPhone(phoneNumber);
        if (!assessed.ok) throw phoneError(assessed.reason);

        const clientRef = clientRefOf(ctx.headers);
        if (clientRef === null) throw kitError("UNTRUSTED_CLIENT");

        const verified = await service.verifyCode({
          phone: assessed.e164,
          code,
          clientRef,
          purpose: "sign-up",
        });
        if (!verified.ok) throw kitError(verified.code);

        const existing = await findUserByPhone(ctx as never, assessed.e164);
        if (existing !== null) {
          throw apiError("BAD_REQUEST", "PHONE_ALREADY_REGISTERED", "该手机号已注册，请直接登录。");
        }

        const name = readString(body.name, 40) ?? "读者";
        const passwordHash = await ctx.context.password.hash(password);

        let created: PhoneUserRow;
        try {
          created = (await ctx.context.internalAdapter.createUser(
            {
              email: phonePlaceholderEmail(assessed.e164),
              emailVerified: true,
              name,
              phoneNumber: assessed.e164,
              phoneNumberVerified: true,
            } as never,
            { method: "phone-number" } as never,
          )) as unknown as PhoneUserRow;
        } catch (error) {
          // The unique index on `phoneNumber` is the last word on two
          // concurrent registrations of the same number.
          if ((error as { code?: string }).code === "P2002") {
            throw apiError("BAD_REQUEST", "PHONE_ALREADY_REGISTERED", "该手机号已注册，请直接登录。");
          }
          throw error;
        }
        if (!created) {
          throw apiError("INTERNAL_SERVER_ERROR", "FAILED_TO_CREATE_USER", "注册失败，请稍后再试。");
        }

        await ctx.context.internalAdapter.linkAccount({
          userId: created.id,
          providerId: "credential",
          accountId: created.id,
          password: passwordHash,
        });

        return issueSession(ctx as unknown as SessionCtx, created);
      }),

      /** Passwordless sign-in for an existing number. */
      phoneSignInCode: createAuthEndpoint("/phone/sign-in-code", { method: "POST" }, async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const phoneNumber = readString(body.phoneNumber, 32);
        const code = readString(body.code, 32);
        if (phoneNumber === null) throw kitError("INVALID_PHONE");
        if (code === null) throw kitError("CODE_INVALID");

        const assessed = assessPhone(phoneNumber);
        if (!assessed.ok) throw phoneError(assessed.reason);

        const clientRef = clientRefOf(ctx.headers);
        if (clientRef === null) throw kitError("UNTRUSTED_CLIENT");

        const verified = await service.verifyCode({
          phone: assessed.e164,
          code,
          clientRef,
          purpose: "sign-in",
        });
        if (!verified.ok) throw kitError(verified.code);

        const user = await findUserByPhone(ctx as never, assessed.e164);
        if (user === null) throw kitError("CODE_INVALID");
        return issueSession(ctx as never, user);
      }),

      /**
       * Passwordless entry that registers the number on first use.
       *
       * This is the only phone entry the UI offers. Proving the number with a
       * code is the whole credential, so "登录" and "注册" collapse into one
       * action: an existing account is signed in, a new one is created with the
       * number already verified and no password — which is why the password
       * form is an email-only surface.
       */
      phoneSignInOrUp: createAuthEndpoint(
        "/phone/sign-in-or-up",
        { method: "POST" },
        async (ctx) => {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const phoneNumber = readString(body.phoneNumber, 32);
          const code = readString(body.code, 32);
          if (phoneNumber === null) throw kitError("INVALID_PHONE");
          if (code === null) throw kitError("CODE_INVALID");

          const assessed = assessPhone(phoneNumber);
          if (!assessed.ok) throw phoneError(assessed.reason);

          const clientRef = clientRefOf(ctx.headers);
          if (clientRef === null) throw kitError("UNTRUSTED_CLIENT");

          const verified = await service.verifyCode({
            phone: assessed.e164,
            code,
            clientRef,
            purpose: "sign-in-or-up",
          });
          if (!verified.ok) throw kitError(verified.code);

          let user = await findUserByPhone(ctx as never, assessed.e164);
          if (user === null) {
            const name = readString(body.name, 40) ?? "读者";
            try {
              user = (await ctx.context.internalAdapter.createUser(
                {
                  email: phonePlaceholderEmail(assessed.e164),
                  emailVerified: true,
                  name,
                  phoneNumber: assessed.e164,
                  phoneNumberVerified: true,
                } as never,
                { method: "phone-number" } as never,
              )) as unknown as PhoneUserRow;
            } catch (error) {
              // The unique index on `phoneNumber` is the last word on two
              // concurrent first-time sign-ins of the same number: the loser
              // of the race signs in to the row the winner created.
              if ((error as { code?: string }).code !== "P2002") throw error;
              user = await findUserByPhone(ctx as never, assessed.e164);
            }
          }
          if (!user) {
            throw apiError("INTERNAL_SERVER_ERROR", "FAILED_TO_CREATE_USER", "登录失败，请稍后再试。");
          }

          return issueSession(ctx as unknown as SessionCtx, user);
        },
      ),

      /** Password sign-in. One error for every way the pair can be wrong. */
      phoneSignInPassword: createAuthEndpoint(
        "/phone/sign-in-password",
        { method: "POST" },
        async (ctx) => {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const phoneNumber = readString(body.phoneNumber, 32);
          const password = typeof body.password === "string" ? body.password : "";
          const invalid = (): Error =>
            apiError("UNAUTHORIZED", "INVALID_PHONE_OR_PASSWORD", "手机号或密码不正确。");

          if (phoneNumber === null || password.length === 0) throw invalid();
          const assessed = assessPhone(phoneNumber);
          if (!assessed.ok) throw invalid();

          const user = await findUserByPhone(ctx as never, assessed.e164);
          if (user === null) throw invalid();

          const account = (await ctx.context.internalAdapter.findCredentialAccount(
            user.id,
          )) as unknown as CredentialAccountRow | null;
          if (!account?.password) throw invalid();

          const matches = await ctx.context.password.verify({
            hash: account.password,
            password,
          });
          if (!matches) throw invalid();

          return issueSession(ctx as never, user);
        },
      ),

      /**
       * Reset with a code. Every existing session is revoked afterwards: a
       * password change is how someone reacts to a suspected compromise, and
       * leaving the attacker's session alive would defeat it.
       */
      phoneResetPassword: createAuthEndpoint(
        "/phone/reset-password",
        { method: "POST" },
        async (ctx) => {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          const phoneNumber = readString(body.phoneNumber, 32);
          const code = readString(body.code, 32);
          const newPassword = readPassword(body.newPassword);

          if (phoneNumber === null) throw kitError("INVALID_PHONE");
          if (code === null) throw kitError("CODE_INVALID");

          const assessed = assessPhone(phoneNumber);
          if (!assessed.ok) throw phoneError(assessed.reason);

          const clientRef = clientRefOf(ctx.headers);
          if (clientRef === null) throw kitError("UNTRUSTED_CLIENT");

          const verified = await service.verifyCode({
            phone: assessed.e164,
            code,
            clientRef,
            purpose: "reset-password",
          });
          if (!verified.ok) throw kitError(verified.code);

          const user = await findUserByPhone(ctx as never, assessed.e164);
          if (user === null) throw kitError("CODE_INVALID");

          const passwordHash = await ctx.context.password.hash(newPassword);
          const account = (await ctx.context.internalAdapter.findCredentialAccount(
            user.id,
          )) as unknown as CredentialAccountRow | null;

          if (account === null) {
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: passwordHash,
            });
          } else {
            await ctx.context.internalAdapter.updatePassword(user.id, passwordHash);
          }

          await ctx.context.internalAdapter.deleteUserSessions(user.id);
          return ctx.json({ status: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
