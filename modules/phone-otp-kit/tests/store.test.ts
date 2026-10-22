// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The challenge store's lifecycle and its atomicity.
 *
 * These tests run against the in-memory adapter, which serialises every
 * operation through a mutex precisely so it can be held to the contract a real
 * backing store has to meet. The concurrency cases are the ones worth reading:
 * a store that reads, decides, then writes will pass every sequential test in
 * this file and fail the promises in `src/otp/store.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  constantTimeEqualHex,
  createMemoryChallengeStore,
  createOtpHasher,
  type MemoryChallengeStore,
} from "../src/server";

const hasher = createOtpHasher("store-suite-secret-0123456789abcdefghijkl");

const PURPOSE = "sign-in";
const OTHER_PURPOSE = "bind-phone";
const T0 = 1_700_000_000_000;
const PHONE = hasher.phoneRef("+8613800138000");
const OTHER_PHONE = hasher.phoneRef("+8613900139000");

function codeHash(code: string, purpose = PURPOSE, phoneRef = PHONE): string {
  return hasher.codeHash({ purpose, phoneRef, code });
}

interface BeginOverrides {
  readonly code?: string;
  readonly purpose?: string;
  readonly phoneRef?: string;
  readonly ttlMs?: number;
  readonly maxAttempts?: number;
  readonly now?: number;
}

function begin(
  store: MemoryChallengeStore,
  overrides: BeginOverrides = {},
): Promise<{ id: string; generation: number; expiresAt: number }> {
  return store.beginChallenge({
    purpose: overrides.purpose ?? PURPOSE,
    phoneRef: overrides.phoneRef ?? PHONE,
    codeHash: codeHash(overrides.code ?? "123456", overrides.purpose ?? PURPOSE, overrides.phoneRef ?? PHONE),
    now: overrides.now ?? T0,
    ttlMs: overrides.ttlMs ?? 300_000,
    maxAttempts: overrides.maxAttempts ?? 3,
  });
}

/* ───────────────────────── pending is not usable ───────────────────────── */

test("a begun but unactivated challenge cannot be consumed", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store);

  assert.deepEqual(store.stats(), { total: 1, active: 0, pending: 1 });
  const outcome = await store.consumeChallenge({
    purpose: PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("123456"),
    now: T0,
  });
  assert.equal(outcome.status, "absent");
  assert.deepEqual(store.stats(), { total: 1, active: 0, pending: 1 });
  assert.equal(reservation.generation, 1);
});

test("activation publishes exactly one challenge", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store);

  const activated = await store.activateChallenge({
    id: reservation.id,
    generation: reservation.generation,
    now: T0,
  });
  assert.deepEqual(activated, { activated: true, superseded: false });
  assert.deepEqual(store.stats(), { total: 1, active: 1, pending: 0 });

  const outcome = await store.consumeChallenge({
    purpose: PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("123456"),
    now: T0,
  });
  assert.equal(outcome.status, "consumed");
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });
});

test("a consumed challenge cannot be replayed", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store);
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });

  const first = await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("123456"), now: T0 });
  const replay = await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("123456"), now: T0 });
  assert.equal(first.status, "consumed");
  assert.equal(replay.status, "absent");
});

test("activating twice does not resurrect the challenge", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store);
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });
  const again = await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });
  assert.deepEqual(again, { activated: false, superseded: false });
});

/* ─────────────────────── concurrent single use ─────────────────────── */

test("three concurrent verifications of the correct code consume it once", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store);
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });

  const results = await Promise.all(
    [0, 1, 2].map(() =>
      store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("123456"), now: T0 }),
    ),
  );
  const consumed = results.filter((result) => result.status === "consumed");
  assert.equal(consumed.length, 1, "exactly one caller may win");
  assert.equal(results.filter((result) => result.status === "absent").length, 2);
});

test("concurrent wrong codes do not lose attempts", async () => {
  // The classic read-decide-write failure: five concurrent comparisons that each
  // read `attempts: 0` would each write `1`, granting an unlimited budget.
  const store = createMemoryChallengeStore();
  const reservation = await begin(store, { maxAttempts: 5 });
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });

  const results = await Promise.all(
    [0, 1, 2, 3, 4].map(() =>
      store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("000000"), now: T0 }),
    ),
  );
  const mismatches = results.filter((result) => result.status === "mismatch");
  const exhausted = results.filter((result) => result.status === "too_many_attempts");
  assert.equal(mismatches.length, 4);
  assert.equal(exhausted.length, 1);
  assert.deepEqual(
    mismatches.map((result) => (result.status === "mismatch" ? result.attemptsRemaining : -1)).sort((a, b) => a - b),
    [1, 2, 3, 4],
  );
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });
});

test("two concurrent successful sends leave exactly one live challenge", async () => {
  const store = createMemoryChallengeStore();
  const first = await begin(store, { code: "111111" });
  const second = await begin(store, { code: "222222" });

  const activations = await Promise.all([
    store.activateChallenge({ id: second.id, generation: second.generation, now: T0 }),
    store.activateChallenge({ id: first.id, generation: first.generation, now: T0 }),
  ]);
  assert.equal(activations.filter((result) => result.activated).length, 2, "both activations succeed");
  assert.deepEqual(store.stats(), { total: 1, active: 1, pending: 0 }, "the later activation wins");

  // Whichever won, exactly one of the two codes works.
  const winners = await Promise.all(
    ["111111", "222222"].map((code) =>
      store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash(code), now: T0 }),
    ),
  );
  assert.equal(winners.filter((result) => result.status === "consumed").length, 1);
});

/* ───────────────────────── attempts and expiry ───────────────────────── */

test("wrong codes decrement the allowance and then retire the challenge", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store, { maxAttempts: 3 });
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });

  const wrong = (): Promise<string> =>
    store
      .consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("000000"), now: T0 })
      .then((outcome) => outcome.status);

  assert.equal(await wrong(), "mismatch");
  assert.equal(await wrong(), "mismatch");
  assert.equal(await wrong(), "too_many_attempts");
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });

  // And the correct code is now gone too: exhausting the allowance retires the
  // challenge rather than leaving it for a lucky guess.
  const late = await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("123456"), now: T0 });
  assert.equal(late.status, "absent");
});

test("attemptsRemaining counts down", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store, { maxAttempts: 5 });
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });

  const remaining = async (): Promise<number> => {
    const outcome = await store.consumeChallenge({
      purpose: PURPOSE,
      phoneRef: PHONE,
      codeHash: codeHash("000000"),
      now: T0,
    });
    return outcome.status === "mismatch" ? outcome.attemptsRemaining : -1;
  };
  assert.equal(await remaining(), 4);
  assert.equal(await remaining(), 3);
  assert.equal(await remaining(), 2);
  assert.equal(await remaining(), 1);
  assert.equal(await remaining(), -1, "the fifth wrong code exhausts the allowance");
});

test("an expired challenge reports expiry, is dropped, and cannot be resurrected", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store, { ttlMs: 60_000 });
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });

  const expired = await store.consumeChallenge({
    purpose: PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("123456"),
    now: T0 + 60_000,
  });
  assert.equal(expired.status, "expired");
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });

  // A clock that moves backwards must not bring it back.
  const rewound = await store.consumeChallenge({
    purpose: PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("123456"),
    now: T0,
  });
  assert.equal(rewound.status, "absent");
});

test("a reservation that expires before it is published is refused", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store, { ttlMs: 60_000 });
  const activated = await store.activateChallenge({
    id: reservation.id,
    generation: 1,
    now: T0 + 60_001,
  });
  assert.deepEqual(activated, { activated: false, superseded: false });
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });
});

test("exhausting the allowance reports remaining as zero, not a negative", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store, { maxAttempts: 1 });
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });
  const outcome = await store.consumeChallenge({
    purpose: PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("000000"),
    now: T0,
  });
  assert.equal(outcome.status, "too_many_attempts");
  if (outcome.status !== "too_many_attempts") throw new Error("expected exhaustion");
  assert.equal(outcome.attemptsRemaining, 0);
});

/* ─────────────────── supersession and failed-send cleanup ─────────────────── */

test("reserving a new challenge does not disturb the live one", async () => {
  const store = createMemoryChallengeStore();
  const live = await begin(store, { code: "111111" });
  await store.activateChallenge({ id: live.id, generation: 1, now: T0 });

  const reservation = await begin(store, { code: "222222" });
  assert.deepEqual(store.stats(), { total: 2, active: 1, pending: 1 });

  // The live code still works while the new send is in flight.
  const outcome = await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("111111"), now: T0 });
  assert.equal(outcome.status, "consumed");
  assert.equal(reservation.generation, 2);
});

test("a failed send's cleanup cannot erase the live challenge", async () => {
  // The headline property. `revokeChallenge` only ever removes its own *pending*
  // reservation, so a provider failure is structurally unable to take away a
  // code the user already has.
  const store = createMemoryChallengeStore();
  const live = await begin(store, { code: "111111" });
  await store.activateChallenge({ id: live.id, generation: 1, now: T0 });

  const failed = await begin(store, { code: "222222" });
  const revoked = await store.revokeChallenge({ id: failed.id, generation: failed.generation, now: T0 });
  assert.deepEqual(revoked, { revoked: true, reason: "revoked" });
  assert.deepEqual(store.stats(), { total: 1, active: 1, pending: 0 });

  const outcome = await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("111111"), now: T0 });
  assert.equal(outcome.status, "consumed", "the earlier code survived the failed resend");
});

test("revoking the live challenge directly is refused", async () => {
  const store = createMemoryChallengeStore();
  const live = await begin(store);
  await store.activateChallenge({ id: live.id, generation: 1, now: T0 });

  const revoked = await store.revokeChallenge({ id: live.id, generation: 1, now: T0 });
  assert.deepEqual(revoked, { revoked: false, reason: "not-pending" });
  assert.equal(store.stats().active, 1);
});

test("a revoke with a stale generation is refused", async () => {
  const store = createMemoryChallengeStore();
  const first = await begin(store, { code: "111111" });
  const second = await begin(store, { code: "222222" });
  assert.equal(second.generation, first.generation + 1);

  const revoked = await store.revokeChallenge({ id: first.id, generation: second.generation, now: T0 });
  assert.deepEqual(revoked, { revoked: false, reason: "stale-generation" });
  assert.equal(store.stats().total, 2);
});

test("revoking an unknown or already-cleaned reservation is a no-op", async () => {
  const store = createMemoryChallengeStore();
  const first = await store.revokeChallenge({ id: "oc_does-not-exist", generation: 1, now: T0 });
  assert.deepEqual(first, { revoked: false, reason: "absent" });

  const reservation = await begin(store);
  await store.revokeChallenge({ id: reservation.id, generation: 1, now: T0 });
  const second = await store.revokeChallenge({ id: reservation.id, generation: 1, now: T0 });
  assert.deepEqual(second, { revoked: false, reason: "absent" });
});

test("a new activation retires the previous live challenge", async () => {
  const store = createMemoryChallengeStore();
  const first = await begin(store, { code: "111111" });
  await store.activateChallenge({ id: first.id, generation: 1, now: T0 });
  const second = await begin(store, { code: "222222" });
  const activated = await store.activateChallenge({ id: second.id, generation: 2, now: T0 });

  assert.deepEqual(activated, { activated: true, superseded: true });
  assert.deepEqual(store.stats(), { total: 1, active: 1, pending: 0 });

  // The replaced code no longer works. It reports `mismatch` rather than
  // `absent` because a *new* challenge is live under the same key and this
  // attempt was compared against it, and cost it an attempt — which is the
  // right accounting: a stale code typed in is a wrong code.
  const old = await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("111111"), now: T0 });
  assert.equal(old.status, "mismatch");
  if (old.status !== "mismatch") throw new Error("expected a mismatch against the live challenge");
  assert.equal(old.attemptsRemaining, 2, "the stale attempt was charged to the live challenge");

  const current = await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: codeHash("222222"), now: T0 });
  assert.equal(current.status, "consumed");
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });
});

/* ───────────────────────────── keying ───────────────────────────── */

test("challenges are keyed by purpose and phone, independently", async () => {
  const store = createMemoryChallengeStore();
  const signIn = await begin(store, { code: "111111" });
  const bind = await begin(store, { purpose: OTHER_PURPOSE, code: "222222" });
  await store.activateChallenge({ id: signIn.id, generation: signIn.generation, now: T0 });
  await store.activateChallenge({ id: bind.id, generation: bind.generation, now: T0 });
  assert.deepEqual(store.stats(), { total: 2, active: 2, pending: 0 });

  // Purpose binding: the sign-in code is not accepted for bind-phone. It comes
  // back as a mismatch rather than absent because a bind-phone challenge *is*
  // live under that key — the digest differs because the purpose is mixed into
  // it, so the code cannot cross. The charge lands on the bind-phone challenge.
  const crossed = await store.consumeChallenge({
    purpose: OTHER_PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("111111", PURPOSE),
    now: T0,
  });
  assert.equal(crossed.status, "mismatch");
  assert.notEqual(codeHash("111111", PURPOSE), codeHash("111111", OTHER_PURPOSE));

  const right = await store.consumeChallenge({
    purpose: PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("111111", PURPOSE),
    now: T0,
  });
  assert.equal(right.status, "consumed", "the sign-in challenge survived the crossed attempt");

  // The bind-phone code is still live, with one attempt spent on the crossing.
  const bindNow = await store.consumeChallenge({
    purpose: OTHER_PURPOSE,
    phoneRef: PHONE,
    codeHash: codeHash("222222", OTHER_PURPOSE),
    now: T0,
  });
  assert.equal(bindNow.status, "consumed");

  // Phone binding: another number has no challenge at all, which is the one case
  // that reports `absent`.
  const otherPhone = await store.consumeChallenge({
    purpose: OTHER_PURPOSE,
    phoneRef: OTHER_PHONE,
    codeHash: codeHash("222222", OTHER_PURPOSE, OTHER_PHONE),
    now: T0,
  });
  assert.equal(otherPhone.status, "absent");
});

test("generations count per key, not globally", async () => {
  const store = createMemoryChallengeStore();
  const a1 = await begin(store);
  const b1 = await begin(store, { purpose: OTHER_PURPOSE });
  const c1 = await begin(store, { phoneRef: OTHER_PHONE });
  const a2 = await begin(store);
  assert.deepEqual([a1.generation, a2.generation], [1, 2]);
  assert.equal(b1.generation, 1);
  assert.equal(c1.generation, 1);
});

/* ─────────────────────── no plaintext in the store ─────────────────────── */

test("the stored digest is not the code and does not contain it", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store, { code: "123456" });

  const view = store.unsafeActiveView(PURPOSE, PHONE);
  assert.equal(view, undefined, "still pending, so nothing is live yet");
  const all = store.unsafeAllViews();
  assert.equal(all.length, 1);
  const record = all[0];
  if (record === undefined) throw new Error("expected one record");

  assert.equal(record.id, reservation.id);
  assert.notEqual(record.codeHash, "123456");
  assert.ok(!record.codeHash.includes("123456"));
  assert.equal(record.codeHash.length, 64, "hex HMAC-SHA256");
  assert.ok(!JSON.stringify(record).includes("123456"));
  // And the raw number is not in there either — only its reference.
  assert.ok(!JSON.stringify(record).includes("13800138000"));
  assert.equal(record.phoneRef, PHONE);
});

test("the digest is bound to purpose and phone", () => {
  const shared = hasher.codeHash({ purpose: PURPOSE, phoneRef: PHONE, code: "123456" });
  assert.notEqual(shared, hasher.codeHash({ purpose: OTHER_PURPOSE, phoneRef: PHONE, code: "123456" }));
  assert.notEqual(shared, hasher.codeHash({ purpose: PURPOSE, phoneRef: OTHER_PHONE, code: "123456" }));
  assert.notEqual(shared, hasher.codeHash({ purpose: PURPOSE, phoneRef: PHONE, code: "654321" }));
  assert.equal(shared, hasher.codeHash({ purpose: PURPOSE, phoneRef: PHONE, code: "123456" }));
});

test("a digest mismatch is detected without comparing plaintext", () => {
  const a = hasher.codeHash({ purpose: PURPOSE, phoneRef: PHONE, code: "123456" });
  const b = hasher.codeHash({ purpose: PURPOSE, phoneRef: PHONE, code: "123457" });
  assert.equal(constantTimeEqualHex(a, a), true);
  assert.equal(constantTimeEqualHex(a, b), false);
  assert.equal(constantTimeEqualHex(a.slice(0, 63), a), false, "length mismatch");
  assert.equal(constantTimeEqualHex("", ""), false, "empty digests never match");
  assert.equal(constantTimeEqualHex("zz", "zz"), false, "unparseable hex never matches");
  assert.equal(constantTimeEqualHex(undefined, a), false);
  assert.equal(constantTimeEqualHex(a, 42), false);
});

/* ──────────────────── the digest is not challenge-bound ──────────────────── */

test("the same code across a resend digests identically, and is still single-use", async () => {
  // The documented boundary (`createOtpHasher`, `OtpChallengeStore`): the digest
  // binds purpose and phone, not the challenge instance. A code that happens to
  // repeat — 1 in 10^6 for six digits — is therefore the same secret the user was
  // just sent, not an old one resurrected, because activating a new challenge
  // deletes the previous record.
  const store = createMemoryChallengeStore();
  const shared = codeHash("123456");

  const first = await begin(store, { code: "123456" });
  await store.activateChallenge({ id: first.id, generation: first.generation, now: T0 });
  const firstView = store.unsafeActiveView(PURPOSE, PHONE);
  assert.equal(firstView?.codeHash, shared);

  const second = await begin(store, { code: "123456" });
  await store.activateChallenge({ id: second.id, generation: second.generation, now: T0 });
  const secondView = store.unsafeActiveView(PURPOSE, PHONE);
  assert.equal(secondView?.codeHash, shared, "the digest does not vary with the challenge");
  assert.notEqual(second.id, first.id);
  assert.deepEqual(store.stats(), { total: 1, active: 1, pending: 0 });

  // Consumable exactly once: there is no superseded record left holding the same
  // digest for a second attempt.
  assert.equal(
    (await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: shared, now: T0 })).status,
    "consumed",
  );
  assert.equal(
    (await store.consumeChallenge({ purpose: PURPOSE, phoneRef: PHONE, codeHash: shared, now: T0 })).status,
    "absent",
  );
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });
});

/* ───────────────────────────── maintenance ───────────────────────────── */

test("pruneExpiredChallenges removes expired records only", async () => {
  const store = createMemoryChallengeStore();
  await begin(store, { code: "111111", ttlMs: 60_000 });
  await begin(store, { code: "222222", purpose: OTHER_PURPOSE, ttlMs: 600_000 });

  const removed = await store.pruneExpiredChallenges({ now: T0 + 120_000 });
  assert.deepEqual(removed, { removed: 1 });
  assert.equal(store.stats().total, 1);

  const again = await store.pruneExpiredChallenges({ now: T0 + 120_000 });
  assert.deepEqual(again, { removed: 0 });
});

test("clear empties everything the store holds", async () => {
  const store = createMemoryChallengeStore();
  const reservation = await begin(store);
  await store.activateChallenge({ id: reservation.id, generation: 1, now: T0 });
  store.clear();
  assert.deepEqual(store.stats(), { total: 0, active: 0, pending: 0 });
  // Generations reset too, which is what makes a test's second run identical.
  const fresh = await begin(store);
  assert.equal(fresh.generation, 1);
});
