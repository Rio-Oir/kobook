// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The durable `OtpChallengeStore` for the phone verification kit.
 *
 * The kit ships an in-memory store, but brands it test-only for a reason: a
 * second process cannot see it and a restart silently invalidates a code the
 * user is holding. This adapter puts the same three-state lifecycle on the
 * `phone_otp_challenge` table, and the properties the kit requires are the
 * properties this file has to preserve:
 *
 *  1. **Single use, atomic.** `consumeChallenge` runs inside a transaction that
 *     first takes a per-(purpose, phoneRef) advisory lock, so two concurrent
 *     guesses against the same number are serialised and exactly one can see
 *     the matching code. The row is deleted as part of the same transaction.
 *  2. **A wrong guess costs an attempt even though the request fails.** The
 *     increment is committed by the same transaction that reports
 *     `mismatch`; there is no rollback-on-error path to exploit.
 *  3. **Constant-time digest comparison.** `constantTimeEqualHex`, not `===`.
 *  4. **Expiry is enforced here, not only by the caller.** An expired row is
 *     removed when it is found, so a clock change cannot resurrect it.
 *  5. **`revoke` / `activate` are conditional on `(id, generation)` and only
 *     touch `pending` rows.** A failed send can therefore never delete a newer,
 *     already-published challenge.
 *  6. **`activate` supersedes the previous active challenge in the same
 *     transaction, under the same advisory lock.** Two concurrent activations
 *     leave exactly one active row, and the loser is told it lost.
 *
 * Nothing here returns the stored digest, and nothing here stores the phone
 * number: `phoneRef` and `codeHash` are the kit's HMAC digests.
 */

import type { Prisma } from "../../generated/prisma/client.js";
import type { AppPrisma } from "../../db.js";
import { constantTimeEqualHex, generateChallengeId } from "../../../../modules/phone-otp-kit/src/otp/crypto.js";
import type {
  ActivateChallengeInput,
  ActivateChallengeResult,
  BeginChallengeInput,
  BeginChallengeResult,
  ConsumeChallengeInput,
  ConsumeChallengeOutcome,
  OtpChallengeStore,
  RevokeChallengeInput,
  RevokeChallengeResult,
} from "../../../../modules/phone-otp-kit/src/otp/store.js";

/**
 * Serialises every mutation for one (purpose, phoneRef) inside the current
 * transaction.
 *
 * `hashtext` is a 32-bit hash, so two different numbers can in principle share
 * a lock; that only costs contention, never correctness, because the lock is a
 * mutex and not an identity check. The column values are parameters, never
 * interpolated.
 */
async function lockChallengeGroup(
  tx: Prisma.TransactionClient,
  purpose: string,
  phoneRef: string,
): Promise<void> {
  // `\u0000` is not usable here: PostgreSQL text cannot contain a NUL byte,
  // and the failure is a driver-level encoding error, not an empty result.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${purpose}|${phoneRef}`}))`;
}

export interface PrismaChallengeStore extends OtpChallengeStore {
  /** Rows currently stored, for the acceptance run's "no plaintext" checks. */
  count(): Promise<number>;
}

class PostgresChallengeStore implements PrismaChallengeStore {
  readonly #prisma: AppPrisma;

  constructor(prisma: AppPrisma) {
    this.#prisma = prisma;
  }

  async beginChallenge(input: BeginChallengeInput): Promise<BeginChallengeResult> {
    return this.#prisma.$transaction(async (tx) => {
      // Lazy hygiene: a send is rare enough (one per minute per number) that
      // sweeping here is cheaper than a scheduler, and it keeps the table
      // bounded even if nothing ever calls `pruneExpiredChallenges`.
      await tx.phoneOtpChallenge.deleteMany({
        where: { expiresAt: { lte: BigInt(input.now) } },
      });

      const created = await tx.phoneOtpChallenge.create({
        data: {
          id: generateChallengeId(),
          purpose: input.purpose,
          phoneRef: input.phoneRef,
          codeHash: input.codeHash,
          state: "pending",
          maxAttempts: input.maxAttempts,
          createdAt: BigInt(input.now),
          expiresAt: BigInt(input.now + input.ttlMs),
        },
        select: { id: true, generation: true, expiresAt: true },
      });

      return {
        id: created.id,
        generation: created.generation,
        expiresAt: Number(created.expiresAt),
      };
    });
  }

  async activateChallenge(input: ActivateChallengeInput): Promise<ActivateChallengeResult> {
    return this.#prisma.$transaction(async (tx) => {
      const row = await tx.phoneOtpChallenge.findUnique({ where: { id: input.id } });

      if (row === null || row.generation !== input.generation || row.state !== "pending") {
        return { activated: false, superseded: false };
      }

      await lockChallengeGroup(tx, row.purpose, row.phoneRef);

      const updated = await tx.phoneOtpChallenge.updateMany({
        where: {
          id: input.id,
          generation: input.generation,
          state: "pending",
          expiresAt: { gt: BigInt(input.now) },
        },
        data: { state: "active" },
      });

      if (updated.count === 0) {
        // The reservation expired while the provider call was in flight. The
        // delivered code must not become usable, and reporting success would
        // hand the caller a code that cannot work.
        await tx.phoneOtpChallenge.deleteMany({
          where: { id: input.id, generation: input.generation, state: "pending" },
        });
        return { activated: false, superseded: false };
      }

      const superseded = await tx.phoneOtpChallenge.deleteMany({
        where: {
          purpose: row.purpose,
          phoneRef: row.phoneRef,
          state: "active",
          id: { not: input.id },
        },
      });

      return { activated: true, superseded: superseded.count > 0 };
    });
  }

  async revokeChallenge(input: RevokeChallengeInput): Promise<RevokeChallengeResult> {
    // No transaction: a single conditional delete is atomic on its own, and it
    // can only ever remove the caller's own `pending` reservation.
    const deleted = await this.#prisma.phoneOtpChallenge.deleteMany({
      where: {
        id: input.id,
        generation: input.generation,
        state: "pending",
      },
    });
    if (deleted.count > 0) return { revoked: true, reason: "revoked" };

    const row = await this.#prisma.phoneOtpChallenge.findUnique({ where: { id: input.id } });
    if (row === null) return { revoked: false, reason: "absent" };
    if (row.generation !== input.generation) return { revoked: false, reason: "stale-generation" };
    return { revoked: false, reason: "not-pending" };
  }

  async consumeChallenge(input: ConsumeChallengeInput): Promise<ConsumeChallengeOutcome> {
    return this.#prisma.$transaction(async (tx) => {
      await lockChallengeGroup(tx, input.purpose, input.phoneRef);

      const row = await tx.phoneOtpChallenge.findFirst({
        where: { purpose: input.purpose, phoneRef: input.phoneRef, state: "active" },
      });

      if (row === null) return { status: "absent" };

      if (Number(row.expiresAt) <= input.now) {
        await tx.phoneOtpChallenge.deleteMany({ where: { id: row.id } });
        return { status: "expired" };
      }

      if (row.attempts >= row.maxAttempts) {
        await tx.phoneOtpChallenge.deleteMany({ where: { id: row.id } });
        return { status: "too_many_attempts", attemptsRemaining: 0 };
      }

      if (!constantTimeEqualHex(row.codeHash, input.codeHash)) {
        const attempts = row.attempts + 1;
        if (attempts >= row.maxAttempts) {
          await tx.phoneOtpChallenge.deleteMany({ where: { id: row.id } });
          return { status: "too_many_attempts", attemptsRemaining: 0 };
        }
        await tx.phoneOtpChallenge.update({
          where: { id: row.id },
          data: { attempts },
        });
        return { status: "mismatch", attemptsRemaining: row.maxAttempts - attempts };
      }

      await tx.phoneOtpChallenge.deleteMany({ where: { id: row.id } });
      return { status: "consumed", id: row.id };
    });
  }

  async pruneExpiredChallenges(input: { readonly now: number }): Promise<{ readonly removed: number }> {
    const result = await this.#prisma.phoneOtpChallenge.deleteMany({
      where: { expiresAt: { lte: BigInt(input.now) } },
    });
    return { removed: result.count };
  }

  async count(): Promise<number> {
    return this.#prisma.phoneOtpChallenge.count();
  }
}

export function createPrismaChallengeStore(prisma: AppPrisma): PrismaChallengeStore {
  return new PostgresChallengeStore(prisma);
}
