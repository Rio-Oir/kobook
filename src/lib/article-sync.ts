// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Upload a locally-parsed article to the controlled backend.
 *
 * This is the adapter-facing half of the article upload. The *policy* — when to
 * upload, which frozen identity the attempt belongs to, and what the local
 * record keeps afterwards — is base's (`src/lib/cloud/bridge.ts`): with no
 * adapter installed an article is saved, opened and readable and no upload is
 * ever attempted, and the verdict this module returns is applied by base
 * through the store's own actions.
 *
 * What is left here is the transport:
 *
 *  1. **Freeze identity before the request.** The `(ownerUserId, epoch)` pair
 *     base hands in is re-checked before the request is built and again by the
 *     coordinator after the response lands. A response that arrives after the
 *     user signed out or switched accounts is reported as `stale-owner`, which
 *     base applies by touching nothing.
 *
 *  2. **Reuse the `SyncTransport` shape the local-import-sync unit gate
 *     covers.** The transport posts to `/api/articles/sync` and translates
 *     `ApiRequestError` into the `{ ok: false, httpStatus, message }` verdict
 *     the coordinator expects. The "no API key ever travels" rule, the
 *     idempotency-key stability rule and the stale-owner rule are inherited
 *     from the coordinator rather than re-implemented here.
 *
 *  3. **Never touch the local article.** Base writes the server id from the
 *     verdict it receives; this module only reports. That is what keeps a
 *     single definition of "what an article looks like" — and it is why the
 *     local id (`local-<textHash16>`) is never remapped: the Reader's URL
 *     stays the same and the notes the user already made keep working.
 *
 * Async by design: base calls this after the navigation has already happened.
 * The user is reading before the upload finishes, which is the property the
 * plan calls "本机优先" — the network is allowed to be slow, gone, or wrong,
 * and the article stays.
 */

import { syncArticle } from "./account-articles";
import { ApiRequestError } from "./api-error";
import { useSession } from "./session";
import { currentSessionEpoch } from "./session-epoch";
import { useStore } from "./store";
import {
  createSyncCoordinator,
  type SyncArticle,
  type SyncTransport,
  type SyncUploadResult,
} from "./local-import-sync";
import {
  actingUserId,
  flushQueue,
  persistAnswer,
  persistFollowUpQuestion,
  persistNote,
  useCloudQueue,
} from "./cloud-notes";
import type {
  CloudArticleUpload,
  CloudOwnerIdentity,
  CloudUploadVerdict,
} from "./cloud/contract";
import type { ArticleSyncRequest } from "./cloud/contracts";

/**
 * The transport the sync coordinator calls.
 *
 * Translating `ApiRequestError` into the `{ httpStatus, message }` shape the
 * coordinator expects is the one job this object has.
 *
 * The coordinator already passes the idempotency key in the second argument,
 * so the transport's only job is to attach it to the wire request. The
 * coordinator computes the same key from the same quadruple
 * (`owner | articleId | textHash | payload`) that the server uses for its
 * `(ownerUserId, clientKey)` unique constraint, so a retried upload lands on
 * the article the first attempt created.
 *
 * The caller's `signal` is forwarded to the underlying fetch so a sign-out or
 * a route change during a slow URL import actually reaches the network.
 */
const uploadTransport: SyncTransport = {
  async upload(payload, options): Promise<SyncUploadResult> {
    try {
      const request: ArticleSyncRequest = {
        title: payload.title,
        sourceUrl: payload.sourceUrl,
        source: payload.source,
        author: payload.author,
        textHash: payload.textHash,
        blocks: payload.blocks,
        clientKey: options.idempotencyKey,
        ...(payload.coverImage ? { coverImage: payload.coverImage } : {}),
        ...(payload.publishedAt ? { publishedAt: payload.publishedAt } : {}),
      };
      const resp = await syncArticle(request, { signal: options.signal });
      return { ok: true, articleId: resp.articleId, versionId: resp.versionId };
    } catch (err) {
      if (err instanceof ApiRequestError) {
        return { ok: false, httpStatus: err.status, message: err.message };
      }
      return { ok: false, networkError: err instanceof Error ? err.message : String(err) };
    }
  },
};

/** Whether base's frozen identity still describes the live session. */
function identityIsCurrent(identity: CloudOwnerIdentity): boolean {
  if (useSession.getState().user?.id !== identity.ownerUserId) return false;
  return currentSessionEpoch() === identity.epoch;
}

/**
 * Upload one locally-parsed article and report the verdict.
 *
 * Base has already saved the article locally and is not waiting on this: a
 * rejection, a network error or a synchronous throw is reported as a verdict
 * (or contained by base's `callAdapter`), never as a local failure.
 */
export async function uploadArticle(input: CloudArticleUpload): Promise<CloudUploadVerdict> {
  const { article, document, source, identity } = input;
  // Rule 3 of the contract: identity is passed in, never inferred. Re-check it
  // before building anything, so a call that was already stale on arrival does
  // not put a request on the wire.
  if (!identityIsCurrent(identity)) return { status: "stale-owner" };

  const syncArticleShape: SyncArticle = {
    id: article.id,
    ...(article.url ? { url: article.url } : {}),
    title: article.title,
    ...(article.author ? { author: article.author } : {}),
    textHash: document.textHash,
    ...(article.coverImage ? { coverImage: article.coverImage } : {}),
    ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
  };

  const coordinator = createSyncCoordinator({
    transport: uploadTransport,
    // The live identity is what the coordinator's late check compares against
    // the frozen one, so a sign-out or account switch between submit and
    // response lands as `stale-owner` and the result is dropped. The frozen
    // `identity` is what the pre-check above used; at this point the two are
    // equal by construction.
    captureOwnerId: () => useSession.getState().user?.id ?? null,
    currentEpoch: () => currentSessionEpoch(),
  });

  const outcome = await coordinator.enqueue({
    article: syncArticleShape,
    document,
    source,
  });

  if (outcome.status === "uploaded") {
    // Notes the user made *before* the upload landed were parked: this adapter
    // refuses to push them without a server article id. Now that the upload has
    // one, catch them up.
    //
    // Base writes the server id onto the local article *after* this function
    // resolves, so the catch-up is deferred by a macrotask rather than a
    // microtask: every microtask of base's `.then` chain (including the
    // `setArticleRemote` that gives the article its id) drains before a timer
    // callback runs. A `queueMicrotask` here would fire first and find nothing
    // to attach to.
    if (identityIsCurrent(identity)) {
      setTimeout(() => {
        void syncPendingNotes(article.id, identity.ownerUserId, identity.epoch);
      }, 0);
    }
    return { status: "uploaded", articleId: outcome.articleId, versionId: outcome.versionId };
  }

  if (outcome.status === "cancelled") return { status: "cancelled" };
  if (outcome.status === "stale-owner") return { status: "stale-owner" };
  if (outcome.status === "network-error") {
    return { status: "network-error", ...(outcome.message ? { message: outcome.message } : {}) };
  }
  return { status: "rejected", ...(outcome.message ? { message: outcome.message } : {}) };
}

/**
 * Push the notes that were created while the article had no server id.
 *
 * `createRemoteNote` refuses to send anything until `article.remoteId` exists,
 * so a note the user makes between "the article is saved locally" and "the
 * upload lands" stays local-only. This is the catch-up: it runs once,
 * immediately after the upload reported success and base wrote the server id,
 * and walks the article's notes.
 *
 * Three rules, each of which is a way this could go wrong:
 *
 *  1. **Re-read live state per note.** The list is snapshotted once, but every
 *     decision after that happens across an `await`; a stale `note` object
 *     would say "not streaming" about a note the user just started a new run
 *     on. So each iteration re-reads the note from the store and skips it if it
 *     has since gained a `remoteId` (already pushed) or started streaming (the
 *     reader's own completion path will push the finished answer).
 *  2. **Stop on an identity change.** `current()` is checked before and after
 *     every awaited step, so a sign-out or an epoch bump mid-loop cannot push
 *     the rest of one account's notes into the next account's session.
 *  3. **The whole turn history is replayed, and only once.** Turn 0 is the
 *     original question, which the create already carried as `question`; turns
 *     1..n are replayed with a key derived from the note id and the turn index,
 *     so a second invocation is idempotent rather than additive.
 */
export async function syncPendingNotes(articleId: string, owner: string, epoch: number): Promise<void> {
  const current = () => actingUserId() === owner && currentSessionEpoch() === epoch;
  if (!current()) return;
  for (const snapshot of useStore.getState().getNotesForArticle(articleId)) {
    if (!current()) return;
    const note = useStore.getState().notes[snapshot.id];
    if (!note) continue; // deleted while we walked
    if (note.remoteId || !note.selectionText) continue;
    const remoteId = await persistNote(note.id, articleId, note);
    if (!current()) return;
    if (!remoteId) continue;
    // Re-read: `persistNote` may have raced a state change, and a note that
    // started streaming while the create was in flight must not have a partial
    // answer frozen in as if it were final.
    const after = useStore.getState().notes[note.id];
    if (!after) continue;
    const turns = after.turns ?? [];
    if (turns.length > 1) {
      for (let i = 1; i < turns.length; i += 1) {
        if (!current()) return;
        const turn = turns[i]!;
        // Kept short and stable: the key must not change if this runs again
        // after a reload, or the server would append a duplicate.
        const turnKey = turn.clientTurnId ?? `initial-${note.id}-${i}`;
        if (turn.role === "user") await persistFollowUpQuestion(note.id, turn.content, turnKey);
        else await persistAnswer(note.id, turn.content, turn.status ?? "succeeded", turnKey);
      }
    } else if (!after.isStreaming && !useCloudQueue.getState().pendingStatuses.some((s) => s.noteId === note.id)) {
      await persistAnswer(
        note.id,
        after.answer,
        after.localStatus && after.localStatus !== "running" ? after.localStatus : "succeeded",
        `initial-${note.id}`,
      );
    }
  }
  if (current()) await flushQueue(owner);
}
