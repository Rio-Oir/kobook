// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reacting to a resolved session: whose local cache is this?
 *
 * The stores (`store`, `settings`, `theme`) each hold account-scoped data and
 * each carries an `ownerUserId` stamp. This module is the single place that
 * decides what happens to that data when the resolved identity changes.
 *
 * It lives in base, not in the cloud adapter, because the *decision* is a
 * property of the local data format: an old blob with no stamp must still be
 * readable, a foreign owner's cache must not stay on screen, and the epoch
 * must advance so in-flight work from the previous session is dropped. None
 * of that depends on a server existing.
 *
 * What the adapter owns is the *cloud* half — snapshotting an anonymous
 * workspace aside, offering a migration, dropping cached server state. It is
 * notified through `CloudAdapter.onOwnerResolved` once the local stamps are
 * already consistent, so an implementation that does nothing still leaves a
 * coherent store.
 *
 * Three outcomes, from the shared `reconcileOwner` rule:
 *   - `keep`   the resolved user already owns the cache, do nothing;
 *   - `adopt`  the cache is unowned, attach the resolved user to it (so
 *              someone who just signed up on a device with anonymous data
 *              does not lose their pasted article);
 *   - `clear`  a *different* user owned the cache — the safest interpretation
 *              of "is this mine" is "no", and the previous account's
 *              articles, notes and API key must not remain on screen.
 */

import { ANONYMOUS_OWNER, reconcileOwner, type OwnerDecision } from "./identity";
import { useStore } from "./store";
import { useSettings } from "./settings";
import { useTheme } from "./theme";
import { bumpSessionEpoch } from "./session-epoch";
import { callAdapterHook } from "./cloud/contract";

/**
 * Tell the optional adapter which owner base has just settled on.
 *
 * Routed through `callAdapterHook` so a hook that throws synchronously cannot
 * interrupt the ownership work it is being told about — and, on the session
 * paths that call this, cannot stop the session status from being published.
 * The local stamps are always written before this runs, so an adapter that
 * does nothing (or fails) still leaves a coherent store.
 */
function notifyOwnerResolved(ownerUserId: string | null): void {
  callAdapterHook((adapter) => adapter.onOwnerResolved?.(ownerUserId));
}

export function applyOwnership(resolvedUserId: string | null): OwnerDecision {
  const current = useStore.getState().ownerUserId;
  // Every resolution advances the epoch, even a no-op one. In-flight work
  // captures the epoch when it starts and re-checks it before using its
  // result, so bumping here is what stops a response that belongs to the
  // previous session from being applied to this one.
  bumpSessionEpoch();

  if (resolvedUserId === null) {
    // No session. If the cache is *already* anonymous there is nothing to
    // isolate and nothing to destroy — and destroying it is actively
    // wrong: this runs on every session probe, including the one that fires
    // on page load, so a signed-out reader who configured a BYOK key or
    // pasted an article would lose both simply by refreshing. The rule is
    // "anonymous→anonymous 的启动探测不能擦除用户设置".
    if (current === ANONYMOUS_OWNER) {
      notifyOwnerResolved(null);
      return "keep";
    }
    // A real account's cache is present and the session ended: isolate it.
    // Every credential and private item goes, and the owner stamp returns to
    // anonymous. The account's content is *not* converted into anonymous
    // content — the rule is explicit that it must not be.
    useStore.getState().clearUserCache();
    useSettings.getState().clearApiKey();
    useSettings.getState().setOwner(ANONYMOUS_OWNER);
    useTheme.getState().resetValue();
    useTheme.getState().setOwner(ANONYMOUS_OWNER);
    notifyOwnerResolved(null);
    return "clear";
  }

  const decision = reconcileOwner(current, resolvedUserId);
  if (decision === "clear") {
    useStore.getState().clearUserCache();
    useSettings.getState().clearApiKey();
    useTheme.getState().resetValue();
    useStore.getState().setOwner(resolvedUserId);
    useSettings.getState().setOwner(resolvedUserId);
    useTheme.getState().setOwner(resolvedUserId);
    notifyOwnerResolved(resolvedUserId);
    return "clear";
  }
  if (decision === "keep") {
    notifyOwnerResolved(resolvedUserId);
    return "keep";
  }

  // `adopt`: the cache is unowned. The local space is handed to the account
  // *in place* — the reader's article, its notes and the BYOK key all stay
  // readable, which is the whole point of adopting rather than clearing.
  //
  // The cloud half is where the subtler rule lives ("登录时不静默上传匿名
  // 内容"): an implementation that has somewhere to upload to must snapshot
  // the anonymous workspace aside and ask before merging. It does that from
  // `onOwnerResolved`, which runs after the stamps below.
  useStore.getState().setOwner(resolvedUserId);
  useSettings.getState().setOwner(resolvedUserId);
  useTheme.getState().setOwner(resolvedUserId);
  notifyOwnerResolved(resolvedUserId);
  return "adopt";
}
