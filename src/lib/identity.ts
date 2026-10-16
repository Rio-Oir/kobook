// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Re-exported from the shared contracts barrel so that the resolution
// rule is identical on both sides of the wire (see the comment in
// `shared/contracts/identity.ts`).
export { ANONYMOUS_OWNER, reconcileOwner, ownerAfterLogout } from "../../shared/contracts/index";
export type { OwnerDecision } from "../../shared/contracts/index";
