// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Account identity and the "who owns this local cache" question.
 *
 * The store and the settings store both hold account-scoped data. Each carries
 * an `ownerUserId` stamp, and a single decision function decides what happens
 * to that data when the resolved user changes.
 *
 * Three outcomes:
 *   - `keep`   the resolved user already owns the cache, do nothing;
 *   - `adopt`  the cache is unowned, attach the resolved user to it (so
 *              someone who just signed up on a device with anonymous data
 *              does not lose their pasted article);
 *   - `clear`  a *different* user owned the cache — the safest interpretation
 *              of "is this mine" is "no", and the previous account's
 *              articles, notes and API key must not remain on screen.
 *
 * Lives in `shared/contracts` so that every store applies one rule to the
 * same input rather than each growing its own copy.
 */

export const ANONYMOUS_OWNER = "anonymous";

/**
 * `reconcileOwner`'s three outcomes, plus one the *application* layer
 * adds.
 *
 * `offer` is not a function of the two owner strings, which is why it is
 * not produced by `reconcileOwner`: it says "the cache is unowned and
 * contains something, so hand it over only with the user's consent" —
 * signing in must never silently upload what was read anonymously. Keeping
 * the pure decision and the consent-aware decision in separate places is what
 * lets each be tested on its own terms.
 */
export type OwnerDecision = "keep" | "adopt" | "clear" | "offer";

export function reconcileOwner(currentOwner: string, nextUserId: string): OwnerDecision {
  if (currentOwner === nextUserId) return "keep";
  if (currentOwner === ANONYMOUS_OWNER || currentOwner === "") return "adopt";
  return "clear";
}

export function ownerAfterLogout(): string {
  return ANONYMOUS_OWNER;
}
