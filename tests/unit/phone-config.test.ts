// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phone sign-in configuration, parsed strictly.
 *
 * The properties worth pinning are the refusals: production must not default to
 * the in-process outbox, must not fall back to the development HMAC key, and
 * must not start with half of an Aliyun account. A value that fails these is a
 * boot error, and a boot error is what stops a deployment that cannot deliver a
 * code from pretending it can.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPhoneSettings,
  isPhoneOtpPurpose,
  PHONE_OTP_PURPOSES,
  VIRTUAL_PHONE_OTP_SECRET,
} from "../../server/src/lib/phone/config.js";

const ALIYUN_ENV = {
  SMS_TRANSPORT: "aliyun",
  SMS_ALIYUN_ACCESS_KEY_ID: "test-key-id",
  SMS_ALIYUN_ACCESS_KEY_SECRET: "test-key-secret",
  SMS_ALIYUN_SIGN_NAME: "KoBook",
  SMS_ALIYUN_TEMPLATE_CODE: "SMS_123456789",
};

const PRODUCTION_ENV = {
  ...ALIYUN_ENV,
  PHONE_OTP_SECRET: "a-production-phone-otp-secret-of-32+chars",
};

test("development and test default to the outbox and the virtual secret", () => {
  for (const nodeEnv of ["development", "test"] as const) {
    const settings = loadPhoneSettings(nodeEnv, {});
    assert.equal(settings.transport, "outbox");
    assert.equal(settings.otpSecret, VIRTUAL_PHONE_OTP_SECRET);
    assert.equal(settings.codeLength, 6);
    assert.equal(settings.codeTtlMs, 5 * 60_000);
    assert.equal(settings.maxVerifyAttempts, 5);
    assert.equal(settings.sendPhoneLimit, 1);
    assert.equal(settings.sendPhoneWindowMs, 60_000);
    assert.equal(settings.sendClientLimit, 10);
    assert.equal(settings.aliyun, undefined);
  }
});

test("production refuses the outbox, an unset transport and the virtual secret", () => {
  assert.throws(() => loadPhoneSettings("production", {}), /SMS_TRANSPORT is required/u);
  assert.throws(
    () => loadPhoneSettings("production", { SMS_TRANSPORT: "outbox" }),
    /outbox is refused in production/u,
  );
  assert.throws(
    () => loadPhoneSettings("production", { ...ALIYUN_ENV }),
    /PHONE_OTP_SECRET must be set/u,
  );
  assert.throws(
    () =>
      loadPhoneSettings("production", {
        ...ALIYUN_ENV,
        PHONE_OTP_SECRET: VIRTUAL_PHONE_OTP_SECRET,
      }),
    /PHONE_OTP_SECRET must be set/u,
  );
  assert.throws(
    () => loadPhoneSettings("production", { ...PRODUCTION_ENV, PHONE_OTP_SECRET: "short" }),
    /at least 32 characters/u,
  );
});

test("a complete Aliyun configuration loads, and a partial one does not", () => {
  const settings = loadPhoneSettings("production", PRODUCTION_ENV);
  assert.equal(settings.transport, "aliyun");
  assert.deepEqual(settings.aliyun, {
    accessKeyId: "test-key-id",
    accessKeySecret: "test-key-secret",
    signName: "KoBook",
    templateCode: "SMS_123456789",
    region: "cn-hangzhou",
  });
  assert.equal(settings.otpSecret, PRODUCTION_ENV.PHONE_OTP_SECRET);

  for (const missing of [
    "SMS_ALIYUN_ACCESS_KEY_ID",
    "SMS_ALIYUN_ACCESS_KEY_SECRET",
    "SMS_ALIYUN_SIGN_NAME",
    "SMS_ALIYUN_TEMPLATE_CODE",
  ] as const) {
    const partial: Record<string, string | undefined> = { ...PRODUCTION_ENV };
    delete partial[missing];
    assert.throws(() => loadPhoneSettings("production", partial), new RegExp(missing, "u"));
  }
});

test("an unknown transport and an out-of-range number are refused", () => {
  assert.throws(
    () => loadPhoneSettings("development", { SMS_TRANSPORT: "carrier-pigeon" }),
    /must be outbox or aliyun/u,
  );
  assert.throws(
    () => loadPhoneSettings("development", { PHONE_OTP_TTL_MS: "1000" }),
    /PHONE_OTP_TTL_MS/u,
  );
  assert.throws(
    () => loadPhoneSettings("development", { PHONE_OTP_MAX_ATTEMPTS: "99" }),
    /PHONE_OTP_MAX_ATTEMPTS/u,
  );
  assert.throws(
    () => loadPhoneSettings("development", { PHONE_OTP_SEND_PHONE_LIMIT: "0" }),
    /PHONE_OTP_SEND_PHONE_LIMIT/u,
  );
});

test("explicit values are honoured", () => {
  const settings = loadPhoneSettings("test", {
    SMS_TRANSPORT: "outbox",
    PHONE_OTP_SECRET: "x".repeat(40),
    PHONE_OTP_TTL_MS: "120000",
    PHONE_OTP_MAX_ATTEMPTS: "3",
    PHONE_OTP_SEND_PHONE_LIMIT: "4",
    PHONE_OTP_SEND_PHONE_WINDOW_MS: "30000",
    PHONE_OTP_SEND_CLIENT_LIMIT: "7",
    PHONE_OTP_SEND_CLIENT_WINDOW_MS: "45000",
  });
  assert.equal(settings.otpSecret, "x".repeat(40));
  assert.equal(settings.codeTtlMs, 120_000);
  assert.equal(settings.maxVerifyAttempts, 3);
  assert.equal(settings.sendPhoneLimit, 4);
  assert.equal(settings.sendPhoneWindowMs, 30_000);
  assert.equal(settings.sendClientLimit, 7);
  assert.equal(settings.sendClientWindowMs, 45_000);
});

test("the purpose allowlist is exactly the flows the UI has", () => {
  assert.deepEqual([...PHONE_OTP_PURPOSES], [
    "sign-up",
    "sign-in",
    "sign-in-or-up",
    "reset-password",
  ]);
  for (const purpose of PHONE_OTP_PURPOSES) assert.equal(isPhoneOtpPurpose(purpose), true);
  for (const value of ["", "signup", "SIGN-IN", "bind-phone", null, 42, {}]) {
    assert.equal(isPhoneOtpPurpose(value), false);
  }
});
