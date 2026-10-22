// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Configuration validation and the production guard.
 *
 * Two properties, and they pull in opposite directions, which is why both are
 * here:
 *
 * - **The guard is real.** `runtime: "production"` refuses every test-only
 *   component, one at a time, naming which one — so a deployment that lost its
 *   store wiring fails at startup instead of shipping a memory store.
 * - **The guard is not a blanket refusal.** A production configuration with
 *   ordinary adapters is accepted and works, which is asserted end-to-end
 *   below. A guard that rejected everything would be indistinguishable from a
 *   module nobody can deploy, and the "no adapters exist yet" limitation would
 *   be hidden rather than documented.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeSmsTransport,
  createMemoryChallengeStore,
  cooldownMsFor,
  createMemoryRateLimiter,
  DEFAULT_LIMITS,
  describeResolvedConfig,
  isPhoneOtpKitError,
  isTestOnlyComponent,
  PhoneOtpService,
  resolvePhoneOtpConfig,
  TEST_ONLY_BRAND,
  type ConsumeChallengeOutcome,
  type OtpChallengeStore,
  type OtpRateLimiter,
  type PhoneOtpConfig,
  type PhoneOtpLimitsInput,
  type SmsSendRequest,
  type SmsSendResult,
  type SmsTransport,
} from "../src/server";

const TEST_SECRET = "config-suite-secret-0123456789abcdefghijkl";
const PURPOSE = "sign-in";

function components(): Pick<PhoneOtpConfig, "store" | "limiter" | "transport"> {
  return {
    store: createMemoryChallengeStore(),
    limiter: createMemoryRateLimiter(),
    transport: createFakeSmsTransport(),
  };
}

function baseConfig(overrides: Partial<PhoneOtpConfig> = {}): PhoneOtpConfig {
  return {
    runtime: "test",
    secret: TEST_SECRET,
    allowedPurposes: [PURPOSE],
    ...components(),
    ...overrides,
  };
}

function expectConfigError(run: () => unknown, code: string, details?: Record<string, unknown>): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(isPhoneOtpKitError(error), `expected a PhoneOtpKitError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

/* ─────────────────────────── defaults ─────────────────────────── */

test("a minimal configuration resolves to the documented defaults", () => {
  const resolved = resolvePhoneOtpConfig(baseConfig());
  assert.equal(resolved.runtime, "test");
  assert.equal(resolved.codeLength, 6);
  assert.equal(resolved.codeTtlMs, 300_000);
  assert.equal(resolved.maxVerifyAttempts, 5);
  assert.equal(resolved.requireTrustedClient, true, "fail closed is the default");
  assert.equal(resolved.refundFailedSend, false, "every provider call is charged unless opted out");
  assert.equal(resolved.smsTemplateId, undefined);
  assert.deepEqual(resolved.allowedPurposes, new Set([PURPOSE]));
  // 0 because the default send budget is a stepped pair, and a stepped budget has
  // no statically knowable next-allowed time. See `cooldownMsFor`.
  assert.equal(resolved.sendCooldownMs, 0);
  assert.deepEqual(resolved.limits, DEFAULT_LIMITS);
});

test("the default budgets are the documented ones", () => {
  // Pinned because these numbers are a product decision, and a silent change to
  // them changes how many SMS a deployment pays for.
  assert.deepEqual(DEFAULT_LIMITS.send.phone, [
    { limit: 1, windowMs: 60_000 },
    { limit: 5, windowMs: 3_600_000 },
  ]);
  assert.deepEqual(DEFAULT_LIMITS.send.client, [
    { limit: 10, windowMs: 60_000 },
    { limit: 50, windowMs: 3_600_000 },
  ]);
  assert.deepEqual(DEFAULT_LIMITS.verify.phone, [{ limit: 10, windowMs: 900_000 }]);
  assert.deepEqual(DEFAULT_LIMITS.verify.client, [{ limit: 30, windowMs: 3_600_000 }]);
});

test("limits can be overridden per scope, and the rest stay at their defaults", () => {
  const resolved = resolvePhoneOtpConfig(
    baseConfig({ limits: { send: { phone: [{ limit: 2, windowMs: 120_000 }] } } }),
  );
  assert.deepEqual(resolved.limits.send.phone, [{ limit: 2, windowMs: 120_000 }]);
  assert.deepEqual(resolved.limits.send.client, DEFAULT_LIMITS.send.client);
  assert.deepEqual(resolved.limits.verify, DEFAULT_LIMITS.verify);
  assert.equal(resolved.sendCooldownMs, 120_000, "a single rule states the wait exactly");
});

test("the cooldown hint is the rule's window, and only for a single rule", () => {
  // With one rule the next allowed attempt is exactly one window after the last,
  // so the figure is exact. With more than one there is no static answer and the
  // hint is 0, because a wrong countdown is worse than none: `1/minute + 5/hour`
  // is the case that motivated this, and any single number would be a guess.
  const single = resolvePhoneOtpConfig(
    baseConfig({ limits: { send: { phone: [{ limit: 5, windowMs: 60_000 }] } } }),
  );
  assert.equal(single.sendCooldownMs, 60_000);

  const stepped = resolvePhoneOtpConfig(baseConfig());
  assert.equal(stepped.limits.send.phone.length, 2);
  assert.equal(stepped.sendCooldownMs, 0, "a multi-rule budget has no static next-allowed time");

  // An empty rule list is not reachable through configuration (validation
  // refuses it), but the helper is defensive about it anyway.
  assert.equal(cooldownMsFor([]), 0);
});

/* ──────────────────────── redacted summary ──────────────────────── */

test("the summary carries no secret and names the component provenance", () => {
  const summary = describeResolvedConfig(resolvePhoneOtpConfig(baseConfig()));
  const rendered = JSON.stringify(summary);
  assert.ok(!rendered.includes(TEST_SECRET));
  assert.ok(!rendered.includes("secret"));
  assert.ok(!rendered.includes("hasher"));
  assert.deepEqual(summary.components, {
    store: "test-only",
    limiter: "test-only",
    transport: "test-only",
  });
  assert.equal(summary.runtime, "test");
  assert.deepEqual(summary.purposes, [PURPOSE]);
});

/* ────────────────────── the production guard ────────────────────── */

test("production refuses the memory challenge store, by name", () => {
  expectConfigError(
    () => resolvePhoneOtpConfig(baseConfig({ runtime: "production" })),
    "TEST_ONLY_COMPONENT_IN_PRODUCTION",
    { component: "store" },
  );
});

test("production refuses the in-process limiter when the store is real", () => {
  const { store, transport } = productionShaped();
  expectConfigError(
    () =>
      resolvePhoneOtpConfig(
        baseConfig({
          runtime: "production",
          store,
          limiter: createMemoryRateLimiter(),
          transport,
        }),
      ),
    "TEST_ONLY_COMPONENT_IN_PRODUCTION",
    { component: "limiter" },
  );
});

test("production refuses the fake transport when everything else is real", () => {
  const { store, limiter } = productionShaped();
  expectConfigError(
    () => resolvePhoneOtpConfig(baseConfig({ runtime: "production", store, limiter, transport: createFakeSmsTransport() })),
    "TEST_ONLY_COMPONENT_IN_PRODUCTION",
    { component: "transport" },
  );
});

test("the brand is non-enumerable, so a spread copy is not a way past the guard", () => {
  const store = createMemoryChallengeStore();
  assert.deepEqual(Object.keys(store), [], "no enumerable own properties");
  assert.ok(Object.getOwnPropertySymbols(store).includes(TEST_ONLY_BRAND));

  const spread = { ...store };
  assert.equal(isTestOnlyComponent(spread), false, "the brand does not survive a spread");
  // Which is not a loophole: the copy loses the methods too, and validation
  // refuses it earlier than the production guard would.
  expectConfigError(
    () =>
      resolvePhoneOtpConfig(
        baseConfig({ runtime: "production", store: spread as unknown as OtpChallengeStore }),
      ),
    "INVALID_CONFIG",
    { field: "store" },
  );
});

test("production accepts a production-shaped configuration, and it works", async () => {
  const shape = productionShaped();
  const productionConfig = baseConfig({
    runtime: "production",
    store: shape.store,
    limiter: shape.limiter,
    transport: shape.transport,
  });
  const service = PhoneOtpService.create({ config: productionConfig });

  assert.equal(service.runtime, "production");
  // `describeResolvedConfig` returns an open record on purpose, so the test
  // narrows the one field it reads rather than the module widening its type.
  const summary = describeResolvedConfig(resolvePhoneOtpConfig(productionConfig)) as {
    readonly components: { readonly store: string };
  };
  assert.equal(summary.components.store, "adapted");

  const requested = await service.requestCode({
    phone: "+8613800138000",
    clientRef: "client:alpha",
    purpose: PURPOSE,
  });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(shape.sent.length, 1);
  // The production path is a working path: the prompt is issued, the transport
  // is called, and the challenge was published.
  assert.deepEqual(shape.sent[0]?.purpose, PURPOSE);
  assert.deepEqual(shape.calls, ["begin", "activate"]);
});

/* ───────────────────────── secret validation ───────────────────────── */

test("a missing or short secret fails at construction with WEAK_SECRET", () => {
  for (const secret of [undefined, "", "too-short", "x".repeat(31)]) {
    expectConfigError(
      () => resolvePhoneOtpConfig(baseConfig({ secret: secret as unknown as string })),
      "WEAK_SECRET",
      { field: "secret", minBytes: 32 },
    );
  }
});

test("a Uint8Array secret is accepted and measured in bytes", () => {
  const resolved = resolvePhoneOtpConfig(baseConfig({ secret: new Uint8Array(32).fill(7) }));
  assert.equal(typeof resolved.hasher.phoneRef("+8613800138000"), "string");
  expectConfigError(
    () => resolvePhoneOtpConfig(baseConfig({ secret: new Uint8Array(16) })),
    "WEAK_SECRET",
    { field: "secret", minBytes: 32 },
  );
});

/* ────────────────────────── runtime ────────────────────────── */

test("runtime must be declared, and only the two known values are accepted", () => {
  expectConfigError(
    () => resolvePhoneOtpConfig(baseConfig({ runtime: undefined as unknown as "test" })),
    "INVALID_CONFIG",
    { field: "runtime" },
  );
  assert.equal(resolvePhoneOtpConfig(baseConfig({ runtime: "test" })).runtime, "test");
  const shape = productionShaped();
  assert.equal(
    resolvePhoneOtpConfig(
      baseConfig({ runtime: "production", store: shape.store, limiter: shape.limiter, transport: shape.transport }),
    ).runtime,
    "production",
  );
  for (const runtime of ["staging", "dev", "PRODUCTION", "", true]) {
    expectConfigError(
      () => resolvePhoneOtpConfig(baseConfig({ runtime: runtime as unknown as "test" })),
      "INVALID_CONFIG",
      { field: "runtime" },
    );
  }
});

/* ───────────────────────── purposes ───────────────────────── */

test("purposes must be present, pattern-valid and unique", () => {
  const purposes: readonly unknown[] = [
    [],
    ["Sign-In"],
    ["sign in"],
    ["1sign-in"],
    ["sign-in", "sign-in"],
    ["sign-in", "sign-in ", "bind"],
    ["x".repeat(33)],
    "sign-in",
    [1],
  ];
  for (const allowedPurposes of purposes) {
    expectConfigError(
      () => resolvePhoneOtpConfig(baseConfig({ allowedPurposes: allowedPurposes as readonly string[] })),
      "INVALID_CONFIG",
      { field: "allowedPurposes" },
    );
  }
  assert.equal(
    resolvePhoneOtpConfig(baseConfig({ allowedPurposes: ["sign-in", "bind-phone", "recover_2"] })).allowedPurposes.size,
    3,
  );
});

/* ───────────────────────── numeric ranges ───────────────────────── */

test("numeric options are range-checked and report their field", () => {
  const cases: ReadonlyArray<readonly [string, Partial<PhoneOtpConfig>]> = [
    ["codeLength", { codeLength: 5 }],
    ["codeLength", { codeLength: 9 }],
    ["codeLength", { codeLength: 6.5 }],
    ["codeTtlMs", { codeTtlMs: 1_000 }],
    ["codeTtlMs", { codeTtlMs: 31 * 60_000 }],
    ["maxVerifyAttempts", { maxVerifyAttempts: 0 }],
    ["maxVerifyAttempts", { maxVerifyAttempts: 11 }],
  ];
  for (const [field, overrides] of cases) {
    expectConfigError(() => resolvePhoneOtpConfig(baseConfig(overrides)), "INVALID_CONFIG", { field });
  }

  assert.equal(resolvePhoneOtpConfig(baseConfig({ codeLength: 8 })).codeLength, 8);
  assert.equal(resolvePhoneOtpConfig(baseConfig({ codeTtlMs: 30_000 })).codeTtlMs, 30_000);
  assert.equal(resolvePhoneOtpConfig(baseConfig({ maxVerifyAttempts: 10 })).maxVerifyAttempts, 10);
});

test("requireTrustedClient must be a boolean", () => {
  assert.equal(resolvePhoneOtpConfig(baseConfig({ requireTrustedClient: false })).requireTrustedClient, false);
  expectConfigError(
    () => resolvePhoneOtpConfig(baseConfig({ requireTrustedClient: "yes" as unknown as boolean })),
    "INVALID_CONFIG",
    { field: "requireTrustedClient" },
  );
});

test("refundFailedSend must be a boolean", () => {
  assert.equal(resolvePhoneOtpConfig(baseConfig({ refundFailedSend: false })).refundFailedSend, false);
  assert.equal(resolvePhoneOtpConfig(baseConfig({})).refundFailedSend, false);
  expectConfigError(
    () => resolvePhoneOtpConfig(baseConfig({ refundFailedSend: 1 as unknown as boolean })),
    "INVALID_CONFIG",
    { field: "refundFailedSend" },
  );
});

test("smsTemplateId is optional but must be a plain provider identifier", () => {
  assert.equal(
    resolvePhoneOtpConfig(baseConfig({ smsTemplateId: "SMS_123456789" })).smsTemplateId,
    "SMS_123456789",
  );
  for (const smsTemplateId of ["", "has space", "a".repeat(65), "tpl;drop", "+86"]) {
    expectConfigError(
      () => resolvePhoneOtpConfig(baseConfig({ smsTemplateId })),
      "INVALID_CONFIG",
      { field: "smsTemplateId" },
    );
  }
});

/* ───────────────────────── limit rules ───────────────────────── */

test("limit rules are range-checked and report their scope", () => {
  const bad: readonly PhoneOtpLimitsInput[] = [
    { send: { phone: [] } },
    { send: { phone: [{ limit: 0, windowMs: 60_000 }] } },
    { send: { phone: [{ limit: 10_001, windowMs: 60_000 }] } },
    { send: { phone: [{ limit: 1, windowMs: 999 }] } },
    { send: { phone: [{ limit: 1, windowMs: 86_400_001 }] } },
    { send: { phone: [{ limit: 1 } as { limit: number; windowMs: number }] } },
    {
      verify: {
        client: Array.from({ length: 5 }, () => ({ limit: 1, windowMs: 60_000 })),
      },
    },
    { send: "everything" as never },
  ];
  for (const limits of bad) {
    expectConfigError(
      () => resolvePhoneOtpConfig(baseConfig({ limits })),
      "INVALID_CONFIG",
      { field: limits.send !== undefined ? "limits.send" : "limits.verify" },
    );
  }
});

test("the maximum number of rules per scope is accepted", () => {
  const rules = Array.from({ length: 4 }, (_, index) => ({ limit: index + 1, windowMs: 60_000 }));
  const resolved = resolvePhoneOtpConfig(baseConfig({ limits: { send: { phone: rules } } }));
  assert.equal(resolved.limits.send.phone.length, 4);
});

/* ───────────────────────── components ───────────────────────── */

test("a component missing its methods is refused, naming the component", () => {
  const { store, limiter, transport } = components();
  const cases: ReadonlyArray<readonly [string, Partial<PhoneOtpConfig>]> = [
    ["store", { store: { beginChallenge: () => undefined } as unknown as OtpChallengeStore }],
    ["store", { store: undefined as unknown as OtpChallengeStore }],
    ["store", { store: "redis://…" as unknown as OtpChallengeStore }],
    ["limiter", { limiter: {} as unknown as OtpRateLimiter }],
    ["transport", { transport: { kind: "acme" } as unknown as SmsTransport }],
    ["transport", { transport: null as unknown as SmsTransport }],
  ];
  for (const [field, overrides] of cases) {
    expectConfigError(() => resolvePhoneOtpConfig(baseConfig(overrides)), "INVALID_CONFIG", { field });
  }
  // And the complete set passes.
  assert.ok(resolvePhoneOtpConfig(baseConfig({ store, limiter, transport })));
});

test("an onError that is not a function is refused", () => {
  expectConfigError(
    () => resolvePhoneOtpConfig(baseConfig({ onError: "log" as unknown as () => void })),
    "INVALID_CONFIG",
    { field: "onError" },
  );
});

test("a non-object configuration is refused rather than defaulted", () => {
  for (const config of [undefined, null, "config", 42]) {
    expectConfigError(
      () => resolvePhoneOtpConfig(config as unknown as PhoneOtpConfig),
      "INVALID_CONFIG",
      { field: "config" },
    );
  }
});

/* ─────────────────────── the service constructor ─────────────────────── */

test("PhoneOtpService.create validates, and is the only way to build one", () => {
  // The "only way" half is a compile-time guarantee: the constructor is private,
  // so `new PhoneOtpService(…)` is a type error checked by the module's own
  // `tsc` run rather than at runtime, where TypeScript modifiers do not exist.
  expectConfigError(
    () => PhoneOtpService.create({ config: baseConfig({ runtime: "production" }) }),
    "TEST_ONLY_COMPONENT_IN_PRODUCTION",
    { component: "store" },
  );
  const service = PhoneOtpService.create({ config: baseConfig() });
  assert.equal(service.runtime, "test");
  assert.ok(!JSON.stringify(service.describe()).includes(TEST_SECRET));
  assert.equal(typeof PhoneOtpService.create, "function");
});

/* ─────────────────────────── helpers ─────────────────────────── */

/**
 * Adapters with the shape a real one would have — no test-only brand, so the
 * production guard lets them through. Minimal by design: this file is about
 * configuration, not about behaviour.
 */
function productionShaped(): {
  readonly store: OtpChallengeStore;
  readonly limiter: OtpRateLimiter;
  readonly transport: SmsTransport;
  readonly sent: SmsSendRequest[];
  readonly calls: string[];
} {
  const sent: SmsSendRequest[] = [];
  const calls: string[] = [];
  let counter = 0;

  const store: OtpChallengeStore = {
    beginChallenge: (input) => {
      calls.push("begin");
      counter += 1;
      return Promise.resolve({
        id: `durable_${counter}`,
        generation: counter,
        expiresAt: input.now + input.ttlMs,
      });
    },
    activateChallenge: () => {
      calls.push("activate");
      return Promise.resolve({ activated: true, superseded: false });
    },
    revokeChallenge: () => {
      calls.push("revoke");
      return Promise.resolve({ revoked: true, reason: "revoked" as const });
    },
    consumeChallenge: (): Promise<ConsumeChallengeOutcome> => {
      calls.push("consume");
      return Promise.resolve({ status: "absent" });
    },
    pruneExpiredChallenges: () => Promise.resolve({ removed: 0 }),
  };

  const limiter: OtpRateLimiter = {
    consume: () => Promise.resolve({ allowed: true, retryAfterMs: 0, remaining: 9 }),
    release: () => Promise.resolve({ released: true }),
  };

  const transport: SmsTransport = {
    kind: "durable-stub",
    send: (request): Promise<SmsSendResult> => {
      sent.push(request);
      return Promise.resolve({ ok: true });
    },
  };

  return { store, limiter, transport, sent, calls };
}
