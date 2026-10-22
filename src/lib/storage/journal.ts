// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A synchronous record of bodies that still have to be deleted.
 *
 * ## The problem it solves
 *
 * `clearUserCache()` is synchronous and has to stay that way. It is called from
 * `applyOwnership`, which runs on every session resolution and is itself
 * synchronous, and the order around it is load-bearing: `bumpSessionEpoch()`
 * must advance *before* the cache is cleared, or an in-flight upload from the
 * previous session can land in the new one. Making the clear asynchronous would
 * push `await` through `applyOwnership`, `session.ts` and every caller.
 *
 * But the bodies are in IndexedDB, and IndexedDB has no synchronous delete. So
 * there is a window between "the records are gone from memory and
 * `localStorage`" and "the bodies are gone from disk". Closing the tab inside
 * that window would leave one account's article text on the device after the
 * user signed out — the exact thing the clear exists to prevent.
 *
 * The journal closes it the only way a synchronous caller can: it records the
 * intent in `localStorage` *synchronously*, so the intent survives a crash, and
 * a later run finishes the job. It is the same shape as a write-ahead log, for
 * the same reason.
 *
 * ## Why the journal lives in `localStorage` and not in IndexedDB
 *
 * Because it has to be writable synchronously, which is the entire point.
 * `localStorage` is the one storage primitive here that is synchronous, and the
 * payload is a handful of ids — a few hundred bytes against a 10 MiB ceiling.
 * This is the case the primitive is right for: a small, synchronous, durable
 * note to self. It is not where article text goes.
 *
 * ## Failure behaviour
 *
 * If `localStorage` itself is unavailable (a blocked profile, the Node test
 * environment without a polyfill), the journal degrades to a no-op and the
 * deletion is still attempted — it is just no longer crash-safe. Refusing to
 * sign out because a journal write failed would be worse than a narrow,
 * documented window.
 */

const JOURNAL_KEY = "gloss-storage-journal";

interface Journal {
  version: 1;
  /** Article ids whose bodies are pending physical deletion. */
  pendingBodyDeletes: string[];
}

function read(): Journal {
  const empty: Journal = { version: 1, pendingBodyDeletes: [] };
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Journal>;
    if (!Array.isArray(parsed.pendingBodyDeletes)) return empty;
    // Deduplicated on read: the writers below union rather than append, but a
    // hand-edited or half-written file should not cost more than it has to.
    return {
      version: 1,
      pendingBodyDeletes: [...new Set(parsed.pendingBodyDeletes.filter((id) => typeof id === "string"))],
    };
  } catch {
    // A corrupt journal is discarded rather than repaired. Its only content is
    // a list of ids; the cost of losing it is a body that has to be cleaned up
    // by a full wipe later, and the cost of trusting it is deleting an id that
    // happens to be in the garbage.
    return empty;
  }
}

function write(journal: Journal): void {
  try {
    if (journal.pendingBodyDeletes.length === 0) {
      localStorage.removeItem(JOURNAL_KEY);
      return;
    }
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  } catch {
    // Out of quota, or storage blocked. See the module note: the deletion is
    // still attempted, it just stops being crash-safe.
  }
}

/**
 * Record that these bodies are about to be deleted.
 *
 * Synchronous by contract — call it in the same tick as the in-memory clear,
 * *before* the asynchronous deletion is started.
 */
export function recordBodyDeletes(articleIds: readonly string[]): void {
  if (articleIds.length === 0) return;
  const journal = read();
  const merged = new Set(journal.pendingBodyDeletes);
  for (const id of articleIds) merged.add(id);
  write({ version: 1, pendingBodyDeletes: [...merged] });
}

/**
 * Forget these ids, after their deletion succeeded.
 *
 * Re-reads first rather than writing the list this caller knew about: a second
 * clear may have added ids while this one was awaiting storage, and overwriting
 * with the older list would drop them from the journal while their bodies were
 * never deleted.
 */
export function clearBodyDeletes(articleIds: readonly string[]): void {
  if (articleIds.length === 0) return;
  const journal = read();
  const done = new Set(articleIds);
  const remaining = journal.pendingBodyDeletes.filter((id) => !done.has(id));
  if (remaining.length === journal.pendingBodyDeletes.length) return;
  write({ version: 1, pendingBodyDeletes: remaining });
}

/** Every id still waiting to be deleted. */
export function pendingBodyDeletes(): string[] {
  return read().pendingBodyDeletes;
}

/** Whether there is anything to resume. Cheap enough to call at startup. */
export function hasPendingBodyDeletes(): boolean {
  return read().pendingBodyDeletes.length > 0;
}
