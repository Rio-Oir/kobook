// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createOtpHasher } from "../../src/otp/crypto";
import type { OtpChallengeStore } from "../../src/otp/store";
import type { OtpRateLimiter, OtpRateLimitRuleset } from "../../src/otp/limiter";

/** Fresh isolated namespace per case; peers must share its backing state. */
export interface AdapterFixture<T> {
  peers: readonly [T, T, ...T[]];
  /** Epoch milliseconds. Adapter must honour operation `now`, including TTL tests. */
  now: number;
  /** Remove only this fixture's resources; called even when assertions fail. */
  dispose(): Promise<void>;
}
export interface AdapterConformanceOptions {
  name: string;
  store(): Promise<AdapterFixture<OtpChallengeStore>>;
  limiter(): Promise<AdapterFixture<OtpRateLimiter>>;
}

const hasher = createOtpHasher("conformance-fixture-only-0123456789abcdef");
const phoneRef = hasher.phoneRef("+8613800138000");
const clientRef = hasher.clientRef("trusted:test-client");
const purpose = "sign-in";
const digest = (code: string) => hasher.codeHash({ phoneRef, purpose, code });
const wide = [{ limit: 100, windowMs: 60_000 }];
const rules: OtpRateLimitRuleset = {
  send: { phone: [{ limit: 2, windowMs: 1000 }], client: wide },
  verify: { phone: wide, client: [{ limit: 2, windowMs: 1000 }] },
};

/** Test-only entry: register identical assertions for any existing adapter. */
export function registerAdapterConformance(options: AdapterConformanceOptions): void {
  function check<T>(label: string, open: () => Promise<AdapterFixture<T>>, run: (fixture: AdapterFixture<T>) => Promise<void>): void {
    test(`${options.name}: ${label}`, async () => {
      const fixture = await open();
      try { await run(fixture); } finally { await fixture.dispose(); }
    });
  }
  const reserve = (store: OtpChallengeStore, now: number, code = "123456") => store.beginChallenge({
    purpose, phoneRef, codeHash: digest(code), now, ttlMs: 1000, maxAttempts: 3,
  });
  const consume = (store: OtpChallengeStore, now: number, code = "123456") =>
    store.consumeChallenge({ purpose, phoneRef, codeHash: digest(code), now });

  check("pending is unusable; shared concurrent consume succeeds once; replay fails", options.store, async ({ peers: [a, b], now }) => {
    const r = await reserve(a, now);
    assert.notEqual((await consume(b, now)).status, "consumed");
    assert.equal((await a.activateChallenge({ ...r, now })).activated, true);
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => consume(i % 2 ? a : b, now)));
    assert.equal(outcomes.filter(o => o.status === "consumed").length, 1);
    assert.notEqual((await consume(b, now)).status, "consumed");
  });
  check("wrong attempts commit across connections and exhaust atomically", options.store, async ({ peers: [a, b], now }) => {
    const r = await reserve(a, now);
    await a.activateChallenge({ ...r, now });
    assert.deepEqual(await consume(b, now, "000000"), { status: "mismatch", attemptsRemaining: 2 });
    await Promise.all([consume(a, now, "000000"), consume(b, now, "000000")]);
    assert.notEqual((await consume(a, now)).status, "consumed");
  });
  check("expiry exact boundary and clock rollback cannot resurrect", options.store, async ({ peers: [a, b], now }) => {
    const r = await reserve(a, now);
    await a.activateChallenge({ ...r, now });
    assert.ok(["expired", "absent"].includes((await consume(b, now + 1000)).status));
    assert.notEqual((await consume(a, now)).status, "consumed");
    const pending = await reserve(a, now);
    assert.equal((await b.activateChallenge({ ...pending, now: now + 1000 })).activated, false);
  });
  check("concurrent activations leave exactly one consumable challenge", options.store, async ({ peers: [a, b], now }) => {
    const first = await reserve(a, now, "123456");
    const second = await reserve(b, now, "654321");
    await Promise.all([a.activateChallenge({ ...first, now }), b.activateChallenge({ ...second, now })]);
    const results = await Promise.all([consume(a, now, "123456"), consume(b, now, "654321")]);
    assert.equal(results.filter(r => r.status === "consumed").length, 1);
  });
  check("failed resend cleanup and stale generation preserve active code", options.store, async ({ peers: [a, b], now }) => {
    const live = await reserve(a, now);
    await a.activateChallenge({ ...live, now });
    const pending = await reserve(b, now, "654321");
    assert.equal((await a.revokeChallenge({ ...pending, generation: pending.generation + 1, now })).revoked, false);
    assert.equal((await b.revokeChallenge({ ...pending, now })).revoked, true);
    assert.equal((await a.revokeChallenge({ ...live, now })).revoked, false);
    assert.equal((await consume(b, now)).status, "consumed");
  });
  check("phone and purpose isolation", options.store, async ({ peers: [a, b], now }) => {
    const r = await reserve(a, now);
    await a.activateChallenge({ ...r, now });
    for (const changed of [{ purpose: "bind-phone" }, { phoneRef: hasher.phoneRef("+8613900139000") }]) {
      assert.notEqual((await b.consumeChallenge({ purpose, phoneRef, codeHash: digest("123456"), now, ...changed })).status, "consumed");
    }
    assert.equal((await consume(a, now)).status, "consumed");
  });
  check("shared send concurrency, phone scope, refusal does not extend window", options.limiter, async ({ peers: [a, b], now }) => {
    const input = { bucket: "send" as const, phoneRef, clientRef, now, rules };
    const hits = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).consume({ ...input, clientRef: hasher.clientRef(`trusted:${i}`) })));
    assert.equal(hits.filter(h => h.allowed).length, 2);
    assert.equal((await b.consume({ ...input, now: now + 999 })).allowed, false);
    assert.equal((await a.consume({ ...input, now: now + 1000 })).allowed, true);
  });
  check("verify client scope survives phone changes; buckets are independent", options.limiter, async ({ peers: [a, b], now }) => {
    const input = { bucket: "verify" as const, phoneRef, clientRef, now, rules };
    assert.equal((await a.consume(input)).allowed, true);
    assert.equal((await b.consume({ ...input, phoneRef: hasher.phoneRef("+8613900139000") })).allowed, true);
    assert.equal((await a.consume(input)).allowed, false);
    assert.equal((await b.consume({ ...input, bucket: "send" })).allowed, true);
  });
  check("release removes one exact event and preserves other charged attempts", options.limiter, async ({ peers: [a, b], now }) => {
    const input = { bucket: "send" as const, phoneRef, clientRef, now, rules };
    await a.consume(input);
    await b.consume({ ...input, now: now + 1 });
    assert.equal((await a.release({ bucket: "send", phoneRef, clientRef, at: now + 99 })).released, false);
    assert.equal((await b.release({ bucket: "send", phoneRef, clientRef, at: now })).released, true);
    assert.equal((await a.release({ bucket: "send", phoneRef, clientRef, at: now })).released, false);
    assert.equal((await a.consume({ ...input, now: now + 2 })).allowed, true);
    assert.equal((await b.consume({ ...input, now: now + 3 })).allowed, false);
  });
}
