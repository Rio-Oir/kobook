// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared test harness.
 *
 * Builds a complete `PhoneOtpService` out of the test-only components plus an
 * injected clock, so every test can advance time instead of sleeping and can
 * read the code that the transport "delivered".
 *
 * The secret is a literal here because this file is test-only and the kit reads
 * no environment. `WEAK_SECRET` guards the module's own secrets, not fixtures.
 */

import {
  createFakeSmsTransport,
  createMemoryChallengeStore,
  createMemoryRateLimiter,
  PhoneOtpService,
  type FakeSmsOutboxEntry,
  type FakeSmsTransport,
  type MemoryChallengeStore,
  type MemoryRateLimiter,
  type OtpChallengeStore,
  type OtpRateLimiter,
  type PhoneOtpConfig,
  type PhoneOtpLimitsInput,
  type PhoneOtpObservation,
  type SmsSendRequest,
  type SmsSendResult,
} from "../../src/server";

/** Long enough to satisfy the 32-byte minimum. */
export const TEST_SECRET = "phone-otp-kit-test-secret-0123456789abcdef";

export const SIGN_IN = "sign-in";
export const BIND_PHONE = "bind-phone";

/** A mainland mobile in E.164. */
export const PHONE_A = "+8613800138000";
export const PHONE_B = "+8613900139000";

/** Valid `clientRef` values: 8–128 chars of `[A-Za-z0-9_.:~-]`. */
export function client(seed: string): string {
  return `client:${seed}`;
}

const CLOCK_START = 1_700_000_000_000;

export interface HarnessOptions {
  readonly runtime?: "production" | "test";
  readonly limits?: PhoneOtpLimitsInput;
  readonly onSend?: (request: SmsSendRequest, callIndex: number) => SmsSendResult | undefined | Promise<SmsSendResult | undefined>;
  readonly allowedPurposes?: readonly string[];
  readonly maxVerifyAttempts?: number;
  readonly codeTtlMs?: number;
  readonly requireTrustedClient?: boolean;
  readonly refundFailedSend?: boolean;
  readonly observations?: PhoneOtpObservation[];
}

export interface Harness {
  readonly service: PhoneOtpService;
  readonly store: MemoryChallengeStore;
  readonly limiter: MemoryRateLimiter;
  readonly transport: FakeSmsTransport;
  /** Epoch ms the service currently believes it is. */
  now(): number;
  /** Move the clock forward. */
  advance(ms: number): void;
  /** The code from the most recent successful send. */
  lastCode(): string;
  lastEntry(): FakeSmsOutboxEntry | undefined;
  /** Every observation the `onError` hook received, in order. */
  observations(): readonly PhoneOtpObservation[];
}

export function createHarness(options: HarnessOptions = {}): Harness {
  let clock = CLOCK_START;
  const observations = options.observations ?? [];

  const store = createMemoryChallengeStore();
  const transport = createFakeSmsTransport({
    now: () => clock,
    ...(options.onSend === undefined ? {} : { onSend: options.onSend }),
  });

  // The limiter holds no rules: the service passes the resolved configuration
  // with every call, which is what makes `options.limits` the only place this
  // harness decides a budget.
  const limiter = createMemoryRateLimiter();

  const config: PhoneOtpConfig = {
    runtime: options.runtime ?? "test",
    secret: TEST_SECRET,
    allowedPurposes: options.allowedPurposes ?? [SIGN_IN, BIND_PHONE],
    store,
    limiter,
    transport,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.maxVerifyAttempts === undefined ? {} : { maxVerifyAttempts: options.maxVerifyAttempts }),
    ...(options.codeTtlMs === undefined ? {} : { codeTtlMs: options.codeTtlMs }),
    ...(options.requireTrustedClient === undefined
      ? {}
      : { requireTrustedClient: options.requireTrustedClient }),
    ...(options.refundFailedSend === undefined
      ? {}
      : { refundFailedSend: options.refundFailedSend }),
    onError: (observation) => {
      observations.push(observation);
    },
  };

  const service = PhoneOtpService.create({ config, now: () => clock });

  return {
    service,
    store,
    limiter,
    transport,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    lastCode: () => {
      const entry = transport.latest();
      if (entry === undefined || !entry.delivered) {
        throw new Error("harness: no delivered code in the fake outbox");
      }
      return entry.code;
    },
    lastEntry: () => transport.latest(),
    observations: () => observations,
  };
}

/**
 * A limiter whose `consume` always rejects.
 *
 * Deliberately a plain object rather than a decorated memory limiter: the point
 * of the fail-closed tests is what the service does when a *dependency* fails,
 * and forwarding to a real implementation would make the failure conditional on
 * that implementation's internals.
 */
export const throwingLimiter: OtpRateLimiter = {
  consume: () => Promise.reject(new Error("limiter backend unavailable: 13800138000")),
  release: () => Promise.reject(new Error("limiter backend unavailable: 13800138000")),
};

/** A store whose every operation rejects, for the fail-closed tests. */
export function throwingStore(): OtpChallengeStore {
  const failure = (operation: string) => () =>
    Promise.reject(new Error(`store unavailable during ${operation}: 13800138000`));
  return {
    beginChallenge: failure("begin"),
    activateChallenge: failure("activate"),
    revokeChallenge: failure("revoke"),
    consumeChallenge: failure("consume"),
    pruneExpiredChallenges: failure("prune"),
  };
}
