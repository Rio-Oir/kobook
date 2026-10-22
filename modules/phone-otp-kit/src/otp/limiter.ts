// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The rate limiter.
 *
 * ## Two buckets, two scopes, no challenge id
 *
 * `send` and `verify` are separate buckets because they defend against opposite
 * things. Sending costs money and annoys a human; verifying costs nothing and is
 * the actual attack. Accounting a wrong guess against the *send* budget turns
 * "someone is guessing" into "the real user cannot receive a code".
 *
 * Within each bucket two scopes are evaluated together: `phone` (the target
 * number — the anti-brute-force control, since 1e6 possible codes are only safe
 * if you cannot try many of them against one number) and `client` (a *trusted,
 * server-derived* identity — the anti-distribution control).
 *
 * Neither key contains a challenge id. That is load-bearing: the budget is
 * charged per phone and per client, so requesting a fresh code does not reset it.
 *
 * ## The caller supplies the rules, on every call
 *
 * `consume` receives the rules it must apply. There is deliberately **no**
 * adapter-side configuration of limits: the resolved configuration is the single
 * source of policy, and an adapter cannot disagree with it because it holds no
 * opinion. The alternative — an adapter built with its own rules, plus a startup
 * check that they match the configuration — leaves a window in which the two
 * differ and needs every adapter to expose its rules for comparison. Passing
 * them removes the possibility instead of detecting it.
 *
 * ## `consume` is atomic, and records only what it allows
 *
 * One call evaluates every rule for both scopes and, if nothing is exceeded,
 * records the attempt — as a single operation. A refused attempt is **not**
 * recorded. Recording refusals would mean every refused request pushed its own
 * window forward, so a caller who knows a victim's number could hold it blocked
 * by hammering. A refusal guarantees that nothing proceeds; it does not have to
 * spend the budget to do that. Atomicity still matters: two concurrent calls at
 * the boundary must not both observe headroom and both be allowed.
 *
 * ## Fail closed
 *
 * There is no "allow on failure" path. A limiter that cannot reach its backing
 * store throws; the service maps that to `INTERNAL` and the request is denied —
 * the transport is never called and the challenge store is never touched.
 */

export type OtpRateBucket = "send" | "verify";

export type OtpRateScope = "phone" | "client";

/** One window with one allowance. Several together make a stepped budget. */
export interface OtpRateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface OtpRateLimitRules {
  readonly phone: readonly OtpRateLimitRule[];
  readonly client: readonly OtpRateLimitRule[];
}

/** Keyed by bucket, so a bucket name and its rules cannot be paired wrongly. */
export interface OtpRateLimitRuleset {
  readonly send: OtpRateLimitRules;
  readonly verify: OtpRateLimitRules;
}

export interface OtpRateLimitInput {
  readonly bucket: OtpRateBucket;
  /** From `OtpHasher.phoneRef`. Never the raw number. */
  readonly phoneRef: string;
  /** From `OtpHasher.clientRef`. Never the raw client value. */
  readonly clientRef: string;
  readonly now: number;
  /** The resolved configuration, for this call. The adapter applies these verbatim. */
  readonly rules: OtpRateLimitRuleset;
}

export interface OtpRateLimitDecision {
  readonly allowed: boolean;
  /** Which scope refused the attempt. Present only when `allowed` is false. */
  readonly scope?: OtpRateScope;
  /** The rule that refused it. Present only when `allowed` is false. */
  readonly limit?: number;
  readonly windowMs?: number;
  /** Milliseconds until the caller may retry. `0` when allowed. */
  readonly retryAfterMs: number;
  /** Smallest remaining headroom across every rule, never negative. */
  readonly remaining: number;
}

export interface OtpRateLimitReleaseInput {
  readonly bucket: OtpRateBucket;
  readonly phoneRef: string;
  readonly clientRef: string;
  /**
   * The exact `now` the corresponding `consume` recorded. Release is by value,
   * not by position, so an adapter removes one entry equal to this one and never
   * "the newest".
   */
  readonly at: number;
}

export interface OtpRateLimitReleaseResult {
  /** `true` when this call removed an entry; `false` when there was nothing to remove. */
  readonly released: boolean;
}

/**
 * What an adapter must guarantee:
 *
 * 1. **Atomic.** The check and the recording are one operation. A read-then-write
 *    pair lets concurrent requests all observe headroom and all pass — the
 *    classic double-spend, and on the send path it is literally money.
 * 2. **Applies `rules` verbatim, for the `bucket` given.** An adapter holds no
 *    limits of its own, must not cache one call's rules for the next, and must
 *    not ignore a rule because it looks unusual.
 * 3. **Records an allowed attempt; leaves a refusal unrecorded.** What must never
 *    happen is the reverse: an *allowed* attempt that is not recorded.
 * 4. **Keys are the derived refs.** An adapter must not add a field to the key
 *    that the caller did not pass (a challenge id, a request id, a timestamp
 *    bucket) — that is how a budget silently becomes per-request.
 * 5. **Throwing means "deny".** Never catch an internal error and return
 *    `allowed: true`.
 * 6. **`release` removes at most one recorded attempt per scope, and only one
 *    that matches `at`.** It is the inverse of an allowed `consume`, used when
 *    the message never reached the user (see `PhoneOtpConfig.refundFailedSend`).
 *    It must be idempotent, must return `{ released: false }` rather than
 *    throwing when there is nothing to release, and must never be implemented as
 *    "clear the window".
 * 7. No log line, metric label or error may contain the raw `phoneRef` or
 *    `clientRef` values in a form that survives; they are digests, and a digest
 *    of a phone number is still a stable identifier for that phone number.
 */
export interface OtpRateLimiter {
  consume(input: OtpRateLimitInput): Promise<OtpRateLimitDecision>;
  release(input: OtpRateLimitReleaseInput): Promise<OtpRateLimitReleaseResult>;
}
