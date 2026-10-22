// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The account half of the single library.
 *
 * Three operations, one rule each:
 *
 *  - **upload** — every local article that is not on the account yet is sent
 *    once, non-blocking, through the same idempotent path the importer uses
 *    (`retryArticleSync`). The account answers with the article it already has
 *    when the content matches, so a second device importing the same text binds
 *    to the same row instead of creating a twin.
 *  - **pull** — a row that only exists in the account is downloaded the moment
 *    the reader opens it, and becomes a normal local article (server id).
 *  - **delete** — "delete" means both ends. The account copy is deleted first;
 *    if that cannot happen (offline, expired session) the id is queued and the
 *    local copy still goes away, so the row disappears from the shelf and the
 *    server copy is removed as soon as the account is reachable again.
 *
 * Nothing here renders. `Library.tsx` owns the states; this module owns the
 * order of operations, because "delete locally then forget the server row" is
 * exactly the kind of mistake that belongs in one place.
 */

import { ApiRequestError } from "./api-error";
import {
  deleteArticle,
  getArticle,
  listArticles,
  serverToLocalArticle,
} from "./account-articles";
import type { ArticleSummary } from "./cloud/contracts";
import { actingUserId, isCloudEnabled, retryArticleSync } from "./cloud/bridge";
import { currentSessionEpoch } from "./session-epoch";
import { confirmMigration } from "./migration";
import { forgetMigratedArticle, pendingMigrationAccount } from "./migration-store";
import { useStore } from "./store";

/** Server rows are read in 50-row pages; ten pages is a personal library. */
const MAX_CLOUD_PAGES = 10;

/** Server ids whose account-side delete is still owed. */
const PENDING_DELETE_KEY = "gloss-pending-article-deletes";

export interface LibrarySyncOutcome {
  /** Anonymous articles uploaded by the one-time migration, if it ran. */
  migrated: number;
  /** Local articles handed to the uploader in this pass. */
  queued: number;
  /** Articles whose body is not on this device, so they cannot be uploaded. */
  skipped: number;
}

/**
 * The account's whole library.
 *
 * Paged, with a page cap: the shelf must not turn into an unbounded request
 * chain just because an account has a large library. Ten pages (500 rows) is
 * far past a personal reading list, and the cursor loop is also guarded against
 * a server repeating the same cursor.
 */
export async function listCloudLibrary(): Promise<ArticleSummary[]> {
  const articles: ArticleSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CLOUD_PAGES; page += 1) {
    const body = await listArticles(cursor);
    articles.push(...body.articles);
    if (!body.nextCursor || seenCursors.has(body.nextCursor)) break;
    seenCursors.add(body.nextCursor);
    cursor = body.nextCursor;
  }
  return articles;
}

/**
 * Download one account article into the device.
 *
 * The saved record keeps the *server* id (that is what `serverToLocalArticle`
 * returns), which is also what makes it merge with its own summary instead of
 * appearing twice.
 */
export async function pullCloudArticle(serverId: string): Promise<void> {
  const detail = await getArticle(serverId);
  const { article, paragraphs } = serverToLocalArticle(detail);
  // The pull is authoritative for the *document*, but it must not erase
  // account metadata this device happens to be holding in a newer state (a
  // summary generated here, tags the server has not accepted yet, a cover
  // learned from the page). Those are pushed on the next Reader open; keeping
  // the local copy until then avoids a visible flicker and a pointless
  // re-generation.
  const existing = useStore.getState().articles[serverId];
  const merged = {
    ...article,
    ...(article.tags && article.tags.length > 0
      ? {}
      : existing?.tags && existing.tags.length > 0
        ? { tags: existing.tags, tagsModel: existing.tagsModel, tagsAt: existing.tagsAt }
        : {}),
    ...(article.brief || !existing?.brief ? {} : { brief: existing.brief }),
    ...(article.coverImage || !existing?.coverImage ? {} : { coverImage: existing.coverImage }),
    ...(article.publishedAt || !existing?.publishedAt ? {} : { publishedAt: existing.publishedAt }),
  };
  await useStore.getState().saveArticle(merged, paragraphs);
}

/**
 * Push what the device has and the account does not.
 *
 * The anonymous-workspace migration is folded in: when the account has a
 * pending migration offer, signing in and opening the library is the moment to
 * take it, because the whole point is that the reader sees one complete shelf
 * rather than a local half and a cloud half. It runs through the existing
 * `confirmMigration` (same mapping, same idempotency, same progress records),
 * not a second uploader.
 *
 * Local uploads are fire-and-forget on purpose: the article is already saved
 * and readable, and the row's badge changes when the verdict lands. The counts
 * returned are what was *handed over*, which is the only thing this call can
 * honestly promise.
 *
 * Concurrent callers share one run. Sign-in (App), the library page and a
 * return to the shelf can all ask within a second of each other; without this
 * the same article would be handed to the uploader three times. The server
 * would dedupe it, but the wire should not have to.
 */
let inFlightSync: Promise<LibrarySyncOutcome> | null = null;

export function syncLocalLibrary(): Promise<LibrarySyncOutcome> {
  if (inFlightSync) return inFlightSync;
  inFlightSync = runLibrarySync().finally(() => {
    inFlightSync = null;
  });
  return inFlightSync;
}

async function runLibrarySync(): Promise<LibrarySyncOutcome> {
  const outcome: LibrarySyncOutcome = { migrated: 0, queued: 0, skipped: 0 };
  if (!isCloudEnabled()) return outcome;
  const owner = actingUserId();
  if (!owner) return outcome;

  if (pendingMigrationAccount() === owner) {
    try {
      const result = await confirmMigration(owner);
      outcome.migrated = result.uploadedArticles;
    } catch {
      // The migration store records the failure and the account page reports
      // it; the library still opens with the rows it has.
    }
  }

  const state = useStore.getState();
  for (const article of Object.values(state.articles)) {
    if (article.remoteId) continue;
    const entry = state.bodies[article.id];
    if (!entry || entry.state !== "present" || entry.body.paragraphs.length === 0) {
      // An article whose text is not on this device cannot be uploaded from a
      // record alone; counting it keeps the UI honest about what is missing
      // instead of silently retrying forever.
      outcome.skipped += 1;
      continue;
    }
    retryArticleSync(article, entry.body.paragraphs, {
      ownerUserId: owner,
      epoch: currentSessionEpoch(),
    });
    outcome.queued += 1;
  }
  return outcome;
}

/**
 * Delete one article from both ends.
 *
 * The account copy goes first and is queued if it cannot be removed right now;
 * the local copy is always removed, because the reader pressed delete on a row
 * that is in front of them. Returns whether the server side needed a queue so
 * the page can say so.
 */
export async function deleteArticleEverywhere(args: {
  localId?: string;
  remoteId?: string;
}): Promise<{ cloudDeleted: boolean; queued: boolean }> {
  let cloudDeleted = false;
  let queued = false;

  if (args.remoteId) {
    try {
      await deleteArticle(args.remoteId);
      cloudDeleted = true;
    } catch (err) {
      // 404 means the account no longer has it — that is the desired end state,
      // not a failure to report.
      if (err instanceof ApiRequestError && err.status === 404) {
        cloudDeleted = true;
      } else {
        queuePendingDelete(args.remoteId);
        queued = true;
      }
    }
  }

  if (args.localId) useStore.getState().deleteArticle(args.localId);

  // If this article came from the anonymous snapshot, remove it there too —
  // otherwise a later sign-out would restore the article the reader just
  // deleted. Best-effort: the mapping only exists for migrated rows.
  if (args.remoteId) {
    const owner = actingUserId();
    if (owner) await forgetMigratedArticle(owner, args.remoteId);
  }
  return { cloudDeleted, queued };
}

/** Server deletes still owed to the account, oldest first. */
export function pendingDeleteIds(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(PENDING_DELETE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writePendingDeletes(ids: readonly string[]): void {
  try {
    if (ids.length === 0) globalThis.localStorage?.removeItem(PENDING_DELETE_KEY);
    else globalThis.localStorage?.setItem(PENDING_DELETE_KEY, JSON.stringify([...ids]));
  } catch {
    // Degraded storage: the delete still happened locally; the queue is the
    // only part that is lost.
  }
}

function queuePendingDelete(serverId: string): void {
  const ids = pendingDeleteIds();
  if (ids.includes(serverId)) return;
  writePendingDeletes([...ids, serverId]);
}

/**
 * Retry the queued server deletes.
 *
 * Runs when the library opens under a live account. A 404 counts as done — the
 * row is gone either way — and anything else stays queued rather than being
 * dropped, so a delete the reader asked for is never silently abandoned.
 */
export async function flushPendingDeletes(): Promise<number> {
  const ids = pendingDeleteIds();
  if (ids.length === 0) return 0;
  if (!isCloudEnabled() || !actingUserId()) return 0;

  let done = 0;
  const kept: string[] = [];
  for (const id of ids) {
    try {
      await deleteArticle(id);
      done += 1;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) done += 1;
      else kept.push(id);
    }
  }
  writePendingDeletes(kept);
  return done;
}
