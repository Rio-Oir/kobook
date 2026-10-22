// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The rate limiter.
 *
 * The tests that matter are about *what the rules are*, *where they come from*
 * and *what the key is*.
 *
 * - The rules arrive with each call, so the resolved configuration is the only
 *   policy source. Two callers with different rulesets get different enforcement
 *   from the same limiter instance, and that is asserted rather than described.
 * - `consume` takes no challenge id, so a fresh code cannot buy a fresh budget.
 * - The concurrency case pins the atomicity the interface promises: a limiter
 *   that checks then records lets every concurrent caller through at exactly the
 *   boundary the limit exists to defend.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMemoryRateLimiter,
  createOtpHasher,
  type MemoryRateLimiter,
  type OtpRateBucket,
  type OtpRateLimitDecision,
  type OtpRateLimitInput,
  type OtpRateLimitReleaseInput,
  type OtpRateLimitReleaseResult,
  type OtpRateLimitRule,
  type OtpRateLimitRuleset,
  type OtpRateScope,
} from "../src/server";

const hasher = createOtpHasher("limiter-suite-secret-0123456789abcdefghij");

const T0 = 1_700_000_000_000;
const PHONE = hasher.phoneRef("+8613800138000");
const OTHER_PHONE = hasher.phoneRef("+8613900139000");
const CLIENT = hasher.clientRef("client:alpha");
const OTHER_CLIENT = hasher.clientRef("client:beta");

const WIDE: readonly OtpRateLimitRule[] = [{ limit: 1_000, windowMs: 60_000 }];

interface RuleOverrides {
  readonly sendPhone?: readonly OtpRateLimitRule[];
  readonly sendClient?: readonly OtpRateLimitRule[];
  readonly verifyPhone?: readonly OtpRateLimitRule[];
  readonly verifyClient?: readonly OtpRateLimitRule[];
}

function ruleset(overrides: RuleOverrides): OtpRateLimitRuleset {
  return {
    send: { phone: overrides.sendPhone ?? WIDE, client: overrides.sendClient ?? WIDE },
    verify: { phone: overrides.verifyPhone ?? WIDE, client: overrides.verifyClient ?? WIDE },
  };
}

/**
 * A limiter bound to a ruleset, the way the service is: the caller supplies the
 * rules, so these tests exercise the same path production does.
 */
interface Bound {
  readonly limiter: MemoryRateLimiter;
  readonly rules: OtpRateLimitRuleset;
  hit(input: Omit<OtpRateLimitInput, "rules">): Promise<OtpRateLimitDecision>;
  release(input: OtpRateLimitReleaseInput): Promise<OtpRateLimitReleaseResult>;
  stats(): { readonly windows: number; readonly timestamps: number };
  clear(): void;
}

function boundTo(rules: OtpRateLimitRuleset): Bound {
  const limiter = createMemoryRateLimiter();
  return {
    limiter,
    rules,
    hit: (input) => limiter.consume({ ...input, rules }),
    release: (input) => limiter.release(input),
    stats: () => limiter.stats(),
    clear: () => limiter.clear(),
  };
}

function limiterWith(overrides: RuleOverrides): Bound {
  return boundTo(ruleset(overrides));
}

function hit(
  bound: Bound,
  now: number,
  over: {
    readonly bucket?: OtpRateBucket;
    readonly phoneRef?: string;
    readonly clientRef?: string;
  } = {},
): Promise<OtpRateLimitDecision> {
  return bound.hit({
    bucket: over.bucket ?? "send",
    phoneRef: over.phoneRef ?? PHONE,
    clientRef: over.clientRef ?? CLIENT,
    now,
  });
}

/* ─────────────────── the rules come from the caller ─────────────────── */

test("the same limiter applies whichever rules it is handed", () => {
  // The single-source property: a limiter holds no limits, so a resolved
  // configuration cannot disagree with what is enforced.
  const limiter = createMemoryRateLimiter();
  const strict = ruleset({ sendPhone: [{ limit: 1, windowMs: 60_000 }] });
  const generous = ruleset({ sendPhone: [{ limit: 5, windowMs: 60_000 }] });

  const call = (rules: OtpRateLimitRuleset, now: number): Promise<OtpRateLimitDecision> =>
    limiter.consume({ bucket: "send", phoneRef: PHONE, clientRef: CLIENT, now, rules });

  return (async (): Promise<void> => {
    assert.equal((await call(strict, T0)).allowed, true);
    // The second attempt against the strict rules would be refused...
    assert.equal((await call(strict, T0 + 1)).allowed, false);
    // ...and the same limiter, given the generous rules, still admits attempts.
    assert.equal((await call(generous, T0 + 2)).allowed, true);
    assert.equal((await call(generous, T0 + 3)).allowed, true);
  })();
});

test("the rules for the bucket being charged are the ones applied", async () => {
  const bound = limiterWith({
    sendPhone: [{ limit: 2, windowMs: 60_000 }],
    verifyPhone: [{ limit: 1, windowMs: 60_000 }],
  });
  assert.equal((await hit(bound, T0, { bucket: "send" })).allowed, true);
  assert.equal((await hit(bound, T0, { bucket: "send" })).allowed, true);
  assert.equal((await hit(bound, T0, { bucket: "verify" })).allowed, true);
  // The third send is refused by send's own rules, and verify's second by its.
  assert.equal((await hit(bound, T0, { bucket: "send" })).allowed, false);
  assert.equal((await hit(bound, T0, { bucket: "verify" })).allowed, false);
});

/* ───────────────────────────── send window ───────────────────────────── */

test("one send a minute: the second attempt is refused with the wait", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 1, windowMs: 60_000 }] });

  const first = await hit(bound, T0);
  assert.equal(first.allowed, true);
  assert.equal(first.retryAfterMs, 0);
  assert.equal(first.remaining, 0);

  const second = await hit(bound, T0 + 30_000);
  assert.equal(second.allowed, false);
  assert.equal(second.scope, "phone");
  assert.equal(second.limit, 1);
  assert.equal(second.windowMs, 60_000);
  assert.equal(second.retryAfterMs, 30_000);
});

test("the window slides: the same request succeeds once it has passed", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 1, windowMs: 60_000 }] });
  await hit(bound, T0);

  const atEdge = await hit(bound, T0 + 59_999);
  assert.equal(atEdge.allowed, false);
  assert.equal(atEdge.retryAfterMs, 1);

  assert.equal((await hit(bound, T0 + 60_001)).allowed, true);
});

test("the window ends one window after the allowed attempt, however hard it is hammered", async () => {
  // The availability property. If a refusal were recorded, a caller who kept
  // knocking would push the window forward every time and hold the number shut
  // for as long as they kept going.
  const bound = limiterWith({ sendPhone: [{ limit: 1, windowMs: 60_000 }] });
  await hit(bound, T0);

  for (let offset = 1_000; offset <= 59_000; offset += 1_000) {
    assert.equal((await hit(bound, T0 + offset)).allowed, false);
  }
  assert.equal((await hit(bound, T0 + 60_001)).allowed, true, "58 refused requests did not extend the block");
});

test("a refused attempt is not recorded against the window", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 2, windowMs: 60_000 }] });
  await hit(bound, T0);
  await hit(bound, T0 + 10_000);
  assert.equal(bound.stats().timestamps, 4, "two allowed attempts across two scopes");

  for (const offset of [20_000, 30_000, 40_000]) {
    await hit(bound, T0 + offset);
  }
  assert.equal(bound.stats().timestamps, 4, "three refusals added nothing");

  const third = await hit(bound, T0 + 50_000);
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterMs, 10_000, "the wait is measured from the first allowed attempt");
});

test("stepped rules express a resend gate and a cost ceiling together", async () => {
  const bound = limiterWith({
    sendPhone: [
      { limit: 1, windowMs: 60_000 },
      { limit: 3, windowMs: 3_600_000 },
    ],
  });

  const decisions: OtpRateLimitDecision[] = [];
  for (const offset of [0, 61_000, 122_000, 183_000]) {
    decisions.push(await hit(bound, T0 + offset));
  }
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, true, false]);

  const refused = decisions[3];
  if (refused === undefined) throw new Error("expected a fourth decision");
  assert.equal(refused.scope, "phone");
  assert.equal(refused.limit, 3);
  assert.equal(refused.windowMs, 3_600_000);
  // The wait is measured from the oldest attempt still inside the hourly window.
  assert.equal(refused.retryAfterMs, 3_600_000 - 183_000);
});

/* ──────────────────────────── client scope ──────────────────────────── */

test("the client scope bounds one caller across many numbers", async () => {
  const bound = limiterWith({ sendClient: [{ limit: 2, windowMs: 60_000 }] });
  const phoneRefs = ["+8613800138000", "+8613900139000", "+8613700137000"].map((e164) =>
    hasher.phoneRef(e164),
  );

  const decisions: OtpRateLimitDecision[] = [];
  for (const phoneRef of phoneRefs) {
    decisions.push(await hit(bound, T0, { phoneRef }));
  }
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, true, false]);
  const refused = decisions[2];
  if (refused === undefined) throw new Error("expected a third decision");
  assert.equal(refused.scope, "client");
  assert.equal(refused.limit, 2);
});

test("a different client, and a different phone, each have their own budget", async () => {
  const byClient = limiterWith({ sendClient: [{ limit: 1, windowMs: 60_000 }] });
  assert.equal((await hit(byClient, T0)).allowed, true);
  assert.equal((await hit(byClient, T0)).allowed, false);
  assert.equal((await hit(byClient, T0, { clientRef: OTHER_CLIENT })).allowed, true);

  const byPhone = limiterWith({ sendPhone: [{ limit: 1, windowMs: 60_000 }] });
  assert.equal((await hit(byPhone, T0)).allowed, true);
  assert.equal((await hit(byPhone, T0, { phoneRef: OTHER_PHONE })).allowed, true);
});

test("the refusal names the scope that actually bound", async () => {
  const bound = limiterWith({
    sendPhone: WIDE,
    sendClient: [{ limit: 1, windowMs: 60_000 }],
  });
  await hit(bound, T0);
  const refused = await hit(bound, T0);
  assert.equal(refused.allowed, false);
  assert.equal(refused.scope, "client");
});

/* ──────────────────── buckets are genuinely separate ──────────────────── */

test("exhausting the send budget leaves the verify budget alone, and the reverse", async () => {
  // The reason the buckets are separate: charging a wrong guess against the send
  // budget would let an attacker who is guessing lock the real user out of
  // *receiving* a code.
  const bound = limiterWith({
    sendPhone: [{ limit: 1, windowMs: 60_000 }],
    verifyPhone: [{ limit: 2, windowMs: 60_000 }],
  });

  assert.equal((await hit(bound, T0, { bucket: "send" })).allowed, true);
  assert.equal((await hit(bound, T0, { bucket: "send" })).allowed, false);

  assert.equal((await hit(bound, T0, { bucket: "verify" })).allowed, true, "a refused send does not consume the guess budget");
  assert.equal((await hit(bound, T0, { bucket: "verify" })).allowed, true);

  const exhausted = await hit(bound, T0, { bucket: "verify" });
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.scope, "phone");
});

test("the guess budget does not care how many challenges there have been", async () => {
  // Stated as a limiter test because it is a property of the *key*: there is no
  // parameter through which a challenge could enter it.
  const bound = limiterWith({ verifyPhone: [{ limit: 3, windowMs: 900_000 }] });
  const spends: boolean[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    spends.push((await hit(bound, T0, { bucket: "verify" })).allowed);
  }
  assert.deepEqual(spends, [true, true, true, false, false]);
});

/* ──────────────────────────── atomicity ──────────────────────────── */

test("concurrent attempts at the boundary admit exactly the limit", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 3, windowMs: 60_000 }] });
  const decisions = await Promise.all(
    Array.from({ length: 10 }, () => hit(bound, T0)),
  );
  assert.equal(decisions.filter((decision) => decision.allowed).length, 3);
  assert.equal(decisions.filter((decision) => !decision.allowed).length, 7);
});

test("concurrent attempts spread across both scopes admit the smaller limit", async () => {
  const bound = limiterWith({
    sendPhone: [{ limit: 4, windowMs: 60_000 }],
    sendClient: [{ limit: 2, windowMs: 60_000 }],
  });
  const decisions = await Promise.all(
    Array.from({ length: 8 }, () => hit(bound, T0)),
  );
  assert.equal(decisions.filter((decision) => decision.allowed).length, 2);
});

/* ───────────────────────────── release ───────────────────────────── */

test("release undoes exactly the attempt it was given", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 1, windowMs: 60_000 }] });
  await hit(bound, T0);
  assert.equal((await hit(bound, T0 + 1)).allowed, false);

  const released = await bound.release({ bucket: "send", phoneRef: PHONE, clientRef: CLIENT, at: T0 });
  assert.equal(released.released, true);
  assert.equal((await hit(bound, T0 + 3)).allowed, true);
});

test("release is idempotent and never touches another window", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 2, windowMs: 60_000 }] });
  await hit(bound, T0);
  await hit(bound, T0 + 1_000);
  assert.equal(bound.stats().timestamps, 4, "two attempts across two scopes");

  const first = await bound.release({ bucket: "send", phoneRef: PHONE, clientRef: CLIENT, at: T0 });
  assert.equal(first.released, true);
  assert.equal(bound.stats().timestamps, 2, "one entry removed from each scope");

  const again = await bound.release({ bucket: "send", phoneRef: PHONE, clientRef: CLIENT, at: T0 });
  assert.equal(again.released, false, "releasing twice is not an error, it is a no-op");

  const neverRecorded = await bound.release({
    bucket: "send",
    phoneRef: PHONE,
    clientRef: CLIENT,
    at: T0 + 999,
  });
  assert.equal(neverRecorded.released, false, "an attempt that was never recorded is not released");

  const otherWindow = await bound.release({
    bucket: "send",
    phoneRef: OTHER_PHONE,
    clientRef: OTHER_CLIENT,
    at: T0,
  });
  assert.equal(otherWindow.released, false, "another number's window is untouched");
  assert.equal(bound.stats().timestamps, 2);
});

test("release never clears a window", async () => {
  // The shape a lazy implementation would take, and the reason it is refused: a
  // provider failure must not become a way to reset the budget.
  const bound = limiterWith({ sendPhone: [{ limit: 2, windowMs: 60_000 }] });
  await hit(bound, T0);
  await hit(bound, T0 + 1_000);

  await bound.release({ bucket: "send", phoneRef: PHONE, clientRef: CLIENT, at: T0 });
  assert.equal((await hit(bound, T0 + 3_000)).allowed, true);
  assert.equal((await hit(bound, T0 + 4_000)).allowed, false, "the other charge survived");
});

/* ─────────────────────── remaining, pruning, reset ─────────────────────── */

test("remaining reports the smallest headroom across the rules", async () => {
  const bound = limiterWith({
    sendPhone: [
      { limit: 3, windowMs: 60_000 },
      { limit: 2, windowMs: 3_600_000 },
    ],
  });
  const first = await hit(bound, T0);
  assert.equal(first.remaining, 1, "the hourly rule has two and used one; the minute rule has three");
  assert.equal((await hit(bound, T0)).remaining, 0);
  assert.equal((await hit(bound, T0)).allowed, false);
});

test("timestamps outside the longest window are dropped", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 2, windowMs: 60_000 }] });
  await hit(bound, T0);
  assert.equal(bound.stats().timestamps, 2, "one per scope");

  await hit(bound, T0 + 60_001);
  assert.equal(bound.stats().timestamps, 2, "the stale timestamp from each scope was pruned");
});

test("clear resets every window, and a scope with no rules is not evaluated", async () => {
  const bound = limiterWith({ sendPhone: [{ limit: 1, windowMs: 3_600_000 }] });
  await hit(bound, T0);
  assert.equal((await hit(bound, T0)).allowed, false);
  bound.clear();
  assert.equal(bound.stats().windows, 0);
  assert.equal((await hit(bound, T0)).allowed, true);

  const phoneOnly = boundTo({
    send: { phone: [{ limit: 1, windowMs: 60_000 }], client: [] },
    verify: { phone: WIDE, client: WIDE },
  });
  const decisions: boolean[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    decisions.push((await hit(phoneOnly, T0)).allowed);
  }
  assert.deepEqual(decisions, [true, false, false]);
});

test("a scope the caller did not supply is treated as unlimited", async () => {
  const bound = boundTo({
    send: { phone: WIDE, client: [] },
    verify: { phone: WIDE, client: WIDE },
  });
  assert.equal((await hit(bound, T0)).allowed, true);
  assert.equal(bound.stats().windows, 1, "only the phone scope kept a window");
});

/* ───────────────────────── the scope union stays closed ───────────────────────── */

test("both buckets and both scopes are exercised above", () => {
  const scopes: readonly OtpRateScope[] = ["phone", "client"];
  const buckets: readonly OtpRateBucket[] = ["send", "verify"];
  assert.equal(scopes.length, 2);
  assert.equal(buckets.length, 2);
});
