// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The error allowlist.
 *
 * Every failure this module can report to a caller is one of the codes below.
 * Nothing else crosses the boundary: no `cause`, no provider text, no HTTP
 * body, no stack, and no phone number. The reason is narrow and mechanical —
 * an error message is the single easiest place to leak a one-time code or a
 * phone number into a log, a bug report or an HTML page, and a message built
 * by string concatenation cannot be audited by reading one file.
 *
 * Two families, because they have different audiences:
 *
 * - `PHONE_OTP_RESPONSE_CODES` are *expected outcomes* of a request. They are
 *   returned as data (`{ ok: false, code }`), never thrown, and each one has a
 *   fixed user-facing sentence in the browser message table.
 * - `PHONE_OTP_CONFIG_CODES` are *deployment mistakes* found while resolving
 *   configuration. They are thrown from `createPhoneOtpService` only, so a
 *   misconfigured process fails at construction instead of quietly falling
 *   back to a weaker implementation.
 *
 * `details` is a closed set of primitive keys with constrained values
 * (see `sanitizeDetails`). A caller cannot smuggle a phone number through it:
 * unknown keys and non-primitive values are dropped, and string values must
 * match a narrow identifier pattern.
 */

/** Expected outcomes of `requestCode` / `verifyCode`. Returned, never thrown. */
export const PHONE_OTP_RESPONSE_CODES = [
  /** The input is not a usable phone number at all (empty, junk, wrong length). */
  "INVALID_PHONE",
  /** Syntactically valid E.164, but not a number this module claims it can send to. */
  "UNSUPPORTED_PHONE",
  /** The purpose is not one of the administrator-configured purposes. */
  "INVALID_PURPOSE",
  /** No trustworthy client identity was supplied, and configuration requires one. */
  "UNTRUSTED_CLIENT",
  /** The send budget for this phone or client is exhausted. */
  "SEND_LIMITED",
  /** The SMS transport refused or failed. Deliberately indistinguishable between causes. */
  "SMS_SEND_FAILED",
  /** The guess budget for this phone or client is exhausted. */
  "VERIFY_LIMITED",
  /** A challenge existed for this purpose+phone and is past its expiry. */
  "CODE_EXPIRED",
  /** No usable challenge, or the supplied code did not match. Deliberately merged. */
  "CODE_INVALID",
  /** The per-challenge attempt allowance is used up. */
  "TOO_MANY_ATTEMPTS",
  /** The kit failed for a reason it will not describe. Never carries a cause. */
  "INTERNAL",
] as const;

export type PhoneOtpResponseCode = (typeof PHONE_OTP_RESPONSE_CODES)[number];

/** Deployment mistakes. Thrown from configuration resolution only. */
export const PHONE_OTP_CONFIG_CODES = [
  /** A configuration value is missing or out of range. */
  "INVALID_CONFIG",
  /** The HMAC secret is absent or shorter than 32 bytes. */
  "WEAK_SECRET",
  /** A test-only component (memory store/limiter, fake transport) was wired into production. */
  "TEST_ONLY_COMPONENT_IN_PRODUCTION",
] as const;

export type PhoneOtpConfigCode = (typeof PHONE_OTP_CONFIG_CODES)[number];

export type PhoneOtpErrorCode = PhoneOtpResponseCode | PhoneOtpConfigCode;

/**
 * The closed set of keys `details` may carry. Adding a key here is a deliberate
 * act: it is the only way to attach anything to an error.
 */
export const PHONE_OTP_DETAIL_KEYS = [
  /** Configuration field name that failed validation. */
  "field",
  /** Which wired component was rejected (`store` | `limiter` | `transport`). */
  "component",
  /** Milliseconds until the caller may retry. */
  "retryAfterMs",
  /** Attempts left on the current challenge. */
  "attemptsRemaining",
  /** The configured limit that was hit. */
  "limit",
  /** The configured window, in milliseconds, that the limit applies over. */
  "windowMs",
  /** Which limiting scope was hit (`phone` | `client`). */
  "scope",
  /** Minimum accepted secret size, in bytes. */
  "minBytes",
] as const;

export type PhoneOtpDetailKey = (typeof PHONE_OTP_DETAIL_KEYS)[number];

export type PhoneOtpErrorDetails = Partial<
  Record<PhoneOtpDetailKey, string | number | boolean>
>;

/**
 * Fixed, code-indexed sentences. These are the *only* strings an error can
 * carry. They are English and developer-facing; the browser-facing Chinese
 * table lives in `react/messages.ts`.
 */
const ERROR_MESSAGES: Readonly<Record<PhoneOtpErrorCode, string>> = Object.freeze({
  INVALID_PHONE: "the phone number is malformed or empty",
  UNSUPPORTED_PHONE: "the phone number is not a supported mainland-mobile number",
  INVALID_PURPOSE: "the requested purpose is not configured",
  UNTRUSTED_CLIENT: "no trustworthy client identity was supplied",
  SEND_LIMITED: "the verification-code send budget is exhausted",
  SMS_SEND_FAILED: "the SMS transport did not accept the message",
  VERIFY_LIMITED: "the verification-code guess budget is exhausted",
  CODE_EXPIRED: "the verification code has expired",
  CODE_INVALID: "the verification code is wrong",
  TOO_MANY_ATTEMPTS: "too many wrong attempts for this verification code",
  INTERNAL: "the phone OTP kit failed internally",
  INVALID_CONFIG: "the phone OTP kit configuration is invalid",
  WEAK_SECRET: "the phone OTP kit HMAC secret is missing or too short",
  TEST_ONLY_COMPONENT_IN_PRODUCTION:
    "a test-only component was wired into a production runtime",
});

/**
 * Identifier-shaped strings only, so a detail value can never carry PII.
 *
 * Two guards, both mechanical: a leading letter (every real detail value is a
 * field name, a component name or a scope name, and a phone number starts with a
 * digit), and no run of six digits (which is the shape of a one-time code).
 * Without them, `{ field: "13800138000" }` would be a leak with a plausible
 * name — and a validation error is exactly the kind of thing that gets pasted
 * into a bug report.
 */
const SAFE_DETAIL_STRING = /^[A-Za-z][A-Za-z0-9_.:-]{0,31}$/;
const DIGIT_RUN = /\d{6,}/;

/**
 * Drop anything that is not a known key with a primitive, bounded value.
 * A caller passing `{ phone: "+8613800138000" }` gets `{}` back, not a leak.
 */
export function sanitizeDetails(details: unknown): PhoneOtpErrorDetails {
  if (typeof details !== "object" || details === null) return {};
  const out: Record<string, string | number | boolean> = {};
  let entries: [string, unknown][];
  try { entries = Object.entries(details); } catch { return {}; }
  const numericCaps: Record<string, number> = { retryAfterMs: 86_400_000, windowMs: 86_400_000, attemptsRemaining: 20, limit: 100_000, minBytes: 32 };
  for (const [key, value] of entries) {
    if (!(PHONE_OTP_DETAIL_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value === "number") {
      const cap = numericCaps[key];
      if (cap !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= cap) {
        out[key] = value;
      }
    } else if (typeof value === "string") {
      if (key === "field" && SAFE_DETAIL_STRING.test(value) && !DIGIT_RUN.test(value)) out[key] = value;
      if (key === "component" && ["store", "limiter", "transport"].includes(value)) out[key] = value;
      if (key === "scope" && ["phone", "client"].includes(value)) out[key] = value;
    }
  }
  return out as PhoneOtpErrorDetails;
}

/**
 * The only error type this module throws.
 *
 * The constructor takes a code, not a message: there is no parameter through
 * which a caller (or a wrapped provider error) can inject text. `cause` is
 * deliberately never set — the reference implementation attached provider text
 * to `cause`, which no code read but every `console.error(err)` would print.
 */
export class PhoneOtpKitError extends Error {
  readonly code: PhoneOtpErrorCode;

  readonly details: PhoneOtpErrorDetails;

  constructor(code: PhoneOtpErrorCode, details?: PhoneOtpErrorDetails) {
    const safeCode = isPhoneOtpErrorCode(code) ? code : "INTERNAL";
    super(ERROR_MESSAGES[safeCode]);
    this.name = "PhoneOtpKitError";
    this.code = safeCode;
    this.details = sanitizeDetails(details);
    // Keep the stack pointing at the throw site, not at this constructor.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, PhoneOtpKitError);
    }
  }

  /** `JSON.stringify` of this error is safe to log. */
  toJSON(): { name: string; code: PhoneOtpErrorCode; details: PhoneOtpErrorDetails } {
    return { name: this.name, code: this.code, details: this.details };
  }
}

export function isPhoneOtpKitError(value: unknown): value is PhoneOtpKitError {
  return value instanceof PhoneOtpKitError;
}

export function isPhoneOtpResponseCode(value: unknown): value is PhoneOtpResponseCode {
  return (
    typeof value === "string" &&
    (PHONE_OTP_RESPONSE_CODES as readonly string[]).includes(value)
  );
}

export function isPhoneOtpErrorCode(value: unknown): value is PhoneOtpErrorCode {
  return (
    isPhoneOtpResponseCode(value) ||
    (typeof value === "string" && (PHONE_OTP_CONFIG_CODES as readonly string[]).includes(value))
  );
}

/**
 * The fixed sentence for a code, or `undefined` for anything not on the list.
 * Callers rendering user-visible text must go through this rather than reading
 * a code off the wire and printing it.
 */
export function safeMessageFor(code: unknown): string | undefined {
  return isPhoneOtpErrorCode(code) ? ERROR_MESSAGES[code] : undefined;
}
