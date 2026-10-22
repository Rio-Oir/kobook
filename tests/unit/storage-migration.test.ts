// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Storage migration gate.
 *
 * The phase-1 store had no `ownerUserId` and no `version` key. Phase 2
 * introduces owner stamps on both `gloss-storage` (articles + notes) and
 * `gloss-settings` (API key), so the persist middleware's `migrate` runs
 * when the version field is present and mismatches. The migration must:
 *
 *   1. preserve every existing article, note, provider, model and baseURL
 *      that a phase-1 user accumulated — those were typed in by hand and
 *      losing them on the first reload after phase 2 ships is unacceptable;
 *   2. stamp the owner as `anonymous` so the reconciliation rule on the
 *      first sign-up of a v1 user takes the `adopt` path instead of `clear`
 *      (which would destroy the just-migrated data again);
 *   3. be a no-op for already-v2 payloads — re-running it must not corrupt
 *      a stamped owner.
 *
 * Two seed shapes are covered:
 *   - "v0" (no version key): the persist middleware does not call migrate
 *     at all, but its default `merge` keeps the initial state's
 *     `ownerUserId: "anonymous"` and overlays the persisted articles.
 *     This is what a real phase-1 install looked like.
 *   - "v1" (version: 1): migrate is called with version=1, explicitly
 *     stamps the owner, and the blob is rewritten to version 2.
 *
 * Zustand v5's `createJSONStorage(() => window.localStorage)` swallows a
 * missing `window` and silently disables persist (see
 * `node_modules/zustand/esm/middleware.mjs:282`). Stub both `window` and
 * `localStorage` so the same `createJSONStorage` factory succeeds in Node.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { installMemoryLocalStorage, resetBodyStorage } from "./storage-fixture.js";

const memory = new Map<string, string>();
const localStoragePolyfill = {
  getItem: (k: string): string | null => memory.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    memory.set(k, v);
  },
  removeItem: (k: string): void => {
    memory.delete(k);
  },
  clear: (): void => {
    memory.clear();
  },
  key: (i: number): string | null => Array.from(memory.keys())[i] ?? null,
  get length(): number {
    return memory.size;
  },
};

before(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStoragePolyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStoragePolyfill,
    configurable: true,
    writable: true,
  });
  assert.equal(localStoragePolyfill.getItem("probe"), null);
  localStoragePolyfill.setItem("probe", "1");
  assert.equal(localStoragePolyfill.getItem("probe"), "1");
  localStoragePolyfill.removeItem("probe");
});

beforeEach(async () => {
  memory.clear();
  await resetBodyStorage();
});

test("v0 gloss-storage (real phase-1 shape) keeps articles and the initial anonymous stamp", async () => {
  // No `version` key: the persist middleware's `if (typeof ... === "number"
  // && ... !== options.version)` guard is false, so migrate is not called.
  // The default `merge` (`{...current, ...persisted}`) preserves the
  // initial state's `ownerUserId: "anonymous"` and overlays articles/notes.
  memory.set(
    "gloss-storage",
    JSON.stringify({
      state: {
        currentArticleId: "a1",
        articles: {
          a1: { id: "a1", title: "我的文章", paragraphs: [{ index: 1, text: "正文", hash: "h" }], createdAt: 1_700_000_000_000 },
        },
        notes: {
          n1: { id: "n1", articleId: "a1", question: "Q", answer: "A", isStreaming: false, createdAt: 1_700_000_000_001 },
        },
      },
    }),
  );
  const { useStore } = await import("../../src/lib/store.js");
  await useStore.persist.rehydrate();

  const state = useStore.getState();
  assert.equal(state.ownerUserId, "anonymous");
  assert.deepEqual(Object.keys(state.articles), ["a1"], "articles must survive the no-version merge");
  assert.equal(state.articles["a1"]?.title, "我的文章");
  assert.equal(state.notes["n1"]?.answer, "A", "notes must survive the no-version merge");
  assert.equal(state.currentArticleId, "a1");
});

test("v1 gloss-storage triggers migrate, stamps the owner, and rewrites to v2", async () => {
  memory.set(
    "gloss-storage",
    JSON.stringify({
      state: {
        currentArticleId: "a1",
        articles: {
          a1: { id: "a1", title: "我的文章", paragraphs: [{ index: 1, text: "正文", hash: "h" }], createdAt: 1 },
        },
        notes: {
          n1: { id: "n1", articleId: "a1", question: "Q", answer: "A", isStreaming: false, createdAt: 1 },
        },
      },
      version: 1,
    }),
  );
  const { useStore } = await import("../../src/lib/store.js");
  await useStore.persist.rehydrate();

  const state = useStore.getState();
  assert.equal(state.ownerUserId, "anonymous", "migrate must stamp owner as anonymous");
  assert.equal(state.articles["a1"]?.title, "我的文章", "migrate must not drop articles");
  assert.equal(state.notes["n1"]?.answer, "A", "migrate must not drop notes");
  // Migrate writes the new state and bumps the version.
  const persisted = JSON.parse(memory.get("gloss-storage")!) as { version: number; state: { ownerUserId: string } };
  // 3 is the version that moved article bodies out of this blob.
  assert.equal(persisted.version, 3);
  assert.equal(persisted.state.ownerUserId, "anonymous");
});

test("v1 gloss-settings migrates without losing provider / model / baseURL", async () => {
  memory.set(
    "gloss-settings",
    JSON.stringify({
      state: {
        provider: "openai",
        apiKey: "sk-keep-me",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      version: 1,
    }),
  );
  const { useSettings } = await import("../../src/lib/settings.js");
  // Import hydrates once and scrubs the legacy persisted key. Only rehydrate
  // when this cached module has not already consumed this fixture.
  if (useSettings.getState().apiKey !== "sk-keep-me") await useSettings.persist.rehydrate();

  const state = useSettings.getState();
  assert.equal(state.ownerUserId, "anonymous");
  assert.equal(state.provider, "openai");
  assert.equal(state.apiKey, "sk-keep-me", "API key must not be wiped during migration");
  assert.equal(state.baseURL, "https://api.openai.com/v1");
  assert.equal(state.model, "gpt-4o-mini");
  assert.equal(state.rememberKey, false);
  assert.equal(state.legacyKeyMigrated, true, "the upgrade must expose its memory-only migration notice");

  const persisted = JSON.parse(memory.get("gloss-settings")!) as { version: number; state: { ownerUserId: string; apiKey: string } };
  assert.equal(persisted.version, 4);
  assert.equal(persisted.state.apiKey, "", "legacy plaintext copy must be scrubbed while the in-memory key survives");
  assert.equal(persisted.state.ownerUserId, "anonymous");
});

test("a v2 payload with a real owner is left untouched", async () => {
  const stamped = {
    state: {
      ownerUserId: "user-42",
      currentArticleId: "a2",
      articles: { a2: { id: "a2", title: "用户42的文章", paragraphs: [], createdAt: 1 } },
      notes: {},
    },
    version: 2,
  };
  memory.set("gloss-storage", JSON.stringify(stamped));
  const { useStore } = await import("../../src/lib/store.js");
  await useStore.persist.rehydrate();

  const state = useStore.getState();
  assert.equal(state.ownerUserId, "user-42", "v2 owner must not be reset");
  assert.equal(state.articles["a2"]?.title, "用户42的文章");
  // The blob is rewritten at the current version — an old version number here
  // would mean the next load ran the migration again.
  const persisted = JSON.parse(memory.get("gloss-storage")!) as { version: number };
  assert.equal(persisted.version, 3);
});

test("clearStorage wipes the local copy and resets to the initial state", async () => {
  // Seed a v2 user-42 payload, rehydrate (state now reflects user-42), then
  // wipe storage and force a re-read so the in-memory state is also reset.
  memory.set(
    "gloss-storage",
    JSON.stringify({
      state: { ownerUserId: "user-42", currentArticleId: null, articles: { x: { id: "x", title: "x", paragraphs: [], createdAt: 1 } }, notes: {} },
      version: 2,
    }),
  );
  const { useStore } = await import("../../src/lib/store.js");
  await useStore.persist.rehydrate();
  assert.equal(useStore.getState().ownerUserId, "user-42");

  useStore.persist.clearStorage();
  assert.equal(memory.get("gloss-storage"), undefined, "clearStorage must remove the blob");
  // After clearStorage, the in-memory state still reflects user-42 until a
  // setState reset; production code does this via clearUserCache on
  // sign-out, so the test mirrors the real flow rather than relying on
  // rehydrate alone (rehydrate's default merge keeps current state when
  // persistedState is undefined).
  useStore.getState().clearUserCache();
  const state = useStore.getState();
  assert.equal(state.ownerUserId, "anonymous");
  assert.deepEqual(state.articles, {});
  assert.deepEqual(state.notes, {});
  assert.equal(state.currentArticleId, null);
});

// ── The body migration (2 → 3) ────────────────────────────────────────────
//
// Before this, `gloss-storage` held every article *with* its paragraphs, plus a
// second copy of the same text in `syncDocument` for anything that had been
// through the extractor. Both move to IndexedDB. What these gates pin is that
// the move is lossless, that it survives being interrupted, and that the blob
// really does shrink — the last one being the entire point, since the ceiling
// this exists to escape is a property of the blob.

const { migrateBodiesToIdb, WORKSPACE_KEY, STORAGE_VERSION, resumePendingBodyDeletes } = await import(
  "../../src/lib/storage/migrate.js"
);
const { readBody, writeBody, makeBody, listBodyIds } = await import("../../src/lib/storage/bodies.js");
const { recordBodyDeletes, pendingBodyDeletes } = await import("../../src/lib/storage/journal.js");
const { sha256Hex } = await import("../../src/lib/local-import-blocks.js");

function seedV2(article: Record<string, unknown>): void {
  memory.set(
    WORKSPACE_KEY,
    JSON.stringify({
      state: { ownerUserId: "anonymous", currentArticleId: null, articles: { a1: article }, notes: {} },
      version: 2,
    }),
  );
}

function readBlobArticle(): Record<string, unknown> {
  const blob = JSON.parse(memory.get(WORKSPACE_KEY)!) as {
    version: number;
    state: { articles: Record<string, Record<string, unknown>> };
  };
  assert.equal(blob.version, STORAGE_VERSION);
  return blob.state.articles["a1"]!;
}

test("a v2 blob's article text moves to IndexedDB and the blob shrinks", async () => {
  seedV2({ id: "a1", title: "书", paragraphs: [{ index: 1, text: "正文内容", hash: "h" }], createdAt: 1 });

  assert.equal(await migrateBodiesToIdb(), 1);

  const body = await readBody("a1");
  assert.deepEqual(body?.paragraphs, [{ index: 1, text: "正文内容", hash: "h" }]);

  const record = readBlobArticle();
  assert.equal("paragraphs" in record, false, "the text must leave the blob");
  assert.equal(record["title"], "书");
  assert.deepEqual(record["bodyStats"], { paragraphs: 1, chars: 4 });
});

test("the body migration is idempotent — a second run moves nothing and loses nothing", async () => {
  seedV2({ id: "a1", title: "书", paragraphs: [{ index: 1, text: "正文内容", hash: "h" }], createdAt: 1 });
  assert.equal(await migrateBodiesToIdb(), 1);
  // A tab that closed between "bodies written" and "blob rewritten" re-runs the
  // whole thing; a tab that closed after both re-runs and finds nothing.
  assert.equal(await migrateBodiesToIdb(), 0);
  assert.deepEqual((await readBody("a1"))?.paragraphs, [{ index: 1, text: "正文内容", hash: "h" }]);
});

test("syncDocument is dropped, and its blocks become the record's digest", async () => {
  const blocks = [{ id: "b1-aaaaaaaa", index: 1, type: "paragraph", text: "正文", hash: sha256Hex("正文") }];
  seedV2({
    id: "a1",
    title: "书",
    paragraphs: [{ index: 1, text: "正文", hash: sha256Hex("正文").slice(0, 12) }],
    syncDocument: { title: "书", blocks, source: "markdown-remark", extractorVersion: "phase1.2", textHash: "t" },
    createdAt: 1,
  });

  await migrateBodiesToIdb();

  const record = readBlobArticle();
  assert.equal("syncDocument" in record, false, "the second copy of the text must go");
  assert.equal(record["blocksDigest"], sha256Hex(JSON.stringify(blocks)));

  // The paragraph hash was stored truncated, which the sync route would reject;
  // it is restored to the full digest, verified against the text it describes.
  const body = await readBody("a1");
  assert.equal(body?.paragraphs[0]?.hash, sha256Hex("正文"));
});

test("a hash that does not describe its text is left alone rather than guessed at", async () => {
  // A legacy import whose hash came from a different scheme. Recomputing it
  // would replace one value with another; leaving it means the article simply
  // cannot be uploaded, which is the conservative branch.
  seedV2({ id: "a1", title: "旧", paragraphs: [{ index: 1, text: "正文", hash: "legacyhash" }], createdAt: 1 });
  await migrateBodiesToIdb();
  assert.equal((await readBody("a1"))?.paragraphs[0]?.hash, "legacyhash");
});

test("a blob that is not valid JSON is left exactly as it was", async () => {
  memory.set(WORKSPACE_KEY, "{not json");
  assert.equal(await migrateBodiesToIdb(), 0);
  assert.equal(memory.get(WORKSPACE_KEY), "{not json");
});

test("a deletion a previous run started is finished at startup", async () => {
  // What a crash between "clear the cache" and "delete the bodies" leaves.
  await writeBody(makeBody("a1", [{ index: 1, text: "私密正文", hash: "h" }]));
  recordBodyDeletes(["a1"]);
  assert.deepEqual(pendingBodyDeletes(), ["a1"]);

  assert.equal(await resumePendingBodyDeletes(), 1);

  assert.deepEqual(await listBodyIds(), [], "the text must not outlive the sign-out");
  assert.deepEqual(pendingBodyDeletes(), [], "and the journal must not keep asking");
});

test("a record with no text migrates to a zero-size body, not to a failure", async () => {
  // A record with no text is the state this whole change makes possible, so the
  // migration has to pass over it without inventing one. Nothing to move means
  // the pre-pass has nothing to do and returns early — the record is normalised
  // by the merge on hydration instead, which is where a record that never had a
  // body gets its `bodyStats`.
  seedV2({ id: "a1", title: "无正文", createdAt: 1 });
  assert.equal(await migrateBodiesToIdb(), 0);
  assert.equal(memory.get(WORKSPACE_KEY)!.includes("bodyStats"), false);

  const { useStore } = await import("../../src/lib/store.js");
  await useStore.persist.rehydrate();
  assert.deepEqual(useStore.getState().articles["a1"]?.bodyStats, { paragraphs: 0, chars: 0 });
  assert.equal(useStore.getState().bodies["a1"], undefined);
});
