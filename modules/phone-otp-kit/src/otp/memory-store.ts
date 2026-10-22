// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An in-process `OtpChallengeStore` for tests and local development.
 *
 * Every mutating method runs its entire read-decide-write sequence inside one
 * {@link Mutex} critical section, so the concurrency tests exercise the same
 * interleavings a real atomic primitive would have to survive. That is the
 * whole point of the extra machinery: a naive in-memory map would pass a
 * sequential test suite and then hide the bug it was written to catch.
 *
 * It is branded test-only, and `runtime: "production"` refuses it. It is not a
 * fallback, not a cache in front of something durable, and not appropriate for
 * a second process — it cannot see another process's challenges, so two
 * instances would each keep their own idea of which code is live.
 */

import { constantTimeEqualHex, generateChallengeId } from "./crypto";
import { Mutex } from "./mutex";
import { brandTestOnly, TEST_ONLY_BRAND, type TestOnlyComponent } from "./test-only";
import type {
  ActivateChallengeInput,
  ActivateChallengeResult,
  BeginChallengeInput,
  BeginChallengeResult,
  ChallengeState,
  ConsumeChallengeInput,
  ConsumeChallengeOutcome,
  OtpChallengeStore,
  RevokeChallengeInput,
  RevokeChallengeResult,
} from "./store";

interface ChallengeRecord {
  readonly id: string;
  readonly purpose: string;
  readonly phoneRef: string;
  readonly codeHash: string;
  readonly generation: number;
  state: ChallengeState;
  attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * A read-only view of one stored record.
 *
 * Named `unsafe` because it exists for assertions, not for application code: it
 * exposes the stored digest. What it is *for* is proving the negative — that the
 * plaintext code is nowhere in the record.
 */
export interface UnsafeChallengeView {
  readonly id: string;
  readonly purpose: string;
  readonly phoneRef: string;
  readonly codeHash: string;
  readonly generation: number;
  readonly state: ChallengeState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface MemoryChallengeStore extends OtpChallengeStore, TestOnlyComponent {
  /** Record counts, for assertions about supersession and revocation. */
  stats(): { readonly total: number; readonly active: number; readonly pending: number };
  /** The live challenge for a purpose + phone, without revealing its code. */
  unsafeActiveView(purpose: string, phoneRef: string): UnsafeChallengeView | undefined;
  /** Every record, for assertions about what a failed send left behind. */
  unsafeAllViews(): readonly UnsafeChallengeView[];
  clear(): void;
}

/** Sweep threshold: small stores are cheap to scan, and the mutex already serialises. */
const SWEEP_THRESHOLD = 64;

function challengeKey(purpose: string, phoneRef: string): string {
  return `${purpose}\u0000${phoneRef}`;
}

function view(record: ChallengeRecord): UnsafeChallengeView {
  return { ...record };
}

class InMemoryChallengeStore implements MemoryChallengeStore {
  /**
   * Declared, not assigned: `brandTestOnly` attaches the real property with
   * `defineProperty` (non-enumerable, non-writable) so it cannot be copied away
   * by an object spread or overwritten by a caller.
   */
  declare readonly [TEST_ONLY_BRAND]: true;

  #records = new Map<string, ChallengeRecord>();

  #active = new Map<string, string>();

  #generations = new Map<string, number>();

  #mutex = new Mutex();

  beginChallenge(input: BeginChallengeInput): Promise<BeginChallengeResult> {
    return this.#mutex.run(() => {
      const key = challengeKey(input.purpose, input.phoneRef);
      const generation = (this.#generations.get(key) ?? 0) + 1;
      this.#generations.set(key, generation);

      const id = generateChallengeId();
      const expiresAt = input.now + input.ttlMs;
      this.#records.set(id, {
        id,
        purpose: input.purpose,
        phoneRef: input.phoneRef,
        codeHash: input.codeHash,
        generation,
        state: "pending",
        attempts: 0,
        maxAttempts: input.maxAttempts,
        createdAt: input.now,
        expiresAt,
      });

      this.#sweep(input.now);
      return { id, generation, expiresAt };
    });
  }

  activateChallenge(input: ActivateChallengeInput): Promise<ActivateChallengeResult> {
    return this.#mutex.run(() => {
      const record = this.#records.get(input.id);
      if (record === undefined) return { activated: false, superseded: false };
      // A generation mismatch means this activation belongs to a reservation
      // that has already been replaced.
      if (record.generation !== input.generation) return { activated: false, superseded: false };
      if (record.state !== "pending") return { activated: false, superseded: false };
      if (record.expiresAt <= input.now) {
        this.#records.delete(record.id);
        return { activated: false, superseded: false };
      }

      const key = challengeKey(record.purpose, record.phoneRef);
      const previousId = this.#active.get(key);
      let superseded = false;
      if (previousId !== undefined && previousId !== record.id) {
        this.#records.delete(previousId);
        superseded = true;
      }

      record.state = "active";
      this.#active.set(key, record.id);
      return { activated: true, superseded };
    });
  }

  revokeChallenge(input: RevokeChallengeInput): Promise<RevokeChallengeResult> {
    return this.#mutex.run(() => {
      const record = this.#records.get(input.id);
      if (record === undefined) return { revoked: false, reason: "absent" };
      if (record.generation !== input.generation) {
        return { revoked: false, reason: "stale-generation" };
      }
      // The restriction to `pending` is what makes "a failed send cannot erase a
      // newer challenge" true structurally: an active challenge is never a
      // revoke target, whatever id the caller supplies.
      if (record.state !== "pending") return { revoked: false, reason: "not-pending" };

      this.#records.delete(record.id);
      const key = challengeKey(record.purpose, record.phoneRef);
      if (this.#active.get(key) === record.id) this.#active.delete(key);
      return { revoked: true, reason: "revoked" };
    });
  }

  consumeChallenge(input: ConsumeChallengeInput): Promise<ConsumeChallengeOutcome> {
    return this.#mutex.run(() => {
      const key = challengeKey(input.purpose, input.phoneRef);
      const activeId = this.#active.get(key);
      if (activeId === undefined) return { status: "absent" };

      const record = this.#records.get(activeId);
      if (record === undefined) {
        // Defensive: the index and the records must not disagree. Drop the
        // dangling index entry and report absence rather than guessing.
        this.#active.delete(key);
        return { status: "absent" };
      }

      if (record.expiresAt <= input.now) {
        this.#remove(record);
        return { status: "expired" };
      }

      if (record.attempts >= record.maxAttempts) {
        this.#remove(record);
        return { status: "too_many_attempts", attemptsRemaining: 0 };
      }

      if (!constantTimeEqualHex(record.codeHash, input.codeHash)) {
        // Increment first, then report. An increment that is rolled back on the
        // failure path would make the attempt allowance unlimited.
        record.attempts += 1;
        if (record.attempts >= record.maxAttempts) {
          this.#remove(record);
          return { status: "too_many_attempts", attemptsRemaining: 0 };
        }
        return { status: "mismatch", attemptsRemaining: record.maxAttempts - record.attempts };
      }

      this.#remove(record);
      return { status: "consumed", id: record.id };
    });
  }

  pruneExpiredChallenges(input: { readonly now: number }): Promise<{ readonly removed: number }> {
    return this.#mutex.run(() => ({ removed: this.#sweep(input.now, true) }));
  }

  stats(): { total: number; active: number; pending: number } {
    let active = 0;
    let pending = 0;
    for (const record of this.#records.values()) {
      if (record.state === "active") active += 1;
      else pending += 1;
    }
    return { total: this.#records.size, active, pending };
  }

  unsafeActiveView(purpose: string, phoneRef: string): UnsafeChallengeView | undefined {
    const activeId = this.#active.get(challengeKey(purpose, phoneRef));
    if (activeId === undefined) return undefined;
    const record = this.#records.get(activeId);
    return record === undefined ? undefined : view(record);
  }

  unsafeAllViews(): readonly UnsafeChallengeView[] {
    return [...this.#records.values()].map(view);
  }

  clear(): void {
    this.#records.clear();
    this.#active.clear();
    this.#generations.clear();
  }

  #remove(record: ChallengeRecord): void {
    this.#records.delete(record.id);
    const key = challengeKey(record.purpose, record.phoneRef);
    if (this.#active.get(key) === record.id) this.#active.delete(key);
  }

  #sweep(now: number, force = false): number {
    if (!force && this.#records.size < SWEEP_THRESHOLD) return 0;
    let removed = 0;
    for (const record of [...this.#records.values()]) {
      if (record.expiresAt <= now) {
        this.#remove(record);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Create the in-memory challenge store. Test-only: the returned object carries
 * the brand, and a `production` configuration refuses it at construction.
 */
export function createMemoryChallengeStore(): MemoryChallengeStore {
  return brandTestOnly(new InMemoryChallengeStore());
}
