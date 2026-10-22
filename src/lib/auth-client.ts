// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Account HTTP client.
 *
 * The frontend talks to the account service through the same origin (Caddy at
 * `http://127.0.0.1:8080` in development, the deployment origin in
 * production), so `credentials: "same-origin"` is enough to send the session
 * cookie. No CORS, no token plumbing, no proxy.
 *
 * ## What is *not* here any more
 *
 * This module used to be three things at once: the account HTTP client, the
 * session store, and the shared error contract. Base owns the last two now —
 * `src/lib/session.ts` resolves the session through the optional cloud adapter,
 * `src/lib/api-error.ts` owns `ApiRequestError` and the one request helper, and
 * `src/lib/ownership.ts` owns the owner/epoch reconciliation that used to be
 * `applyOwnership` here.
 *
 * What remains is exactly the account surface the base line cannot have: the
 * sign-up / sign-in / password / verification calls and the admin check. They
 * reach the server only because this line installs the adapter
 * (`src/lib/cloud/adapter.ts`); with no adapter registered nothing calls them.
 *
 * ## Why the Chinese message table is still here
 *
 * Base's `normalizeApiError` reports the code; it does not translate vendor
 * codes, because "which codes mean what to a user" is account vocabulary. The
 * account screens render `err.message` directly, so the mapping back from a
 * server code to user-readable Chinese lives with the account client that
 * produces those errors.
 */

import { API_PREFIX, ROUTES, type SessionUser } from "./cloud/contracts";
import type { UserRole } from "./types";
import { ApiRequestError, apiRequest } from "./api-error";
import { applyOwnership } from "./ownership";
import { prepareOwnershipTransition } from "./migration-store";
import { LOCAL_STORAGE_BLOCKED_REASON, setBlockedSignIn } from "./cloud/session-block";

const AUTH_BASE = `${API_PREFIX}/auth` as const;

export { ApiRequestError };

const CODE_MESSAGES: Record<string, string> = {
  // Shared error contract codes.
  EMAIL_NOT_VERIFIED: "请先完成邮箱验证。",
  ACCOUNT_DISABLED: "账号已被停用，请联系管理员。",
  RATE_LIMITED: "操作过于频繁，请稍后再试。",
  FORBIDDEN: "没有权限执行该操作。",
  UNAUTHORIZED: "未登录或会话已失效。",
  // Account vendor native codes.
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确。",
  USER_ALREADY_EXISTS: "该邮箱已注册。",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "该邮箱已注册。",
  PASSWORD_TOO_SHORT: "密码至少 8 位。",
  PASSWORD_TOO_LONG: "密码不能超过 128 位。",
  INVALID_EMAIL: "邮箱格式不正确。",
  INVALID_TOKEN: "链接无效或已过期。",
  TOKEN_EXPIRED: "链接已过期，请重新申请。",
  EMAIL_ALREADY_VERIFIED: "该邮箱已经验证过了。",
  BANNED_USER: "账号已被停用，请联系管理员。",
  FAILED_TO_CREATE_USER: "注册失败，请稍后再试。",
  USER_NOT_FOUND: "用户不存在。",
  // Six-digit sign-in code. The wording is deliberately identical for
  // "wrong code" and "already used", so a failed attempt reveals nothing
  // about which side of the check failed.
  INVALID_OTP: "验证码不正确或已过期。",
  OTP_EXPIRED: "验证码已过期，请重新获取。",
  TOO_MANY_ATTEMPTS: "验证码错误次数过多，请重新获取。",
  // Phone-number endpoints (`lib/phone/plugin.ts`). The server already sends a
  // Chinese sentence; these entries exist so the copy lives in one table and a
  // code rendered through a different screen still reads the same.
  INVALID_PHONE: "手机号格式不正确。",
  UNSUPPORTED_PHONE: "目前仅支持中国大陆手机号。",
  UNTRUSTED_CLIENT: "请求来源无法识别，请刷新后重试。",
  SEND_LIMITED: "验证码发送过于频繁，请稍后再试。",
  SMS_SEND_FAILED: "短信发送失败，请稍后再试。",
  VERIFY_LIMITED: "验证码尝试次数过多，请稍后再试。",
  CODE_EXPIRED: "验证码已过期，请重新获取。",
  CODE_INVALID: "验证码不正确或已过期。",
  INVALID_PHONE_OR_PASSWORD: "手机号或密码不正确。",
  PHONE_ALREADY_REGISTERED: "该手机号已注册，请直接登录。",
  RESERVED_EMAIL_DOMAIN: "该邮箱域名仅用于手机号账号，不能注册。",
};

function localize(err: ApiRequestError): ApiRequestError {
  const localized = err.code ? CODE_MESSAGES[err.code] : undefined;
  if (!localized || localized === err.message) return err;
  return new ApiRequestError(localized, err.status, err.code, err.requestId);
}

/**
 * One JSON request, with account error codes rendered in Chinese.
 *
 * Delegates to base's `apiRequest` so there is a single place that knows how
 * to build a same-origin JSON request and how to read either of the two error
 * envelopes; the only thing added here is the code→copy mapping above.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await apiRequest<T>(path, init);
  } catch (err) {
    if (err instanceof ApiRequestError) throw localize(err);
    throw err;
  }
}

// ── Account actions ───────────────────────────────────────────────────────

/**
 * Hand the resolved account this device, or refuse the sign-in.
 *
 * The anonymous workspace has to be set aside *before* base takes the live
 * space, because base clears an account's cache on sign-out and would
 * therefore destroy an un-back-up-able anonymous workspace at the next
 * sign-out. `prepareOwnershipTransition` returning `blocked` means it could
 * not be put anywhere, so the sign-in is rolled back on the server and the
 * device stays anonymous — the content survives, and the user is told why.
 *
 * This is the second of the two veto points (the other is `probeSession`,
 * which covers a session that already existed on page load). Base is not
 * modified and no base file is forked to get this; see the ordering note in
 * `migration-store.prepareOwnershipTransition`.
 */
async function admitAccount(user: SessionUser): Promise<void> {
  const transition = await prepareOwnershipTransition(user.id);
  if (transition !== "blocked") {
    setBlockedSignIn(null);
    applyOwnership(user.id);
    return;
  }
  // Roll back: drop the cookie this request just obtained so the device does
  // not claim "no account" while a session keeps resolving to one.
  await signOutRemote().catch(() => undefined);
  setBlockedSignIn(LOCAL_STORAGE_BLOCKED_REASON);
  throw new ApiRequestError(LOCAL_STORAGE_BLOCKED_REASON, 409, "LOCAL_STORAGE_BLOCKED");
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
  callbackURL: string;
}

export async function signUp(input: SignUpInput): Promise<unknown> {
  const response = await request<{ user: SessionUser }>(`${AUTH_BASE}/sign-up/email`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  // Sign-up auto-signs-in on the server side (account-vendor default). Hand
  // the ownership transition to base so the new account either inherits an
  // anonymous cache or clears a previous account's — see `ownership.ts`.
  if (response?.user) await admitAccount(response.user);
  return response;
}

export interface SignInInput {
  email: string;
  password: string;
}

export async function signIn(input: SignInInput): Promise<unknown> {
  const response = await request<{ user: SessionUser }>(`${AUTH_BASE}/sign-in/email`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  // Re-derive the owner stamp from the freshly-resolved user. The session
  // probe in `session.refresh` also does this, but it runs on a microtask
  // after the SPA's `window.location.hash = "#/"` hop — by the time the store
  // checks, the user has already moved on. Running it here, synchronously
  // after sign-in, makes the cache transition observable on the very next
  // render.
  if (response?.user) await admitAccount(response.user);
  return response;
}

/**
 * Requests a six-digit sign-in code.
 *
 * The server answers `{ success: true }` whether or not the address has an
 * account (codes are only sent to registered mailboxes), so the UI must not
 * treat success as "an account exists". The copy says "如果该邮箱已注册".
 */
export async function sendSignInOtp(email: string): Promise<unknown> {
  return request<unknown>(`${AUTH_BASE}/email-otp/send-verification-otp`, {
    method: "POST",
    body: JSON.stringify({ email, type: "sign-in" }),
  });
}

export interface SignInWithEmailOtpInput {
  email: string;
  otp: string;
}

/**
 * Passwordless sign-in. The server resolves the account from the code and
 * creates the same session cookie the password path does, so everything after
 * this call is identical to `signIn` — including the ownership transition.
 */
export async function signInWithEmailOtp(
  input: SignInWithEmailOtpInput,
): Promise<unknown> {
  const response = await request<{ user: SessionUser }>(`${AUTH_BASE}/sign-in/email-otp`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response?.user) await admitAccount(response.user);
  return response;
}

export interface RequestPasswordResetInput {
  email: string;
  redirectTo: string;
}export async function requestPasswordReset(input: RequestPasswordResetInput): Promise<unknown> {
  return request<unknown>(`${AUTH_BASE}/request-password-reset`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ResetPasswordInput {
  newPassword: string;
  token: string;
}

export async function resetPassword(input: ResetPasswordInput): Promise<unknown> {
  return request<unknown>(`${AUTH_BASE}/reset-password`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sendVerificationEmail(email: string, callbackURL: string): Promise<unknown> {
  return request<unknown>(`${AUTH_BASE}/send-verification-email`, {
    method: "POST",
    body: JSON.stringify({ email, callbackURL }),
  });
}

// ── Phone-number account actions ──────────────────────────────────────────

/**
 * Which flow a code is for. The server sends to an unknown number only for
 * `sign-up` and `sign-in-or-up`; `sign-in` and `reset-password` stay silent
 * there, which is why every send answers the same shape and the UI must not
 * read success as "this number has an account".
 *
 * `sign-in-or-up` is what the login screen uses: one code, and the server
 * decides whether to recognise the number or register it.
 */
export type PhoneCodePurpose = "sign-up" | "sign-in" | "sign-in-or-up" | "reset-password";

export interface PhoneCodeResponse {
  ok: true;
  /** Display form, e.g. `138****8000`. Never the full number. */
  maskedPhone: string;
  expiresInSeconds: number;
  cooldownSeconds: number;
}

export async function sendPhoneCode(input: {
  phoneNumber: string;
  purpose: PhoneCodePurpose;
}): Promise<PhoneCodeResponse> {
  return request<PhoneCodeResponse>(`${AUTH_BASE}/phone/send-code`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

interface PhoneAuthResponse {
  status: true;
  user: SessionUser;
}

/** Registration: the code proves the number, the password becomes the credential. */
export async function signUpWithPhone(input: {
  phoneNumber: string;
  code: string;
  password: string;
  name?: string;
}): Promise<unknown> {
  const response = await request<PhoneAuthResponse>(`${AUTH_BASE}/phone/sign-up`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response?.user) await admitAccount(response.user);
  return response;
}

/** Passwordless sign-in for a registered number. */
export async function signInWithPhoneCode(input: {
  phoneNumber: string;
  code: string;
}): Promise<unknown> {
  const response = await request<PhoneAuthResponse>(`${AUTH_BASE}/phone/sign-in-code`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response?.user) await admitAccount(response.user);
  return response;
}

/**
 * The phone entry the login screen uses: sign in if the number is known,
 * register it if it is not. The code is the credential either way, which is
 * why phone accounts are created without a password.
 */
export async function signInOrSignUpWithPhone(input: {
  phoneNumber: string;
  code: string;
  name?: string;
}): Promise<unknown> {
  const response = await request<PhoneAuthResponse>(`${AUTH_BASE}/phone/sign-in-or-up`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response?.user) await admitAccount(response.user);
  return response;
}

export async function signInWithPhonePassword(input: {
  phoneNumber: string;
  password: string;
}): Promise<unknown> {
  const response = await request<PhoneAuthResponse>(`${AUTH_BASE}/phone/sign-in-password`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (response?.user) await admitAccount(response.user);
  return response;
}

/**
 * Reset with a code. Succeeds without signing in: the server revokes every
 * session, so the next step is an explicit sign-in with the new password.
 */
export async function resetPasswordWithPhone(input: {
  phoneNumber: string;
  code: string;
  newPassword: string;
}): Promise<unknown> {
  return request<{ status: true }>(`${AUTH_BASE}/phone/reset-password`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Probes the AI entry — used by the Account page to know whether a verified
 * session can reach the platform AI.
 */
export async function probeAiEntry(): Promise<{ allowed: true; actorUserId: string }> {
  return request<{ allowed: true; actorUserId: string }>(ROUTES.aiEntry, { method: "POST" });
}

/**
 * Ends the session against the account service.
 *
 * Split out of the session store: base's `session.signOut` clears local state
 * first and then calls this best-effort through the adapter, so a hung or
 * broken endpoint cannot keep the user signed in on this device.
 *
 * The empty JSON body is deliberate: the vendor's sign-out handler rejects a
 * `content-type: application/json` request with no bytes as a 400 ("Invalid
 * JSON in request body"), and the cookie-clearing `Set-Cookie` header never
 * reaches the browser when it does.
 */
export async function signOutRemote(): Promise<void> {
  await request<unknown>(`${AUTH_BASE}/sign-out`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Whether the current principal is a non-trivial administrator. */
export function isAdmin(user: SessionUser | null): user is SessionUser & { role: UserRole } {
  return user?.role === "admin";
}
