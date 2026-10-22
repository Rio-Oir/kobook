// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The service: ordering, failure handling and what a result may contain.
 *
 * Three claims run through the whole file.
 *
 * 1. **Budget before work.** A request spends its budget before the code exists
 *    and before the provider is called, so a refusal costs nothing and an outage
 *    cannot be converted into free attempts.
 * 2. **A failure is data, never text.** Every failure below is asserted by code,
 *    and the provider-failure cases additionally assert that the vendor's string
 *    — which carries the number and the template id, as vendor strings do — is
 *    nowhere in the result, the store, or the operator hook.
 * 3. **One number, one identity, one purpose.** A code issued for a purpose and a
 *    number only works for that purpose and that number.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeSmsTransport,
  createMemoryChallengeStore,
  createMemoryRateLimiter,
  DEFAULT_LIMITS,
  generateChallengeId,
  generateOtpCode,
  PhoneOtpService,
  type OtpRateLimiter,
  type OtpRateLimitRuleset,
  type PhoneOtpConfig,
  type PhoneOtpObservation,
  type PhoneOtpRequestResult,
  type PhoneOtpVerifyResult,
  type SmsSendResult,
  type SmsTransport,
} from "../src/server";
import { notOk, ok } from "./support/assert";
import {
  BIND_PHONE,
  client,
  createHarness,
  PHONE_A,
  PHONE_B,
  SIGN_IN,
  throwingLimiter,
  throwingStore,
  type Harness,
} from "./support/harness";

const ALPHA = client("alpha");

interface RequestOverrides {
  readonly phone?: string;
  readonly clientRef?: string | null;
  readonly purpose?: string;
}

interface VerifyOverrides extends RequestOverrides {
  readonly code?: string;
}

function request(h: Harness, overrides: RequestOverrides = {}): Promise<PhoneOtpRequestResult> {
  return h.service.requestCode({
    phone: overrides.phone ?? PHONE_A,
    clientRef: overrides.clientRef === undefined ? ALPHA : overrides.clientRef,
    purpose: overrides.purpose ?? SIGN_IN,
  });
}

function verify(h: Harness, overrides: VerifyOverrides = {}): Promise<PhoneOtpVerifyResult> {
  return h.service.verifyCode({
    phone: overrides.phone ?? PHONE_A,
    code: overrides.code ?? h.lastCode(),
    clientRef: overrides.clientRef === undefined ? ALPHA : overrides.clientRef,
    purpose: overrides.purpose ?? SIGN_IN,
  });
}

/** Move past the default 60-second resend cooldown. */
function nextWindow(h: Harness): void {
  h.advance(61_000);
}

/* ───────────────────────────── happy path ───────────────────────────── */

test("a request issues one code, masks the number, and reports the countdown", async () => {
  const h = createHarness();
  const result = ok(await request(h));

  assert.equal(result.maskedPhone, "138****8000");
  assert.equal(result.purpose, SIGN_IN);
  // 0: the default send budget is a stepped pair, so no static cooldown exists.
  assert.equal(result.cooldownSeconds, 0);
  assert.equal(result.expiresInSeconds, 300);
  assert.equal(result.expiresAt, h.now() + 300_000);

  assert.equal(h.transport.outbox.length, 1);
  const delivery = h.transport.outbox[0];
  if (delivery === undefined) throw new Error("expected one delivery");
  assert.equal(delivery.toE164, PHONE_A);
  assert.match(delivery.code, /^\d{6}$/);
  assert.equal(delivery.purpose, SIGN_IN);
  assert.equal(delivery.delivered, true);
  assert.equal(delivery.maskedTo, "138****8000");

  // The code is live, and the store holds a digest rather than the code.
  assert.equal(h.store.stats().active, 1);
  assert.ok(!JSON.stringify(h.store.unsafeAllViews()).includes(delivery.code));
});

test("a result carries no code, no challenge id and no full number", async () => {
  const h = createHarness();
  const requested = ok(await request(h));
  const code = h.lastCode();

  const rendered = JSON.stringify(requested);
  assert.ok(!rendered.includes(code), "the code is never in the response");
  assert.ok(!rendered.includes("13800138000"), "only the masked form is");
  assert.ok(!rendered.includes("challengeId"), "no id leaves the store");
  assert.ok(!rendered.includes("token"));
  assert.ok(!rendered.includes("session"));

  const verified = ok(await verify(h, { code }));
  const verifyRendered = JSON.stringify(verified);
  assert.ok(!verifyRendered.includes(code));
  assert.ok(!verifyRendered.includes("13800138000"));
  assert.deepEqual(Object.keys(verified).sort(), ["maskedPhone", "ok", "purpose"]);
});

test("a code verifies once and cannot be replayed", async () => {
  const h = createHarness();
  ok(await request(h));
  const code = h.lastCode();

  ok(await verify(h, { code }));
  const replay = notOk(await verify(h, { code }));
  assert.equal(replay.code, "CODE_INVALID");
  assert.equal(h.store.stats().active, 0);
});

test("two spellings of one number reach one challenge", async () => {
  const h = createHarness();
  ok(await request(h, { phone: "+8613800138000" }));
  const code = h.lastCode();

  // The panel sends E.164; a mobile client may send the bare national form.
  ok(await verify(h, { phone: "13800138000", code }));
});

/* ───────────────────────────── input gates ───────────────────────────── */

test("a malformed phone is refused before anything is spent", async () => {
  const h = createHarness();
  for (const phone of ["", "   ", "abc", "+86", "+8612345", "+861380013800012345"]) {
    assert.equal(notOk(await request(h, { phone })).code, "INVALID_PHONE", phone);
  }
  assert.equal(h.transport.outbox.length, 0);
  assert.equal(h.store.stats().total, 0);
  assert.equal(h.limiter.stats().timestamps, 0, "no budget was charged");

  // Which is why a valid request straight afterwards still works.
  ok(await request(h));
});

test("a valid number outside the supported country is refused as unsupported", async () => {
  const h = createHarness();
  for (const phone of ["+14155552671", "+819012345678", "+8610123456789"]) {
    assert.equal(notOk(await request(h, { phone })).code, "UNSUPPORTED_PHONE", phone);
  }
  assert.equal(h.transport.outbox.length, 0);
  ok(await request(h));
});

test("a purpose that is not configured is refused", async () => {
  const h = createHarness();
  for (const purpose of ["signin", "SIGN-IN", "", "reset-password"]) {
    assert.equal(notOk(await request(h, { purpose })).code, "INVALID_PURPOSE", purpose);
    assert.equal(notOk(await verify(h, { purpose, code: "123456" })).code, "INVALID_PURPOSE", purpose);
  }
  assert.equal(h.transport.outbox.length, 0);
  assert.equal(h.limiter.stats().timestamps, 0);
});

test("a missing or malformed client reference fails closed", async () => {
  const h = createHarness();
  // Called through the service directly rather than the `request` helper: the
  // helper treats an omitted `clientRef` as "not supplied by this test", and the
  // omitted case is exactly what is under test here.
  const cases: readonly (string | null | undefined)[] = [
    null,
    undefined,
    "",
    "short",
    "has spaces",
    "x".repeat(129),
  ];
  for (const clientRef of cases) {
    assert.equal(
      notOk(await h.service.requestCode({ phone: PHONE_A, clientRef, purpose: SIGN_IN })).code,
      "UNTRUSTED_CLIENT",
      String(clientRef),
    );
    assert.equal(
      notOk(await h.service.verifyCode({ phone: PHONE_A, code: "123456", clientRef, purpose: SIGN_IN })).code,
      "UNTRUSTED_CLIENT",
      String(clientRef),
    );
  }
  assert.equal(h.transport.outbox.length, 0);
  assert.equal(h.limiter.stats().timestamps, 0, "an untrusted request spends nothing");
  ok(await request(h));
});

test("the client check can be lifted explicitly, and then shares one bucket", async () => {
  const h = createHarness({
    requireTrustedClient: false,
    limits: { send: { client: [{ limit: 1, windowMs: 60_000 }] } },
  });
  ok(await request(h, { clientRef: null }));
  // Every unreferenced caller is one bucket, which is the conservative reading.
  assert.equal(notOk(await request(h, { clientRef: null, phone: PHONE_B })).code, "SEND_LIMITED");
});

test("a code of the wrong shape is refused without reaching the limiter", async () => {
  const h = createHarness();
  for (const code of ["", "12345", "1234567", "12345a", "abcdef", "123456 ", "１２３４５６"]) {
    assert.equal(notOk(await verify(h, { code })).code, "CODE_INVALID", code);
  }
  assert.equal(h.limiter.stats().timestamps, 0, "a shape check is free");
  assert.equal(h.transport.outbox.length, 0);

  // And it never cost the user an attempt: the real code still has a full
  // allowance after one wrong guess.
  ok(await request(h));
  const wrong = notOk(await verify(h, { code: "000000" }));
  assert.equal(wrong.attemptsRemaining, 4);
});

/* ───────────────────────────── the budgets ───────────────────────────── */

test("a second send inside the cooldown is refused with the wait", async () => {
  const h = createHarness();
  ok(await request(h));
  const limited = notOk(await request(h));
  assert.equal(limited.code, "SEND_LIMITED");
  assert.equal(limited.retryAfterMs, 60_000);
  assert.equal(h.transport.outbox.length, 1, "the provider was not called again");

  nextWindow(h);
  ok(await request(h));
  assert.equal(h.transport.outbox.length, 2);
});

test("the client budget bounds one caller across several numbers", async () => {
  const h = createHarness({ limits: { send: { client: [{ limit: 2, windowMs: 60_000 }] } } });
  ok(await request(h, { phone: PHONE_A }));
  h.advance(1_000);
  ok(await request(h, { phone: PHONE_B }));
  h.advance(1_000);

  const limited = notOk(await request(h, { phone: "+8613700137000" }));
  assert.equal(limited.code, "SEND_LIMITED");
  assert.equal(limited.retryAfterMs, 58_000, "measured from the first attempt by this client");
  assert.equal(h.transport.outbox.length, 2);
});

test("a send refusal does not consume the guess budget, and the reverse", async () => {
  const h = createHarness({
    limits: {
      send: { phone: [{ limit: 1, windowMs: 60_000 }] },
      verify: { phone: [{ limit: 2, windowMs: 60_000 }] },
    },
  });
  ok(await request(h));
  assert.equal(notOk(await request(h)).code, "SEND_LIMITED");

  // The refusal was a send, so two guesses are still available.
  assert.equal(notOk(await verify(h, { code: "000000" })).code, "CODE_INVALID");
  assert.equal(notOk(await verify(h, { code: "000000" })).code, "CODE_INVALID");
  const limited = notOk(await verify(h, { code: "000000" }));
  assert.equal(limited.code, "VERIFY_LIMITED");
  assert.equal(limited.retryAfterMs, 60_000);
});

test("exhausting the guesses does not stop the user requesting a new code", async () => {
  const h = createHarness({
    limits: {
      send: { phone: [{ limit: 5, windowMs: 60_000 }] },
      verify: { phone: [{ limit: 3, windowMs: 60_000 }] },
    },
    maxVerifyAttempts: 5,
  });
  ok(await request(h));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(notOk(await verify(h, { code: "000000" })).code, "CODE_INVALID");
  }
  assert.equal(notOk(await verify(h, { code: "000000" })).code, "VERIFY_LIMITED");

  // The whole point of separate buckets.
  ok(await request(h));
  assert.equal(h.transport.outbox.length, 2);
});

test("guessing stays bounded across challenge replacements", async () => {
  // The property the reference implementation could not state: because the guess
  // budget is keyed by number and client and never by challenge, asking for a
  // fresh code does not hand out a fresh allowance.
  const h = createHarness({
    limits: {
      send: { phone: [{ limit: 1, windowMs: 60_000 }] },
      verify: { phone: [{ limit: 5, windowMs: 900_000 }] },
    },
    maxVerifyAttempts: 5,
  });

  ok(await request(h));
  const outcomes: string[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    outcomes.push(notOk(await verify(h, { code: "000000" })).code);
  }
  assert.deepEqual(outcomes, [
    "CODE_INVALID",
    "CODE_INVALID",
    "CODE_INVALID",
    "CODE_INVALID",
    "TOO_MANY_ATTEMPTS",
  ]);

  // A brand-new code, well inside the 15-minute window.
  nextWindow(h);
  ok(await request(h));
  const afterResend = notOk(await verify(h, { code: "000000" }));
  assert.equal(afterResend.code, "VERIFY_LIMITED", "the resend did not refund the guess budget");
  assert.equal(h.transport.outbox.length, 2, "the send itself was still allowed");
});

test("a refused send is charged by default, so failures cannot be repeated for free", async () => {
  // The amplification regression. If a failed send were refunded by default, a
  // provider outage — or a number the provider rejects — would leave the send
  // budget permanently empty, and a caller could drive provider traffic without
  // limit. The charge is what bounds the loop.
  const h = createHarness({
    limits: { send: { phone: [{ limit: 3, windowMs: 3_600_000 }] } },
    onSend: () => ({ ok: false, failure: "TRANSPORT_UNAVAILABLE" }),
  });

  const codes: string[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    codes.push(notOk(await request(h)).code);
  }
  assert.deepEqual(codes, [
    "SMS_SEND_FAILED",
    "SMS_SEND_FAILED",
    "SMS_SEND_FAILED",
    "SEND_LIMITED",
    "SEND_LIMITED",
  ]);
  // Three provider calls, no more — the budget bound it, not the provider.
  assert.equal(h.transport.outbox.length, 3);
  assert.equal(h.limiter.stats().timestamps, 6, "three charges across two scopes");
});

test("refunding a failed send is opt-in, and then the retry is not limited", async () => {
  const h = createHarness({
    limits: { send: { phone: [{ limit: 1, windowMs: 60_000 }] } },
    refundFailedSend: true,
    onSend: (_request, callIndex) =>
      callIndex === 0 ? { ok: false, failure: "TRANSPORT_UNAVAILABLE" } : undefined,
  });

  assert.equal(notOk(await request(h)).code, "SMS_SEND_FAILED");
  const retry = await request(h);
  assert.equal(retry.ok, true, `the retry should not be limited: ${JSON.stringify(retry)}`);
  assert.equal(h.transport.outbox.filter((entry) => entry.delivered).length, 1);

  // And with the refund on, the same budget still bounds successful sends.
  assert.equal(notOk(await request(h)).code, "SEND_LIMITED");
});

test("a limiter that cannot release does not change the reported failure", async () => {
  const limiter = createMemoryRateLimiter();
  const refusing = {
    consume: limiter.consume.bind(limiter),
    release: () => Promise.reject(new Error("limiter backend unavailable: 13800138000")),
  };
  const service = PhoneOtpService.create({
    config: {
      runtime: "test",
      secret: "release-failure-suite-secret-0123456789abc",
      allowedPurposes: [SIGN_IN],
      store: createMemoryChallengeStore(),
      limiter: refusing,
      transport: createFakeSmsTransport({ onSend: () => ({ ok: false, failure: "REJECTED" }) }),
    },
  });

  const failure = notOk(
    await service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN }),
  );
  assert.equal(failure.code, "SMS_SEND_FAILED", "the real failure is what the caller sees");
  assert.ok(!JSON.stringify(failure).includes("limiter backend unavailable"));
});

/* ───────────────────────────── send failures ───────────────────────────── */

test("a provider refusal is reported as one code and leaves nothing live", async () => {
  const h = createHarness({ onSend: () => ({ ok: false, failure: "REJECTED" }) });
  const failure = notOk(await request(h));
  assert.equal(failure.code, "SMS_SEND_FAILED");
  assert.deepEqual(Object.keys(failure).sort(), ["code", "ok"], "no provider detail reaches the caller");
  assert.equal(h.store.stats().total, 0, "the reservation was rolled back");
  assert.deepEqual(h.observations(), [
    { operation: "request-code", code: "SMS_SEND_FAILED", smsFailure: "REJECTED" },
  ]);
});

test("a provider that throws a vendor error leaks nothing", async () => {
  // The shape of the reference implementation's bug: the vendor message carries
  // the destination number and the template id, and a naive adapter interpolates
  // it into the error it throws.
  const vendorText = "Aliyun SMS failed for +8613800138000 (template SMS_123456789): code 123456";
  const h = createHarness({
    onSend: () => {
      throw new Error(vendorText);
    },
  });

  const failure = notOk(await request(h));
  assert.equal(failure.code, "SMS_SEND_FAILED");
  assert.ok(!JSON.stringify(failure).includes("Aliyun"));
  assert.ok(!JSON.stringify(failure).includes("13800138000"));
  assert.deepEqual(Object.keys(failure).sort(), ["code", "ok"]);

  assert.deepEqual(h.observations(), [
    { operation: "request-code", code: "SMS_SEND_FAILED", smsFailure: "UNKNOWN" },
  ]);
  const rendered = JSON.stringify(h.observations());
  assert.ok(!rendered.includes("Aliyun"));
  assert.ok(!rendered.includes("13800138000"));
  assert.ok(!/\d{6}/u.test(rendered), "no six-digit run survives into the operator signal");
  assert.equal(h.store.stats().total, 0);
});

test("a failed resend does not take away the code the user already has", async () => {
  // The headline property. Send 1 succeeds; send 2 fails at the provider; the
  // code from send 1 must still work, because the user is holding it.
  let callIndex = 0;
  const h = createHarness({
    onSend: () => {
      callIndex += 1;
      return callIndex === 2 ? { ok: false, failure: "TRANSPORT_UNAVAILABLE" } : undefined;
    },
  });

  ok(await request(h));
  const firstCode = h.lastCode();
  nextWindow(h);

  assert.equal(notOk(await request(h)).code, "SMS_SEND_FAILED");
  assert.deepEqual(h.store.stats(), { total: 1, active: 1, pending: 0 });

  const survived = await verify(h, { code: firstCode });
  assert.equal(survived.ok, true, "the earlier code survived the failed resend");
});

test("a successful resend replaces the earlier code", async () => {
  const h = createHarness();
  ok(await request(h));
  const firstCode = h.lastCode();
  nextWindow(h);
  ok(await request(h));
  const secondCode = h.lastCode();

  assert.notEqual(firstCode, secondCode);
  assert.equal(h.store.stats().active, 1);
  assert.equal(notOk(await verify(h, { code: firstCode })).code, "CODE_INVALID");
  ok(await verify(h, { code: secondCode }));
});

test("each successful resend replaces the live challenge and gets its own code", async () => {
  const h = createHarness({ limits: { send: { phone: [{ limit: 50, windowMs: 3_600_000 }] } } });
  const codes = new Set<string>();
  for (let round = 0; round < 5; round += 1) {
    ok(await request(h));
    codes.add(h.lastCode());
    assert.deepEqual(h.store.stats(), { total: 1, active: 1, pending: 0 });
    h.advance(60_000);
  }
  assert.equal(codes.size, 5, "five sends, five distinct codes");
});

test("a code delivered too late to publish is refused rather than reported as sent", async () => {
  // The provider accepted the message, but the reservation expired while the
  // call was in flight, so the delivered code is already dead. Neither
  // `SMS_SEND_FAILED` (the provider did not fail) nor success (the user holds a
  // code that cannot work) is honest, so it is an unexplained failure.
  let advance: (ms: number) => void = () => undefined;
  const h = createHarness({
    codeTtlMs: 60_000,
    limits: { send: { phone: [{ limit: 5, windowMs: 60_000 }] } },
    onSend: () => {
      advance(60_001);
      return undefined;
    },
  });
  advance = h.advance;

  const failure = notOk(await request(h));
  assert.equal(failure.code, "INTERNAL");
  assert.equal(h.transport.outbox.length, 1, "the message did go out");
  const delivered = h.transport.latest();
  if (delivered === undefined) throw new Error("expected a delivery");

  const tooLate = await verify(h, { code: delivered.code });
  assert.equal(tooLate.ok, false);
  assert.equal(h.store.stats().total, 0);
});

/* ──────────────────────── attempts and expiry ──────────────────────── */

test("the per-challenge allowance is reported and then exhausted", async () => {
  const h = createHarness({ maxVerifyAttempts: 3 });
  ok(await request(h));

  const first = notOk(await verify(h, { code: "000000" }));
  assert.equal(first.code, "CODE_INVALID");
  assert.equal(first.attemptsRemaining, 2);
  assert.equal(notOk(await verify(h, { code: "000000" })).attemptsRemaining, 1);

  const exhausted = notOk(await verify(h, { code: "000000" }));
  assert.equal(exhausted.code, "TOO_MANY_ATTEMPTS");
  assert.equal(exhausted.attemptsRemaining, 0);
  assert.equal(h.store.stats().total, 0, "the challenge is retired, not left for a lucky guess");

  // Even the right code is gone now.
  assert.equal(notOk(await verify(h, { code: h.lastCode() })).code, "CODE_INVALID");
});

test("an expired code is reported as expired", async () => {
  const h = createHarness({
    codeTtlMs: 60_000,
    limits: { send: { phone: [{ limit: 5, windowMs: 60_000 }] } },
  });
  ok(await request(h));
  const code = h.lastCode();

  h.advance(60_000);
  assert.equal(notOk(await verify(h, { code })).code, "CODE_EXPIRED");
  assert.equal(h.store.stats().total, 0);
});

test("concurrent submissions of the correct code succeed exactly once", async () => {
  const h = createHarness();
  ok(await request(h));
  const code = h.lastCode();

  const results = await Promise.all([verify(h, { code }), verify(h, { code }), verify(h, { code })]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(h.store.stats().active, 0, "the winner consumed it");
});

/* ─────────────────────────── purpose and phone ─────────────────────────── */

test("a code issued for one purpose cannot be used for another", async () => {
  const h = createHarness();
  ok(await request(h, { purpose: SIGN_IN }));
  const code = h.lastCode();

  assert.equal(notOk(await verify(h, { purpose: BIND_PHONE, code })).code, "CODE_INVALID");
  // The sign-in challenge is still live, so the right purpose still works.
  ok(await verify(h, { purpose: SIGN_IN, code }));
});

test("a code issued for one number cannot be used for another", async () => {
  const h = createHarness();
  ok(await request(h, { phone: PHONE_A }));
  const code = h.lastCode();

  const other = notOk(await verify(h, { phone: PHONE_B, code }));
  assert.equal(other.code, "CODE_INVALID");
  assert.equal(other.attemptsRemaining, undefined, "there is no challenge for that number to charge");
  ok(await verify(h, { phone: PHONE_A, code }));
});

test("verify does not reveal whether a challenge exists", async () => {
  const h = createHarness();
  ok(await request(h, { phone: PHONE_A }));
  const code = h.lastCode();

  // No challenge at all for PHONE_B; a wrong code against PHONE_A's live
  // challenge; the same wrong code after that challenge has been consumed. One
  // code, one shape. The reference implementation answered these differently,
  // which is the challenge-existence oracle this design removes by never
  // exposing the id.
  assert.equal(notOk(await verify(h, { phone: PHONE_B, code: "123456" })).code, "CODE_INVALID");
  assert.equal(notOk(await verify(h, { phone: PHONE_A, code: "000000" })).code, "CODE_INVALID");
  ok(await verify(h, { phone: PHONE_A, code }));
  assert.equal(notOk(await verify(h, { phone: PHONE_A, code })).code, "CODE_INVALID");
});

/* ───────────────────────────── randomness ───────────────────────────── */

test("challenge ids are unpredictable, prefixed and unique", () => {
  const ids = new Set<string>();
  for (let draw = 0; draw < 1_000; draw += 1) {
    const id = generateChallengeId();
    assert.match(id, /^oc_[A-Za-z0-9_-]{24}$/u);
    assert.equal(ids.has(id), false, "a repeated id would let one challenge shadow another");
    ids.add(id);
  }
  assert.equal(ids.size, 1_000);
});

test("codes are uniformly shaped, spread out and not sequential", () => {
  const codes: string[] = [];
  for (let draw = 0; draw < 500; draw += 1) codes.push(generateOtpCode());
  for (const code of codes) assert.match(code, /^\d{6}$/u);

  const distinct = new Set(codes);
  assert.ok(distinct.size > 480, `500 draws over 1e6 should barely collide, saw ${distinct.size}`);
  const leading = new Set(codes.map((code) => code.slice(0, 1)));
  assert.ok(leading.size >= 8, "the first digit is not concentrated");
  assert.ok(!codes.includes("000000"), "a zero code is possible but not privileged");
});

/* ───────────────────────── a transport result is checked ───────────────────────── */

/** A service wired to an arbitrary transport, so the result shapes can be faked. */
function serviceWithTransport(
  transport: SmsTransport,
  overrides: Partial<PhoneOtpConfig> = {},
): { readonly service: PhoneOtpService; readonly observations: PhoneOtpObservation[] } {
  const observations: PhoneOtpObservation[] = [];
  const service = PhoneOtpService.create({
    config: {
      runtime: "test",
      secret: "transport-result-suite-secret-0123456789ab",
      allowedPurposes: [SIGN_IN],
      store: createMemoryChallengeStore(),
      limiter: createMemoryRateLimiter(),
      transport,
      ...overrides,
      onError: (observation) => {
        observations.push(observation);
      },
    },
  });
  return { service, observations };
}

function transportReturning(factory: () => unknown): SmsTransport {
  return {
    kind: "malformed-stub",
    send: () => Promise.resolve(factory() as SmsSendResult),
  };
}

test("a malformed transport result is a failed send, and only an exact ok is a success", async () => {
  // The transport is external code. `{ ok: 1 }` is not a confirmation, and a
  // truthy `ok` treated as one is how a broken adapter publishes a code the user
  // cannot use.
  const malformed: readonly unknown[] = [
    undefined,
    null,
    "ok",
    42,
    [],
    {},
    { ok: 1 },
    { ok: "yes" },
    { ok: null },
    { failure: "REJECTED" },
    { ok: false, failure: "Aliyun: template rejected for +8613800138000" },
  ];

  for (const value of malformed) {
    const { service, observations } = serviceWithTransport(transportReturning(() => value));
    const failure = notOk(
      await service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN }),
    );
    assert.equal(failure.code, "SMS_SEND_FAILED", JSON.stringify(value) ?? "undefined");
    assert.equal(observations.length, 1);
    const rendered = JSON.stringify(observations);
    assert.ok(!rendered.includes("Aliyun"), rendered);
    assert.ok(!rendered.includes("13800138000"), rendered);
    assert.ok(!/\d{6}/u.test(rendered), rendered);
  }

  // And the shapes that are confirmations are treated as confirmations.
  const accepted = serviceWithTransport(transportReturning(() => ({ ok: true })));
  const requested = await accepted.service.requestCode({
    phone: PHONE_A,
    clientRef: ALPHA,
    purpose: SIGN_IN,
  });
  assert.equal(requested.ok, true);
});

test("a transport result whose getters throw is a failed send, not a crash", async () => {
  const throwingOk = {
    get ok(): boolean {
      throw new Error("getter side effect: +8613800138000");
    },
  };
  const throwingFailure = {
    ok: false,
    get failure(): string {
      throw new Error("getter side effect: 123456");
    },
  };

  for (const value of [throwingOk, throwingFailure]) {
    const { service, observations } = serviceWithTransport(transportReturning(() => value));
    const failure = notOk(
      await service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN }),
    );
    assert.equal(failure.code, "SMS_SEND_FAILED");
    assert.deepEqual(observations, [
      { operation: "request-code", code: "SMS_SEND_FAILED", smsFailure: "UNKNOWN" },
    ]);
    assert.ok(!JSON.stringify(observations).includes("getter side effect"));
  }
});

/* ───────────────── the limits come from the configuration ───────────────── */

test("the service hands the limiter the resolved configuration, not its own rules", async () => {
  const seen: OtpRateLimitRuleset[] = [];
  const recording: OtpRateLimiter = {
    consume: (input) => {
      seen.push(input.rules);
      return Promise.resolve({
        allowed: false,
        retryAfterMs: 1,
        remaining: 0,
        scope: "phone",
        limit: 1,
        windowMs: 60_000,
      });
    },
    release: () => Promise.resolve({ released: false }),
  };

  const override = { limit: 1, windowMs: 30_000 };
  const { service } = serviceWithTransport(createFakeSmsTransport(), {
    limiter: recording,
    limits: { send: { phone: [override] } },
  });
  await service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN });

  // Exactly the resolved ruleset: the override, with every un-overridden scope
  // still at its default. A limiter built with its own rules could disagree with
  // this; one that is handed the rules cannot.
  assert.deepEqual(seen, [
    {
      send: { phone: [override], client: DEFAULT_LIMITS.send.client },
      verify: DEFAULT_LIMITS.verify,
    },
  ]);
});

test("two services sharing one limiter enforce their own configured budgets", async () => {
  // The mismatch the reviewer asked about, made impossible: the limiter holds no
  // limits, so two configurations cannot disagree with what is enforced — each
  // call carries the rules it must apply.
  const shared = createMemoryRateLimiter();
  const strictService = serviceWithTransport(createFakeSmsTransport(), {
    limiter: shared,
    limits: { send: { phone: [{ limit: 1, windowMs: 60_000 }] } },
  });
  const generousService = serviceWithTransport(createFakeSmsTransport(), {
    limiter: shared,
    limits: { send: { phone: [{ limit: 5, windowMs: 60_000 }] } },
  });

  assert.equal(
    (await strictService.service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN })).ok,
    true,
  );
  assert.equal(
    notOk(await strictService.service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN })).code,
    "SEND_LIMITED",
  );

  // A different number, so the windows do not overlap: the generous service on
  // the same limiter admits two in a row.
  assert.equal(
    (await generousService.service.requestCode({ phone: PHONE_B, clientRef: ALPHA, purpose: SIGN_IN })).ok,
    true,
  );
  assert.equal(
    (await generousService.service.requestCode({ phone: PHONE_B, clientRef: ALPHA, purpose: SIGN_IN })).ok,
    true,
  );
  // One window per number, plus one shared client window — both services used the
  // same client reference, which is also what makes the client budget shared.
  assert.equal(shared.stats().windows, 3);
});

/* ─────────────── the observation names the budget, nothing else ─────────────── */

test("a send refusal reports the budget and scope that bound it", async () => {
  const h = createHarness();
  ok(await request(h));
  assert.equal(notOk(await request(h)).code, "SEND_LIMITED");

  assert.deepEqual(h.observations(), [
    { operation: "request-code", code: "SEND_LIMITED", bucket: "send", scope: "phone" },
  ]);
  // The scope is operator information: it is not in the returned failure.
  const failure = notOk(await request(h));
  assert.deepEqual(Object.keys(failure).sort(), ["code", "ok", "retryAfterMs"]);
});

test("a guess refusal reports the verify bucket", async () => {
  const h = createHarness({
    limits: { verify: { phone: [{ limit: 1, windowMs: 60_000 }] } },
  });
  ok(await request(h));
  assert.equal(notOk(await verify(h, { code: "000000" })).code, "CODE_INVALID");
  assert.equal(notOk(await verify(h, { code: "000000" })).code, "VERIFY_LIMITED");

  assert.deepEqual(h.observations().at(-1), {
    operation: "verify-code",
    code: "VERIFY_LIMITED",
    bucket: "verify",
    scope: "phone",
  });
});

/* ──────────────── fail closed ──────────────── */

interface FailureHarness {
  readonly service: PhoneOtpService;
  readonly sent: unknown[];
  readonly observations: unknown[];
}

function withFailing(overrides: { readonly limiter?: boolean; readonly store?: boolean }): FailureHarness {
  const sent: unknown[] = [];
  const observations: unknown[] = [];
  const service = PhoneOtpService.create({
    config: {
      runtime: "test",
      secret: "fail-closed-suite-secret-0123456789abcdef",
      allowedPurposes: [SIGN_IN],
      store: overrides.store === true ? throwingStore() : createMemoryChallengeStore(),
      limiter: overrides.limiter === true ? throwingLimiter : createMemoryRateLimiter(),
      transport: createFakeSmsTransport({
        onSend: (request) => {
          sent.push(request);
          return undefined;
        },
      }),
      onError: (observation) => {
        observations.push(observation);
      },
    },
  });
  return { service, sent, observations };
}

test("a limiter that cannot answer denies the request", async () => {
  const { service, sent, observations } = withFailing({ limiter: true });
  const failure = notOk(
    await service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN }),
  );
  assert.equal(failure.code, "INTERNAL");
  assert.deepEqual(sent, [], "the provider was never called");
  assert.deepEqual(observations, [{ operation: "request-code", code: "INTERNAL" }]);
  assert.ok(!JSON.stringify(observations).includes("limiter backend unavailable"));
});

test("a store that cannot answer denies the request and the provider is not called", async () => {
  const { service, sent } = withFailing({ store: true });
  const failure = notOk(
    await service.requestCode({ phone: PHONE_A, clientRef: ALPHA, purpose: SIGN_IN }),
  );
  assert.equal(failure.code, "INTERNAL");
  assert.deepEqual(sent, []);
});

test("a store that cannot answer denies a verification too", async () => {
  const { service } = withFailing({ store: true });
  const failure = notOk(
    await service.verifyCode({ phone: PHONE_A, code: "123456", clientRef: ALPHA, purpose: SIGN_IN }),
  );
  assert.equal(failure.code, "INTERNAL");
});

test("an operator hook that throws does not change the outcome", async () => {
  const service = PhoneOtpService.create({
    config: {
      runtime: "test",
      secret: "throwing-hook-suite-secret-0123456789abcdef",
      allowedPurposes: [SIGN_IN],
      store: createMemoryChallengeStore(),
      limiter: createMemoryRateLimiter(),
      transport: createFakeSmsTransport(),
      onError: () => {
        throw new Error("the operator's logger fell over");
      },
    },
  });
  const failure = notOk(
    await service.requestCode({ phone: "not-a-phone", clientRef: ALPHA, purpose: SIGN_IN }),
  );
  assert.equal(failure.code, "INVALID_PHONE");
});

/* ────────────────── the service never makes an account ────────────────── */

test("a successful verification returns no identity, session or token", async () => {
  const h = createHarness();
  ok(await request(h));
  const verified = ok(await verify(h));
  assert.deepEqual(Object.keys(verified).sort(), ["maskedPhone", "ok", "purpose"]);
  assert.equal(h.service.runtime, "test");
  // And nothing was created anywhere: the only state the kit holds is the
  // challenge, which verification consumed.
  assert.deepEqual(h.store.stats(), { total: 0, active: 0, pending: 0 });
});
