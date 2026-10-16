// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A counter that changes whenever account ownership changes.
 *
 * Asynchronous work that started under one account must not finish under
 * another. The stores are cleared on a switch, so "the note is gone"
 * already covers the common case — but a *remote* write does not consult
 * the local store, and a response that arrives after a sign-out can carry
 * a session cookie belonging to whoever signed in next. Comparing a
 * captured epoch before touching the server turns that from a silent
 * cross-account write into a no-op.
 *
 * Kept in its own module with no imports so `ownership` (which bumps it on
 * every session resolution) and the cloud bridge and note lifecycle (which
 * read it) can depend on it without any of them importing another.
 */

let epoch = 0;

export function bumpSessionEpoch(): number {
  epoch += 1;
  return epoch;
}

export function currentSessionEpoch(): number {
  return epoch;
}
