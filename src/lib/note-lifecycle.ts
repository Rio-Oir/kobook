// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local note lifecycle.
 *
 * Everything here operates only on the local store. It used to be tangled
 * with the upload queue, which meant the reader's turn bookkeeping could not
 * be read (or tested) without a server client in the import graph. Splitting
 * it out is what lets the reader keep its exact behaviour with no cloud
 * adapter installed at all.
 *
 * The rules the reader depends on:
 *
 *   - **A turn id is frozen when the turn starts.** `mintTurnId` is called
 *     once, and the same id is reused for every retry. A counter or a
 *     timestamp re-derived at flush time would collide across tabs and
 *     across a reload — exactly when it must not.
 *   - **The active turn is recorded so an interruption can be attributed.**
 *     `isStreaming` surviving into a fresh page load *is* the evidence that a
 *     run was cut off: nothing clears it when a tab is closed. The sweep
 *     records the *active turn's own* partial text, not the note's whole
 *     accumulated answer — the flattened answer includes every earlier turn,
 *     so replaying it would duplicate the entire conversation.
 *   - **Terminal state and streaming flag are set in one place.**
 *     `markLocalStatus` clears the active-turn marker as well, so a stale
 *     marker cannot survive a finished run and make a later sweep re-record
 *     it as an interruption.
 */

import { useStore } from "./store";
import { callAdapter } from "./cloud/contract";
import type { NoteStatus } from "./types";

export type { CloudNoteAnchor as NoteAnchor, CloudPersistStatus as PersistStatus } from "./cloud/contract";

/**
 * An article is on the server if its id came from the server. The anonymous
 * import path mints `local-<textHash>` ids precisely so this is a string test
 * rather than a guess.
 */
export function isServerArticle(articleId: string): boolean {
  return !articleId.startsWith("local-");
}

/** A globally unique id for one turn, frozen for the life of that turn. */
export function mintTurnId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mark a turn as the one currently being generated.
 *
 * The id is frozen here so an interruption can be recorded against *this*
 * turn; the text is filled in as chunks arrive.
 */
export function startActiveTurn(localNoteId: string, turnId: string): void {
  const note = useStore.getState().notes[localNoteId];
  if (!note) return;
  useStore.getState().updateNote(localNoteId, {
    isStreaming: true,
    activeTurnId: turnId,
    activeTurnText: "",
  });
}

/**
 * Record this client's lifecycle state for a note.
 *
 * Separate from clearing the streaming flag alone: the *reason* a run ended is
 * what the reader shows and what the next page load reports, and a boolean
 * cannot carry it.
 */
export function markLocalStatus(localNoteId: string, status: NoteStatus): void {
  const note = useStore.getState().notes[localNoteId];
  if (!note) return;
  useStore.getState().updateNote(localNoteId, {
    localStatus: status,
    isStreaming: false,
    activeTurnId: undefined,
    activeTurnText: undefined,
  });
}

/**
 * Sweep notes left mid-stream by a reload, and record the partial turn.
 *
 * Returns the local ids that were swept. The local part of the sweep always
 * happens; mirroring the partial answer is offered to the adapter, which
 * no-ops when there is none — so a crash mid-run is still recorded locally in
 * a build with no account.
 */
export function markStaleStreamsInterrupted(articleId: string): string[] {
  const swept: string[] = [];
  for (const note of Object.values(useStore.getState().notes)) {
    if (note.articleId !== articleId) continue;
    if (!note.isStreaming) continue;
    const turnId = note.activeTurnId;
    const partial = note.activeTurnText ?? "";
    useStore.getState().updateNote(note.id, {
      isStreaming: false,
      localStatus: "interrupted",
      activeTurnId: undefined,
      activeTurnText: undefined,
    });
    swept.push(note.id);
    if (turnId) {
      if (partial.trim().length > 0) {
        useStore.getState().appendTurn(note.id, {
          role: "assistant",
          content: partial,
          status: "interrupted",
          turnId,
        });
      }
      // Routed through `callAdapter`: a transport that throws before
      // returning must not abort the sweep half way through, leaving the
      // remaining notes looking like they are still streaming.
      void callAdapter(
        (adapter) => adapter.persistAnswer(note.id, partial, "interrupted", turnId),
        undefined,
      );
    }
  }
  return swept;
}
