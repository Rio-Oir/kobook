// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { PhoneOtpPanel, type PhoneOtpRequestResult, type PhoneOtpVerifyResult } from "../src/browser";
import { constantTimeEqualHex, sanitizeDetails, PhoneOtpKitError, type PhoneOtpErrorCode } from "../src/server";
import { createHarness, PHONE_A, SIGN_IN, client } from "./support/harness";
import { mount } from "./support/dom";

test("digest comparison rejects incomplete and nonhex data instead of truncating it", () => {
  for (const [a, b] of [["abx1", "abz2"], ["abc", "abd"], ["01xx", "01zz"], ["", ""]]) {
    assert.equal(constantTimeEqualHex(a, b), false);
  }
  assert.equal(constantTimeEqualHex("abcd", "ABCD"), true);
});

test("error details reject numeric phone values and unknown error codes", () => {
  assert.deepEqual(sanitizeDetails({ field: 13800138000, retryAfterMs: 13800138000, attemptsRemaining: 123456, scope: "secret" }), {});
  assert.equal(new PhoneOtpKitError("sensitive text" as PhoneOtpErrorCode).code, "INTERNAL");
  assert.deepEqual(sanitizeDetails(Object.defineProperty({}, "field", { enumerable: true, get() { throw new Error("sensitive"); } })), {});
});

test("configuration diagnostics are detached from enforced rate rules", async () => {
  const h = createHarness({ limits: { send: { phone: [{ limit: 1, windowMs: 60_000 }] } } });
  const summary = h.service.describe() as { limits: { send: { phone: { limit: number }[] } } };
  summary.limits.send.phone[0]!.limit = 100;
  const input = { phone: PHONE_A, purpose: SIGN_IN, clientRef: client("independent") };
  assert.equal((await h.service.requestCode(input)).ok, true);
  const denied = await h.service.requestCode(input);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "SEND_LIMITED");
});

test("both panel callbacks reject null, malformed success and hostile property getters", async () => {
  const getter = Object.defineProperty({}, "ok", { get() { throw new Error("sensitive provider response"); } });
  for (const value of [null, undefined, { ok: "yes" }, { ok: 1 }, getter]) {
    const panel = await mount(createElement(PhoneOtpPanel, {
      purpose: SIGN_IN,
      onRequestCode: async () => value as unknown as PhoneOtpRequestResult,
      onVerifyCode: async () => value as unknown as PhoneOtpVerifyResult,
    }));
    try {
      await panel.type(panel.q("phone-input"), "13800138000");
      await panel.click(panel.q("send"));
      assert.equal(panel.q("notice").getAttribute("data-notice-kind"), "error");
      await panel.type(panel.q("code-input"), "123456");
      await panel.click(panel.q("verify"));
      assert.equal(panel.q("notice").getAttribute("data-notice-kind"), "error");
      assert.ok(!panel.visibleText().includes("sensitive provider response"));
    } finally { await panel.unmount(); }
  }
});
