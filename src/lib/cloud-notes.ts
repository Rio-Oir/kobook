// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cloud-notes bridge for the Reader.
 *
 * The Reader is local-first — every action works with no account, because
 * that is what reading means — and this module mirrors the result to the
 * server when there is an account to mirror it to.
 *
 * ## The invariants, and the defect each one exists to prevent
 *
 * 1. **A request never crosses accounts.** Every entry point captures the
 *    operations context *before* its first `await` and re-checks after
 *    each one. A response arriving into a different session is discarded.
 * 2. **Cloud work requires owner ≡ session user.** While the local space
 *    and the session disagree (mid sign-in, mid migration) no write is
 *    attempted, because there is no single account the write is *for*.
 * 3. **Intent is persisted before the request.** Every create, turn and
 *    delete is written to the queue *first* and removed only when the
 *    server confirms it. A crash, a reload or an account switch between
 *    "sent" and "acknowledged" therefore leaves the work retryable
 *    instead of losing it. The alternative — enqueue on failure — loses
 *    exactly the case that matters, because a process that dies mid-flight
 *    never runs its failure branch.
 * 4. **Every write is idempotent.** The stable key travels *in the request
 *    body*, so a replay after a lost response lands on the row the first
 *    attempt created rather than adding a second one.
 * 5. **Reconciliation is version-aware.** The list answers about one
 *    version; a client showing another must not read "absent" as
 *    "deleted".
 * 6. **A local stream is never clobbered by a snapshot**, and an
 *    interrupted run is recorded from its *own* partial turn rather than
 *    from the whole accumulated answer.
 *
 * ## Key generation
 *
 * Turn keys come from a frozen per-turn id the caller supplies, never from
 * a counter. A counter is not stable across clients (two tabs compute the
 * same ordinal for different turns) and not stable across a reload, so it
 * collides exactly when it must not.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  appendMessage,
  createNote,
  deleteNote as deleteNoteRemote,
  listNotes,
  updateNoteStatus,
} from "./notes";
import { ApiRequestError } from "./api-error";
import { useSession } from "./session";
import { useStore } from "./store";
import { currentSessionEpoch } from "./session-epoch";
import { cloudAdapter, type CloudNoteCreated } from "./cloud/contract";
import {
  captureCloudContext,
  cloudContextUserId,
  isCloudContextCurrent,
  type CloudContext,
} from "./cloud/guard";
import {
  isServerArticle,
  markLocalStatus,
  markStaleStreamsInterrupted,
  mintTurnId,
  startActiveTurn,
} from "./note-lifecycle";
import type { HighlightColor, Note, NoteMessage, NoteStatus, NoteType } from "./types";
import type { NoteCreateRequest } from "./cloud/contracts";

/**
 * The local note lifecycle moved to base (`src/lib/note-lifecycle.ts`): a
 * turn's id, its active marker and the interruption sweep are properties of
 * the local note record, and the reader runs them with no account at all. The
 * names stay exported from here because this module is where they used to
 * live, and every consumer already imports them alongside the cloud helpers.
 */
export { isServerArticle, markLocalStatus, markStaleStreamsInterrupted, mintTurnId, startActiveTurn };

/** Whether a cloud implementation is installed at all. */
export function isCloudEnabled(): boolean {
  // The seam replaced the release-channel switch: an adapter is registered or
  // it is not. `actingUserId` gates every cloud call on this, so this single
  // line is what makes "no adapter ⇒ no cloud request" true at the transport
  // layer even if a stale cookie left `status` at "authed".
  return cloudAdapter() !== null && useSession.getState().status === "authed";
}

/**
 * The server id the article is reachable under, for a local article the
 * dual-channel uploader has already pushed.
 *
 * Returns `null` for purely local articles (anonymous reader, or a signed-in
 * reader whose upload is still in flight). This module consults it to discover
 * the right server id to push a note against; without it a local note would
 * need a server `Article` row to attach to, which the user is creating
 * precisely because there isn't one yet.
 */
export function getSyncedArticleId(articleId: string): string | null {
  if (isServerArticle(articleId)) return articleId;
  const article = useStore.getState().articles[articleId];
  return article?.remoteId ?? null;
}

// ── Operations context ───────────────────────────────────────────────────

/**
 * The account an operation started under, and the check that its response still
 * belongs to that account.
 *
 * The implementation lives in `cloud/guard.ts` now, so the account-library page
 * and this queue share one definition rather than two that can drift. The names
 * stay exported from here because every call site in this module — and the unit
 * gate — already uses them.
 */
export type OperationsContext = CloudContext;
export const captureContext = captureCloudContext;
export const isContextCurrent = isCloudContextCurrent;

/**
 * The account cloud work may act for right now, or null.
 *
 * The local space and the session must name the same account. They diverge
 * in two real windows — between a sign-in resolving and the local space
 * being handed over, and between a sign-out and the store being cleared —
 * and in both a write has no unambiguous owner. Writing anyway is how
 * content lands in the wrong account.
 */
export function actingUserId(): string | null {
  if (!isCloudEnabled()) return null;
  return cloudContextUserId(captureCloudContext());
}

// ── Durable retry queue ──────────────────────────────────────────────────

export type PersistStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

/** A note that exists (or will exist) locally and on the server. */
export interface QueuedCreate {
  ownerUserId: string;
  localNoteId: string;
  articleId: string;
  clientKey: string;
  body: NoteCreateRequest;
}

/** A conversation turn (or an answer) owed to the server. */
export interface QueuedMessage {
  ownerUserId: string;
  noteId: string;
  /** Empty while the note it belongs to has no remote row yet. */
  remoteId: string;
  role: "user" | "assistant";
  content: string;
  status?: PersistStatus;
  clientKey: string;
  /** For an entry parked behind a pending create. */
  turnId?: string;
}

/** A remote row whose deletion is owed, with the owner it belongs to. */
export interface QueuedDelete {
  ownerUserId: string;
  remoteId: string;
}

/**
 * A terminal state that could not be written.
 *
 * A run can end with no text at all — cancelled before the first token, or
 * a provider that failed immediately. The message route cannot carry that,
 * so the status travels on its own; without it the remote note would stay
 * "running" forever and every other device would keep showing it as in
 * progress.
 */
export interface QueuedStatus {
  ownerUserId: string;
  /** The local note, so a flush can find the id a create produced. */
  noteId: string;
  /** Empty while the note is still being created. */
  remoteId: string;
  status: Exclude<PersistStatus, "running">;
  clientKey: string;
}

interface CloudQueueState {
  pendingCreates: QueuedCreate[];
  pendingMessages: QueuedMessage[];
  pendingDeletes: QueuedDelete[];
  pendingStatuses: QueuedStatus[];
  enqueueCreate: (entry: QueuedCreate) => void;
  dequeueCreate: (clientKey: string) => void;
  findCreate: (localNoteId: string) => QueuedCreate | undefined;
  enqueueMessage: (entry: QueuedMessage) => void;
  dequeueMessage: (clientKey: string) => void;
  enqueueDelete: (entry: QueuedDelete) => void;
  dequeueDelete: (remoteId: string) => void;
  enqueueStatus: (entry: QueuedStatus) => void;
  dequeueStatus: (clientKey: string) => void;
  pendingMessagesFor: (remoteId: string) => number;
  reset: () => void;
}

/**
 * Upgrade from the v2 shape, which had a single `pendingAnswers` list and
 * bare `pendingDeletes`.
 *
 * Discarding those on upgrade would delete the user's queued work as a
 * side effect of shipping a newer client — the exact kind of silent loss
 * the queue exists to prevent. They are carried across instead: the
 * answers become assistant turns, and the deletes keep their owner.
 */
/**
 * The part of the queue that is actually written to storage.
 *
 * Declaring it lets `migrate` return a partial *by type*. A cast would
 * claim the persisted blob contains the store's actions, which it never
 * does — and a cast is exactly what stops the compiler noticing when a
 * future field is added to the queue but forgotten here.
 */
type PersistedQueue = Pick<
  CloudQueueState,
  "pendingCreates" | "pendingMessages" | "pendingDeletes" | "pendingStatuses"
>;

function migrateQueue(persisted: unknown, version: number): PersistedQueue {
  const state = (persisted ?? {}) as Partial<CloudQueueState> & {
    pendingAnswers?: {
      ownerUserId?: string;
      noteId?: string;
      remoteId?: string;
      content?: string;
      status?: PersistStatus;
      clientKey?: string;
    }[];
  };
  if (version >= 3) {
    return {
      pendingCreates: state.pendingCreates ?? [],
      pendingMessages: state.pendingMessages ?? [],
      pendingDeletes: state.pendingDeletes ?? [],
      pendingStatuses: state.pendingStatuses ?? [],
    };
  }
  const carried: QueuedMessage[] = (state.pendingAnswers ?? [])
    .filter((entry) => entry.ownerUserId && entry.remoteId && entry.clientKey)
    .map((entry) => ({
      ownerUserId: entry.ownerUserId!,
      noteId: entry.noteId ?? "",
      remoteId: entry.remoteId!,
      role: "assistant" as const,
      content: entry.content ?? "",
      ...(entry.status ? { status: entry.status } : {}),
      clientKey: entry.clientKey!,
    }));
  return {
    pendingCreates: [],
    pendingMessages: carried,
    pendingDeletes: (state.pendingDeletes ?? []).filter((d) => d.ownerUserId && d.remoteId),
    pendingStatuses: [],
  };
}

export const useCloudQueue = create<CloudQueueState>()(
  persist<CloudQueueState, [], [], PersistedQueue>(
    (set, get) => ({
      pendingCreates: [],
      pendingMessages: [],
      pendingDeletes: [],
      pendingStatuses: [],
      enqueueCreate: (entry) =>
        set((s) =>
          s.pendingCreates.some((c) => c.clientKey === entry.clientKey)
            ? s
            : { ...s, pendingCreates: [...s.pendingCreates, entry] },
        ),
      dequeueCreate: (clientKey) =>
        set((s) => ({
          ...s,
          pendingCreates: s.pendingCreates.filter((c) => c.clientKey !== clientKey),
        })),
      findCreate: (localNoteId) =>
        get().pendingCreates.find((c) => c.localNoteId === localNoteId),
      enqueueMessage: (entry) =>
        set((s) =>
          s.pendingMessages.some((m) => m.clientKey === entry.clientKey)
            ? s
            : { ...s, pendingMessages: [...s.pendingMessages, entry] },
        ),
      dequeueMessage: (clientKey) =>
        set((s) => ({
          ...s,
          pendingMessages: s.pendingMessages.filter((m) => m.clientKey !== clientKey),
        })),
      enqueueDelete: (entry) =>
        set((s) =>
          s.pendingDeletes.some((d) => d.remoteId === entry.remoteId)
            ? s
            : { ...s, pendingDeletes: [...s.pendingDeletes, entry] },
        ),
      dequeueDelete: (remoteId) =>
        set((s) => ({
          ...s,
          pendingDeletes: s.pendingDeletes.filter((d) => d.remoteId !== remoteId),
        })),
      enqueueStatus: (entry) =>
        set((s) =>
          s.pendingStatuses.some((x) => x.clientKey === entry.clientKey)
            ? s
            : { ...s, pendingStatuses: [...s.pendingStatuses, entry] },
        ),
      dequeueStatus: (clientKey) =>
        set((s) => ({
          ...s,
          pendingStatuses: s.pendingStatuses.filter((x) => x.clientKey !== clientKey),
        })),
      pendingMessagesFor: (remoteId) =>
        get().pendingMessages.filter((m) => m.remoteId === remoteId).length,
      reset: () =>
        set({
          pendingCreates: [],
          pendingMessages: [],
          pendingDeletes: [],
          pendingStatuses: [],
        }),
    }),
    { name: "gloss-cloud-queue", version: 3, migrate: migrateQueue },
  ),
);

// ── Note anchoring ───────────────────────────────────────────────────────

export interface NoteAnchor {
  paragraphIndex: number;
  type: NoteType;
  selectionText: string;
  question: string;
  model: string;
  startParagraphIndex?: number;
  startOffset?: number;
  endParagraphIndex?: number;
  endOffset?: number;
  startBlockId?: string;
  endBlockId?: string;
}

function hasUsableRange(anchor: NoteAnchor): boolean {
  const { startParagraphIndex, startOffset, endParagraphIndex, endOffset } = anchor;
  if (
    startParagraphIndex === undefined ||
    startOffset === undefined ||
    endParagraphIndex === undefined ||
    endOffset === undefined
  ) {
    return false;
  }
  if (endParagraphIndex < startParagraphIndex) return false;
  if (endParagraphIndex === startParagraphIndex && endOffset <= startOffset) return false;
  return true;
}

/** The idempotency key for creating a note. Stable for the local note. */
export function noteCreateClientKey(
  ownerUserId: string,
  articleId: string,
  localNoteId: string,
): string {
  return `cn:${ownerUserId}:${articleId}:${localNoteId}`;
}

/** The key for one conversation turn, frozen by its turn id. */
export function turnClientKey(remoteId: string, turnId: string): string {
  return `t:${remoteId}:${turnId}`;
}

/**
 * The body for `POST /api/articles/:id/notes`.
 *
 * `color` is passed in rather than read off the anchor on purpose: an
 * anchor is where the note is *about*, and the colour is what it *is* —
 * it is frozen on the local note at creation and never re-derived. Reading
 * it from the store here rather than from the anchor means the create
 * carries whatever colour the note actually ended up with, including a
 * note whose colour was set before the anchor was cut.
 */
function buildCreateBody(
  anchor: NoteAnchor,
  articleVersionId: string,
  color: HighlightColor | undefined,
): NoteCreateRequest {
  const colorField = color ? { color } : {};
  return hasUsableRange(anchor)
    ? {
        paragraphIndex: anchor.paragraphIndex,
        startParagraphIndex: anchor.startParagraphIndex!,
        startOffset: anchor.startOffset!,
        endParagraphIndex: anchor.endParagraphIndex!,
        endOffset: anchor.endOffset!,
        ...(anchor.startBlockId ? { startBlockId: anchor.startBlockId } : {}),
        ...(anchor.endBlockId ? { endBlockId: anchor.endBlockId } : {}),
        articleVersionId,
        selectionText: anchor.selectionText,
        type: anchor.type,
        question: anchor.question,
        model: anchor.model,
        ...colorField,
      }
    : {
        paragraphIndex: anchor.paragraphIndex,
        articleVersionId,
        selectionText: anchor.selectionText,
        type: anchor.type,
        question: anchor.question,
        model: anchor.model,
        ...colorField,
      };
}

/**
 * In-flight creates, keyed by local note id.
 *
 * Two callers can ask for the same note's remote row at once — the reader's
 * create path and a turn that arrives before the create answered. The server
 * would treat both as the same idempotent request, but collapsing them here
 * means one request and one binding instead of two round trips.
 */
const pendingRemote = new Map<string, Promise<CloudNoteCreated | null>>();

/**
 * Create the server row for a local note and report its binding.
 *
 * This is the adapter-facing entry point. It deliberately does **not** write
 * the binding onto the local note: base owns the local note record and applies
 * the create verdict itself (`src/lib/cloud/bridge.ts`), so there is exactly
 * one place that decides what a bound note looks like.
 */
export function createRemoteNote(
  localNoteId: string,
  articleId: string,
  anchor: NoteAnchor,
): Promise<CloudNoteCreated | null> {
  const existing = useStore.getState().notes[localNoteId]?.remoteId;
  if (existing) {
    const version = useStore.getState().notes[localNoteId]?.remoteVersionId;
    if (version) return Promise.resolve({ remoteId: existing, remoteVersionId: version });
  }
  const running = pendingRemote.get(localNoteId);
  if (running) return running;
  const promise = persistNoteInner(localNoteId, articleId, anchor);
  pendingRemote.set(localNoteId, promise);
  void promise.finally(() => {
    if (pendingRemote.get(localNoteId) === promise) pendingRemote.delete(localNoteId);
  });
  return promise;
}

/**
 * Create the remote row *and* bind it locally.
 *
 * Used only by the paths inside this module that own their own bookkeeping: a
 * turn that arrives before its note has a server id, and the queue flush that
 * retries a parked create. The reader's create path goes through base's bridge,
 * which does the binding itself — so this is not a second definition of "what
 * a bound note is", only the same store action called from the one place that
 * has no base-side caller.
 */
export async function persistNote(
  localNoteId: string,
  articleId: string,
  anchor: NoteAnchor,
): Promise<string | null> {
  if (useStore.getState().notes[localNoteId]?.remoteId) {
    return useStore.getState().notes[localNoteId]!.remoteId!;
  }
  const created = await createRemoteNote(localNoteId, articleId, anchor);
  if (!created) return null;
  bindNote(localNoteId, created);
  return created.remoteId;
}

/** Write a create verdict onto the local note through the store's own action. */
function bindNote(localNoteId: string, created: CloudNoteCreated): void {
  // The note may have been deleted while the create was in flight; the
  // adapter's own reconciliation owns the server-side cleanup, and there is no
  // local record left to bind.
  if (!useStore.getState().notes[localNoteId]) return;
  useStore.getState().setNoteRemote(localNoteId, created.remoteId, created.remoteVersionId);
}

async function persistNoteInner(
  localNoteId: string,
  articleId: string,
  anchor: NoteAnchor,
): Promise<CloudNoteCreated | null> {
  const ctx = captureContext();
  const ownerUserId = actingUserId();
  if (!ownerUserId) return null;
  // A `local-XXX` article whose upload has not yet completed has no
  // server row to attach a note to, and pushing against the
  // `local-XXX` id would 404 the server's `GET
  // /api/articles/:id/notes`. `getSyncedArticleId` returns the
  // server id when there is one, and `null` otherwise — which is
  // the same condition under which the note stays local-only, so a
  // later sync can still find it by walking the local note store.
  const serverArticleId = getSyncedArticleId(articleId);
  if (anchor.selectionText.length === 0) return null;

  const localArticle = useStore.getState().articles[articleId];
  const articleVersionId = localArticle?.remoteVersionId ?? localArticle?.versionId;
  if (serverArticleId && !articleVersionId) return null;

  const entry: QueuedCreate = {
    ownerUserId,
    localNoteId,
    articleId: serverArticleId ?? articleId,
    clientKey: noteCreateClientKey(ownerUserId, articleId, localNoteId),
    body: buildCreateBody(
      anchor,
      articleVersionId ?? '',
      useStore.getState().notes[localNoteId]?.color,
    ),
  };
  // Written before the request: a process that dies between here and the
  // response still has a record of what it owed.
  useCloudQueue.getState().enqueueCreate(entry);
  if (!serverArticleId) return null;
  return createNoteDurably(entry, ctx);
}

/**
 * Create the remote note, or leave it queued.
 *
 * The key travels *in the body* — a key held only in the queue would never
 * reach the server, and the retry would create a second row exactly when the
 * first one's response was lost.
 *
 * Reports the binding rather than applying it: see `createRemoteNote`.
 */
async function createNoteDurably(
  entry: QueuedCreate,
  ctx: OperationsContext,
): Promise<CloudNoteCreated | null> {
  try {
    const response = await createNote(entry.articleId, {
      ...entry.body,
      clientKey: entry.clientKey,
    });

    if (!isContextCurrent(ctx)) {
      // Somebody else is signed in. The row belongs to `entry.ownerUserId`
      // and this session has no authority over it, so nothing is reported and
      // the entry stays queued for its own owner — the replay is safe because
      // the key is in the request.
      return null;
    }

    const local = useStore.getState().notes[entry.localNoteId];
    if (!local) {
      // Deleted while the create was in flight. The context is unchanged,
      // so this session still owns the row and the delete is authorised.
      useCloudQueue.getState().dequeueCreate(entry.clientKey);
      await deleteRemoteDurably(entry.ownerUserId, response.note.id);
      return null;
    }

    useCloudQueue.getState().dequeueCreate(entry.clientKey);
    return { remoteId: response.note.id, remoteVersionId: response.note.versionId };
  } catch (err) {
    if (!isContextCurrent(ctx)) return null;
    if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      // A refusal (bad anchor, foreign version) will not become true on a
      // retry, so it is dropped rather than retried forever. The note
      // stays local and the answer still streams.
      console.warn(`[cloud-notes] note kept local: ${err.status} ${err.message}`);
      useCloudQueue.getState().dequeueCreate(entry.clientKey);
      return null;
    }
    return null;
  }
}

// ── Turns ────────────────────────────────────────────────────────────────

/**
 * Mirror one conversation turn.
 *
 * `turnId` is minted once by the caller when the turn *starts* and reused
 * for every retry, which is what makes the key stable across a lost
 * response, a reload and a second client.
 */
export async function persistTurn(
  localNoteId: string,
  turnId: string,
  turn: { role: "user" | "assistant"; content: string; status?: PersistStatus },
): Promise<void> {
  const ctx = captureContext();
  const ownerUserId = actingUserId();
  if (!ownerUserId) return;

  const existingNote=useStore.getState().notes[localNoteId];
  if(existingNote && !existingNote.remoteId && !useCloudQueue.getState().findCreate(localNoteId)) {
    await persistNote(localNoteId,existingNote.articleId,existingNote);
    if(!isContextCurrent(ctx))return;
  }

  // A run can end with no text at all: cancelled before the first token,
  // or a provider that failed immediately. Dropping it here would leave
  // the server's row `running` forever, so every other device would keep
  // showing the note as still generating. The status is sent on its own
  // rather than smuggled in on an invented empty message.
  if (turn.content.trim().length === 0) {
    if (turn.role !== "assistant" || !turn.status) return;
    const note = useStore.getState().notes[localNoteId];
    if (!note?.remoteId) {
      // Parked behind a create. The create supplies the id the status
      // needs; dropping it here would leave the row running for good.
      if (note) {
        useCloudQueue.getState().enqueueStatus({
          ownerUserId,
          noteId: localNoteId,
          remoteId: "",
          status: turn.status as Exclude<PersistStatus, "running">,
          clientKey: `status:${localNoteId}:${turnId}`,
        });
      }
      return;
    }
    await reportTerminalStatus(ownerUserId, localNoteId, note.remoteId, turn.status, turnId);
    return;
  }

  const pending = pendingRemote.get(localNoteId);
  if (pending) await pending.catch(() => null);
  if (!isContextCurrent(ctx)) return;

  const note = useStore.getState().notes[localNoteId];
  const remoteId = note?.remoteId;

  if (!remoteId) {
    // Parked behind a create. The key is provisional and is rewritten to
    // the real turn key once the note has a remote id (see `flushQueue`).
    if (note) {
      useCloudQueue.getState().enqueueMessage({
        ownerUserId,
        noteId: localNoteId,
        remoteId: "",
        role: turn.role,
        content: turn.content,
        ...(turn.status ? { status: turn.status } : {}),
        clientKey: `pending:${localNoteId}:${turnId}`,
        turnId,
      });
    }
    return;
  }

  useCloudQueue.getState().enqueueMessage({
    ownerUserId,
    noteId: localNoteId,
    remoteId,
    role: turn.role,
    content: turn.content,
    ...(turn.status ? { status: turn.status } : {}),
    clientKey: turnClientKey(remoteId, turnId),
  });

  if (actingUserId() !== ownerUserId) return;
  const queued = useCloudQueue
    .getState()
    .pendingMessages.find((m) => m.ownerUserId === ownerUserId && m.turnId === turnId);
  await sendMessage(
    queued ?? {
      ownerUserId,
      noteId: localNoteId,
      remoteId,
      role: turn.role,
      content: turn.content,
      ...(turn.status ? { status: turn.status } : {}),
      clientKey: turnClientKey(remoteId, turnId),
    },
  );
}

export async function persistAnswer(
  localNoteId: string,
  answer: string,
  status: PersistStatus,
  turnId?: string,
): Promise<void> {
  await persistTurn(localNoteId, turnId ?? mintTurnId(), {
    role: "assistant",
    content: answer,
    status,
  });
}

export async function persistFollowUpQuestion(
  localNoteId: string,
  question: string,
  turnId?: string,
): Promise<void> {
  await persistTurn(localNoteId, turnId ?? mintTurnId(), { role: "user", content: question });
}

/**
 * Record a terminal state on the server for a run that produced no text.
 *
 * Idempotent by nature — it sets a value — and skipped entirely once the
 * row has already left `running`, so a late "failed" cannot rewrite a
 * success.
 */
/**
 * Record a terminal state for a run that produced no text.
 *
 * Durable rather than best-effort. "The next sync will reconcile it" is not
 * true: a sync merges *from* the server, and nothing in it pushes a local
 * terminal state upward. A dropped request here would therefore leave the
 * row `running` forever, and every other device would keep showing the note
 * as still generating — which is the whole reason this path exists. So the
 * write is queued and retried like every other write.
 *
 * `succeeded` is included, not excluded: a provider can legitimately return
 * an empty completion, and recording that as "succeeded with no text" is
 * honest where leaving it "running" is not.
 */
async function reportTerminalStatus(
  ownerUserId: string,
  localNoteId: string,
  remoteId: string,
  status: PersistStatus,
  turnId: string,
): Promise<void> {
  const entry: QueuedStatus = {
    ownerUserId,
    noteId: localNoteId,
    remoteId,
    status: status as Exclude<PersistStatus, "running">,
    clientKey: `status:${localNoteId}:${turnId}`,
  };
  useCloudQueue.getState().enqueueStatus(entry);
  await sendStatus(entry);
}

async function sendStatus(entry: QueuedStatus): Promise<void> {
  if (actingUserId() !== entry.ownerUserId) return;
  if (!entry.remoteId) return;
  const ctx=captureContext();
  try {
    await updateNoteStatus(entry.remoteId, {
      status: entry.status,
      clientKey: entry.clientKey,
    });
    if(!isContextCurrent(ctx))return;
    useCloudQueue.getState().dequeueStatus(entry.clientKey);
  } catch (err) {
    if(!isContextCurrent(ctx))return;
    if (err instanceof ApiRequestError && err.status === 404) {
      // The row is gone; retrying cannot succeed.
      useCloudQueue.getState().dequeueStatus(entry.clientKey);
      return;
    }
    useCloudQueue.getState().enqueueStatus(entry);
  }
}

async function sendMessage(entry: QueuedMessage): Promise<void> {
  if (!entry.remoteId) return; // still parked behind a create
  if (actingUserId() !== entry.ownerUserId) return;
  const ctx=captureContext();
  try {
    await appendMessage(entry.remoteId, {
      role: entry.role,
      content: entry.content,
      ...(entry.status ? { status: entry.status } : {}),
      clientKey: entry.clientKey,
    });
    if(!isContextCurrent(ctx))return;
    useCloudQueue.getState().dequeueMessage(entry.clientKey);
  } catch (err) {
    if(!isContextCurrent(ctx))return;
    if (err instanceof ApiRequestError && err.status === 404) {
      useCloudQueue.getState().dequeueMessage(entry.clientKey);
    }
    // Otherwise it stays queued for its owner.
  }
}

// ── Deletion ─────────────────────────────────────────────────────────────

/**
 * Remove a note's remote row, after base has already removed the local one.
 *
 * Base's `removeNote` deletes locally and *then* offers the delete here, so
 * this function must not delete locally again — it only cleans up the queue
 * entry the delete makes moot and asks the server to drop the row. The
 * tombstone is written *before* the network call: a delete that loses its
 * response must still not be retried as if it had never been attempted, and —
 * because the tombstone records the owner — it is retried under the account
 * that owns the row even if a different account is signed in by then.
 */
export async function deleteRemoteNote(localNoteId: string, remoteId: string): Promise<void> {
  const ownerUserId = actingUserId() ?? useStore.getState().ownerUserId;
  // A create that is still queued for this note is now moot: the local row it
  // would attach to is gone.
  const queuedCreate = useCloudQueue.getState().findCreate(localNoteId);
  if (queuedCreate) useCloudQueue.getState().dequeueCreate(queuedCreate.clientKey);
  await deleteRemoteDurably(ownerUserId, remoteId);
}

async function deleteRemoteDurably(ownerUserId: string, remoteId: string): Promise<void> {
  useCloudQueue.getState().enqueueDelete({ ownerUserId, remoteId });
  if (actingUserId() !== ownerUserId) return;
  try {
    await deleteNoteRemote(remoteId);
    useCloudQueue.getState().dequeueDelete(remoteId);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      useCloudQueue.getState().dequeueDelete(remoteId);
    }
    // Otherwise the tombstone stays and the next flush for this owner
    // retries it. It also stops the sync from resurrecting the card.
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────

/**
 * Retry queued writes, then pull the server-side notes for the version on
 * screen.
 *
 * Reconciliation is **version-aware**: the list answers about the version
 * the caller names, and a local note is removed only when it belongs to
 * *that* version and is absent from it. A note bound to an older version
 * is never touched, because nothing in this response says anything about
 * it — without that rule one refresh would delete every cached
 * old-version note, which is the "旧笔记仍能读原版本" promise being broken
 * from the client side.
 */
export async function syncNotesFromServer(articleId: string): Promise<number> {
  const ctx = captureContext();
  const ownerUserId = actingUserId();
  if (!ownerUserId) return 0;
  // Pull cloud notes only for articles the server actually has. A
  // `local-XXX` article whose upload has not finished has no server
  // row to query; pulling against the local id would 404 the
  // `GET /api/articles/:id/notes` route.
  const serverArticleId = getSyncedArticleId(articleId);
  if (!serverArticleId) return 0;

  await flushQueue(ownerUserId);
  if (!isContextCurrent(ctx)) return 0;

  const localArticle = useStore.getState().articles[articleId];
  // The version id the user is rendering is the local article's
  // `remoteVersionId` (set after the dual-channel uploader finishes)
  // when present, falling back to the plain `versionId` for
  // articles that arrived from the server without going through
  // the sync route. Both columns are written by the same server
  // shape (`articleVersion.id`); the fallback is what keeps the
  // existing phase-3 tests (which use a server-native article)
  // passing without giving up the new wire-A case.
  const displayedVersionId = localArticle?.remoteVersionId ?? localArticle?.versionId;
  const response = await listNotes(serverArticleId, displayedVersionId);
  if (!isContextCurrent(ctx)) return 0;

  const queue = useCloudQueue.getState();
  const remotelyDeleted = new Set(
    queue.pendingDeletes.filter((d) => d.ownerUserId === ownerUserId).map((d) => d.remoteId),
  );

  if (displayedVersionId !== response.versionId) {
    // The server answered about a different version than we asked for
    // (only possible if the article changed under us). Merge nothing and
    // delete nothing: the local notes are the only copy of the version on
    // screen.
    return 0;
  }

  const remoteIds = new Set(response.notes.map((n) => n.id));
  for (const remote of response.notes) {
    if (remotelyDeleted.has(remote.id)) continue;
    const local = Object.values(useStore.getState().notes).find((n) => n.remoteId === remote.id);
    if (local?.isStreaming) continue;
    if (queue.pendingMessagesFor(remote.id) > 0) continue;
    // `articleId` stays the *local* article id: the server row names its own
    // article id, and a pasted article that was uploaded has a different local
    // one. Writing the server id here would hide the note from the Reader,
    // which filters by the id it is showing.
    useStore.getState().upsertRemoteNote({
      ...remoteNoteToLocal(remote, response.messagesByNote[remote.id] ?? []),
      articleId,
    });
  }

  for (const note of Object.values(useStore.getState().notes)) {
    if (note.articleId !== articleId) continue;
    if (!note.remoteId) continue;
    // Only rows about *this* version can be judged by *this* response.
    if (note.remoteVersionId !== response.versionId) continue;
    if (remoteIds.has(note.remoteId)) continue;
    if (note.isStreaming) continue;
    if (queue.pendingMessagesFor(note.remoteId) > 0) continue;
    useStore.getState().deleteNote(note.id);
  }

  return response.notes.length;
}

/**
 * Retry every queued create, turn and delete for `ownerUserId`.
 *
 * Creates run first: a turn parked behind one has no remote id yet, and
 * only the create can give it one.
 */
export async function flushQueue(ownerUserId = actingUserId() ?? undefined): Promise<void> {
  if (!ownerUserId) return;
  if (actingUserId() !== ownerUserId) return;

  for (const create of [...useCloudQueue.getState().pendingCreates]) {
    if (create.ownerUserId !== ownerUserId) continue;
    if (actingUserId() !== ownerUserId) return;
    const note=useStore.getState().notes[create.localNoteId];
    if(!note){useCloudQueue.getState().dequeueCreate(create.clientKey);continue;}
    if(note.remoteId){useCloudQueue.getState().dequeueCreate(create.clientKey);continue;}
    const localArticle=useStore.getState().articles[note.articleId];
    const articleId=getSyncedArticleId(note.articleId);
    const versionId=localArticle?.remoteVersionId??localArticle?.versionId;
    if(!articleId||!versionId)continue;
    if(pendingRemote.has(note.id))await pendingRemote.get(note.id);
    else {
      const created = await createNoteDurably({...create,articleId,body:{...create.body,articleVersionId:versionId}},captureContext());
      // The flush owns its own binding: unlike the reader's create path there
      // is no base-side caller to apply the verdict.
      if (created) bindNote(create.localNoteId, created);
    }
  }

  for (const entry of [...useCloudQueue.getState().pendingMessages]) {
    if (entry.ownerUserId !== ownerUserId) continue;
    if (actingUserId() !== ownerUserId) return;
    let resolved = entry;
    if (!resolved.remoteId) {
      const note = useStore.getState().notes[entry.noteId];
      if (!note?.remoteId) continue; // its create still has not landed
      const turnId = entry.turnId ?? entry.clientKey;
      resolved = {
        ...entry,
        remoteId: note.remoteId,
        clientKey: turnClientKey(note.remoteId, turnId),
      };
      useCloudQueue.getState().dequeueMessage(entry.clientKey);
      useCloudQueue.getState().enqueueMessage(resolved);
    }
    await sendMessage(resolved);
  }

  for (const entry of [...useCloudQueue.getState().pendingStatuses]) {
    if (entry.ownerUserId !== ownerUserId) continue;
    if (actingUserId() !== ownerUserId) return;
    if (entry.remoteId) {
      await sendStatus(entry);
      continue;
    }
    // Parked behind a create: adopt the id once the create has landed.
    const note = useStore.getState().notes[entry.noteId];
    if (!note?.remoteId) continue;
    useCloudQueue.getState().dequeueStatus(entry.clientKey);
    await sendStatus({ ...entry, remoteId: note.remoteId });
  }

  for (const pending of [...useCloudQueue.getState().pendingDeletes]) {
    if (pending.ownerUserId !== ownerUserId) continue;
    if (actingUserId() !== ownerUserId) return;
    try {
      await deleteNoteRemote(pending.remoteId);
      useCloudQueue.getState().dequeueDelete(pending.remoteId);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        useCloudQueue.getState().dequeueDelete(pending.remoteId);
      }
      // Otherwise it stays queued for this owner.
    }
  }
}

// The interruption sweep, the local status marker and the active-turn marker
// are base's now (`src/lib/note-lifecycle.ts`) and are re-exported at the top
// of this module. Their local half runs with no adapter installed; the half
// that mirrors a partial answer runs through `callAdapter`, so a transport
// that throws cannot abort the sweep half way through.

/**
 * Rebuild a local note from a server row plus its conversation turns.
 *
 * `isStreaming` is always false (see above) and `localStatus` is not set:
 * the server's lifecycle is reported through `remoteStatus` so the two are
 * never conflated.
 */
export function remoteNoteToLocal(
  remote: {
    id: string;
    articleId: string;
    versionId: string;
    paragraphIndex: number;
    startParagraphIndex: number;
    startOffset: number;
    endParagraphIndex: number;
    endOffset: number;
    startBlockId: string;
    endBlockId: string;
    type: NoteType;
    selectionText: string;
    question: string;
    answer: string;
    model: string;
    status: NoteStatus;
    /**
     * The note's own colour. `null` on a row written before the column
     * existed, and absent is what makes the note render with the default
     * blue — the same state a locally created note starts in before the
     * reader picks anything.
     */
    color?: HighlightColor | null;
    createdAt: string;
  },
  turns: NoteMessage[] = [],
): Note {
  const assistantTurns = turns.filter((t) => t.role === "assistant");
  const questionTurns = turns.filter((t) => t.role === "user");
  const answer =
    assistantTurns.length > 0
      ? assistantTurns.map((t) => t.content).join("\n\n---\n\n")
      : remote.answer;

  return {
    id: `remote-${remote.id}`,
    remoteId: remote.id,
    remoteVersionId: remote.versionId,
    remoteStatus: remote.status,
    articleId: remote.articleId,
    paragraphIndex: remote.paragraphIndex,
    startParagraphIndex: remote.startParagraphIndex,
    startOffset: remote.startOffset,
    endParagraphIndex: remote.endParagraphIndex,
    endOffset: remote.endOffset,
    startBlockId: remote.startBlockId || undefined,
    endBlockId: remote.endBlockId || undefined,
    type: remote.type,
    selectionText: remote.selectionText,
    question: remote.question,
    answer,
    model: remote.model,
    isStreaming: false,
    createdAt: Date.parse(remote.createdAt),
    localAnswerCount: assistantTurns.length,
    localQuestionCount: questionTurns.length,
    // Only set when the row carries one. Spreading `remote.color`
    // unconditionally would write an explicit `color: null` onto a note
    // whose local copy still had a colour — `upsertRemoteNote` overlays the
    // server row onto the local one, and a null would quietly erase what
    // this device already knew.
    ...(remote.color ? { color: remote.color } : {}),
    ...(turns.length > 0 ? { turns } : {}),
  };
}
