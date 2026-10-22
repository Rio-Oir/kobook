// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The stale-response guard for account-scoped cloud work.
 *
 * ## The defect this exists to prevent
 *
 * Every account-scoped operation is a request that can land after the account
 * it belongs to has changed. A `getArticle` for Alice that resolves after Alice
 * signed out — or after Bob signed in — is still *her* article, and applying it
 * to the local store at that moment writes one account's content into another
 * account's cache (or into the anonymous space). The same applies to appending
 * a page of a list, to navigating to an article, and to downloading one.
 *
 * So every one of those operations captures the account it started under, and
 * re-checks it after **every** `await` before touching the store, the URL or
 * the filesystem — including in `catch` and `finally`, where a stale failure
 * would otherwise surface as a message about the wrong account, or clear a
 * spinner that belongs to a newer action.
 *
 * ## What it is built from
 *
 * Only base state, and only base's *public* primitives:
 *
 *  - `session-epoch` — base advances it on every ownership resolution;
 *  - `session` — the resolved session user;
 *  - `store.ownerUserId` — the stamp on the live local space.
 *
 * It is not a copy of base's session implementation: it reads base's three
 * sources of truth and compares them. `cloud-notes` re-exports these two
 * functions under its older names so the queue machinery and the pages share
 * one implementation rather than two that can drift.
 *
 * ## Why the epoch is the signal, and not just the user id
 *
 * Comparing user ids alone treats "signed out and signed back in as the same
 * person" as no change, but every cache on the device was isolated in between.
 * The epoch moves on *each* resolution — including a no-op one — so it is the
 * only reliable "the session changed under this request" signal.
 */

import { currentSessionEpoch } from "../session-epoch";
import { useSession } from "../session";
import { useStore } from "../store";

export interface CloudContext {
  /** Session epoch at capture time. */
  epoch: number;
  /** The owner stamp on the local space at capture time. */
  ownerUserId: string;
  /** The resolved session user at capture time, or null. */
  sessionUserId: string | null;
}

/** Snapshot the account an operation is starting under. */
export function captureCloudContext(): CloudContext {
  return {
    epoch: currentSessionEpoch(),
    ownerUserId: useStore.getState().ownerUserId,
    sessionUserId: useSession.getState().user?.id ?? null,
  };
}

/**
 * Whether the operation that captured `ctx` may still apply its result.
 *
 * False means: discard the response silently. It is not an error state for the
 * *new* account to show — the request belongs to a session that is over.
 */
export function isCloudContextCurrent(ctx: CloudContext): boolean {
  if (ctx.epoch !== currentSessionEpoch()) return false;
  if (ctx.ownerUserId !== useStore.getState().ownerUserId) return false;
  if (ctx.sessionUserId !== (useSession.getState().user?.id ?? null)) return false;
  return true;
}

/**
 * The one account both halves agree on, or `null`.
 *
 * `null` means "there is no unambiguous account to act for" — signed out, or in
 * the window where the session already names someone but the local space has
 * not been handed over yet (and the mirror image, between a sign-out and the
 * cache being cleared). Work started in that window must not be sent at all,
 * which is why callers check this *before* the request, not only after it.
 */
export function cloudContextUserId(ctx: CloudContext): string | null {
  if (ctx.sessionUserId === null) return null;
  if (ctx.ownerUserId !== ctx.sessionUserId) return null;
  return ctx.sessionUserId;
}
