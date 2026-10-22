// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The value-added cloud adapter.
 *
 * `cloud/contract.ts` is the *only* seam between the base line and this one,
 * and this file is the object that fills it in. Everything it exposes is
 * implemented by the modules this line owns (`cloud-notes`, `article-sync`,
 * `migration-store`, `auth-client`); base reaches them only through
 * `registerCloudAdapter`, so with the adapter uninstalled — the state a base
 * release is in — none of this code is on any path.
 *
 * ## The contract rules, and where each one is kept
 *
 * 1. *Absence is the default.* Nothing here runs unless `install.ts` registered
 *    this object.
 * 2. *Nothing blocks a local write.* Base calls every method below through
 *    `callAdapter` / `callAdapterHook`, which contain a synchronous throw as
 *    well as a rejection, so a transport that blows up before returning cannot
 *    reach base's own stack. `probeSession` is the one method base calls
 *    directly (from `session.refresh`, inside its own `try`), and the only
 *    error it is allowed to raise is `AbortError` — which base needs in order
 *    to let a newer probe take over.
 * 3. *Identity is passed in.* `uploadArticle` re-checks the frozen
 *    `{ ownerUserId, epoch }` before it builds a request and the coordinator
 *    re-checks it after the response; `onOwnerResolved` receives the owner base
 *    has already settled on rather than inferring one.
 * 4. *No base data structure is re-implemented.* This adapter reports
 *    verdicts; base writes them through its own store actions.
 * 5. *No credential crosses the seam.* The only article payload that leaves is
 *    the one `local-import-sync.buildSyncPayload` builds, which refuses any
 *    field outside its allow-list and scans the result for secret-shaped keys —
 *    a BYOK key cannot reach a request built here, and nothing here reads the
 *    user's key, the backup format or the logs.
 */

import { ROUTES } from "./contracts";
import type {
  CloudAdapter,
  CloudArticleUpload,
  CloudArticleVersionUpload,
  CloudNoteAnchor,
  CloudNoteCreated,
  CloudNoteDelete,
  CloudSessionUser,
  CloudUploadVerdict,
  CloudVersionVerdict,
} from "./contract";
import { signOutRemote } from "../auth-client";
import { useStore } from "../store";
import {
  clearPendingAdopt,
  consumePendingAdopt,
  offerMigrationFor,
  prepareOwnershipTransition,
  restoreAnonymousSpace,
} from "../migration-store";
import { LOCAL_STORAGE_BLOCKED_REASON, setBlockedSignIn } from "./session-block";
import {
  createRemoteNote,
  deleteRemoteNote,
  persistAnswer as persistAnswerRemote,
  persistFollowUpQuestion as persistFollowUpQuestionRemote,
  syncNotesFromServer as syncNotesFromServerRemote,
} from "../cloud-notes";
import { uploadArticle as uploadArticleRemote } from "../article-sync";
import { updateArticleVersionRemote } from "../article-version-sync";

/** Stable id, for logs and for the boot assertion in tests. */
export const GLOSS_CLOUD_ADAPTER_ID = "gloss-cloud";

/**
 * Resolve the session against `/api/me`.
 *
 * Anything that is not an authenticated 200 is `null` — anonymous — because
 * the reader has to stay usable with the account service down. The one
 * exception is `AbortError`, which is re-raised so base can tell "this probe
 * was superseded" apart from "this probe failed"; swallowing it here would let
 * a cancelled probe publish a stale `anon`.
 *
 * ## The one case where a *successful* probe resolves to anonymous
 *
 * If the anonymous workspace on this device cannot be set aside, this device
 * must not be handed to the account: base's ownership rule clears an account's
 * cache on sign-out, so an account that adopts an un-back-up-able anonymous
 * workspace would destroy it at the next sign-out. Base decides ownership
 * *after* this call and offers no veto, so the refusal is expressed here —
 * resolve `null`, which makes base settle on `anon` and leave the live space
 * stamped anonymous and intact.
 *
 * The server-side session is revoked best-effort at the same time, so the
 * device is not left saying "no account" while a cookie keeps resolving to
 * one. `blockedSignIn` records the reason for `AccountLink` to surface.
 */
async function probeSession(signal?: AbortSignal): Promise<CloudSessionUser | null> {
  let response: Response;
  try {
    response = await fetch(ROUTES.me, {
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return null;
  }

  let user: CloudSessionUser | null = null;
  if (response.ok) {
    try {
      user = ((await response.json()) as { user?: CloudSessionUser }).user ?? null;
    } catch {
      user = null;
    }
  }

  if (!user) {
    clearPendingAdopt();
    return null;
  }

  // Take the anonymous workspace aside *while it is still stamped anonymous*.
  // Base's ownership reconciliation runs after this call and stamps the live
  // space with the new owner, and `archiveAnonymousSpace` refuses to snapshot a
  // blob an account owns — so this is the last moment the snapshot can be
  // taken. `onOwnerResolved` then consumes the marker.
  const transition = await prepareOwnershipTransition(user.id);
  if (transition === "blocked") {
    clearPendingAdopt();
    setBlockedSignIn(LOCAL_STORAGE_BLOCKED_REASON);
    void signOutRemote().catch(() => undefined);
    return null;
  }

  setBlockedSignIn(null);
  return user;
}

/**
 * React to the owner base has settled on.
 *
 * Base has already advanced the epoch, stamped the owner and cleared a foreign
 * cache by the time this runs, so an implementation that does nothing still
 * leaves a consistent store. What is left here is the *cloud* rule base does
 * not own: "登录时不静默上传匿名内容，显示迁移/同步确认" — signing in never
 * uploads, it raises an offer — and "拒绝后保留独立匿名本地空间".
 *
 * Exported rather than inlined into the adapter literal so the ownership
 * contract can be exercised directly: it is the adapter's whole reaction to an
 * ownership resolution, and hiding it inside an object literal would mean the
 * only way to test it is through a fully registered adapter.
 */
export function onOwnerResolved(ownerUserId: string | null): void {
  if (ownerUserId === null) {
    clearPendingAdopt();
    // Coming back to an anonymous session is the moment to hand a
    // previously set-aside anonymous workspace back. The records land
    // synchronously; the text follows, and this hook is synchronous by
    // contract, so the promise is deliberately dropped.
    void restoreAnonymousSpace();
    return;
  }

  if (!consumePendingAdopt(ownerUserId)) return;

  // This resolution is the adopt the snapshot was taken for. The anonymous
  // content is safe in the archive, so the account gets its own clean space:
  // signing in must not merge the two, because a cloud article pulled for the
  // account would otherwise land in the unconfirmed anonymous workspace and
  // the two would be indistinguishable.
  useStore.getState().clearUserCache();
  useStore.getState().setOwner(ownerUserId);
  offerMigrationFor(ownerUserId, true);
}

/**
 * Build the adapter.
 *
 * A factory rather than a module-level singleton so a test can create one,
 * register it, and drop it again without resetting a module. `install.ts` is
 * the only production caller.
 */
export function createGlossCloudAdapter(): CloudAdapter {
  return {
    id: GLOSS_CLOUD_ADAPTER_ID,

    probeSession,

    signOut(): Promise<void> {
      // Base does not await this and has nothing to do with the outcome: the
      // local session is already cleared, and whether the server-side revoke
      // worked is settled by the next probe, not by this call.
      return signOutRemote().catch(() => undefined);
    },

    onOwnerResolved,

    uploadArticle(input: CloudArticleUpload): Promise<CloudUploadVerdict> {
      return uploadArticleRemote(input);
    },

    updateArticleVersion(input: CloudArticleVersionUpload): Promise<CloudVersionVerdict> {
      return updateArticleVersionRemote(input);
    },

    persistNote(
      noteId: string,
      articleId: string,
      anchor: CloudNoteAnchor,
    ): Promise<CloudNoteCreated | null> {
      // Reports the binding; base writes it onto the local note.
      return createRemoteNote(noteId, articleId, anchor);
    },

    persistAnswer(noteId, answer, status, turnId): Promise<void> {
      return persistAnswerRemote(noteId, answer, status, turnId);
    },

    persistFollowUpQuestion(noteId, question, turnId): Promise<void> {
      return persistFollowUpQuestionRemote(noteId, question, turnId);
    },

    deleteNote(entry: CloudNoteDelete): Promise<void> {
      return deleteRemoteNote(entry.localNoteId, entry.remoteId);
    },

    syncNotesFromServer(articleId: string): Promise<number> {
      return syncNotesFromServerRemote(articleId);
    },
  };
}
