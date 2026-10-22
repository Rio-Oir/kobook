// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An in-process sliding-window `OtpRateLimiter` for tests and local development.
 *
 * Sliding windows rather than fixed buckets: a fixed 60-second bucket lets a
 * caller spend the whole allowance at 0:59 and the whole allowance again at
 * 1:01, which is the burst a cooldown exists to prevent. Each window keeps the
 * timestamps of the attempts inside it and counts them.
 *
 * The timestamps are the *only* state, and they are per (bucket, scope, ref), so
 * two windows on one scope are two counts over the same list. That is what makes
 * `[1 per minute, 5 per hour]` express both "one code a minute" and "five codes
 * an hour" without a second data structure.
 *
 * Branded test-only, like the memory store: it cannot see another process, so a
 * second instance has its own budget. A production deployment needs the limiter
 * in the shared store the authentication system already trusts.
 *
 * It holds no limits of its own: the rules arrive with each `consume` call, so
 * the resolved configuration is the only place a budget is decided.
 */

import { Mutex } from "./mutex";
import { brandTestOnly, TEST_ONLY_BRAND, type TestOnlyComponent } from "./test-only";
import type {
  OtpRateBucket,
  OtpRateLimitDecision,
  OtpRateLimitInput,
  OtpRateLimitReleaseInput,
  OtpRateLimitReleaseResult,
  OtpRateLimitRule,
  OtpRateLimiter,
  OtpRateScope,
} from "./limiter";

export interface MemoryRateLimiter extends OtpRateLimiter, TestOnlyComponent {
  /** Number of (bucket, scope, ref) windows currently retained. */
  stats(): { readonly windows: number; readonly timestamps: number };
  clear(): void;
}

const SCOPES: readonly OtpRateScope[] = ["phone", "client"];

function windowKey(bucket: OtpRateBucket, scope: OtpRateScope, ref: string): string {
  return `${bucket}\u0000${scope}\u0000${ref}`;
}

function longestWindow(rules: readonly OtpRateLimitRule[]): number {
  let longest = 0;
  for (const rule of rules) {
    if (rule.windowMs > longest) longest = rule.windowMs;
  }
  return longest;
}

interface Exceeded {
  scope: OtpRateScope;
  limit: number;
  windowMs: number;
  retryAfterMs: number;
}

class InMemoryRateLimiter implements MemoryRateLimiter {
  declare readonly [TEST_ONLY_BRAND]: true;

  /** (bucket, scope, ref) → attempt timestamps, oldest first, already pruned. */
  #events = new Map<string, number[]>();

  #mutex = new Mutex();

  consume(input: OtpRateLimitInput): Promise<OtpRateLimitDecision> {
    return this.#mutex.run(() => {
      // Evaluate both scopes against the *recorded* attempts first, decide, and
      // only then record, so a refusal cannot push its own window forward.
      let worst: Exceeded | null = null;
      /**
       * Headroom left *after* this attempt, per rule, as `limit - inWindow - 1`.
       * Counting the current attempt as permitted is what makes the comparison
       * `headroom < 0` rather than `<= 0`.
       */
      let remainingAfter = Number.POSITIVE_INFINITY;
      const pending: Array<{ key: string; stamps: number[] }> = [];

      for (const scope of SCOPES) {
        const rules = input.rules[input.bucket][scope];
        if (rules.length === 0) continue;

        const ref = scope === "phone" ? input.phoneRef : input.clientRef;
        const key = windowKey(input.bucket, scope, ref);
        const horizon = longestWindow(rules);
        const stamps = (this.#events.get(key) ?? []).filter((at) => at > input.now - horizon);

        for (const rule of rules) {
          const inWindow = stamps.filter((at) => at > input.now - rule.windowMs).length;
          const headroom = rule.limit - inWindow - 1;
          if (headroom < remainingAfter) remainingAfter = headroom;

          if (headroom >= 0) continue;

          const oldest = stamps.find((at) => at > input.now - rule.windowMs);
          const retryAfterMs =
            oldest === undefined ? 0 : Math.max(0, oldest + rule.windowMs - input.now);
          if (worst === null || retryAfterMs > worst.retryAfterMs) {
            worst = { scope, limit: rule.limit, windowMs: rule.windowMs, retryAfterMs };
          }
        }

        pending.push({ key, stamps });
      }

      const remaining = Number.isFinite(remainingAfter) ? Math.max(0, remainingAfter) : 0;

      if (worst !== null) {
        return {
          allowed: false,
          scope: worst.scope,
          limit: worst.limit,
          windowMs: worst.windowMs,
          retryAfterMs: worst.retryAfterMs,
          remaining,
        };
      }

      for (const { key, stamps } of pending) {
        stamps.push(input.now);
        this.#events.set(key, stamps);
      }
      return { allowed: true, retryAfterMs: 0, remaining };
    });
  }

  release(input: OtpRateLimitReleaseInput): Promise<OtpRateLimitReleaseResult> {
    return this.#mutex.run(() => {
      let released = false;
      for (const scope of SCOPES) {
        // No rules are needed to release: a scope that was never charged has no
        // window to find, and one that was finds it here.
        const ref = scope === "phone" ? input.phoneRef : input.clientRef;
        const key = windowKey(input.bucket, scope, ref);
        const stamps = this.#events.get(key);
        if (stamps === undefined) continue;

        // Remove one entry *equal to* `at`, not the newest one: the caller is
        // undoing a specific attempt, and removing a different one would release
        // an attempt that was already counted for someone else's request.
        const at = stamps.indexOf(input.at);
        if (at === -1) continue;
        stamps.splice(at, 1);
        released = true;
        if (stamps.length === 0) this.#events.delete(key);
      }
      return { released };
    });
  }

  stats(): { windows: number; timestamps: number } {
    let timestamps = 0;
    for (const stamps of this.#events.values()) timestamps += stamps.length;
    return { windows: this.#events.size, timestamps };
  }

  clear(): void {
    this.#events.clear();
  }
}

/**
 * Create the in-process limiter. Test-only: the returned object carries the
 * brand, and a `production` configuration refuses it at construction. It takes
 * no rules — see `OtpRateLimitInput.rules`.
 */
export function createMemoryRateLimiter(): MemoryRateLimiter {
  return brandTestOnly(new InMemoryRateLimiter());
}
