// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Transport for one edited article version.
 *
 * Base's `bridge.syncArticleEdit` owns the policy (when to upload, which frozen
 * identity the attempt belongs to, what the local record keeps). This module
 * only puts the edited blocks on the wire and translates the server's answer:
 *
 *  - `409` is a real product outcome, not a retry: another device wrote a
 *    version from a newer base, so blindly retrying would overwrite it.
 *  - `404` means the server row is gone (deleted elsewhere); the local article
 *    keeps its text and the caller marks the edit as unsynced.
 *  - a rejected promise is a network error, distinct from an HTTP rejection so
 *    the UI can say "稍后重试" rather than "云端拒绝了这次编辑".
 */

import { ApiRequestError } from "./api-error";
import { createArticleVersion } from "./account-articles";
import { useSession } from "./session";
import { currentSessionEpoch } from "./session-epoch";
import type { CloudArticleVersionUpload, CloudVersionVerdict } from "./cloud/contract";

function identityIsCurrent(identity: CloudArticleVersionUpload["identity"]): boolean {
  if (useSession.getState().user?.id !== identity.ownerUserId) return false;
  return currentSessionEpoch() === identity.epoch;
}

export async function updateArticleVersionRemote(
  input: CloudArticleVersionUpload,
): Promise<CloudVersionVerdict> {
  // The identity was frozen before the (possibly slow) local save. Re-check it
  // before writing anything: a sign-out between save and upload must not put
  // one account's edit on another account's article.
  if (!identityIsCurrent(input.identity)) return { status: "stale-owner" };

  try {
    const response = await createArticleVersion(input.remoteId, {
      blocks: input.blocks,
      textHash: input.textHash,
      ...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}),
    });
    if (!identityIsCurrent(input.identity)) return { status: "stale-owner" };
    return { status: "uploaded", versionId: response.version.id };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 409) {
        return { status: "conflict", message: error.message };
      }
      if (error.status === 404) {
        return { status: "missing", message: error.message };
      }
      return { status: "rejected", message: error.message };
    }
    return {
      status: "network-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
