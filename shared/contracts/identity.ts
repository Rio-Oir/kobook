// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Account identity and the "who owns this local cache" question.
 *
 * The store and the settings store both hold account-scoped data, but the
 * phase-1 design did not record whose account produced it. Phase 2 adds an
 * `ownerUserId` stamp to each store, and a single decision function that the
 * session bootstrap calls when the resolved user changes.
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
 * Lives in `shared/contracts` because the decision must be identical on both
 * sides of the wire: the server's seed and the browser's rehydration apply
 * the same rule to the same input.
 */

export const ANONYMOUS_OWNER = "anonymous";

/**
 * `reconcileOwner`'s three outcomes, plus one the *application* layer
 * adds.
 *
 * `offer` is not a function of the two owner strings, which is why it is
 * not produced by `reconcileOwner`: it says "the cache is unowned and
 * contains something, so hand it over only with the user's consent"
 * (产品规则: "登录时不静默上传匿名内容：显示迁移/同步确认"). Keeping the
 * pure decision and the consent-aware decision in separate places is what
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
