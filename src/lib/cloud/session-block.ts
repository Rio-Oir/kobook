// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Why this device refused to sign an account in, and the copy for it.
 *
 * A leaf module on purpose. The refusal is produced by the session probe
 * (`cloud/adapter.ts`) and by the sign-in handler (`auth-client.ts`), and read
 * by `AccountLink` — three modules that would otherwise form a cycle, since
 * the adapter already imports the account client for `signOutRemote`.
 *
 * ## Why a blocked sign-in is not "just a failed request"
 *
 * If the anonymous workspace on this device cannot be set aside, the account
 * must not take the live space. Base's ownership rule clears an account's
 * cache on sign-out (`ownership.ts`, the `clear` path), so handing the
 * workspace to an account that cannot restore it means the next sign-out
 * destroys it. Refusing the sign-in is the only outcome that keeps the
 * content — and the user has to be *told*, or they are left staring at a
 * signed-out header with no explanation.
 *
 * Deliberately module state rather than store state: it describes one
 * resolution in this page load, it is not user data, and persisting it would
 * leave a stale warning behind after the storage problem is fixed. It is
 * cleared the moment a session is admitted normally.
 */

export const LOCAL_STORAGE_BLOCKED_REASON =
  "本机存储不可用，无法备份匿名内容，已取消在本机登录，以免这些内容在以后退出登录时被清除。请清理浏览器存储后重试。";

let blockedSignInReason: string | null = null;

/** The last refusal, or `null`. Never throws. */
export function blockedSignIn(): string | null {
  return blockedSignInReason;
}

/** Set (or clear, with `null`) the refusal notice. */
export function setBlockedSignIn(reason: string | null): void {
  blockedSignInReason = reason;
}
