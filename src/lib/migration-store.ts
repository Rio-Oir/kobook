// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Anonymous→account migration: the local state and the ownership rules.
 *
 * Kept separate from `migration.ts` (which performs the upload) so that the
 * ownership path can consult these rules without importing the article/notes
 * HTTP clients. The account client imports *them*, so importing `migration.ts`
 * here would close a module cycle whose failure mode is a store constructed
 * before its dependencies exist.
 *
 * ## Who drives it now
 *
 * It used to be `auth-client.applyOwnership`, which this line owned. Base owns
 * owner/epoch reconciliation now (`src/lib/ownership.ts`), and it deliberately
 * stamps the new owner *before* notifying the adapter — so the snapshot this
 * module takes can no longer be taken from the ownership hook. The adapter
 * therefore takes it one step earlier, from `prepareOwnershipTransition`, which
 * runs from the session probe and from the sign-in handler, while the live
 * space is still stamped anonymous. `onOwnerResolved` then consumes the marker
 * and raises the offer.
 *
 * ## The rules this implements
 *
 *   - "登录时不静默上传匿名内容：显示迁移/同步确认" — signing in never
 *     uploads. It raises an *offer*.
 *   - "拒绝后保留独立匿名本地空间" — declining keeps the anonymous
 *     workspace intact and gives the account a clean one.
 *   - "迁移幂等、可重试，不带 API key" — retrying must not duplicate, and
 *     the credential never travels with the content.
 *
 * ## Why namespaces rather than a relabel
 *
 * The first draft of this module stamped the account's owner id onto the
 * anonymous rows before asking anything. That is wrong twice over: it
 * decides for the user, and — because the archive was written *after*
 * the relabel — the snapshot it kept was stamped with the account, so
 * the "restore the anonymous space" path refused it and the content was
 * gone. Two bugs, one cause.
 *
 * The fix is to treat the spaces as genuinely separate:
 *
 *   - the anonymous workspace is snapshotted **verbatim, while it is
 *     still stamped anonymous**, so it can be restored or migrated
 *     later;
 *   - the account's space is activated only on an explicit choice
 *     (confirm or decline), never on sign-in alone;
 *   - nothing the account pulls from the cloud is ever mixed into the
 *     unconfirmed anonymous workspace, because the local store stays
 *     anonymous-owned until the user decides.
 *
 * A snapshot that cannot be written is a hard failure: the caller must
 * not clear the live space if there is nowhere to put it.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useStore, STORAGE_KEY } from "./store";
import { ANONYMOUS_OWNER } from "./identity";
import {
  archiveBodies,
  dropArchivedBodies,
  readArchivedBodies,
  readLiveBodies,
  restoreBodies,
} from "./storage/bodies";

/** The stored copy of the anonymous workspace while the account is active. */
export const ANON_SPACE_KEY = "gloss-anon-space";

export type MigrationStatus = "idle" | "offered" | "running" | "done" | "declined" | "failed";

/** What a migrated server article looks like, for anchoring notes. */
export interface MigratedVersion {
  versionId: string;
  /** The imported version's blocks, in order, as the server returned them. */
  paragraphs: { index: number; id: string; text: string }[];
}

/** Per-account progress, so a retry resumes instead of restarting. */
export interface MigrationProgress {
  /** Local article id → server article id. */
  articleMap: Record<string, string>;
  /** Server article id → the version its notes must anchor to. */
  versionMap: Record<string, MigratedVersion>;
  /**
   * Idempotency keys already accepted by the server, so a retry skips
   * work that succeeded even when the client never saw the response.
   */
  completedNoteKeys: string[];
  /** Notes that could not be created yet; retried on the next attempt. */
  failedNoteKeys: string[];
  /**
   * Conversation turns already replayed. Keyed per turn rather than per
   * note: a note whose answer failed must not be recorded as complete,
   * and a retry has to know *which* turn is still missing.
   */
  completedMessageKeys: string[];
  /** Turns that failed and must be retried. */
  failedMessageKeys: string[];
  /** Article ids that failed; retried on the next attempt. */
  failedArticleIds: string[];
}

function emptyProgress(): MigrationProgress {
  return {
    articleMap: {},
    versionMap: {},
    completedNoteKeys: [],
    failedNoteKeys: [],
    completedMessageKeys: [],
    failedMessageKeys: [],
    failedArticleIds: [],
  };
}

interface MigrationState {
  status: MigrationStatus;
  /** The account an outstanding offer is for, or null. */
  pendingFor: string | null;
  /** Accounts whose migration finished completely. */
  completedFor: string[];
  /** Per-account upload progress. */
  progress: Record<string, MigrationProgress>;
  /** Why the last attempt stopped short, when it did. */
  lastError: string | null;

  offer: (userId: string) => void;
  dismissOffer: () => void;
  markRunning: (userId: string) => void;
  markDone: (userId: string) => void;
  markFailed: (userId: string, reason: string) => void;
  markDeclined: () => void;
  recordArticle: (userId: string, localId: string, serverId: string) => void;
  recordArticleFailure: (userId: string, localId: string) => void;
  recordNote: (userId: string, key: string) => void;
  recordNoteFailure: (userId: string, key: string) => void;
  recordVersion: (userId: string, serverArticleId: string, version: MigratedVersion) => void;
  recordMessage: (userId: string, key: string) => void;
  recordMessageFailure: (userId: string, key: string) => void;
  progressFor: (userId: string) => MigrationProgress;
  reset: () => void;
}

export const useMigration = create<MigrationState>()(
  persist(
    (set, get) => ({
      status: "idle",
      pendingFor: null,
      completedFor: [],
      progress: {},
      lastError: null,

      offer: (userId) =>
        set((s) =>
          s.pendingFor === userId && s.status === "offered"
            ? s
            : { ...s, pendingFor: userId, status: "offered" },
        ),
      dismissOffer: () => set((s) => ({ ...s, pendingFor: null, status: "idle" })),
      markRunning: (userId) =>
        set((s) => ({ ...s, status: "running", pendingFor: userId, lastError: null })),
      markDone: (userId) =>
        set((s) => ({
          ...s,
          status: "done",
          pendingFor: null,
          lastError: null,
          completedFor: s.completedFor.includes(userId)
            ? s.completedFor
            : [...s.completedFor, userId],
        })),
      markFailed: (userId, reason) =>
        set((s) => ({ ...s, status: "failed", pendingFor: userId, lastError: reason })),
      markDeclined: () => set((s) => ({ ...s, status: "declined", pendingFor: null })),

      recordArticle: (userId, localId, serverId) =>
        set((s) => {
          const progress = s.progress[userId] ?? emptyProgress();
          return {
            ...s,
            progress: {
              ...s.progress,
              [userId]: {
                ...progress,
                articleMap: { ...progress.articleMap, [localId]: serverId },
                failedArticleIds: progress.failedArticleIds.filter((id) => id !== localId),
              },
            },
          };
        }),
      recordArticleFailure: (userId, localId) =>
        set((s) => {
          const progress = s.progress[userId] ?? emptyProgress();
          return {
            ...s,
            progress: {
              ...s.progress,
              [userId]: {
                ...progress,
                failedArticleIds: progress.failedArticleIds.includes(localId)
                  ? progress.failedArticleIds
                  : [...progress.failedArticleIds, localId],
              },
            },
          };
        }),
      recordNote: (userId, key) =>
        set((s) => {
          const progress = s.progress[userId] ?? emptyProgress();
          return {
            ...s,
            progress: {
              ...s.progress,
              [userId]: {
                ...progress,
                completedNoteKeys: progress.completedNoteKeys.includes(key)
                  ? progress.completedNoteKeys
                  : [...progress.completedNoteKeys, key],
                failedNoteKeys: progress.failedNoteKeys.filter((k) => k !== key),
              },
            },
          };
        }),
      recordNoteFailure: (userId, key) =>
        set((s) => {
          const progress = s.progress[userId] ?? emptyProgress();
          return {
            ...s,
            progress: {
              ...s.progress,
              [userId]: {
                ...progress,
                failedNoteKeys: progress.failedNoteKeys.includes(key)
                  ? progress.failedNoteKeys
                  : [...progress.failedNoteKeys, key],
              },
            },
          };
        }),

      recordVersion: (userId, serverArticleId, version) =>
        set((s) => {
          const progress = s.progress[userId] ?? emptyProgress();
          return {
            ...s,
            progress: {
              ...s.progress,
              [userId]: {
                ...progress,
                versionMap: { ...progress.versionMap, [serverArticleId]: version },
              },
            },
          };
        }),
      recordMessage: (userId, key) =>
        set((s) => {
          const progress = s.progress[userId] ?? emptyProgress();
          return {
            ...s,
            progress: {
              ...s.progress,
              [userId]: {
                ...progress,
                completedMessageKeys: progress.completedMessageKeys.includes(key)
                  ? progress.completedMessageKeys
                  : [...progress.completedMessageKeys, key],
                failedMessageKeys: progress.failedMessageKeys.filter((k) => k !== key),
              },
            },
          };
        }),
      recordMessageFailure: (userId, key) =>
        set((s) => {
          const progress = s.progress[userId] ?? emptyProgress();
          return {
            ...s,
            progress: {
              ...s.progress,
              [userId]: {
                ...progress,
                failedMessageKeys: progress.failedMessageKeys.includes(key)
                  ? progress.failedMessageKeys
                  : [...progress.failedMessageKeys, key],
              },
            },
          };
        }),
      progressFor: (userId) => get().progress[userId] ?? emptyProgress(),
      reset: () =>
        set({
          status: "idle",
          pendingFor: null,
          completedFor: [],
          progress: {},
          lastError: null,
        }),
    }),
    { name: "gloss-migration", version: 1 },
  ),
);

// ── Local space handling ─────────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The owner stamp recorded inside a persisted store blob, if readable. */
export function ownerOfPersistedBlob(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: { ownerUserId?: unknown } };
    const owner = parsed?.state?.ownerUserId;
    return typeof owner === "string" ? owner : null;
  } catch {
    return null;
  }
}

/** Whether the live store holds anything worth migrating. */
export function hasAnonymousContent(): boolean {
  const s = useStore.getState();
  return hasContentIn({
    articles: s.articles,
    notes: s.notes,
    highlights: s.highlights,
  });
}

function hasContentIn(state: {
  articles?: Record<string, unknown>;
  notes?: Record<string, unknown>;
  highlights?: Record<string, unknown>;
}): boolean {
  return (
    Object.keys(state.articles ?? {}).length > 0 ||
    Object.keys(state.notes ?? {}).length > 0 ||
    Object.keys(state.highlights ?? {}).length > 0
  );
}

/** Whether an archived anonymous workspace exists. */
export function hasArchive(): boolean {
  const store = storage();
  return ownerOfPersistedBlob(store?.getItem(ANON_SPACE_KEY) ?? null) !== null;
}

/**
 * Read the anonymous workspace that a migration should upload.
 *
 * Two sources, in order: the live store when it is still anonymous-owned
 * (the offer path, where nothing has been relabelled), and otherwise the
 * archived snapshot. Returning the live store first matters because it is
 * the authoritative one — the archive is a copy taken earlier and could
 * be older than an edit made after the offer was raised.
 *
 * ## Why the bodies come from storage and not from the store's memory
 *
 * The records are in the `localStorage` blob, but the text is not: it lives in
 * its own object store and is loaded into the store lazily, one article at a
 * time, only when the reader opens it. A migration that read
 * `useStore.getState().bodies` would therefore upload whichever articles the
 * user happened to have visited this session and silently skip the rest —
 * an upload that reports success and loses most of the library. So both
 * branches read the text from storage, for exactly the ids being migrated.
 */
export async function readAnonymousWorkspace(): Promise<{
  source: "live" | "archive";
  articles: Record<string, import("./types").Article>;
  notes: Record<string, import("./types").Note>;
  highlights: Record<string, import("./types").Highlight>;
  bodies: Record<string, import("./types").ArticleBody>;
} | null> {
  const live = useStore.getState();
  if (live.ownerUserId === ANONYMOUS_OWNER && hasContentIn(live)) {
    const liveBodies = await readLiveBodies(Object.keys(live.articles));
    return {
      source: "live",
      articles: live.articles,
      notes: live.notes,
      highlights: live.highlights,
      bodies: byArticleId(liveBodies),
    };
  }
  const raw = storage()?.getItem(ANON_SPACE_KEY) ?? null;
  if (!raw || ownerOfPersistedBlob(raw) !== ANONYMOUS_OWNER) return null;
  try {
    const parsed = JSON.parse(raw) as {
      state?: {
        articles?: Record<string, import("./types").Article>;
        notes?: Record<string, import("./types").Note>;
        highlights?: Record<string, import("./types").Highlight>;
      };
    };
    const state = parsed.state ?? {};
    const articles = state.articles ?? {};
    const archived = await readArchivedBodies(Object.keys(articles));
    return {
      source: "archive",
      articles,
      notes: state.notes ?? {},
      highlights: state.highlights ?? {},
      bodies: byArticleId(archived),
    };
  } catch {
    return null;
  }
}

function byArticleId(
  bodies: readonly import("./types").ArticleBody[],
): Record<string, import("./types").ArticleBody> {
  return Object.fromEntries(bodies.map((body) => [body.articleId, body]));
}

/**
 * Copy the live workspace into the archive, verbatim — records *and* text.
 *
 * Deliberately taken *before* any owner stamp changes, so the copy says
 * `ownerUserId: "anonymous"` and can be restored later. Returns whether
 * it succeeded — a caller about to clear the live space must treat
 * `false` as "do not proceed", or the content is gone with nothing to
 * restore it from.
 *
 * Async since the text moved out of the blob. It used to be synchronous and
 * therefore *looked* complete, which is how the shelf came to be archived
 * without the books: `clearUserCache` purged the bodies on the next tick and
 * the snapshot had never held them. The `await` is the fix — the caller cannot
 * clear the live space until this resolves, so there is no window in which the
 * text is in neither place.
 */
export async function archiveAnonymousSpace(): Promise<boolean> {
  const store = storage();
  if (!store) return false;
  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    // Refuse to archive a blob that already belongs to an account: that
    // would overwrite the anonymous snapshot with account data and make
    // the anonymous workspace unrecoverable.
    if (ownerOfPersistedBlob(raw) !== ANONYMOUS_OWNER) return false;
    store.setItem(ANON_SPACE_KEY, raw);
  } catch {
    return false;
  }
  // Only the ids the snapshot actually lists. Archiving every live body would
  // take the account's text along with the anonymous text — and the two share
  // keys, because a local id is a hash of the text and carries no owner.
  await archiveBodies(articleIdsInBlob(raw));
  return true;
}

/** The article ids a stored blob lists, or none when it will not parse. */
function articleIdsInBlob(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { state?: { articles?: Record<string, unknown> } };
    return Object.keys(parsed.state?.articles ?? {});
  } catch {
    return [];
  }
}

/**
 * Put the archived anonymous workspace back as the live one.
 *
 * Only runs when the live space is empty or already anonymous, and only
 * from a snapshot that is itself anonymous-stamped — restoring an
 * account's data over another space would be a cross-user leak dressed
 * up as a restore.
 *
 * The state is installed with `setState` rather than by writing the blob
 * and calling `persist.rehydrate()`. Rehydrate is asynchronous, so the
 * caller — every path that has just observed "no session" — would briefly
 * see an empty library, and on a slow tick would render the signed-out
 * reader's articles as missing. `setState` applies the snapshot in the
 * same tick the decision was made.
 *
 * ## Why this is `async` while still being "same tick"
 *
 * The records are installed synchronously, before the first `await` — that is
 * the guarantee above and it is unchanged. What follows is the *text*, which
 * lives in its own store and cannot be moved without one. The returned promise
 * resolves when the bodies are back, so a caller that wants to know can await
 * it; `onOwnerResolved` deliberately does not, because it is a synchronous
 * hook. The window in between is closed by the re-arm in
 * `restoreArchivedBodies`.
 */
export async function restoreAnonymousSpace(): Promise<boolean> {
  const store = storage();
  if (!store) return false;
  const raw = store.getItem(ANON_SPACE_KEY);
  if (!raw) return false;
  if (ownerOfPersistedBlob(raw) !== ANONYMOUS_OWNER) return false;
  const liveOwner = useStore.getState().ownerUserId;
  if (liveOwner !== ANONYMOUS_OWNER && hasAnonymousContent()) return false;
  try {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (!parsed.state) return false;
    useStore.setState(parsed.state as Partial<ReturnType<typeof useStore.getState>>);
    store.removeItem(ANON_SPACE_KEY);
    await restoreArchivedBodies(articleIdsInBlob(raw));
    return true;
  } catch {
    return false;
  }
}

/**
 * Put the archived text back and re-arm the reader for it.
 *
 * Not awaited by `restoreAnonymousSpace`, and it does not need to be: that
 * function runs from `onOwnerResolved`, which base calls *synchronously* as
 * part of ownership reconciliation (`cloud/contract.ts` says so explicitly),
 * so there is no async seam to await at. The records are installed
 * synchronously and the text follows.
 *
 * What makes the late arrival harmless is the re-arm at the end. `ensureBody`
 * records a *terminal* verdict — including `never-stored` — and never re-reads
 * on its own, so a reader that opened an article in the moment between the
 * records landing and the text arriving would be stuck on "this article's text
 * is not on this device" for the rest of the session. Dropping the entry and
 * asking again is what closes that window; `ensureBody` is idempotent and
 * cheap, and it drops the entry itself if the record is gone by then.
 *
 * The archive is dropped once its contents are live: a copy that outlived the
 * restore would let a *later* sign-out resurrect articles the reader had since
 * deleted.
 */
async function restoreArchivedBodies(articleIds: readonly string[]): Promise<void> {
  const archived = await readArchivedBodies(articleIds);
  if (archived.length === 0) return;
  await restoreBodies(archived);
  await dropArchivedBodies(archived.map((body) => body.articleId));

  const restored = new Set(archived.map((body) => body.articleId));
  useStore.setState((s) => {
    const bodies = { ...s.bodies };
    for (const id of restored) delete bodies[id];
    return { bodies };
  });
  for (const id of restored) useStore.getState().ensureBody(id);
}

/**
 * Hand the account a clean workspace, keeping the anonymous one aside.
 *
 * Returns false when the snapshot could not be written — in which case
 * nothing has been cleared, so the caller can report the failure instead
 * of losing the content.
 */
export async function activateAccountSpace(userId: string): Promise<boolean> {
  const live = useStore.getState();
  if (live.ownerUserId === ANONYMOUS_OWNER && hasAnonymousContent()) {
    if (!(await archiveAnonymousSpace())) return false;
  }
  useStore.getState().clearUserCache();
  useStore.getState().setOwner(userId);
  return true;
}

/**
 * The account whose sign-in snapshot of the anonymous workspace was just
 * taken, or null.
 *
 * Module state rather than store state on purpose: it describes one in-flight
 * ownership transition inside this page load, and persisting it would let a
 * stale marker from a previous session clear a live store on the next one.
 */
let pendingAdoptFor: string | null = null;

/**
 * The outcome of trying to take the anonymous workspace aside for a sign-in.
 *
 * `blocked` is a *veto*, not a degraded success: the workspace could not be
 * put anywhere, so the caller must refuse the switch rather than let the
 * account take the live space. See `prepareOwnershipTransition`.
 */
export type OwnershipTransition = "none" | "archived" | "blocked";

/**
 * Take the anonymous workspace aside *before* the account takes the live one.
 *
 * Must run while the live space is still stamped anonymous — i.e. before
 * `applyOwnership`. `archiveAnonymousSpace` refuses to snapshot a blob that an
 * account already owns, precisely so a late call cannot overwrite the
 * anonymous copy with account data; that check is what makes this call order
 * load-bearing rather than stylistic.
 *
 * ## Why `blocked` has to abort the sign-in, and where the veto happens
 *
 * Once an account owns the live space, base's own ownership rule says a later
 * sign-out clears it (`ownership.ts`, the `clear` path). So an account that
 * adopts an un-back-up-able anonymous workspace is a *delay*, not a
 * resolution: sign out afterwards and the content is gone with no snapshot to
 * restore it from. That is the failure this function's third result exists to
 * prevent.
 *
 * Base offers no decision-time veto — `applyOwnership` resolves `adopt`,
 * stamps the owner and *then* notifies the adapter — so the refusal cannot be
 * expressed from `onOwnerResolved`. It does not need to be: `probeSession`
 * runs *before* base decides, and the sign-in handler runs before the session
 * store is even consulted. Those two value-added call sites are therefore the
 * veto points, and both treat `blocked` as "do not proceed; leave the device
 * anonymous" (see `cloud/adapter.ts` and `auth-client.ts`). Base is not
 * modified, and no base file is forked to get this.
 *
 * The guarantee is only as good as that ordering: a future base change that
 * resolved ownership before probing the adapter would silently remove the
 * veto. `tests/unit/cloud-adapter.test.ts` and
 * `tests/unit/ownership-apply.test.ts` pin the behaviour from the outside so
 * the loss would be visible rather than silent.
 */
export async function prepareOwnershipTransition(
  resolvedUserId: string,
): Promise<OwnershipTransition> {
  pendingAdoptFor = null;
  if (useStore.getState().ownerUserId !== ANONYMOUS_OWNER) return "none";
  if (!hasAnonymousContent()) return "none";
  if (await archiveAnonymousSpace()) {
    pendingAdoptFor = resolvedUserId;
    return "archived";
  }
  return "blocked";
}

/**
 * Consume the marker for `userId`, reporting whether this resolution is the
 * adopt it was taken for.
 */
export function consumePendingAdopt(userId: string): boolean {
  if (pendingAdoptFor !== userId) return false;
  pendingAdoptFor = null;
  return true;
}

/** Drop the marker for a resolution that went another way (sign-out, switch). */
export function clearPendingAdopt(): void {
  pendingAdoptFor = null;
}

/**
 * Offer migration. Called when a sign-in finds an anonymous workspace with
 * content, and only then — offering to move an empty library is noise, not a
 * choice.
 *
 * `hadContent` is passed by the caller because by the time the offer is raised
 * the live space has already been handed to the account, so the "is there
 * anything to move" question can no longer be asked of it.
 *
 * Not re-issued for an account already recorded as migrated, so re-opening the
 * app does not nag someone who already decided.
 */
export function offerMigrationFor(userId: string, hadContent = hasAnonymousContent()): void {
  if (!hadContent) return;
  const state = useMigration.getState();
  if (state.completedFor.includes(userId)) return;
  state.offer(userId);
}

/** The account with an outstanding offer, or null. */
export function pendingMigrationAccount(): string | null {
  const state = useMigration.getState();
  return state.status === "offered" ? state.pendingFor : null;
}

/**
 * Decline: keep the anonymous content, out of the account's space.
 *
 * Idempotent — archiving twice overwrites the snapshot with the same
 * bytes, and the owner stamp is set once.
 */
export function declineMigration(userId: string): boolean {
  const ok = activateAccountSpace(userId);
  if (!ok) return false;
  useMigration.getState().markDeclined();
  return true;
}

/**
 * Drop one article from the anonymous snapshot.
 *
 * The snapshot is what a sign-out restores, so an article the reader deleted
 * while signed in must not be left inside it: otherwise "delete" undoes itself
 * the next time they sign out. Migration progress holds the only mapping from
 * the local id (the snapshot's key) to the server article, so an article that
 * was not migrated from this device's anonymous space is simply not ours to
 * touch and returns false.
 *
 * The archive's text lives in its own IndexedDB namespace; dropping the record
 * without the body would leave a body no record can reach, so both go.
 */
export async function forgetMigratedArticle(userId: string, serverId: string): Promise<boolean> {
  const progress = useMigration.getState().progress[userId];
  if (!progress) return false;
  const localId = Object.keys(progress.articleMap).find(
    (id) => progress.articleMap[id] === serverId,
  );
  if (!localId) return false;

  const store = storage();
  if (store) {
    const raw = store.getItem(ANON_SPACE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
        if (parsed.state) {
          deleteArticleFromRecord(parsed.state, "articles", localId);
          deleteArticleFromRecord(parsed.state, "notes", localId);
          deleteArticleFromRecord(parsed.state, "highlights", localId);
          store.setItem(ANON_SPACE_KEY, JSON.stringify(parsed));
        }
      } catch {
        // A corrupt snapshot is not rewritten: half-editing it would be worse
        // than leaving it, and the body cleanup below still runs.
      }
    }
  }
  await dropArchivedBodies([localId]);
  useMigration.setState((s) => {
    const current = s.progress[userId];
    if (!current) return s;
    const articleMap = { ...current.articleMap };
    delete articleMap[localId];
    return { ...s, progress: { ...s.progress, [userId]: { ...current, articleMap } } };
  });
  return true;
}

/** Remove one article (or the notes/highlights anchored to it) from a blob. */
function deleteArticleFromRecord(
  state: Record<string, unknown>,
  key: "articles" | "notes" | "highlights",
  articleId: string,
): void {
  const bag = state[key];
  if (!bag || typeof bag !== "object") return;
  const record = bag as Record<string, unknown>;
  if (key === "articles") {
    delete record[articleId];
    return;
  }
  for (const [id, value] of Object.entries(record)) {
    if (
      value &&
      typeof value === "object" &&
      (value as { articleId?: unknown }).articleId === articleId
    ) {
      delete record[id];
    }
  }
}
