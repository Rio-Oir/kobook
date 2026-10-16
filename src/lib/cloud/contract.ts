// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The optional cloud contract — the seam between the local reader and any
 * implementation that adds accounts, sync or a hosted model.
 *
 * ## Why this exists
 *
 * The product used to be one tree with a build-time switch, so the same
 * `src/**` compiled twice — once with accounts and cloud sync and once
 * without. That made "this build makes no cloud request" true at runtime but
 * left the account and cloud code *in the local source and in the dependency
 * lock*, so the reader could not be installed, audited or shipped without
 * dragging in an auth vendor and a database driver it never used.
 *
 * The switch is gone, and so are those dependencies. This side owns:
 *
 *   - reading, local import, anonymous URL extraction, BYOK, notes,
 *     highlights, backup/restore and the offline shell;
 *   - the local data format, including the `ownerUserId` stamp and the
 *     session epoch that make account-scoped caches reconcilable;
 *   - **this contract**, and the fact that nothing implements it by default.
 *
 * An implementation is a separate module that calls `registerCloudAdapter`
 * once at startup; nothing here imports it, and no implementation is shipped
 * with the reader.
 *
 * ## The rules an implementation must keep
 *
 * 1. **Absence is the default and is not an error.** With no adapter
 *    registered every operation below is a no-op and the local flow —
 *    save locally, read, annotate, back up — completes unchanged. No code
 *    here may branch on whether an adapter exists in order to *read*.
 * 2. **Nothing here may block a local write.** Local stores are written
 *    first and the adapter is called afterwards. An adapter that is slow, down,
 *    throwing *synchronously*, or rejecting must not stop a save, a note, or a
 *    navigation; a failure is a cloud failure the user is told about, never a
 *    local failure. This side enforces that itself, in `callAdapter` /
 *    `callAdapterHook` below — an implementation does not have to be careful
 *    about it, and must not rely on the caller being sloppy about it either.
 * 3. **Identity is passed in, never inferred.** The caller hands over the
 *    frozen `{ ownerUserId, epoch }` it captured at the start of the
 *    operation. An implementation must re-check it before applying a result,
 *    so a response that lands after a sign-out cannot be attributed to the
 *    next account.
 * 4. **The adapter never re-implements a local data structure.** It reports a
 *    verdict and this side decides what the local record keeps, so there is
 *    one implementation of "what a note is". Where a merge genuinely needs
 *    remote-only knowledge — turning a server note row into a local note, and
 *    the version-aware reconciliation policy — the adapter does it *through
 *    the store's existing actions* (`upsertRemoteNote`, `deleteNote`,
 *    `updateNote`), never by declaring its own note or article type.
 * 5. **No credential, and no user content the user did not ask to sync, may
 *    leave through this seam.** In particular a BYOK key is never part of any
 *    request built here: it belongs to the browser session, is sent only to
 *    the endpoint the user confirmed, and is excluded from every payload,
 *    export and log this application writes.
 */

import type { Article, ParsedDocument, UserRole } from "../types";
import type { ExtractSource } from "../browser-extract-errors";

/**
 * The identity the adapter resolved for the current session.
 *
 * Deliberately smaller than the account service's own user shape: base needs
 * an id (to stamp caches) and enough to render a header. Anything else is the
 * adapter's business and must not leak into base types.
 */
export interface CloudSessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  role?: UserRole;
}

/**
 * The frozen identity of one base-side operation.
 *
 * Captured before the first `await` and re-checked after the last one. The
 * epoch advances on *every* ownership resolution, including a no-op one, so
 * it is the reliable signal for "the session changed under this request";
 * comparing owner ids alone misses a sign-out followed by a sign-in as the
 * same account.
 */
export interface CloudOwnerIdentity {
  ownerUserId: string;
  epoch: number;
}

/**
 * The outcome of one upload attempt.
 *
 * `rejected` and `network-error` are the two the user is shown; neither
 * removes the local article. `stale-owner` is a verdict base applies without
 * touching the store at all.
 */
export type CloudUploadVerdict =
  | { status: "uploaded"; articleId: string; versionId: string }
  | { status: "duplicate"; articleId: string; versionId: string }
  | {
      status: "rejected" | "network-error" | "cancelled" | "stale-owner";
      message?: string;
    };

/** Terminal state of one generation run, as the server records it. */
export type CloudPersistStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

/**
 * Where a note sits in the document.
 *
 * Kept in base because base *creates* the anchor: the offsets and block ids
 * come from the reader's own selection mapping, and the anchor is part of the
 * local note record whether or not anything is ever uploaded.
 */
export interface CloudNoteAnchor {
  paragraphIndex: number;
  type: "explain" | "ask";
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

export interface CloudArticleUpload {
  article: Article;
  document: ParsedDocument;
  source: ExtractSource;
  identity: CloudOwnerIdentity;
}

export interface CloudNoteDelete {
  localNoteId: string;
  remoteId: string;
}

/**
 * The server binding for a note base has just created locally.
 *
 * Both halves are required: the id is what a later answer or delete is pushed
 * against, and the version id is what keeps the note anchored to the document
 * the user was reading. Returning the id alone would force base to guess the
 * version, which is exactly the guess that mis-anchors a note across a
 * re-import.
 */
export interface CloudNoteCreated {
  remoteId: string;
  remoteVersionId: string;
}

/**
 * Everything base may ask a cloud implementation to do.
 *
 * The surface is intentionally operation-shaped rather than resource-shaped:
 * each method mirrors one thing the reader already does locally, so an
 * implementation is a transport, not a second copy of the product's note
 * semantics.
 */
export interface CloudAdapter {
  /** Stable identifier, for logs and for the boot assertion in tests. */
  readonly id: string;

  /**
   * Resolve the current session, or `null` for anonymous.
   *
   * Must not throw: a network failure is `null` (anonymous), not an error.
   * Base calls this on load and on an explicit refresh.
   */
  probeSession(signal?: AbortSignal): Promise<CloudSessionUser | null>;

  /** End the session. Must not throw. */
  signOut(): Promise<void>;

  /**
   * Called after base has reconciled its local caches for a new owner.
   *
   * This is where an implementation offers a migration of anonymous content,
   * switches its own bookkeeping, or drops cached server state. Base has
   * already stamped `ownerUserId` and cleared a foreign cache by the time
   * this runs, so an implementation that does nothing here still leaves a
   * consistent local store.
   */
  onOwnerResolved?(ownerUserId: string | null): void;

  /**
   * Upload one locally-parsed article.
   *
   * Resolves with a verdict; a rejection is treated as `network-error` by
   * base. Must never be awaited by a caller that is on the user's critical
   * path — see rule 2.
   */
  uploadArticle(input: CloudArticleUpload): Promise<CloudUploadVerdict>;

  /**
   * Create the server row for a note and report its binding, or `null` when
   * the note must stay local (no server article yet, unusable anchor,
   * refusal). Base writes the returned binding onto the local note.
   */
  persistNote(
    noteId: string,
    articleId: string,
    anchor: CloudNoteAnchor,
  ): Promise<CloudNoteCreated | null>;

  /** Mirror one assistant turn (an answer), including empty terminal runs. */
  persistAnswer(
    noteId: string,
    answer: string,
    status: CloudPersistStatus,
    turnId?: string,
  ): Promise<void>;

  /** Mirror one user turn (a follow-up question). */
  persistFollowUpQuestion(noteId: string, question: string, turnId?: string): Promise<void>;

  /** Delete the server row behind a note base has already removed locally. */
  deleteNote(entry: CloudNoteDelete): Promise<void>;

  /**
   * Reconcile this article's notes with the server and return how many remote
   * rows the server reported. Must be version-aware: a note anchored to a
   * version other than the one on screen is never deleted on the strength of
   * a response about a different version.
   */
  syncNotesFromServer(articleId: string): Promise<number>;
}

let adapter: CloudAdapter | null = null;

/**
 * Install the implementation.
 *
 * Called by the host entry point, once, before the app renders. Passing
 * `null` uninstalls it, which is what the tests use to assert the
 * no-adapter behaviour without a module reset.
 */
export function registerCloudAdapter(next: CloudAdapter | null): void {
  adapter = next;
}

/** The installed adapter, or `null`. Never throws, never creates one. */
export function cloudAdapter(): CloudAdapter | null {
  return adapter;
}

/**
 * Whether a cloud implementation is installed at all.
 *
 * Exported for tests and for the build assertion in
 * `apps/reader-release/build.mjs`. Base UI must **not** branch on it to hide
 * or show a local feature — see rule 1.
 */
export function hasCloudAdapter(): boolean {
  return adapter !== null;
}

/**
 * Invoke one optional adapter method so that **neither** a synchronous throw
 * nor a rejected promise can escape into base's own call stack.
 *
 * ## Why `.catch()` alone is not enough
 *
 * `adapter.method(...).catch(...)` attaches its handler to the *result* of the
 * call, so it only ever sees a rejected promise. A method that throws before
 * returning — an eagerly validating transport, a missing global, a constructor
 * that rejects its arguments, a plain JavaScript implementation, or a `throw`
 * on the first line of a `async`-less function — raises the exception *at the
 * call site*, before `.catch` exists. It then propagates out of the base
 * function that called it: out of `saveAndOpen`, out of the session bootstrap,
 * out of the note sweep. That turns "the cloud is broken" into "the save
 * failed", which is exactly what rule 2 forbids.
 *
 * TypeScript does not prevent this. A function whose body only throws has
 * return type `never`, which is assignable to `Promise<T>`, so an
 * implementation that satisfies the interface can still throw synchronously.
 *
 * Every optional call goes through here, so the guarantee is a property of one
 * function rather than a promise each call site has to keep.
 *
 * @param invoke   called only when an adapter is installed
 * @param fallback returned when there is no adapter, the call throws, or the
 *                 promise rejects — the value base would have used anyway
 */
export function callAdapter<T>(
  invoke: (adapter: CloudAdapter) => Promise<T> | T,
  fallback: T,
): Promise<T> {
  const current = adapter;
  if (!current) return Promise.resolve(fallback);
  try {
    return Promise.resolve(invoke(current)).catch(() => fallback);
  } catch {
    return Promise.resolve(fallback);
  }
}

/**
 * Invoke an optional *synchronous* hook — `onOwnerResolved` — which base does
 * not await.
 *
 * Same guarantee as `callAdapter` for a callback whose return value nobody
 * reads: a throw must not interrupt the local work around it. In the ownership
 * paths that work is the whole point of the function — stamping the owner,
 * clearing a foreign cache, advancing the epoch — and on the session paths a
 * throw here would also stop the status from ever being published, stranding
 * the app on its `loading` state.
 */
export function callAdapterHook(invoke: (adapter: CloudAdapter) => void): void {
  const current = adapter;
  if (!current) return;
  try {
    invoke(current);
  } catch {
    // An optional notification is the adapter's own business. Base has already
    // finished the local work it was being told about, and has nothing it
    // could usefully do with the failure.
  }
}
