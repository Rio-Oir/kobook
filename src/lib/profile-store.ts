// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One fetch of the account profile, shared by every surface that shows a
 * name or a bound number.
 *
 * The session shape (`CloudSessionUser`) deliberately carries only id,
 * email, verification and role, so the display name arrives from the account
 * API instead. Two surfaces want it — the header menu and the 我的 page — and
 * asking twice would be both wasteful and visibly inconsistent (the page
 * showing 读者 while the header still showed the email's local part).
 *
 * The cache is keyed by user id: a sign-in as someone else cannot read the
 * previous account's name, and a failed fetch is cached as "no profile" so a
 * broken endpoint does not retry on every render. There is no invalidation
 * because nothing on this line can rename the account yet; when the profile
 * editor lands it can call `invalidateAccountProfile()`.
 */

import { useEffect, useSyncExternalStore } from "react";
import { fetchAccountProfile, type AccountProfile } from "./account-profile";

let cache: { userId: string; profile: AccountProfile | null } | null = null;
let pendingUserId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function ensure(userId: string) {
  if (cache?.userId === userId || pendingUserId === userId) return;
  pendingUserId = userId;
  void fetchAccountProfile().then((profile) => {
    // A response that arrives after the user changed must not overwrite the
    // newer request's slot.
    if (pendingUserId !== userId) return;
    cache = { userId, profile };
    pendingUserId = null;
    emit();
  });
}

/**
 * The current account's profile, or `null` while unknown.
 *
 * `userId` null (signed out / still loading) returns null without a request.
 */
export function useAccountProfile(
  userId: string | null | undefined,
): AccountProfile | null {
  const profile = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => (userId && cache?.userId === userId ? cache.profile : null),
    () => null,
  );

  useEffect(() => {
    if (userId) ensure(userId);
  }, [userId]);

  return profile;
}

/** Drop the cached profile (for a future profile editor). */
export function invalidateAccountProfile(): void {
  cache = null;
  pendingUserId = null;
  emit();
}
