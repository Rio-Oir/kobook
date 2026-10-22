// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Persisted article bodies.
 *
 * The one thing stored outside `localStorage`'s single blob, and therefore the
 * only thing whose durability has to be reasoned about explicitly. Three
 * properties the callers depend on:
 *
 *  1. **A body is either fully here or absent.** A half-written body would be
 *     handed to the reader as an article with missing paragraphs, and every
 *     note anchored past the truncation would point at nothing. So a read that
 *     does not validate is treated as absent, and a write that throws leaves
 *     the previous value in place (the backends write a record in one
 *     operation).
 *  2. **Deleting is idempotent.** The wipe path retries after a crash, so
 *     "already gone" is success, not an error.
 *  3. **Reading never throws for "not there".** The absent case is a normal
 *     state — it is the whole point of separating bodies — and callers
 *     distinguish "absent" from "the storage layer is broken" by getting
 *     `undefined` versus a rejection.
 */

import type { ArticleBody, Paragraph } from "../types";
import { kvBackend, type StoreName } from "./backend.js";
import { recordBodyDeletes, clearBodyDeletes } from "./journal.js";

const STORE = "bodies" as const;

/**
 * Where an anonymous workspace's text waits while an account owns the live
 * space. A separate object store, for the reasons in `backend.ts`.
 */
const ARCHIVE = "bodies-archive" as const;

/**
 * Body mutations, run one at a time in call order.
 *
 * ## Why a queue rather than bare promises
 *
 * `clearUserCache()` has to be synchronous, so its deletion is fire-and-forget.
 * Everything else that writes a body is awaited. That combination has a race
 * with real consequences and no natural ordering:
 *
 *   1. the user signs out → the journal is written and a deletion starts;
 *   2. the user restores a backup → the bodies are written;
 *   3. the deletion — which enumerated the store *before* step 2 — finishes and
 *      removes the bodies step 2 just wrote.
 *
 * The result is a restored library whose text is gone, and the only sign of it
 * is an article that reports its body as missing. Serialising the mutations
 * makes the order the order they were called in, which is the order the user
 * performed them, and the deletion can no longer overtake a write that came
 * after it.
 *
 * Reads are deliberately not serialised: a read is either about to be
 * overwritten or not, and making `ensureBody` wait behind a pending wipe would
 * only delay the article the reader is on.
 */
let mutations: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  // Both branches continue the chain: a failed mutation must not stall every
  // later one, which is what a bare `queue = queue.then(op)` would do.
  const next = mutations.then(operation, operation);
  mutations = next.catch(() => undefined);
  return next;
}

/**
 * Bytes one body costs.
 *
 * Measured on the JSON encoding rather than on the text alone, because the
 * JSON encoding is what `localStorage` actually holds when the fallback
 * backend is in use and a good enough proxy for what IndexedDB holds
 * otherwise. Counting `text.length` would under-count a body with heavy inline
 * emphasis by the size of its span array, which is exactly the body most likely
 * to be large.
 */
export function measureBody(paragraphs: readonly Paragraph[]): number {
  return new TextEncoder().encode(JSON.stringify(paragraphs)).length;
}

/** Build the stored value, so `size` can never disagree with `paragraphs`. */
export function makeBody(articleId: string, paragraphs: Paragraph[]): ArticleBody {
  return {
    articleId,
    paragraphs,
    size: measureBody(paragraphs),
    storedAt: Date.now(),
  };
}

/**
 * Structural check on a value read back from storage.
 *
 * Storage is not a trusted source: it survives version upgrades, hand-editing
 * and (with the `localStorage` backend) a partially written string. The check
 * is about shape, not about content — whether the offsets inside a paragraph's
 * spans are sane is the renderer's business, and re-deriving it here would
 * duplicate a rule that already has one home.
 */
function isArticleBody(value: unknown): value is ArticleBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<ArticleBody>;
  if (typeof body.articleId !== "string" || body.articleId.length === 0) return false;
  if (!Array.isArray(body.paragraphs)) return false;
  if (typeof body.size !== "number" || typeof body.storedAt !== "number") return false;
  return body.paragraphs.every((p) => {
    if (typeof p !== "object" || p === null) return false;
    const paragraph = p as Partial<Paragraph>;
    return (
      typeof paragraph.index === "number" &&
      typeof paragraph.text === "string" &&
      typeof paragraph.hash === "string"
    );
  });
}

/** The body for one article, or `undefined` when it is not on this device. */
export async function readBody(articleId: string): Promise<ArticleBody | undefined> {
  const backend = await kvBackend();
  const stored = await backend.get(STORE, articleId);
  // A record whose shape does not validate is reported as absent rather than
  // repaired: there is no way to know whether a missing paragraph was dropped
  // by a bug or by the user, and guessing would put a note's offsets on the
  // wrong text. The next successful write replaces it.
  if (!isArticleBody(stored)) return undefined;
  if (stored.articleId !== articleId) return undefined;
  return stored;
}

/** Write one body. Rejects if storage refused it — the caller must hear that. */
export function writeBody(body: ArticleBody): Promise<void> {
  return serialize(async () => {
    const backend = await kvBackend();
    await backend.put(STORE, body.articleId, body);
  });
}

/** Remove one body. Absent is success. */
export function removeBody(articleId: string): Promise<void> {
  return serialize(async () => {
    const backend = await kvBackend();
    await backend.delete(STORE, articleId);
  });
}

/**
 * Remove several bodies.
 *
 * Sequential rather than parallel on purpose. The callers are the wipe paths,
 * which run once per account change rather than per interaction, and a
 * `localStorage` backend would serialise them anyway; issuing a hundred
 * concurrent transactions buys nothing and makes a partial failure harder to
 * describe.
 */
export async function removeBodies(articleIds: readonly string[]): Promise<void> {
  for (const id of articleIds) await removeBody(id);
}

/**
 * Forget every body this account left behind.
 *
 * `articleIds` is what the caller knew about synchronously; the store is swept
 * as well, because a body whose record is already gone — an interrupted wipe, a
 * record removed by a path from before bodies were separate — is exactly the
 * text that must not survive a sign-out.
 *
 * The journal entry is written *here* as well as by the caller. The caller's
 * synchronous write covers the ids it knew about before the tab could close;
 * this one covers the orphans, which are only discoverable by enumeration and
 * therefore only after an `await`.
 */
export function purgeBodies(articleIds: readonly string[]): Promise<void> {
  return serialize(async () => {
    const backend = await kvBackend();
    const all = new Set(articleIds);
    for (const key of await backend.keys(STORE)) all.add(key);
    const list = [...all];
    if (list.length === 0) return;
    recordBodyDeletes(list);
    for (const id of list) await backend.delete(STORE, id);
    clearBodyDeletes(list);
  });
}

/** Every article id that has a body on this device. */
export async function listBodyIds(): Promise<string[]> {
  const backend = await kvBackend();
  return backend.keys(STORE);
}

/** Drop every body. Used by tests and by a full reset. */
export function clearBodies(): Promise<void> {
  return serialize(async () => {
    const backend = await kvBackend();
    await backend.clear(STORE);
  });
}

// ── The anonymous archive ─────────────────────────────────────────────────
//
// Setting an anonymous workspace aside is two things, not one: the *records*
// go into the `gloss-anon-space` localStorage blob, and the *text* has to go
// somewhere the wipe paths do not reach. Until this existed, signing in moved
// the shelf and left the books behind — the restored library listed every
// article and opened each one empty, because `clearUserCache` had purged the
// bodies and the snapshot had never held them.
//
// These three operations are whole-value moves for a named set of ids, never a
// sweep. That is deliberate: a sweep of `bodies` would take the account's own
// text along with the anonymous text, and the ids are the only thing that
// distinguishes the two.

/**
 * Copy these bodies into the archive, returning how many were copied.
 *
 * Deliberately **not** routed through `serialize`. The queue orders mutations
 * against each other, and what this needs is the opposite: to read the live
 * store *now*, before any purge that is already queued for the account switch
 * runs. Joining the queue would put the copy behind exactly the deletion it
 * exists to survive. The caller owns the ordering instead — archive first,
 * `clearUserCache` after, never the other way round.
 *
 * A body that is not live is skipped rather than fatal: an article whose text
 * was already evicted has nothing to archive, and failing the whole archive
 * over it would block the sign-in for a book the user cannot read offline
 * anyway.
 */
export async function archiveBodies(articleIds: readonly string[]): Promise<number> {
  const backend = await kvBackend();
  let copied = 0;
  for (const id of articleIds) {
    const stored = await backend.get(STORE, id);
    if (!isArticleBody(stored) || stored.articleId !== id) continue;
    await backend.put(ARCHIVE, id, stored);
    copied += 1;
  }
  return copied;
}

/** Read these ids out of one store, skipping anything that does not validate. */
async function readFrom(store: StoreName, articleIds: readonly string[]): Promise<ArticleBody[]> {
  const backend = await kvBackend();
  const out: ArticleBody[] = [];
  for (const id of articleIds) {
    const stored = await backend.get(store, id);
    if (isArticleBody(stored) && stored.articleId === id) out.push(stored);
  }
  return out;
}

/** The live bodies for these ids. Missing ones are simply not returned. */
export function readLiveBodies(articleIds: readonly string[]): Promise<ArticleBody[]> {
  return readFrom(STORE, articleIds);
}

/** The archived bodies for these ids. Missing ones are simply not returned. */
export function readArchivedBodies(articleIds: readonly string[]): Promise<ArticleBody[]> {
  return readFrom(ARCHIVE, articleIds);
}

/** Put archived bodies back as live ones. Goes through the write queue. */
export async function restoreBodies(bodies: readonly ArticleBody[]): Promise<void> {
  for (const body of bodies) await writeBody(body);
}

/** Drop archived bodies. Absent is success, like every other delete here. */
export async function dropArchivedBodies(articleIds: readonly string[]): Promise<void> {
  const backend = await kvBackend();
  for (const id of articleIds) await backend.delete(ARCHIVE, id);
}

/** Every article id with text in the archive. Diagnostics and tests. */
export async function listArchivedBodyIds(): Promise<string[]> {
  const backend = await kvBackend();
  return backend.keys(ARCHIVE);
}

/**
 * Drop every archived body.
 *
 * Deliberately *not* folded into `clearBodies`. The two mean different things:
 * `clearBodies` is "this device has no article text", which is what the wipe
 * paths want, while the archive is the reader's anonymous library held aside
 * for them — clearing it is throwing that library away. Only a full reset and
 * a test fixture should call this.
 */
export function clearArchivedBodies(): Promise<void> {
  return serialize(async () => {
    const backend = await kvBackend();
    await backend.clear(ARCHIVE);
  });
}
