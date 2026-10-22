// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The base-side half of the cloud seam.
 *
 * The reader and the import page call *these* functions, never an adapter
 * directly and never a transport. Each one:
 *
 *   1. does the local thing that must happen regardless (the local article is
 *      already saved before any of these run; `removeNote` deletes the local
 *      note and *then* offers the delete);
 *   2. offers the cloud half to whatever adapter is installed;
 *   3. applies the returned verdict to the local record itself, so there is
 *      exactly one implementation of "what a note/an article looks like".
 *
 * With no adapter installed — the default — every function is a no-op that
 * keeps its promise contract. Nothing here throws and nothing here blocks: a
 * caller on the user's critical path never awaits a network round trip, and a
 * failing adapter degrades to "this stayed local", which is a state the
 * product already has a name and a UI for (`remoteSyncStatus`).
 */

import { useStore } from "../store";
import { useSession } from "../session";
import { currentSessionEpoch } from "../session-epoch";
import {
  callAdapter,
  cloudAdapter,
  type CloudNoteAnchor,
  type CloudPersistStatus,
  type CloudUploadVerdict,
  type CloudVersionVerdict,
} from "./contract";
import type { ExtractSource } from "../browser-extract-errors";
import type { Article, Paragraph, ParsedDocument } from "../types";
import { documentFromArticle } from "../articles";

/** Whether a cloud implementation is installed. */
export function isCloudEnabled(): boolean {
  return cloudAdapter() !== null;
}

/** The account cloud work may act for right now, or `null`. */
export function actingUserId(): string | null {
  const adapter = cloudAdapter();
  if (!adapter) return null;
  const sessionUserId = useSession.getState().user?.id ?? null;
  if (!sessionUserId) return null;
  // The local space and the session must name the same account. They diverge
  // between a sign-in resolving and the local space being handed over, and in
  // that window a write has no unambiguous owner.
  if (useStore.getState().ownerUserId !== sessionUserId) return null;
  return sessionUserId;
}

// ── Notes ────────────────────────────────────────────────────────────────

/**
 * Offer a newly created local note to the adapter, and bind the server row it
 * reports back onto the local note.
 *
 * Resolves with the server id, or `null` when the note stays local. A local
 * note is complete without this call: the reader has already written it to the
 * store, and every field an upload needs is on the record.
 *
 * The binding is written *here*, not by the adapter, for the same reason the
 * upload verdict is: base owns the local note record, so there is one place
 * that decides what a bound note looks like. It is written only if the session
 * epoch has not moved — a create that lands after a sign-out or an account
 * switch belongs to the session that started it, and binding it now would
 * point this account's note at another account's row.
 */
export function persistNote(
  localNoteId: string,
  articleId: string,
  anchor: CloudNoteAnchor,
): Promise<string | null> {
  if (!actingUserId()) return Promise.resolve(null);
  const existing = useStore.getState().notes[localNoteId];
  if (existing?.remoteId) {
    return Promise.resolve(existing.remoteId);
  }

  const epoch = currentSessionEpoch();
  const ownerUserId = useStore.getState().ownerUserId;
  // `callAdapter` contains a synchronous throw as well as a rejection, so a
  // transport that blows up before returning cannot take the caller's stack
  // with it.
  return callAdapter(
    (adapter) => adapter.persistNote(localNoteId, articleId, anchor),
    null,
  ).then((created) => {
    if (!created) return null;
    if (currentSessionEpoch() !== epoch) return null;
    if (useStore.getState().ownerUserId !== ownerUserId) return null;
    // The note may have been deleted while the create was in flight; the
    // adapter's own reconciliation owns the server-side cleanup, and there
    // is no local record left to bind.
    if (!useStore.getState().notes[localNoteId]) return null;
    useStore
      .getState()
      .setNoteRemote(localNoteId, created.remoteId, created.remoteVersionId);
    return created.remoteId;
  });
}

/** Offer one assistant turn to the adapter. */
export function persistAnswer(
  localNoteId: string,
  answer: string,
  status: CloudPersistStatus,
  turnId?: string,
): Promise<void> {
  if (!actingUserId()) return Promise.resolve();
  return callAdapter(
    (adapter) => adapter.persistAnswer(localNoteId, answer, status, turnId),
    undefined,
  );
}

/** Offer one user turn (a follow-up question) to the adapter. */
export function persistFollowUpQuestion(
  localNoteId: string,
  question: string,
  turnId?: string,
): Promise<void> {
  if (!actingUserId()) return Promise.resolve();
  return callAdapter(
    (adapter) => adapter.persistFollowUpQuestion(localNoteId, question, turnId),
    undefined,
  );
}

/**
 * Delete a note: locally always, remotely when there is a server row.
 *
 * The local delete happens first and unconditionally. A user who deletes a
 * note must see it gone whether or not the account service is reachable; a
 * remote row that outlives the local one is a reconciliation problem the next
 * sync owns, not a reason to refuse the click.
 */
export async function removeNote(localNoteId: string): Promise<void> {
  const note = useStore.getState().notes[localNoteId];
  useStore.getState().deleteNote(localNoteId);
  if (!note?.remoteId) return;
  const remoteId = note.remoteId;
  await callAdapter(
    (adapter) => adapter.deleteNote({ localNoteId, remoteId }),
    undefined,
  );
}

/**
 * Reconcile this article's notes with the server.
 *
 * Returns the number of remote rows the server reported, or 0 when there is
 * nothing to reconcile against.
 */
export function syncNotesFromServer(articleId: string): Promise<number> {
  if (!actingUserId()) return Promise.resolve(0);
  return callAdapter((adapter) => adapter.syncNotesFromServer(articleId), 0);
}

// ── Article upload ───────────────────────────────────────────────────────

/**
 * Apply an upload verdict to the local article.
 *
 * `stale-owner` never touches the store: the result belongs to a session that
 * has ended, and writing it would attribute one account's server row to
 * another's local record. Everything else is recorded as a status the reader
 * already renders, so a failed upload is visible rather than silent — and the
 * article itself is never removed by a sync attempt.
 */
function applyVerdict(
  localArticleId: string,
  verdict: CloudUploadVerdict,
  source: ExtractSource,
): void {
  if (verdict.status === "stale-owner") return;
  if (verdict.status === "uploaded" || verdict.status === "duplicate") {
    useStore
      .getState()
      .setArticleRemote(localArticleId, verdict.articleId, verdict.versionId, source);
    return;
  }
  useStore.getState().setArticleSyncStatus(localArticleId, verdict.status);
}

/**
 * Schedule a non-blocking upload of an article the user has already saved.
 *
 * Returns nothing the caller waits on. The frozen `submitIdentity` is the
 * `(ownerUserId, epoch)` pair the import handler captured at submit time: a
 * sign-out or account switch during a slow URL import must not re-parent the
 * article, so the identity is passed to the adapter rather than re-read from
 * the session when the response lands.
 */
export function enqueueArticleSync(
  localArticle: Article,
  document: ParsedDocument,
  source: ExtractSource,
  submitIdentity?: { ownerUserId: string; epoch: number },
): void {
  // With no adapter there is nothing to record and nothing to attempt: the
  // article is already saved locally, and no status should be written for a
  // cloud that does not exist.
  if (!cloudAdapter()) return;

  const ownerUserId = submitIdentity?.ownerUserId ?? useSession.getState().user?.id ?? null;
  if (!ownerUserId) return;
  if (submitIdentity) {
    const sessionUserId = useSession.getState().user?.id ?? null;
    if (sessionUserId !== submitIdentity.ownerUserId) return;
    if (currentSessionEpoch() !== submitIdentity.epoch) return;
  }
  // First id wins: an article that already carries a server row is not
  // re-uploaded under a new one.
  if (useStore.getState().articles[localArticle.id]?.remoteId) return;

  const identity = { ownerUserId, epoch: submitIdentity?.epoch ?? currentSessionEpoch() };
  // `null` is the "the adapter never produced a verdict" case — it was absent,
  // threw synchronously, or rejected. It is deliberately distinct from a
  // verdict of `network-error` the adapter *reported*, because the two are
  // applied differently: a late failure from a broken transport must not
  // downgrade an article that has already uploaded successfully.
  void callAdapter<CloudUploadVerdict | null>(
    (current) =>
      current.uploadArticle({ article: localArticle, document, source, identity }),
    null,
  ).then((verdict) => {
    if (identity.epoch !== currentSessionEpoch()) return;
    if (verdict === null) {
      if (!useStore.getState().articles[localArticle.id]?.remoteId) {
        useStore.getState().setArticleSyncStatus(localArticle.id, "network-error");
      }
      return;
    }
    applyVerdict(localArticle.id, verdict, source);
  });
}

/**
 * Re-run the upload for an article already in the local store.
 *
 * Used by the reader's retry affordance and by the "I reloaded and the upload
 * never finished" path. The persisted article carries every field the upload
 * needs, so nothing is re-parsed and no key is involved.
 */
export function retryArticleSync(
  localArticle: Article,
  paragraphs: readonly Paragraph[],
  submitIdentity?: { ownerUserId: string; epoch: number },
): void {
  // No text means there is nothing to upload — an article whose body is not on
  // this device cannot be re-sent from a record alone, and pretending otherwise
  // would put an empty document on the wire.
  if (paragraphs.length === 0) {
    useStore.getState().setArticleSyncStatus(localArticle.id, "rejected");
    return;
  }
  enqueueArticleSync(
    localArticle,
    documentFromArticle(localArticle, paragraphs),
    localArticle.syncSource ?? "local",
    submitIdentity,
  );
}

// ── Edited version ───────────────────────────────────────────────────────

/**
 * Upload the local body as a new version of an article that already exists on
 * the server.
 *
 * Called after a paragraph edit has committed locally. The local write is
 * already durable; the return value is for the UI's status line, and the
 * store's `editStatus` is the durable record of the outcome.
 *
 * Refuses to run for an article with no server row: that article's *first*
 * upload already carries the edited body, and creating a version here would
 * require an article id the server has not issued yet.
 */
export function syncArticleEdit(localArticleId: string): Promise<CloudVersionVerdict> {
  const state = useStore.getState();
  const article = state.articles[localArticleId];
  const body = state.bodies[localArticleId];
  if (!actingUserId() || !article?.remoteId || !body || body.state !== "present") {
    return Promise.resolve({ status: "missing" });
  }

  const identity = { ownerUserId: state.ownerUserId, epoch: currentSessionEpoch() };
  const document = documentFromArticle(article, body.body.paragraphs);
  state.markArticleEditStatus(localArticleId, "syncing");

  return callAdapter(
    (adapter) =>
      adapter.updateArticleVersion
        ? adapter.updateArticleVersion({
            remoteId: article.remoteId!,
            blocks: document.blocks,
            textHash: document.textHash,
            ...(article.versionId ? { baseVersionId: article.versionId } : {}),
            identity,
          })
        : Promise.resolve({ status: "missing" as const }),
    { status: "network-error" as const },
  ).then((verdict) => {
    // A response that lands after a sign-out belongs to a session that no
    // longer exists; record nothing, exactly like the upload verdict rule.
    if (currentSessionEpoch() !== identity.epoch) {
      return { status: "stale-owner" as const };
    }
    if (verdict.status === "uploaded") {
      useStore.getState().applyArticleEditVersion(localArticleId, verdict.versionId);
    } else if (verdict.status === "stale-owner") {
      useStore.getState().markArticleEditStatus(localArticleId, "pending");
    } else {
      useStore
        .getState()
        .markArticleEditStatus(localArticleId, "failed", verdict.message);
    }
    return verdict;
  });
}
