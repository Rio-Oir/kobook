// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Getting the bodies out of the `gloss-storage` blob, without losing any.
 *
 * ## The shape of the problem
 *
 * Before this module, `gloss-storage` was one JSON document holding every
 * article *with its paragraphs*, plus — for anything that had been through the
 * extractor — a second copy of the same text (`syncDocument`). Every keystroke
 * in a note re-serialised the lot, and the whole library had to fit in 10 MiB.
 *
 * Moving the text to IndexedDB is a data migration, and a data migration has
 * exactly one unforgivable failure: losing the data. What makes that hard here
 * is that one side of the move is synchronous (`localStorage`, and zustand's
 * hydration) and the other is not (IndexedDB).
 *
 * ## The order that makes a crash safe
 *
 *   1. Read the raw blob.
 *   2. Write every body to IndexedDB and **await** it.
 *   3. Only then rewrite the blob without the bodies.
 *
 * Each step is idempotent and the arrow only points one way. A crash between 2
 * and 3 leaves the blob intact, so the next launch redoes 2 (writing identical
 * values) and then 3. A crash during 2 leaves some bodies written, which is
 * harmless: rewriting a body with the same content is a no-op in effect. There
 * is never a moment at which a body exists in neither place, and there is never
 * a moment at which the device holds two full copies in `localStorage` — which
 * matters, because the users closest to the ceiling are the ones this is for,
 * and a staging copy would push them over it.
 *
 * ## Why the store must not hydrate first
 *
 * Step 3 has to happen before zustand reads the blob, or the store would load
 * articles that still carry `paragraphs` into a type that no longer has the
 * field. `useStore` therefore sets `skipHydration`, and `bootstrapStorage()`
 * runs this migration and then calls `rehydrate()` explicitly.
 *
 * ## The defensive path
 *
 * `merge` still strips a body it finds, and stashes it for a flush. That path
 * normally never runs. It exists because the cost of being wrong is the user's
 * library: a blob written by an older build, a half-finished migration, or a
 * test that seeded `localStorage` directly must not put a body into the store
 * and drop it.
 */

import type { Article, ArticleDraft, Paragraph } from "../types";
import { sha256Hex } from "../local-import-blocks";
import { kvBackend } from "./backend.js";
import { writeBody, makeBody, removeBodies } from "./bodies.js";
import { clearBodyDeletes, pendingBodyDeletes } from "./journal.js";

/** The key zustand's `persist` writes the workspace to. */
export const WORKSPACE_KEY = "gloss-storage";

/** The version this build writes. */
export const STORAGE_VERSION = 3;

/** An article as an older build stored it: body inlined, plus its source copy. */
type StoredArticle = Record<string, unknown> & {
  paragraphs?: Paragraph[];
  syncDocument?: { blocks?: Array<{ hash?: string }> };
};

/**
 * Bring one stored paragraph's `hash` up to the current format.
 *
 * Older builds stored `block.hash.slice(0, 12)`. That prefix cannot be used to
 * rebuild a `ContentBlock` for the sync upload — the route re-derives the hash
 * from the text and rejects a mismatch — so an article migrated with a
 * truncated hash would become permanently un-uploadable. The full value is
 * recoverable, because it is a digest of the text that is right there.
 *
 * Recovery is *conditional on verification*: the recomputed digest must start
 * with what was stored. If it does not, the stored hash did not come from this
 * hashing of this text (an import from the legacy app, a hand-edited backup),
 * and guessing would replace a value with a different one. Leaving it alone is
 * the conservative branch: nothing reads `hash` for anchoring, so the worst
 * case is one article that still cannot be uploaded.
 */
function upgradeParagraphHash(paragraph: Paragraph): Paragraph {
  if (typeof paragraph.hash !== "string" || paragraph.hash.length >= 64) return paragraph;
  const full = sha256Hex(paragraph.text);
  if (!full.startsWith(paragraph.hash)) return paragraph;
  return { ...paragraph, hash: full };
}

/**
 * The record a stored article becomes, plus the body that has to be saved.
 *
 * `paragraphs` and `syncDocument` both leave the record: the first becomes the
 * body, and the second is a duplicate of it. `blocksDigest` is derived from
 * `syncDocument.blocks` while they are still here, which is the only moment it
 * can be derived without re-parsing.
 */
export function splitStoredArticle(raw: unknown): {
  record: ArticleDraft;
  paragraphs: Paragraph[] | undefined;
} {
  const stored = (raw ?? {}) as StoredArticle;
  const paragraphs = Array.isArray(stored.paragraphs)
    ? stored.paragraphs.map(upgradeParagraphHash)
    : undefined;

  const { paragraphs: _bodies, syncDocument, ...rest } = stored;
  const record = rest as unknown as ArticleDraft & { bodyStats?: unknown };

  // The digest is only derivable while `syncDocument` is in hand. It is absent
  // for articles that never went through the extractor, which is fine: the
  // absence means "cannot prove the blocks are equal", and `localArticleKeyFor`
  // takes the safe branch for that.
  const digest =
    record.blocksDigest ??
    (syncDocument && Array.isArray(syncDocument.blocks)
      ? sha256Hex(JSON.stringify(syncDocument.blocks))
      : undefined);
  if (digest) record.blocksDigest = digest;

  if (!record.bodyStats) {
    record.bodyStats = {
      paragraphs: paragraphs?.length ?? 0,
      chars: paragraphs?.reduce((total, p) => total + p.text.length, 0) ?? 0,
    };
  }

  return { record: record as ArticleDraft, paragraphs };
}

/**
 * Bodies found while stripping, waiting to be written.
 *
 * Module state, not store state: it is a migration artefact that exists for the
 * duration of one boot and must not be persisted (persisting it would write the
 * bodies straight back into `localStorage`, which is the thing being moved).
 */
const staged = new Map<string, Paragraph[]>();

/** Strip bodies out of a persisted article map, staging them for a flush. */
export function stripStoredBodies(
  articles: Record<string, unknown> | undefined,
): Record<string, Article> {
  const out: Record<string, Article> = {};
  for (const [id, raw] of Object.entries(articles ?? {})) {
    const { record, paragraphs } = splitStoredArticle(raw);
    if (paragraphs && paragraphs.length > 0) staged.set(id, paragraphs);
    out[id] = record as Article;
  }
  return out;
}

/**
 * Write the bodies that `stripStoredBodies` found, then forget them.
 *
 * Called right after hydration. A failure is not fatal and not silent: the
 * article keeps its record and loses its text, which the reader reports as
 * unavailable rather than pretending the article is intact. The ids stay in
 * this map only until they are written, so a second call is a no-op.
 */
export async function flushStagedBodies(): Promise<number> {
  if (staged.size === 0) return 0;
  let written = 0;
  for (const [articleId, paragraphs] of staged) {
    await writeBody(makeBody(articleId, paragraphs));
    staged.delete(articleId);
    written += 1;
  }
  return written;
}

/** Whether anything is waiting to be flushed. Tests and diagnostics. */
export function stagedBodyCount(): number {
  return staged.size;
}

/**
 * Move every body in the persisted blob into IndexedDB.
 *
 * Returns how many bodies were moved. Idempotent: an article whose body is
 * already out of the blob is skipped, so a run interrupted halfway resumes
 * where it stopped.
 */
export async function migrateBodiesToIdb(): Promise<number> {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (!raw) return 0;

  let parsed: { state?: Record<string, unknown>; version?: number };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // A corrupt blob is left untouched. Rewriting it from a parse we could not
    // perform would destroy whatever is actually in there.
    return 0;
  }
  const state = parsed.state;
  if (!state || typeof state !== "object") return 0;
  const articles = state["articles"];
  if (!articles || typeof articles !== "object") return 0;

  const entries = Object.entries(articles as Record<string, unknown>);
  const carrying = entries.filter(([, value]) => {
    const article = (value ?? {}) as StoredArticle;
    return Array.isArray(article.paragraphs) || article.syncDocument !== undefined;
  });
  if (carrying.length === 0) return 0;

  // Step 2: everything durable before the blob shrinks.
  let moved = 0;
  const nextArticles: Record<string, Article> = {};
  for (const [id, value] of entries) {
    const { record, paragraphs } = splitStoredArticle(value);
    nextArticles[id] = record as Article;
    if (paragraphs && paragraphs.length > 0) {
      await writeBody(makeBody(id, paragraphs));
      moved += 1;
    }
  }

  // Step 3: rewrite the blob without them.
  localStorage.setItem(
    WORKSPACE_KEY,
    JSON.stringify({
      ...parsed,
      version: STORAGE_VERSION,
      state: { ...state, articles: nextArticles },
    }),
  );
  return moved;
}

/**
 * Finish body deletions a previous run started but did not complete.
 *
 * The journal is written synchronously by the wipe paths and cleared only after
 * the deletion succeeds, so anything still in it means a tab closed mid-wipe.
 * Running this at startup is what makes "signing out leaves no article text on
 * the device" true across a crash rather than only in the happy path.
 */
export async function resumePendingBodyDeletes(): Promise<number> {
  const pending = pendingBodyDeletes();
  if (pending.length === 0) return 0;
  await removeBodies(pending);
  clearBodyDeletes(pending);
  return pending.length;
}

/**
 * Ask the browser not to evict this origin's storage.
 *
 * Best-effort, and deliberately not awaited by callers that do not care.
 * Without it, storage is "best-effort": under pressure the browser may delete
 * *all* of an origin's data at once, and no application-side budget or eviction
 * policy has any say in it. The answer is advisory in both directions — Chrome
 * grants it silently based on engagement, Firefox prompts — so a `false` is not
 * a failure to report, just a weaker guarantee.
 *
 * `navigator.storage.persist` is absent in older Safari and in Node.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** What `bootstrapStorage` managed to do, for the boot log and for tests. */
export interface StorageBootstrapReport {
  movedBodies: number;
  resumedDeletes: number;
  flushedBodies: number;
  persisted: boolean;
  backend: "indexeddb" | "local-storage";
}

/**
 * Everything that has to happen before the first render reads the store.
 *
 * Order matters and is the whole reason this is one function rather than four
 * calls in `main.tsx`:
 *
 *   1. migrate the blob (bodies to IndexedDB, blob shrinks);
 *   2. finish any deletion a previous run left half-done — *before* the store
 *      hydrates, so a resumed wipe cannot race a freshly loaded record;
 *   3. hydrate;
 *   4. flush anything the defensive `merge` path staged (normally nothing).
 *
 * Step 1 must precede step 3 (see the module note). Step 2 must precede step 3
 * for the weaker reason that a hydrated article whose body is about to be
 * deleted should never be rendered as ready.
 */
export async function bootstrapStorage(
  hydrate: () => Promise<void>,
): Promise<StorageBootstrapReport> {
  const movedBodies = await migrateBodiesToIdb().catch(() => 0);
  const resumedDeletes = await resumePendingBodyDeletes().catch(() => 0);
  await hydrate();
  const flushedBodies = await flushStagedBodies().catch(() => 0);
  const persisted = await requestPersistentStorage();
  const backend = await kvBackend();
  return {
    movedBodies,
    resumedDeletes,
    flushedBodies,
    persisted,
    backend: backend.kind,
  };
}
