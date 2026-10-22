// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Configuration resolution and validation.
 *
 * Everything the kit does is decided here, once, at construction: the secret,
 * the purposes, the lifetime, the attempt allowance, the budgets, and which
 * components are wired in. `createPhoneOtpService` resolves the config before it
 * builds anything, so a misconfiguration throws at startup rather than at the
 * first user request.
 *
 * Two rules shape the whole file:
 *
 * - **Nothing is read from the environment.** No `process.env`, no file, no
 *   `.env`. The caller passes a plain object, which makes a deployment's
 *   configuration reviewable in one place and makes the module testable without
 *   mutating global state.
 * - **There are no production-safe-looking defaults for the dangerous parts.**
 *   `runtime` has no default, and the secret has no default. A default for
 *   either would be the mechanism by which a production process quietly starts
 *   with a development secret or a fake transport.
 *
 * ## The runtime declaration
 *
 * `runtime: "production" | "test"` is a statement the deployment makes about
 * itself, and the kit acts on it: in production, any component carrying the
 * test-only brand (memory store, memory limiter, fake transport) is refused.
 * There is no flag to skip the check. The value must come from the deployment's
 * own configuration — never from a request, a header or a database row, because
 * "the caller told me I am in test mode" would make the guard meaningless.
 *
 * `"test"` covers development and CI too; the module does not model a third
 * mode, because "development only" and "test only" have the same safety
 * property: neither is production.
 *
 * ## Errors carry a field name and nothing else
 *
 * A validation failure reports `{ field: "codeTtlMs" }`. It does not report the
 * offending value, because the offending value might be the secret, and a
 * validation error is exactly the kind of thing that gets pasted into a bug
 * report.
 */

import {
  CLIENT_REF_PATTERN,
  DEFAULT_CODE_TTL_MS,
  DEFAULT_MAX_VERIFY_ATTEMPTS,
  MAX_CODE_TTL_MS,
  MAX_LIMIT,
  MAX_CODE_LENGTH,
  MAX_PURPOSES,
  MAX_RULES_PER_SCOPE,
  MAX_VERIFY_ATTEMPTS,
  MAX_WINDOW_MS,
  MIN_CODE_LENGTH,
  MIN_CODE_TTL_MS,
  MIN_LIMIT,
  MIN_VERIFY_ATTEMPTS,
  MIN_WINDOW_MS,
  OTP_CODE_LENGTH,
  PURPOSE_PATTERN,
} from "../shared/constants";
import { PhoneOtpKitError, type PhoneOtpResponseCode } from "../shared/errors";
import { createOtpHasher, toSecretBytes, type OtpHasher } from "./crypto";
import type {
  OtpRateBucket,
  OtpRateLimitRule,
  OtpRateLimitRules,
  OtpRateLimitRuleset,
  OtpRateLimiter,
  OtpRateScope,
} from "./limiter";
import type { OtpChallengeStore } from "./store";
import type { SmsFailureCode, SmsTransport } from "./sms";
import { isTestOnlyComponent, type PhoneOtpRuntime } from "./test-only";

/** Which operation an observation is about. */
export type PhoneOtpOperation = "request-code" | "verify-code";

/**
 * A PII-free signal for operators, called once per failed request.
 *
 * It carries an operation name and a code from the allowlist. It cannot carry a
 * phone number, a code, a client reference or a cause, because those are not
 * parameters. The kit has no logger of its own — this hook is how the integrator
 * connects one, so the wiring decision about what may be logged is theirs and is
 * visible in their code.
 */
export interface PhoneOtpObservation {
  readonly operation: PhoneOtpOperation;
  readonly code: PhoneOtpResponseCode;
  /**
   * The transport's classification, when the failure was a send. Always a member
   * of `SMS_FAILURE_CODES` — the service substitutes `UNKNOWN` for anything else
   * before calling the hook, so an adapter cannot get provider text into a log by
   * putting it where a code belongs.
   */
  readonly smsFailure?: SmsFailureCode;
  /** Which budget refused the request, when the failure was a limit. */
  readonly bucket?: OtpRateBucket;
  /** Which scope bound it. */
  readonly scope?: OtpRateScope;
}

/** The only values `runtime` accepts. */
const RUNTIMES: readonly PhoneOtpRuntime[] = ["production", "test"];

const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Default budgets.
 *
 * `send.phone` is a stepped pair: one code a minute, five an hour. The first rule
 * is the resend gate — the reason a user who mistypes their number cannot
 * immediately trigger a second SMS — and the second is the cost ceiling. Both
 * are per *number*, which is what makes rotating source addresses useless against
 * them.
 *
 * `verify.phone` is the brute-force control: ten attempts against one number per
 * fifteen minutes, on top of the per-challenge allowance (default five). Both
 * matter: the per-challenge allowance stops a single code from being ground down,
 * and the per-phone budget stops a fresh code from granting a fresh allowance.
 */
export const DEFAULT_LIMITS: OtpRateLimitRuleset = Object.freeze({
  send: Object.freeze({
    phone: Object.freeze([
      Object.freeze({ limit: 1, windowMs: 60_000 }),
      Object.freeze({ limit: 5, windowMs: 60 * 60_000 }),
    ]),
    client: Object.freeze([
      Object.freeze({ limit: 10, windowMs: 60_000 }),
      Object.freeze({ limit: 50, windowMs: 60 * 60_000 }),
    ]),
  }),
  verify: Object.freeze({
    phone: Object.freeze([Object.freeze({ limit: 10, windowMs: 15 * 60_000 })]),
    client: Object.freeze([Object.freeze({ limit: 30, windowMs: 60 * 60_000 })]),
  }),
});

export interface PhoneOtpLimitsInput {
  readonly send?: Partial<OtpRateLimitRules>;
  readonly verify?: Partial<OtpRateLimitRules>;
}

export interface PhoneOtpConfig {
  /** No default. The deployment states this explicitly, or construction fails. */
  readonly runtime: PhoneOtpRuntime;
  /** At least 32 bytes, as a UTF-8 string or raw bytes. No default. */
  readonly secret: string | Uint8Array;
  /** Every purpose the kit may issue a code for. At least one, no duplicates. */
  readonly allowedPurposes: readonly string[];
  readonly store: OtpChallengeStore;
  readonly limiter: OtpRateLimiter;
  readonly transport: SmsTransport;
  /** Digits per code. Default {@link OTP_CODE_LENGTH}. */
  readonly codeLength?: number;
  /** Challenge and code lifetime. Default five minutes. */
  readonly codeTtlMs?: number;
  /** Wrong codes a single challenge tolerates. Default five. */
  readonly maxVerifyAttempts?: number;
  /** Require a trusted client reference. Default `true` — the fail-closed default. */
  readonly requireTrustedClient?: boolean;
  /**
   * Refund the send budget when the transport refused the message. Default
   * **`false`**: every provider call is charged, whether it was delivered or not.
   *
   * The reasoning, because the other default is defensible and was tried first.
   * A refund is honest cost accounting — the provider accepted nothing, so
   * nothing was paid for. But it also removes the only thing bounding how many
   * times a caller can make the kit talk to the provider: during an outage, or
   * against a number the provider rejects, every failure would be refunded and
   * the send budget would never fill, so the caller can drive provider traffic
   * without limit. A budget that a *failure* resets is not a budget.
   *
   * So the default charges for the attempt. The cost is that a provider outage
   * consumes the user's send budget while it lasts, which is bounded by the
   * budget itself (1/minute, 5/hour by default) and recovers on its own.
   *
   * Setting this to `true` is supported for deployments that pair it with their
   * own provider-attempt bound — the refund is only safe when *something else*
   * limits the retry loop, and the kit cannot check that for you.
   */
  readonly refundFailedSend?: boolean;
  readonly smsTemplateId?: string;
  readonly limits?: PhoneOtpLimitsInput;
  /** Optional operator signal. Called with `{ operation, code }` only. */
  readonly onError?: (observation: PhoneOtpObservation) => void;
}

/**
 * Validated configuration, with the secret already reduced to a hasher.
 *
 * The raw secret does not appear in this object: once the hasher exists, keeping
 * the bytes around only creates somewhere for them to be read from later.
 */
export interface ResolvedPhoneOtpConfig {
  readonly runtime: PhoneOtpRuntime;
  readonly hasher: OtpHasher;
  readonly allowedPurposes: ReadonlySet<string>;
  readonly codeLength: number;
  readonly codeTtlMs: number;
  readonly maxVerifyAttempts: number;
  readonly requireTrustedClient: boolean;
  readonly refundFailedSend: boolean;
  readonly smsTemplateId: string | undefined;
  readonly limits: OtpRateLimitRuleset;
  readonly store: OtpChallengeStore;
  readonly limiter: OtpRateLimiter;
  readonly transport: SmsTransport;
  readonly onError: ((observation: PhoneOtpObservation) => void) | undefined;
  /** Advisory resend cooldown for the UI, derived from the send/phone rules. */
  readonly sendCooldownMs: number;
  /** What the client-reference check uses, exposed so the service and tests agree. */
  readonly clientRefPattern: RegExp;
}

function invalid(field: string): never {
  throw new PhoneOtpKitError("INVALID_CONFIG", { field });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(field);
  }
  return value;
}

function requireRule(value: unknown, field: string): OtpRateLimitRule {
  if (!isPlainObject(value)) invalid(field);
  return {
    limit: requireIntegerInRange(value.limit, field, MIN_LIMIT, MAX_LIMIT),
    windowMs: requireIntegerInRange(value.windowMs, field, MIN_WINDOW_MS, MAX_WINDOW_MS),
  };
}

function requireRuleList(value: unknown, field: string): readonly OtpRateLimitRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RULES_PER_SCOPE) {
    invalid(field);
  }
  return Object.freeze(value.map((rule) => Object.freeze(requireRule(rule, field))));
}

function requireScope(value: unknown, fallback: OtpRateLimitRules, field: string): OtpRateLimitRules {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) invalid(field);
  return Object.freeze({
    phone: value.phone === undefined ? fallback.phone : requireRuleList(value.phone, field),
    client: value.client === undefined ? fallback.client : requireRuleList(value.client, field),
  });
}

function resolveLimits(input: PhoneOtpLimitsInput | undefined): OtpRateLimitRuleset {
  if (input !== undefined && !isPlainObject(input)) invalid("limits");
  return Object.freeze({
    send: requireScope(input?.send, DEFAULT_LIMITS.send, "limits.send"),
    verify: requireScope(input?.verify, DEFAULT_LIMITS.verify, "limits.verify"),
  });
}

/**
 * A display hint for "when may this caller send again?", or `0` for "not
 * knowable from the configuration".
 *
 * Only a **single** rule yields a figure, and then the figure is that rule's
 * window: with one rule the next allowed attempt is exactly one window after the
 * last one, so the number is exact.
 *
 * With more than one rule there is no static answer, and any number would be a
 * guess. The tempting formula — the smallest `windowMs / limit`, i.e. the average
 * spacing — is wrong in both directions: for `[1 per minute, 5 per hour]` it
 * reports 60 seconds (a real gap only while the hourly rule is not binding) while
 * the budget's actual average is 720 seconds, and for `[1 per minute, 1 per hour]`
 * it reports 60 seconds when the true next-allowed time is an hour away. A
 * countdown that says "send again now" while the server refuses is worse than no
 * countdown.
 *
 * So a multi-rule budget reports `0`, the panel shows no timer, and the first
 * refusal supplies the real figure through `SEND_LIMITED.retryAfterMs`. A
 * deployment that wants a client-side countdown before the first refusal should
 * configure one rule per scope.
 */
export function cooldownMsFor(rules: readonly OtpRateLimitRule[]): number {
  if (rules.length !== 1) return 0;
  return rules[0]?.windowMs ?? 0;
}

function requirePurposeList(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PURPOSES) {
    invalid("allowedPurposes");
  }
  const purposes = new Set<string>();
  for (const purpose of value) {
    if (typeof purpose !== "string" || !PURPOSE_PATTERN.test(purpose)) {
      invalid("allowedPurposes");
    }
    if (purposes.has(purpose)) invalid("allowedPurposes");
    purposes.add(purpose);
  }
  return purposes;
}

function requireComponentMethods(value: unknown, methods: readonly string[], field: string): void {
  if (!isPlainObject(value)) invalid(field);
  for (const method of methods) {
    if (typeof (value as Record<string, unknown>)[method] !== "function") invalid(field);
  }
}

/**
 * Refuse a test-only component in a production runtime.
 *
 * Checked on the components themselves rather than on the configuration's
 * intent, so a factory that returns a branded object cannot be dressed up as a
 * production one by passing a different config value.
 */
function assertProductionSafe(config: {
  runtime: PhoneOtpRuntime;
  store: unknown;
  limiter: unknown;
  transport: unknown;
}): void {
  if (config.runtime !== "production") return;
  const components: readonly [string, unknown][] = [
    ["store", config.store],
    ["limiter", config.limiter],
    ["transport", config.transport],
  ];
  for (const [component, value] of components) {
    if (isTestOnlyComponent(value)) {
      throw new PhoneOtpKitError("TEST_ONLY_COMPONENT_IN_PRODUCTION", { component });
    }
  }
}

/**
 * Validate a configuration and reduce it to what the service uses.
 *
 * Throws {@link PhoneOtpKitError} with a `field` detail. Every failure is a
 * startup failure: there is no partially-valid configuration and no fallback
 * component, because both would only ever be reached in production.
 */
export function resolvePhoneOtpConfig(config: PhoneOtpConfig): ResolvedPhoneOtpConfig {
  if (!isPlainObject(config)) invalid("config");

  const runtime = config.runtime;
  if (typeof runtime !== "string" || !RUNTIMES.includes(runtime as PhoneOtpRuntime)) {
    invalid("runtime");
  }

  const allowedPurposes = requirePurposeList(config.allowedPurposes);

  // Presence of a secret is checked before its length, so "missing" and "too
  // short" report the same field but the WEAK_SECRET code either way.
  const secretBytes = toSecretBytes(config.secret);
  const hasher = createOtpHasher(secretBytes);

  const codeLength = requireIntegerInRange(
    config.codeLength ?? OTP_CODE_LENGTH,
    "codeLength",
    MIN_CODE_LENGTH,
    MAX_CODE_LENGTH,
  );
  const codeTtlMs = requireIntegerInRange(
    config.codeTtlMs ?? DEFAULT_CODE_TTL_MS,
    "codeTtlMs",
    MIN_CODE_TTL_MS,
    MAX_CODE_TTL_MS,
  );
  const maxVerifyAttempts = requireIntegerInRange(
    config.maxVerifyAttempts ?? DEFAULT_MAX_VERIFY_ATTEMPTS,
    "maxVerifyAttempts",
    MIN_VERIFY_ATTEMPTS,
    MAX_VERIFY_ATTEMPTS,
  );

  const requireTrustedClient = config.requireTrustedClient ?? true;
  if (typeof requireTrustedClient !== "boolean") invalid("requireTrustedClient");

  const refundFailedSend = config.refundFailedSend ?? false;
  if (typeof refundFailedSend !== "boolean") invalid("refundFailedSend");

  if (config.smsTemplateId !== undefined) {
    if (typeof config.smsTemplateId !== "string" || !TEMPLATE_ID_PATTERN.test(config.smsTemplateId)) {
      invalid("smsTemplateId");
    }
  }

  if (config.onError !== undefined && typeof config.onError !== "function") invalid("onError");

  requireComponentMethods(config.store, ["beginChallenge", "activateChallenge", "revokeChallenge", "consumeChallenge"], "store");
  requireComponentMethods(config.limiter, ["consume"], "limiter");
  requireComponentMethods(config.transport, ["send"], "transport");

  assertProductionSafe({
    runtime: runtime as PhoneOtpRuntime,
    store: config.store,
    limiter: config.limiter,
    transport: config.transport,
  });

  const limits = resolveLimits(config.limits);

  return {
    runtime: runtime as PhoneOtpRuntime,
    hasher,
    allowedPurposes,
    codeLength,
    codeTtlMs,
    maxVerifyAttempts,
    requireTrustedClient,
    refundFailedSend,
    smsTemplateId: config.smsTemplateId,
    limits,
    store: config.store,
    limiter: config.limiter,
    transport: config.transport,
    onError: config.onError,
    sendCooldownMs: cooldownMsFor(limits.send.phone),
    clientRefPattern: CLIENT_REF_PATTERN,
  };
}

/**
 * A redacted summary, for a startup log line.
 *
 * Built by listing fields explicitly rather than by spreading the config, so a
 * field added later is absent until someone decides it is safe. The secret and
 * the hasher are not reachable from here at all.
 */
export function describeResolvedConfig(config: ResolvedPhoneOtpConfig): Record<string, unknown> {
  return {
    runtime: config.runtime,
    purposes: [...config.allowedPurposes].sort(),
    codeLength: config.codeLength,
    codeTtlMs: config.codeTtlMs,
    maxVerifyAttempts: config.maxVerifyAttempts,
    requireTrustedClient: config.requireTrustedClient,
    refundFailedSend: config.refundFailedSend,
    sendCooldownMs: config.sendCooldownMs,
    limits: {
      send: { phone: config.limits.send.phone.map(rule => ({ ...rule })), client: config.limits.send.client.map(rule => ({ ...rule })) },
      verify: { phone: config.limits.verify.phone.map(rule => ({ ...rule })), client: config.limits.verify.client.map(rule => ({ ...rule })) },
    },
    components: {
      store: isTestOnlyComponent(config.store) ? "test-only" : "adapted",
      limiter: isTestOnlyComponent(config.limiter) ? "test-only" : "adapted",
      transport: isTestOnlyComponent(config.transport) ? "test-only" : "adapted",
    },
  };
}
