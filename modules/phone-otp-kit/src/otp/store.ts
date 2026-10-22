// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The challenge store.
 *
 * ## What a challenge is
 *
 * One pending-or-live "we texted a code to this number, for this purpose" record.
 * It holds a *hash* of the code, never the code: an operator with a database
 * dump, a cache dump or a debugger attached to the store gets nothing that can
 * be typed into a login form. The phone appears only as an opaque `phoneRef`.
 *
 * ## The lifecycle, and why it has three states and not two
 *
 * ```
 *   begin ──▶ pending ──activate──▶ active ──consume──▶ (gone)
 *               │                     │
 *               └──revoke──▶ (gone)   └──expiry / max attempts──▶ (gone)
 * ```
 *
 * `pending` is what makes the resend rules expressible. The send path is
 * "reserve, call the transport, then publish", so a provider failure has
 * something concrete to clean up:
 *
 * - A **successful** resend activates its challenge and supersedes the previous
 *   active one. Latest successful send wins; older codes stop working.
 * - A **failed** send revokes only its *own* pending challenge. Because
 *   activation is what supersedes, a failure cannot reach back and delete a
 *   challenge that someone else already activated — "failed send cleanup never
 *   erases a newer challenge" is a structural property here, not an `if`.
 *
 * Without `pending`, the send path would have to either publish the code before
 * knowing the transport accepted it (so a provider outage leaves a live code
 * nobody received, and every retry invalidates the last) or keep no record at
 * all until the send returns (so two concurrent sends both publish and the
 * older one can win).
 *
 * ## What an adapter must guarantee
 *
 * These are not suggestions; the module's security properties are stated in
 * terms of them, and violating one silently weakens the kit:
 *
 * 1. **`consumeChallenge` is atomic and single-use.** Exactly one caller
 *    observing a matching code receives `consumed`; every concurrent caller
 *    receives `mismatch`, `too_many_attempts`, `expired` or `absent`. Implement
 *    it as one server-side operation (a Lua script, a transaction with a row
 *    lock, a conditional delete) — never as read-then-write.
 * 2. **The attempt counter is incremented in the same operation as the failed
 *    comparison, and committed even though the caller is about to be told
 *    "wrong code".** An increment that is rolled back on the error path is an
 *    unlimited guess budget.
 * 3. **Digest comparison is constant-time.** Use `constantTimeEqualHex` or the
 *    comparing primitive of the backing store. A short-circuiting `===` on the
 *    stored digest is a timing oracle on a 6-digit secret.
 * 4. **Expiry is enforced by the store, not only by the caller,** and an expired
 *    challenge is removed when it is found so it cannot be resurrected by a
 *    clock change.
 * 5. **`revokeChallenge` is conditional on `(id, generation)` and only affects a
 *    `pending` record.** A revoke that matches on id alone can delete a newer
 *    challenge if an id is ever reused; generations exist so this cannot happen
 *    even if id uniqueness is broken by an adapter bug.
 * 6. **`activateChallenge` also supersedes the previous active challenge in the
 *    same atomic operation.** Two concurrent activations must leave exactly one
 *    active challenge, and the loser must be told it lost.
 * 7. **No operation returns the stored code digest to the caller.** The store
 *    reports an outcome, not a value.
 * 8. The store may hold `phoneRef`, `purpose`, the digest and counters. It must
 *    not hold the E.164 number, the plaintext code, or anything derived from the
 *    client reference beyond the opaque `clientRef` hash the limiter uses.
 *
 * ## What the code digest does not cover
 *
 * The digest is bound to purpose and phone but **not to the challenge instance**,
 * so a code that happens to repeat across a resend digests identically. That is
 * safe here for a reason worth stating precisely rather than assuming: the code
 * is never replayed from a *different* challenge, because activating a new
 * challenge deletes the old one (point 6), and the only consumable challenge is
 * the live one. A repeated code is therefore the same secret the user was just
 * sent, not an old secret resurrected.
 *
 * The boundary: a resend is not *guaranteed* to invalidate a code the user
 * already read, only the challenge that issued it. A deployment that needs the
 * stronger property has to bind a per-challenge nonce into the digest, which
 * also means storing the nonce and reading it before verification — an extra
 * store round trip this interface deliberately does not require.
 */

import type { OtpHasher } from "./crypto";

/** Why an id can be present in the store but not consumable. */
export type ChallengeState = "pending" | "active";

export interface BeginChallengeInput {
  readonly purpose: string;
  /** Opaque; produced by `OtpHasher.phoneRef`. Never the raw number. */
  readonly phoneRef: string;
  /** Opaque; produced by `OtpHasher.codeHash`. Never the plaintext code. */
  readonly codeHash: string;
  /** Absolute epoch ms. */
  readonly now: number;
  readonly ttlMs: number;
  /** Per-challenge wrong-code allowance, stored so config changes cannot move it. */
  readonly maxAttempts: number;
}

export interface BeginChallengeResult {
  readonly id: string;
  /** Monotonic per (purpose, phoneRef). Required by `revoke` and `activate`. */
  readonly generation: number;
  readonly expiresAt: number;
}

export interface ActivateChallengeInput {
  readonly id: string;
  readonly generation: number;
  readonly now: number;
}

export interface ActivateChallengeResult {
  /** `false` when the challenge is gone, already settled, or was superseded. */
  readonly activated: boolean;
  /** `true` when this activation retired a previously active challenge. */
  readonly superseded: boolean;
}

export interface RevokeChallengeInput {
  readonly id: string;
  readonly generation: number;
  readonly now: number;
}

export interface RevokeChallengeResult {
  /** `true` only when this call removed its own `pending` challenge. */
  readonly revoked: boolean;
  readonly reason: "revoked" | "absent" | "stale-generation" | "not-pending";
}

export interface ConsumeChallengeInput {
  readonly purpose: string;
  readonly phoneRef: string;
  /** Opaque, computed by the caller from purpose + phoneRef + the typed code. */
  readonly codeHash: string;
  readonly now: number;
}

/**
 * The result of one atomic verification attempt.
 *
 * `absent` and `mismatch` are separate here because the *store* benefits from
 * distinguishing them (one means "nothing to charge", the other means "charge
 * an attempt"). The service collapses both into one response code, so the
 * distinction never reaches a client.
 */
export type ConsumeChallengeOutcome =
  | { readonly status: "consumed"; readonly id: string }
  | { readonly status: "mismatch"; readonly attemptsRemaining: number }
  | { readonly status: "too_many_attempts"; readonly attemptsRemaining: 0 }
  | { readonly status: "expired" }
  | { readonly status: "absent" };

export interface OtpChallengeStore {
  beginChallenge(input: BeginChallengeInput): Promise<BeginChallengeResult>;
  activateChallenge(input: ActivateChallengeInput): Promise<ActivateChallengeResult>;
  revokeChallenge(input: RevokeChallengeInput): Promise<RevokeChallengeResult>;
  consumeChallenge(input: ConsumeChallengeInput): Promise<ConsumeChallengeOutcome>;
  /**
   * Drop expired records. The service does not call this: on a real backing
   * store, expiry is the store's own TTL, and on a table it is a scheduled
   * sweep. Exposed so an integrator has somewhere to put that sweep and so the
   * memory adapter can be measured in tests.
   */
  pruneExpiredChallenges(input: { readonly now: number }): Promise<{ readonly removed: number }>;
}

/**
 * Build a code digest for a challenge. Kept next to the interface because the
 * binding rule (purpose + phoneRef + code) is part of the store's contract, not
 * a service detail.
 */
export function codeHashFor(
  hasher: OtpHasher,
  input: { readonly purpose: string; readonly phoneRef: string; readonly code: string },
): string {
  return hasher.codeHash(input);
}
