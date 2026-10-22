// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An in-process `OtpRateLimiter` for the phone verification kit.
 *
 * The kit's own limiter is branded test-only because a second process has its
 * own budget. This adapter is the same sliding-window implementation without
 * the brand, because the deployment this server supports is one process: the
 * auth rate limiter it pairs with (`lib/rate-limit.ts`) is also `storage:
 * "memory"` in production for the same reason. A second replica would need
 * both moved to a shared store — recorded as deployment work rather than
 * quietly assumed.
 *
 * Why it is safe to be atomic without a lock: every `consume` reads, evaluates
 * and records in a single synchronous stretch — no `await` between the check
 * and the write — so the event loop cannot interleave two calls. The moment
 * that changes, this adapter becomes a double-spend bug, which is why the
 * methods are written out linearly and the map operations are the last thing
 * that happens.
 *
 * It holds no limits of its own: the resolved configuration arrives with each
 * call, so the policy cannot diverge between the service and the adapter.
 */

import type {
  OtpRateBucket,
  OtpRateLimitDecision,
  OtpRateLimitInput,
  OtpRateLimitReleaseInput,
  OtpRateLimitReleaseResult,
  OtpRateLimitRule,
  OtpRateLimiter,
  OtpRateScope,
} from "../../../../modules/phone-otp-kit/src/otp/limiter.js";

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

export interface ProcessRateLimiter extends OtpRateLimiter {
  /** Number of (bucket, scope, ref) windows currently retained. */
  stats(): { readonly windows: number; readonly timestamps: number };
  clear(): void;
}

class InProcessRateLimiter implements ProcessRateLimiter {
  /** (bucket, scope, ref) → attempt timestamps, oldest first, already pruned. */
  readonly #events = new Map<string, number[]>();

  async consume(input: OtpRateLimitInput): Promise<OtpRateLimitDecision> {
    // No `await` from here to the recording loop below: that is what makes the
    // check-and-record a single event-loop turn.
    let worst: Exceeded | null = null;
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
  }

  async release(input: OtpRateLimitReleaseInput): Promise<OtpRateLimitReleaseResult> {
    let released = false;
    for (const scope of SCOPES) {
      const ref = scope === "phone" ? input.phoneRef : input.clientRef;
      const key = windowKey(input.bucket, scope, ref);
      const stamps = this.#events.get(key);
      if (stamps === undefined) continue;

      // Remove one entry *equal to* `at`: the caller is undoing a specific
      // attempt, and removing the newest would release someone else's.
      const index = stamps.indexOf(input.at);
      if (index === -1) continue;
      stamps.splice(index, 1);
      released = true;
      if (stamps.length === 0) this.#events.delete(key);
    }
    return { released };
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

export function createProcessRateLimiter(): ProcessRateLimiter {
  return new InProcessRateLimiter();
}
