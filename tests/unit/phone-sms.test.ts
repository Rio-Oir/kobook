// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The Aliyun SMS adapter and the development outbox.
 *
 * What is pinned here:
 *
 *   - the RPC signature matches a known-answer vector, so a refactor that
 *     reorders parameters or forgets to percent-encode fails loudly instead of
 *     producing a signature the provider silently rejects;
 *   - the destination is sent in national form (`13800138000`), because a `+86`
 *     prefix is rejected by the provider as an illegal number;
 *   - every provider outcome folds into the kit's failure allowlist, and the
 *     provider's own message text never appears in a result or a log line;
 *   - the outbox keeps the code where the acceptance run can read it and
 *     nowhere in the log unless the environment is development.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ALIYUN_SMS_ENDPOINT,
  classifyAliyunCode,
  createAliyunSmsTransport,
  signAliyunRequest,
  toNationalNumber,
} from "../../server/src/lib/phone/aliyun.js";
import { createSmsOutbox } from "../../server/src/lib/phone/outbox.js";
import type { SmsLogger, SmsSendRequest } from "../../server/src/lib/phone/transport.js";

const SEND: SmsSendRequest = {
  toE164: "+8613800138000",
  maskedTo: "138****8000",
  code: "123456",
  purpose: "sign-in",
  ttlSeconds: 300,
};

/** A logger that records every call, so a leak is observable. */
function recordingLogger(): { logger: SmsLogger; calls: unknown[] } {
  const calls: unknown[] = [];
  const record = (obj: Record<string, unknown>, msg?: string): void => {
    calls.push({ obj, msg });
  };
  return { logger: { info: record, debug: record, error: record }, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the RPC signature matches a known-answer vector", () => {
  const parameters: Record<string, string> = {
    AccessKeyId: "test-key",
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: "13800138000",
    RegionId: "cn-hangzhou",
    SignName: "KoBook",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: "00000000-0000-4000-8000-000000000000",
    SignatureVersion: "1.0",
    TemplateCode: "SMS_123456789",
    TemplateParam: JSON.stringify({ code: "123456" }),
    Timestamp: "2026-10-20T03:00:00Z",
    Version: "2017-05-25",
  };
  assert.equal(
    signAliyunRequest(parameters, "test-secret"),
    "fl9sSDpeZVDdUY1eJuYs73MUf6Q=",
  );
  // Key order is irrelevant: the algorithm sorts.
  const reordered = Object.fromEntries(Object.entries(parameters).reverse());
  assert.equal(
    signAliyunRequest(reordered, "test-secret"),
    "fl9sSDpeZVDdUY1eJuYs73MUf6Q=",
  );
  // A different secret is a different signature.
  assert.notEqual(
    signAliyunRequest(parameters, "other-secret"),
    "fl9sSDpeZVDdUY1eJuYs73MUf6Q=",
  );
});

test("the destination is converted to the national form Aliyun expects", () => {
  assert.equal(toNationalNumber("+8613800138000"), "13800138000");
  assert.equal(toNationalNumber("13800138000"), "13800138000");
  assert.equal(toNationalNumber("+14155552671"), "14155552671");
});

test("provider codes fold into the kit's failure allowlist", () => {
  assert.equal(classifyAliyunCode("isv.BUSINESS_LIMIT_CONTROL"), "RATE_LIMITED");
  assert.equal(classifyAliyunCode("isv.DAY_LIMIT_CONTROL"), "RATE_LIMITED");
  assert.equal(classifyAliyunCode("isv.MOBILE_NUMBER_ILLEGAL"), "INVALID_DESTINATION");
  assert.equal(classifyAliyunCode("isv.SMS_TEMPLATE_ILLEGAL"), "REJECTED");
  // A bad AccessKey or a signature mismatch is a deployment mistake, reported
  // by the provider under a non-2xx status even though the body is JSON.
  assert.equal(classifyAliyunCode("InvalidAccessKeyId.NotFound"), "REJECTED");
  assert.equal(classifyAliyunCode("SignatureDoesNotMatch"), "REJECTED");
  assert.equal(classifyAliyunCode("isv.SIGNATURE_DOES_NOT_MATCH"), "UNKNOWN");
  assert.equal(classifyAliyunCode(""), "UNKNOWN");
});

test("a successful send posts the signed form, with the code only in the body", async () => {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const transport = createAliyunSmsTransport({
    accessKeyId: "test-key",
    accessKeySecret: "test-secret",
    signName: "KoBook",
    templateCode: "SMS_123456789",
    region: "cn-hangzhou",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ Code: "OK", Message: "OK", RequestId: "req-1", BizId: "biz-1" });
    }) as typeof fetch,
  });

  const result = await transport.send(SEND);
  assert.deepEqual(result, { ok: true });

  assert.equal(captured.length, 1);
  const request = captured[0];
  assert.ok(request);
  assert.equal(request.url, ALIYUN_SMS_ENDPOINT);
  assert.equal(request.init.method, "POST");
  assert.match(String((request.init.headers as Record<string, string>)["content-type"]), /x-www-form-urlencoded/u);

  const body = new URLSearchParams(String(request.init.body));
  assert.equal(body.get("PhoneNumbers"), "13800138000");
  assert.equal(body.get("SignName"), "KoBook");
  assert.equal(body.get("TemplateCode"), "SMS_123456789");
  assert.deepEqual(JSON.parse(body.get("TemplateParam") ?? "{}"), { code: "123456" });
  assert.equal(body.get("Action"), "SendSms");
  assert.equal(body.get("Version"), "2017-05-25");
  assert.ok((body.get("Signature") ?? "").length > 0);
  // The endpoint carries no credential; the code travels in the signed body.
  assert.equal(request.url.includes("123456"), false);
  assert.equal(request.url.includes("13800138000"), false);
});

test("a provider refusal is classified, never retried, and never echoes its message", async () => {
  const { logger, calls } = recordingLogger();
  let attempts = 0;
  const transport = createAliyunSmsTransport({
    accessKeyId: "test-key",
    accessKeySecret: "test-secret",
    signName: "KoBook",
    templateCode: "SMS_123456789",
    region: "cn-hangzhou",
    fetchImpl: (async () => {
      attempts += 1;
      // Provider messages routinely embed the destination and the template
      // parameter. None of this may reach a result or a log.
      return jsonResponse({
        Code: "isv.BUSINESS_LIMIT_CONTROL",
        Message: "触发号码 13800138000 的天级流控，参数 {\"code\":\"123456\"}",
      });
    }) as typeof fetch,
  });
  transport.attachLogger(logger);

  const result = await transport.send(SEND);
  assert.deepEqual(result, { ok: false, failure: "RATE_LIMITED" });
  assert.equal(attempts, 1, "the adapter must not retry: the send budget was already charged");
  const logged = JSON.stringify(calls);
  assert.equal(logged.includes("13800138000"), false);
  assert.equal(logged.includes("123456"), false);
  assert.match(logged, /RATE_LIMITED/u);
});

test("transport failures and malformed responses degrade to fixed codes", async () => {
  const failure = createAliyunSmsTransport({
    accessKeyId: "k",
    accessKeySecret: "s",
    signName: "KoBook",
    templateCode: "SMS_1",
    region: "cn-hangzhou",
    fetchImpl: (async () => {
      throw new Error("getaddrinfo ENOTFOUND dysmsapi.aliyuncs.com for 13800138000");
    }) as typeof fetch,
  });
  assert.deepEqual(await failure.send(SEND), { ok: false, failure: "TRANSPORT_UNAVAILABLE" });

  const serverError = createAliyunSmsTransport({
    accessKeyId: "k",
    accessKeySecret: "s",
    signName: "KoBook",
    templateCode: "SMS_1",
    region: "cn-hangzhou",
    fetchImpl: (async () => jsonResponse({ Message: "boom 13800138000" }, 503)) as typeof fetch,
  });
  assert.deepEqual(await serverError.send(SEND), { ok: false, failure: "TRANSPORT_UNAVAILABLE" });

  const throttled = createAliyunSmsTransport({
    accessKeyId: "k",
    accessKeySecret: "s",
    signName: "KoBook",
    templateCode: "SMS_1",
    region: "cn-hangzhou",
    fetchImpl: (async () => jsonResponse({ Message: "slow down" }, 429)) as typeof fetch,
  });
  assert.deepEqual(await throttled.send(SEND), { ok: false, failure: "RATE_LIMITED" });

  const garbage = createAliyunSmsTransport({
    accessKeyId: "k",
    accessKeySecret: "s",
    signName: "KoBook",
    templateCode: "SMS_1",
    region: "cn-hangzhou",
    // A 200 that is not JSON is a broken gateway, not a provider refusal.
    fetchImpl: (async () => new Response("<html>gateway</html>", { status: 200 })) as typeof fetch,
  });
  assert.deepEqual(await garbage.send(SEND), { ok: false, failure: "TRANSPORT_UNAVAILABLE" });

  // The provider reports a bad AccessKey as HTTP 404 with a JSON body. The body
  // has to win over the status, or an operator chasing a network problem never
  // finds the credential typo.
  const badKey = createAliyunSmsTransport({
    accessKeyId: "k",
    accessKeySecret: "s",
    signName: "KoBook",
    templateCode: "SMS_1",
    region: "cn-hangzhou",
    fetchImpl: (async () =>
      jsonResponse(
        {
          RequestId: "req-1",
          Message: "Specified access key is not found.",
          Code: "InvalidAccessKeyId.NotFound",
        },
        404,
      )) as typeof fetch,
  });
  assert.deepEqual(await badKey.send(SEND), { ok: false, failure: "REJECTED" });
});

test("the outbox keeps the code for the reader and filters by purpose", async () => {
  const outbox = createSmsOutbox({ logCodes: false });
  const { logger, calls } = recordingLogger();
  outbox.attachLogger(logger);

  assert.deepEqual(await outbox.send(SEND), { ok: true });
  assert.deepEqual(
    await outbox.send({ ...SEND, purpose: "reset-password", code: "654321" }),
    { ok: true },
  );

  const latest = outbox.latestFor("+8613800138000");
  assert.equal(latest?.code, "654321");
  assert.equal(latest?.purpose, "reset-password");
  assert.equal(outbox.latestFor("+8613800138000", "sign-in")?.code, "123456");
  assert.equal(outbox.latestFor("+8613900139000"), undefined);

  const listed = outbox.list(10);
  assert.equal(listed.length, 2);
  assert.equal(listed[0]?.code, "654321", "newest first");

  // With `logCodes: false` the code is stored but never printed.
  const logged = JSON.stringify(calls);
  assert.equal(logged.includes("123456"), false);
  assert.equal(logged.includes("654321"), false);

  outbox.clear();
  assert.equal(outbox.list(10).length, 0);
});

test("the development outbox prints the code only when asked to", async () => {
  const outbox = createSmsOutbox({ logCodes: true });
  const { logger, calls } = recordingLogger();
  outbox.attachLogger(logger);
  await outbox.send(SEND);
  const logged = JSON.stringify(calls);
  assert.match(logged, /123456/u);
  assert.equal(logged.includes("13800138000"), false, "the full number is never logged");
});
