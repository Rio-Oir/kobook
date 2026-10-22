// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Highlight sync — the account half of the reader's marks.
 *
 * Marks used to live only in the local store: a line drawn on the laptop was
 * invisible on the phone, which broke the product rule that everything the
 * reader creates belongs to the account. This module is the transport and the
 * reconciliation; `lib/store.ts` stays the only place the local records are
 * written.
 *
 * The three operations mirror the note bridge's rules rather than inventing
 * new ones:
 *
 *   - **Create** is idempotent through `clientKey`. A retried create returns
 *     the row the first attempt wrote, so a lost response cannot paint a
 *     second mark over the same words.
 *   - **Update** patches colour / style / remark / detached on the bound row.
 *   - **Delete** removes the bound row. It is hard on the server because a
 *     mark has no children.
 *
 * Failures park the work in a small persisted queue instead of being dropped:
 * a reader who highlights on a train keeps the mark, and the next open (or
 * login) replays the queue. Pull is a merge, never a replace: local marks with
 * no `remoteId` are this device's unsent work and are pushed, bound marks the
 * server no longer has are removed, and everything else is updated in place.
 */

import {
  createHighlight,
  deleteHighlightRemote,
  listHighlights,
  patchHighlight,
} from "./account-articles";
import { actingUserId, getSyncedArticleId, isCloudEnabled } from "./cloud-notes";
import { currentSessionEpoch } from "./session-epoch";
import { useStore } from "./store";
import type { Highlight, HighlightStyle } from "./types";

const QUEUE_KEY = "gloss-cloud-highlights";

type QueueKind = "creates" | "updates" | "deletes";
type HighlightQueue = Record<QueueKind, string[]>;

const EMPTY_QUEUE: HighlightQueue = { creates: [], updates: [], deletes: [] };

function storageAvailable(): boolean {
  return typeof localStorage !== "undefined";
}

function readQueue(): HighlightQueue {
  if (!storageAvailable()) return { ...EMPTY_QUEUE };
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return { ...EMPTY_QUEUE };
    const parsed = JSON.parse(raw) as Partial<HighlightQueue>;
    return {
      creates: Array.isArray(parsed.creates) ? parsed.creates : [],
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      deletes: Array.isArray(parsed.deletes) ? parsed.deletes : [],
    };
  } catch {
    return { ...EMPTY_QUEUE };
  }
}

function writeQueue(queue: HighlightQueue): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Quota or a privacy mode that refuses writes: the in-memory attempt
    // already happened, so losing the parking spot is survivable.
  }
}

function enqueue(kind: QueueKind, value: string): void {
  const queue = readQueue();
  if (!queue[kind].includes(value)) queue[kind].push(value);
  writeQueue(queue);
}

function dequeue(kind: QueueKind, value: string): void {
  const queue = readQueue();
  queue[kind] = queue[kind].filter((entry) => entry !== value);
  writeQueue(queue);
}

/** The idempotency key for one local mark. Stable for the local record. */
function highlightClientKey(ownerUserId: string, articleId: string, localId: string): string {
  return `hl:${ownerUserId}:${articleId}:${localId}`;
}

/**
 * Create the server row for a local mark and bind it.
 *
 * Returns quietly when the article has no server copy yet (a purely local
 * article, or an upload that has not answered): the mark stays local and the
 * next open reconciles it. That is the same rule the note bridge follows.
 */
export async function persistHighlight(localId: string, articleId: string): Promise<void> {
  if (!isCloudEnabled()) return;
  const ownerUserId = actingUserId();
  if (!ownerUserId) return;
  const highlight = useStore.getState().highlights[localId];
  if (!highlight || highlight.remoteId) return;
  const serverArticleId = getSyncedArticleId(articleId);
  if (!serverArticleId) return;
  const article = useStore.getState().articles[articleId];
  // A local article that was uploaded has a `remoteId` but no `versionId` —
  // that field is the *displayed* version of a pulled row. Omitting the anchor
  // lets the server bind the mark to the article's current version, which is
  // exactly the text the reader is looking at.
  const versionId = article?.remoteVersionId ?? article?.versionId;
  const epoch = currentSessionEpoch();

  try {
    const response = await createHighlight(serverArticleId, {
      paragraphIndex: highlight.paragraphIndex,
      startOffset: highlight.startOffset,
      endOffset: highlight.endOffset,
      ...(highlight.blockId ? { blockId: highlight.blockId } : {}),
      ...(versionId ? { articleVersionId: versionId } : {}),
      clientKey: highlightClientKey(ownerUserId, articleId, localId),
      selectionText: highlight.selectionText,
      color: highlight.color,
      ...(highlight.style ? { style: highlight.style } : {}),
      ...(highlight.note ? { note: highlight.note } : {}),
    });
    // Late-write protection: the account or session may have changed while
    // the request was in flight, and this session must not bind a row that
    // belongs to somebody else's space.
    // Late-write protection: the account or session may have changed while
    // the request was in flight, and this session must not bind a row that
    // belongs to somebody else's space.
    if (actingUserId() !== ownerUserId || currentSessionEpoch() !== epoch) return;
    dequeue("creates", localId);
    useStore
      .getState()
      .setHighlightRemote(localId, response.highlight.id, response.highlight.versionId);
  } catch {
    // Parked, not lost: the queue replays on the next open.
    enqueue("creates", localId);
  }
}

/** Push the local colour / style / remark / detached state to the bound row. */
export async function pushHighlightUpdate(localId: string): Promise<void> {
  if (!isCloudEnabled()) return;
  const ownerUserId = actingUserId();
  if (!ownerUserId) return;
  const highlight = useStore.getState().highlights[localId];
  if (!highlight?.remoteId) return;
  const epoch = currentSessionEpoch();

  try {
    const response = await patchHighlight(highlight.remoteId, {
      color: highlight.color,
      style: (highlight.style ?? "watercolor") as HighlightStyle,
      note: highlight.note ?? "",
      detached: highlight.detached ?? false,
    });
    if (actingUserId() !== ownerUserId || currentSessionEpoch() !== epoch) return;
    dequeue("updates", localId);
    // The server echoes the stored row; adopt its version of the fields so a
    // truncated or normalised value does not drift between the two sides.
    useStore.getState().applyRemoteHighlights(highlight.articleId, [
      {
        ...highlight,
        color: response.highlight.color,
        style: response.highlight.style,
        ...(response.highlight.note ? { note: response.highlight.note } : {}),
        detached: response.highlight.detached,
        remoteVersionId: response.highlight.versionId,
      },
    ]);
  } catch {
    enqueue("updates", localId);
  }
}

/**
 * Delete the bound row for a local mark.
 *
 * Called *before* the local record disappears, because the remote id lives on
 * the record; when there is no remote id there is nothing to delete.
 */
export async function removeRemoteHighlight(localId: string): Promise<void> {
  const highlight = useStore.getState().highlights[localId];
  if (!highlight?.remoteId) return;
  const remoteId = highlight.remoteId;
  dequeue("updates", localId);
  dequeue("creates", localId);
  await deleteRemoteById(remoteId);
}

async function deleteRemoteById(remoteId: string): Promise<void> {
  if (!isCloudEnabled()) return;
  const ownerUserId = actingUserId();
  if (!ownerUserId) return;
  try {
    await deleteHighlightRemote(remoteId);
    dequeue("deletes", remoteId);
  } catch {
    enqueue("deletes", remoteId);
  }
}

/** Replay whatever the last session could not deliver. */
export async function flushHighlightQueue(): Promise<void> {
  if (!isCloudEnabled()) return;
  const queue = readQueue();
  for (const localId of [...queue.creates]) {
    const highlight = useStore.getState().highlights[localId];
    if (!highlight) {
      dequeue("creates", localId);
      continue;
    }
    await persistHighlight(localId, highlight.articleId);
  }
  for (const localId of [...queue.updates]) {
    const highlight = useStore.getState().highlights[localId];
    if (!highlight?.remoteId) {
      dequeue("updates", localId);
      continue;
    }
    await pushHighlightUpdate(localId);
  }
  for (const remoteId of [...queue.deletes]) {
    await deleteRemoteById(remoteId);
  }
}

/**
 * Pull the account's marks for one article and reconcile both directions.
 *
 * Order matters: the queue and the unbound local marks are pushed first, so
 * the pull that follows cannot mistake "not uploaded yet" for "deleted
 * elsewhere" and remove the reader's own fresh mark.
 */
export async function syncHighlightsForArticle(articleId: string): Promise<number> {
  if (!isCloudEnabled()) return 0;
  const ownerUserId = actingUserId();
  if (!ownerUserId) return 0;
  const serverArticleId = getSyncedArticleId(articleId);
  if (!serverArticleId) return 0;
  const epoch = currentSessionEpoch();

  await flushHighlightQueue();

  // Unbound local marks for this article: push them before pulling, or the
  // merge would see them missing from the server list and drop them.
  const unbound = Object.values(useStore.getState().highlights).filter(
    (highlight) => highlight.articleId === articleId && !highlight.remoteId,
  );
  for (const highlight of unbound) {
    await persistHighlight(highlight.id, articleId);
  }

  let rows;
  try {
    rows = await listHighlights(serverArticleId);
  } catch {
    return 0;
  }
  if (actingUserId() !== ownerUserId || currentSessionEpoch() !== epoch) return 0;
  const article = useStore.getState().articles[articleId];
  if (!article) return 0;

  const currentVersionId = article.versionId ?? rows.versionId;
  const incoming: Highlight[] = rows.highlights.map((row) => ({
    id: `remote-hl-${row.id}`,
    articleId,
    paragraphIndex: row.paragraphIndex,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    selectionText: row.selectionText,
    color: row.color,
    style: row.style,
    ...(row.note ? { note: row.note } : {}),
    // A mark measured against another version cannot be painted over this
    // text; the record is kept (and shown in the notebook) but detached.
    detached: row.detached || row.versionId !== currentVersionId,
    createdAt: Date.parse(row.createdAt) || Date.now(),
    remoteId: row.id,
    remoteVersionId: row.versionId,
  }));
  useStore.getState().applyRemoteHighlights(articleId, incoming);
  return incoming.length;
}
