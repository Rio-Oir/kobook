// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phone-number sign-in configuration.
 *
 * Read once, at startup, from the environment: the SMS delivery mode, the
 * provider credentials, and the HMAC key the one-time codes are digested with.
 * Nothing here is read at request time, so a configuration mistake fails the
 * boot instead of surfacing as a silently weaker runtime.
 *
 * The rules are the same shape the mail settings use, for the same reason:
 *
 *  - `SMS_TRANSPORT` defaults to the in-process outbox in development/test and
 *    is refused in production, where it would mean "pretend a message was
 *    delivered";
 *  - a production process must have an explicit HMAC secret; the development
 *    placeholder is deliberately obvious and is rejected there. Deriving it
 *    from `BETTER_AUTH_SECRET` would look tidy and would couple two unrelated
 *    rotations, so it is its own value;
 *  - every provider value is required together: half-configured Aliyun SMS is
 *    a startup error, not a runtime surprise at the first send.
 *
 * No value read here is ever logged.
 */

import type { NodeEnv } from "../../env.js";

/** Delivery modes. `outbox` is development/test only. */
export type SmsTransportMode = "outbox" | "aliyun";

export interface AliyunSmsSettings {
  accessKeyId: string;
  accessKeySecret: string;
  /** Approved sign name, e.g. KoBook. */
  signName: string;
  /** Approved template code, e.g. SMS_123456789. */
  templateCode: string;
  /** API region. Aliyun SMS is served from cn-hangzhou for all regions. */
  region: string;
}

export interface PhoneSettings {
  transport: SmsTransportMode;
  /** Present exactly when `transport === "aliyun"`. */
  aliyun?: AliyunSmsSettings;
  /** HMAC key for the phone/code digests. At least 32 bytes. */
  otpSecret: string;
  /** Digits per code. Fixed at six for the UI's single input. */
  codeLength: 6;
  /** Code lifetime. The kit's default is five minutes. */
  codeTtlMs: number;
  /** Wrong guesses per challenge before it is burned. */
  maxVerifyAttempts: number;
  /**
   * Resend budget per number: at most `sendPhoneLimit` messages per
   * `sendPhoneWindowMs`. Defaults to one a minute, which is the resend gate
   * the UI's countdown mirrors. Exposed because the acceptance run needs to
   * send twice in a row to reach the duplicate-registration path, and because
   * a deployment with a different provider quota may want a different ceiling.
   */
  sendPhoneLimit: number;
  sendPhoneWindowMs: number;
  /**
   * Per-client (server-derived address) ceiling for the same bucket. Separate
   * from the per-number rule because one address legitimately covers several
   * numbers (a family, a shared office), and a deployment behind a proxy that
   * cannot resolve the peer may want to widen it.
   */
  sendClientLimit: number;
  sendClientWindowMs: number;
}

/**
 * Development-only HMAC placeholder, in the same spirit as
 * `VIRTUAL_DEV_SECRET`: long enough for the kit's length check, obviously not
 * a secret, and refused in production.
 */
export const VIRTUAL_PHONE_OTP_SECRET =
  "virtual-development-phone-otp-secret-not-for-production-0000";

/** The kit refuses a key shorter than 32 bytes; the check is repeated here so
 *  the failure is a startup message instead of a constructor stack. */
const MIN_SECRET_BYTES = 32;

const DEFAULT_CODE_TTL_MS = 5 * 60_000;
const MIN_CODE_TTL_MS = 30_000;
const MAX_CODE_TTL_MS = 30 * 60_000;

const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;
const MIN_VERIFY_ATTEMPTS = 1;
const MAX_VERIFY_ATTEMPTS = 10;

const TEMPLATE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function fail(message: string): never {
  throw new Error(message);
}

function readTransport(nodeEnv: NodeEnv, raw: string | undefined): SmsTransportMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "outbox" || value === "aliyun") {
    if (value === "outbox" && nodeEnv === "production") {
      fail(
        "SMS_TRANSPORT=outbox is refused in production: it only keeps codes in " +
          "process memory and delivers nothing. Configure SMS_TRANSPORT=aliyun " +
          "with the SMS_ALIYUN_* settings.",
      );
    }
    return value;
  }
  if (value.length === 0) {
    // The default is the safe one in development and impossible in
    // production, so an unconfigured production deployment stops at boot
    // rather than at the first user who asks for a code.
    return nodeEnv === "production" ? fail(
      "SMS_TRANSPORT is required when NODE_ENV=production (outbox delivers nothing).",
    ) : "outbox";
  }
  return fail(`SMS_TRANSPORT must be outbox or aliyun, got ${JSON.stringify(raw)}`);
}

function readAliyun(raw: Record<string, string | undefined>): AliyunSmsSettings {
  const accessKeyId = raw["SMS_ALIYUN_ACCESS_KEY_ID"]?.trim() ?? "";
  const accessKeySecret = raw["SMS_ALIYUN_ACCESS_KEY_SECRET"]?.trim() ?? "";
  const signName = raw["SMS_ALIYUN_SIGN_NAME"]?.trim() ?? "";
  const templateCode = raw["SMS_ALIYUN_TEMPLATE_CODE"]?.trim() ?? "";
  const region = raw["SMS_ALIYUN_REGION"]?.trim() || "cn-hangzhou";

  const missing = [
    ["SMS_ALIYUN_ACCESS_KEY_ID", accessKeyId],
    ["SMS_ALIYUN_ACCESS_KEY_SECRET", accessKeySecret],
    ["SMS_ALIYUN_SIGN_NAME", signName],
    ["SMS_ALIYUN_TEMPLATE_CODE", templateCode],
  ]
    .filter(([, value]) => value === "")
    .map(([name]) => name);

  if (missing.length > 0) {
    fail(
      `SMS_TRANSPORT=aliyun requires ${missing.join(", ")}. ` +
        "All four values come from the Aliyun SMS console and must be approved " +
        "before they can deliver anything.",
    );
  }
  if (!TEMPLATE_CODE_PATTERN.test(templateCode)) {
    fail(`SMS_ALIYUN_TEMPLATE_CODE does not look like a template id: ${JSON.stringify(templateCode)}`);
  }
  if (signName.length > 32) {
    fail("SMS_ALIYUN_SIGN_NAME is longer than 32 characters.");
  }

  return { accessKeyId, accessKeySecret, signName, templateCode, region };
}

function readSecret(nodeEnv: NodeEnv, raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value.length === 0 || (nodeEnv === "production" && value === VIRTUAL_PHONE_OTP_SECRET)) {
    if (nodeEnv === "production") {
      fail(
        "PHONE_OTP_SECRET must be set when NODE_ENV=production: it keys the " +
          "digest of every phone number and one-time code. The development " +
          "placeholder is not an acceptable production credential.",
      );
    }
    return VIRTUAL_PHONE_OTP_SECRET;
  }
  if (value.length < MIN_SECRET_BYTES) {
    fail(`PHONE_OTP_SECRET must be at least ${MIN_SECRET_BYTES} characters.`);
  }
  return value;
}

function readIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadPhoneSettings(
  nodeEnv: NodeEnv,
  raw: Record<string, string | undefined> = process.env,
): PhoneSettings {
  const transport = readTransport(nodeEnv, raw["SMS_TRANSPORT"]);
  const otpSecret = readSecret(nodeEnv, raw["PHONE_OTP_SECRET"]);

  return {
    transport,
    ...(transport === "aliyun" ? { aliyun: readAliyun(raw) } : {}),
    otpSecret,
    codeLength: 6,
    codeTtlMs: readIntInRange(
      raw["PHONE_OTP_TTL_MS"],
      DEFAULT_CODE_TTL_MS,
      MIN_CODE_TTL_MS,
      MAX_CODE_TTL_MS,
      "PHONE_OTP_TTL_MS",
    ),
    maxVerifyAttempts: readIntInRange(
      raw["PHONE_OTP_MAX_ATTEMPTS"],
      DEFAULT_MAX_VERIFY_ATTEMPTS,
      MIN_VERIFY_ATTEMPTS,
      MAX_VERIFY_ATTEMPTS,
      "PHONE_OTP_MAX_ATTEMPTS",
    ),
    sendPhoneLimit: readIntInRange(
      raw["PHONE_OTP_SEND_PHONE_LIMIT"],
      1,
      1,
      10_000,
      "PHONE_OTP_SEND_PHONE_LIMIT",
    ),
    sendPhoneWindowMs: readIntInRange(
      raw["PHONE_OTP_SEND_PHONE_WINDOW_MS"],
      60_000,
      1_000,
      60 * 60_000,
      "PHONE_OTP_SEND_PHONE_WINDOW_MS",
    ),
    sendClientLimit: readIntInRange(
      raw["PHONE_OTP_SEND_CLIENT_LIMIT"],
      10,
      1,
      10_000,
      "PHONE_OTP_SEND_CLIENT_LIMIT",
    ),
    sendClientWindowMs: readIntInRange(
      raw["PHONE_OTP_SEND_CLIENT_WINDOW_MS"],
      60_000,
      1_000,
      60 * 60_000,
      "PHONE_OTP_SEND_CLIENT_WINDOW_MS",
    ),
  };
}

/** The purposes the app issues codes for. Kept here so the plugin and the
 *  tests agree on the exact set.
 *
 *  `sign-in-or-up` is the phone entry the UI uses: one code covers both
 *  outcomes, so a reader never has to know in advance whether the number
 *  already has an account. */
export const PHONE_OTP_PURPOSES = [
  "sign-up",
  "sign-in",
  "sign-in-or-up",
  "reset-password",
] as const;

export type PhoneOtpPurpose = (typeof PHONE_OTP_PURPOSES)[number];

export function isPhoneOtpPurpose(value: unknown): value is PhoneOtpPurpose {
  return (
    typeof value === "string" &&
    (PHONE_OTP_PURPOSES as readonly string[]).includes(value)
  );
}

