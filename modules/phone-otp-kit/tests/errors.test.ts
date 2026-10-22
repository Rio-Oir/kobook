// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The error allowlist.
 *
 * The claim under test is narrow and mechanical: *nothing a caller can pass in
 * comes back out*. Not through the message (there is no message parameter), not
 * through `details` (unknown keys and PII-shaped values are dropped), and not
 * through `cause` (the property is never set). A raw provider error cannot leak
 * through this type, so no reviewer has to check every throw site by hand.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPhoneOtpErrorCode,
  isPhoneOtpKitError,
  interpretSmsSendResult,
  isPhoneOtpResponseCode,
  PHONE_OTP_CONFIG_CODES,
  PHONE_OTP_DETAIL_KEYS,
  PHONE_OTP_RESPONSE_CODES,
  PhoneOtpKitError,
  safeMessageFor,
  sanitizeDetails,
  toSecretBytes,
  toSafeSmsFailure,
  SMS_FAILURE_CODES,
} from "../src/server";

/* ───────────────────────────── the table ───────────────────────────── */

test("every code has a fixed sentence and nothing is shared by accident", () => {
  const seen = new Set<string>();
  for (const code of [...PHONE_OTP_RESPONSE_CODES, ...PHONE_OTP_CONFIG_CODES]) {
    const message = safeMessageFor(code);
    assert.equal(typeof message, "string", code);
    assert.ok((message ?? "").length > 5, code);
    assert.ok(!seen.has(message ?? ""), `${code} shares its sentence with another code`);
    seen.add(message ?? "");
  }
});

test("an off-list code has no sentence", () => {
  for (const value of ["NOPE", "", null, undefined, 42, {}, ["INVALID_OTP"], "invalid_phone"]) {
    assert.equal(safeMessageFor(value), undefined, JSON.stringify(value) ?? "undefined");
  }
});

test("the two families are recognised separately", () => {
  for (const code of PHONE_OTP_RESPONSE_CODES) {
    assert.equal(isPhoneOtpResponseCode(code), true);
    assert.equal(isPhoneOtpErrorCode(code), true);
  }
  for (const code of PHONE_OTP_CONFIG_CODES) {
    assert.equal(isPhoneOtpResponseCode(code), false, "config codes are not request outcomes");
    assert.equal(isPhoneOtpErrorCode(code), true);
  }
  assert.equal(
    isPhoneOtpErrorCode("INVALID_OTP"),
    false,
    "better-auth's phone-number plugin codes are not this module's codes",
  );
  assert.equal(isPhoneOtpErrorCode("OTP_NOT_FOUND"), false);
});

/* ──────────────────────── the error object ──────────────────────── */

test("an error carries its code and the fixed sentence", () => {
  const error = new PhoneOtpKitError("SEND_LIMITED", { retryAfterMs: 30_000, scope: "phone" });
  assert.equal(error.name, "PhoneOtpKitError");
  assert.equal(error.code, "SEND_LIMITED");
  assert.equal(error.message, safeMessageFor("SEND_LIMITED"));
  assert.deepEqual(error.details, { retryAfterMs: 30_000, scope: "phone" });
  assert.ok(isPhoneOtpKitError(error));
  assert.ok(error instanceof Error);
});

test("there is no cause, so a wrapped provider error cannot ride along", () => {
  const vendorFailure = new Error(
    "Aliyun SMS transport failed for +8613800138000: invalid template 13800138000",
  );
  const error = new PhoneOtpKitError("SMS_SEND_FAILED");
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.equal((error as { cause?: unknown }).cause, undefined);
  const rendered = `${error.message} ${JSON.stringify(error)} ${error.stack ?? ""}`;
  assert.ok(!rendered.includes("Aliyun"));
  assert.ok(!rendered.includes("13800138000"));
  // And the vendor error is untouched, of course — it is simply not attached.
  assert.ok(vendorFailure.message.includes("Aliyun"));
});

test("details cannot smuggle a phone number or a code through a known key", () => {
  const hostile = {
    field: "13800138000",
    component: "+8613800138000",
    scope: "123456",
    retryAfterMs: "13800138000",
    attemptsRemaining: null,
    limit: {},
    windowMs: [1],
    minBytes: undefined,
  };
  assert.deepEqual(sanitizeDetails(hostile), {});
});

test("a six-digit run is refused even in a letter-leading value", () => {
  assert.deepEqual(sanitizeDetails({ field: "code123456" }), {});
  assert.deepEqual(sanitizeDetails({ field: "code12345" }), { field: "code12345" });
});

test("details drops unknown keys and non-primitives but keeps real ones", () => {
  const sanitized = sanitizeDetails({
    field: "limits.send",
    component: "store",
    scope: "client",
    retryAfterMs: 1_500,
    attemptsRemaining: 0,
    limit: 5,
    windowMs: 60_000,
    minBytes: 32,
    phone: "+8613800138000",
    code: "123456",
    phoneRef: "deadbeef",
    nested: { secret: "x" },
    when: () => 0,
  });
  assert.deepEqual(sanitized, {
    field: "limits.send",
    component: "store",
    scope: "client",
    retryAfterMs: 1_500,
    attemptsRemaining: 0,
    limit: 5,
    windowMs: 60_000,
    minBytes: 32,
  });
  for (const kept of Object.keys(sanitized)) {
    assert.ok((PHONE_OTP_DETAIL_KEYS as readonly string[]).includes(kept), kept);
  }
});

test("details drops numbers that are not safe integers", () => {
  assert.deepEqual(sanitizeDetails({ retryAfterMs: Number.NaN }), {});
  assert.deepEqual(sanitizeDetails({ retryAfterMs: Number.POSITIVE_INFINITY }), {});
  assert.deepEqual(sanitizeDetails({ retryAfterMs: 1.5 }), {});
  assert.deepEqual(sanitizeDetails({ retryAfterMs: -1 }), {});
});

test("JSON.stringify of an error is safe to log", () => {
  const error = new PhoneOtpKitError("VERIFY_LIMITED", {
    retryAfterMs: 900_000,
    scope: "phone",
    phone: "+8613800138000",
  } as never);
  assert.deepEqual(error.toJSON(), {
    name: "PhoneOtpKitError",
    code: "VERIFY_LIMITED",
    details: { retryAfterMs: 900_000, scope: "phone" },
  });
  const json = JSON.stringify(error);
  assert.ok(!json.includes("13800138000"));
  assert.ok(!json.includes("+86"));
});

/* ───────────────────────── secret handling ───────────────────────── */

test("a short secret is refused rather than warned about", () => {
  // A distinctive value so "is the secret echoed back?" is answerable: an
  // English word like "short" would match the sentence that reports the field.
  const distinctive = "hunter2-do-not-echo-me";
  for (const secret of ["", distinctive, new Uint8Array(31)]) {
    assert.throws(
      () => toSecretBytes(secret),
      (error: unknown) => {
        assert.ok(isPhoneOtpKitError(error));
        assert.equal(error.code, "WEAK_SECRET");
        assert.equal(error.details.minBytes, 32);
        // The offending value is not echoed anywhere.
        const rendered = `${error.message} ${JSON.stringify(error)} ${error.stack ?? ""}`;
        assert.ok(!rendered.includes(distinctive));
        return true;
      },
    );
  }
});

test("a non-string, non-bytes secret is refused with the same code", () => {
  for (const secret of [undefined, null, 42, {}, []]) {
    assert.throws(() => toSecretBytes(secret), (error: unknown) => {
      assert.ok(isPhoneOtpKitError(error));
      assert.equal(error.code, "WEAK_SECRET");
      return true;
    });
  }
});

test("exactly 32 bytes is accepted", () => {
  assert.equal(toSecretBytes("x".repeat(32)).length, 32);
  assert.equal(toSecretBytes(new Uint8Array(32)).length, 32);
  assert.equal(toSecretBytes("你".repeat(11)).length, 33, "measured in bytes, not characters");
  assert.throws(() => toSecretBytes("你".repeat(10)));
});

/* ───────────────────── transport failure classification ───────────────────── */

test("a thrown error is classified without reading it", () => {
  const withCode = Object.assign(new Error("boom"), { failure: "RATE_LIMITED" });
  assert.equal(toSafeSmsFailure(withCode), "RATE_LIMITED");
  assert.equal(toSafeSmsFailure({ failure: "REJECTED" }), "REJECTED");
  assert.equal(toSafeSmsFailure(new Error("Aliyun says: bad template")), "UNKNOWN");
  assert.equal(toSafeSmsFailure(Object.assign(new Error("x"), { failure: "NOT_A_CODE" })), "UNKNOWN");
  for (const value of [undefined, null, "", 0, "RATE_LIMITED", [], () => undefined]) {
    assert.equal(toSafeSmsFailure(value), "UNKNOWN");
  }
});

test("a property read that throws is classified, not propagated", () => {
  // The thrown value is arbitrary external data: reading it can run a getter.
  const hostile = {
    get failure(): string {
      throw new Error("getter side effect: +8613800138000");
    },
  };
  assert.equal(toSafeSmsFailure(hostile), "UNKNOWN");

  const hostileProxy = new Proxy({}, {
    get(): never {
      throw new Error("proxy trap");
    },
  });
  assert.equal(toSafeSmsFailure(hostileProxy), "UNKNOWN");
});

test("a transport result is checked, not trusted", () => {
  // `ok` must be exactly `true`. Anything truthy but not `true` is a malformed
  // result, and treating it as a confirmation is how a broken adapter turns a
  // failed send into a published, unusable code.
  for (const value of [undefined, null, 0, 1, "ok", "", [], () => undefined, true, {}, { ok: 1 }]) {
    const result = interpretSmsSendResult(value);
    assert.equal(result.ok, false, JSON.stringify(value) ?? "undefined");
    assert.equal(result.failure, "UNKNOWN", JSON.stringify(value) ?? "undefined");
  }

  for (const ok of ["yes", 1, {}, [], null]) {
    const result = interpretSmsSendResult({ ok });
    assert.equal(result.ok, false, String(ok));
    assert.equal(result.failure, "UNKNOWN", String(ok));
  }

  assert.deepEqual(interpretSmsSendResult({ ok: true }), { ok: true });
  assert.deepEqual(interpretSmsSendResult({ ok: false, failure: "REJECTED" }), {
    ok: false,
    failure: "REJECTED",
  });
  // A failure code that is not on the allowlist is replaced, never passed on —
  // this is what keeps provider text from reaching the operator hook.
  for (const failure of ["Aliyun: template rejected", 500, null, {}, ["REJECTED"]]) {
    assert.deepEqual(interpretSmsSendResult({ ok: false, failure }), { ok: false, failure: "UNKNOWN" });
  }
});

test("a transport result whose property access throws is a failure", () => {
  const throwingOk = {
    get ok(): boolean {
      throw new Error("getter side effect");
    },
  };
  assert.deepEqual(interpretSmsSendResult(throwingOk), { ok: false, failure: "UNKNOWN" });

  const throwingFailure = {
    ok: false,
    get failure(): string {
      throw new Error("getter side effect: +8613800138000");
    },
  };
  assert.deepEqual(interpretSmsSendResult(throwingFailure), { ok: false, failure: "UNKNOWN" });
});

test("every sms failure code is a distinct, closed value", () => {
  assert.deepEqual(new Set(SMS_FAILURE_CODES).size, SMS_FAILURE_CODES.length);
  assert.ok(SMS_FAILURE_CODES.includes("UNKNOWN"), "there is always somewhere to put the unclassified");
  // Classification never carries text: these are the only values a transport's
  // failure can take, and none of them is a message.
  for (const code of SMS_FAILURE_CODES) {
    assert.match(code, /^[A-Z_]+$/);
  }
});
