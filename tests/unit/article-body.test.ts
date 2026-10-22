// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Article bodies: where the text lives, and what leaves `localStorage`.
 *
 * Two defects motivated the split, and each has a gate here:
 *
 *  1. **`localStorage` has a hard 10 MiB ceiling in every browser** — roughly
 *     ten 200k-character books — and zustand's `persist` updates memory before
 *     it writes the blob, so a quota failure left an article that was present,
 *     readable and gone after a refresh. The gate is that the workspace blob
 *     does not grow with the text at all.
 *  2. **The whole store was one key**, so appending one streamed token to a
 *     note re-serialised every article the reader owned. The gate is that a
 *     note write does not touch the blob's size.
 *
 * The third thing being pinned is the deletion contract. Everything that
 * removes an article has to remove its text, and it has to do so in a way that
 * survives the tab closing mid-way — which is the difference between "the
 * cache is clear" being true of memory and being true of the disk.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { installMemoryLocalStorage, resetBodyStorage } from "./storage-fixture.js";

installMemoryLocalStorage();
const { useStore } = await import("../../src/lib/store.js");
const { readBody, listBodyIds, makeBody, writeBody } = await import("../../src/lib/storage/bodies.js");
const { pendingBodyDeletes } = await import("../../src/lib/storage/journal.js");
const { setBackendForTesting } = await import("../../src/lib/storage/backend.js");
const { WORKSPACE_KEY } = await import("../../src/lib/storage/migrate.js");

const TEXT = "这是一段足够长的正文，用来确认它确实离开了 localStorage。";

function workspaceBlob(): string {
  return localStorage.getItem(WORKSPACE_KEY) ?? "";
}

/** Wait for a body load that `ensureBody` started to settle. */
async function waitForBody(articleId: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const entry = useStore.getState().bodies[articleId];
    if (entry && entry.state !== "loading") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`body for ${articleId} never settled`);
}

/** An article whose body is `chars` characters wide. */
async function seedSized(id: string, chars: number): Promise<void> {
  await useStore.getState().saveArticle(
    { id, title: id, createdAt: 1 },
    [{ index: 1, text: "文".repeat(chars), hash: `h-${id}` }],
  );
}

async function seed(id = "local-a"): Promise<void> {
  await useStore.getState().saveArticle(
    { id, title: "一篇文章", createdAt: 1 },
    [{ index: 1, text: TEXT, hash: "h1" }],
  );
}

beforeEach(async () => {
  useStore.getState().clearUserCache();
  localStorage.clear();
  await resetBodyStorage();
});

// ── Where the text goes ───────────────────────────────────────────────────

test("saving an article puts the text in the body store and not in the workspace blob", async () => {
  await seed();
  assert.equal((await readBody("local-a"))?.paragraphs[0]?.text, TEXT);

  const blob = workspaceBlob();
  assert.ok(blob.length > 0, "the record is still persisted");
  assert.ok(!blob.includes(TEXT), "the text must not be in localStorage");
  assert.ok(blob.includes("local-a"), "the record must be");
});

test("the record's bodyStats agree with the body it was saved with", async () => {
  await useStore.getState().saveArticle(
    { id: "local-a", title: "t", createdAt: 1 },
    [
      { index: 1, text: "第一段。", hash: "h1" },
      { index: 2, text: "第二段，长一些。", hash: "h2" },
    ],
  );
  const record = useStore.getState().articles["local-a"]!;
  // The count is what the library renders without loading anything, so it has
  // to be derived from the same array that was stored — not accepted from the
  // caller, which is how the two drift apart.
  assert.deepEqual(record.bodyStats, { paragraphs: 2, chars: "第一段。".length + "第二段，长一些。".length });
  assert.equal(record.bodyStats.chars, (await readBody("local-a"))!.paragraphs.reduce((n, p) => n + p.text.length, 0));
});

test("the cost of one streamed token does not depend on the size of the library", async () => {
  // The defect this split removes is not that the text was in `localStorage`,
  // it is that the whole store was *one key*: every token re-serialised every
  // article the reader owned, so the cost of a keystroke grew with the library.
  // Measuring that directly — the same appends, against a small library and
  // then a large one — is the only assertion that can tell the two apart.
  await seedSized("local-a", 100);
  const noteId = useStore.getState().addNote({
    articleId: "local-a", paragraphIndex: 1, type: "explain", selectionText: "正文",
    question: "q", answer: "", model: "m",
  });
  useStore.getState().appendToNote(noteId, "开始");
  const measure = (): number => {
    const before = workspaceBlob().length;
    for (let i = 0; i < 50; i += 1) useStore.getState().appendToNote(noteId, "流式的一段回答。");
    return workspaceBlob().length - before;
  };

  const withOneArticle = measure();
  assert.ok(withOneArticle > 0, "the note itself is persisted");

  // Ten articles of 20 000 characters: 200 kB of text that used to travel
  // through `JSON.stringify` on every one of those appends.
  for (let i = 0; i < 10; i += 1) await seedSized(`local-big-${i}`, 20_000);
  assert.equal(measure(), withOneArticle, "the library's size must not enter the cost");

  const blob = workspaceBlob();
  assert.ok(!blob.includes("文".repeat(1000)), "and none of that text is in localStorage");
});

// ── Reading it back ───────────────────────────────────────────────────────

test("a body that is not in memory is loaded on demand", async () => {
  await seed();
  // What a reload looks like: the records are rehydrated, the bodies are not.
  useStore.setState({ bodies: {} });
  assert.equal(useStore.getState().bodies["local-a"], undefined);

  useStore.getState().ensureBody("local-a");
  await waitForBody("local-a");

  const entry = useStore.getState().bodies["local-a"];
  assert.equal(entry?.state, "present");
  assert.equal(entry?.state === "present" ? entry.body.paragraphs[0]?.text : null, TEXT);
});

test("asking twice does not read twice, and an article with no body says which it is", async () => {
  useStore.setState({
    articles: { "local-empty": { id: "local-empty", title: "无正文", createdAt: 1, bodyStats: { paragraphs: 0, chars: 0 } } },
    bodies: {},
  });
  useStore.getState().ensureBody("local-empty");
  useStore.getState().ensureBody("local-empty");
  await waitForBody("local-empty");

  const entry = useStore.getState().bodies["local-empty"];
  // `never-stored` and `evicted` are different states with different words and
  // different remedies; collapsing them now would erase the distinction before
  // anything could act on it.
  assert.deepEqual(entry, { state: "absent", why: "never-stored" });
});

test("a body that arrives after its article was deleted is dropped", async () => {
  await seed();
  useStore.setState({ bodies: {} });
  useStore.getState().ensureBody("local-a");
  useStore.getState().deleteArticle("local-a");
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The read was already in flight. A body with no record is unreachable, so
  // the entry is removed rather than left for a component to find.
  assert.equal(useStore.getState().bodies["local-a"], undefined);
  assert.equal(await readBody("local-a"), undefined);
});

// ── Deleting ──────────────────────────────────────────────────────────────

test("deleting an article deletes its text from memory and from the disk", async () => {
  await seed();
  useStore.getState().deleteArticle("local-a");
  assert.equal(useStore.getState().bodies["local-a"], undefined, "gone from memory immediately");
  assert.equal(useStore.getState().articles["local-a"], undefined);
  await waitFor(async () => (await readBody("local-a")) === undefined);
  assert.deepEqual(pendingBodyDeletes(), [], "and the journal is not left asking");
});

test("clearing the user cache takes every body with it, including orphans", async () => {
  await seed("local-a");
  await seed("local-b");
  // A body no record points at — what an interrupted earlier wipe leaves.
  await writeBody(makeBody("local-orphan", [{ index: 1, text: "孤儿正文", hash: "h" }]));

  useStore.getState().clearUserCache();

  assert.deepEqual(useStore.getState().articles, {});
  assert.deepEqual(useStore.getState().bodies, {});
  await waitFor(async () => (await listBodyIds()).length === 0);
  assert.deepEqual(await listBodyIds(), [], "no account text may be left on the device");
});

test("the deletion is recorded synchronously, so a tab that closes mid-way still finishes it", async () => {
  // The record has to be on disk before the asynchronous delete is attempted,
  // or a crash in the window leaves the previous account's text behind with
  // nothing left to notice it.
  await seed();
  const backend = {
    kind: "local-storage" as const,
    get: async () => undefined,
    put: async () => undefined,
    delete: async () => {
      throw new Error("storage is gone");
    },
    keys: async () => [],
    clear: async () => undefined,
  };
  setBackendForTesting(backend);
  try {
    useStore.getState().clearUserCache();
    // The delete failed, so the journal must still be holding the id.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(pendingBodyDeletes(), ["local-a"]);
  } finally {
    setBackendForTesting(null);
  }
});

test("a write that lands during a sign-out's cleanup is not deleted by it", async () => {
  // `clearUserCache` is synchronous, so its deletion cannot be. Without an
  // ordering between the two, the wipe enumerates the store, the write lands,
  // and the wipe removes what the write just stored — a library whose text is
  // gone, with an "unavailable" article as the only symptom.
  await seed("local-a");
  useStore.getState().clearUserCache();
  await useStore.getState().saveArticle(
    { id: "local-a", title: "t", createdAt: 1 },
    [{ index: 1, text: TEXT, hash: "h" }],
  );
  // Long enough for a deletion that was going to overtake the write to have
  // done so.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await readBody("local-a"))?.paragraphs[0]?.text, TEXT);
});

// ── A refused write is not a silent one ───────────────────────────────────

test("a body the disk refuses is reported to the caller, and the record is not lost", async () => {
  setBackendForTesting({
    kind: "local-storage",
    get: async () => undefined,
    put: async () => {
      throw new Error("QuotaExceededError");
    },
    delete: async () => undefined,
    keys: async () => [],
    clear: async () => undefined,
  });
  try {
    await assert.rejects(
      () => useStore.getState().saveArticle({ id: "local-a", title: "t", createdAt: 1 }, [{ index: 1, text: TEXT, hash: "h" }]),
      /QuotaExceeded/,
    );
    // The record survives so the article is still listed and its notes are
    // still reachable — the text is reported as unavailable rather than the
    // whole article vanishing. What must NOT happen is the save reporting
    // success, which is the bug this replaced.
    assert.equal(useStore.getState().articles["local-a"]?.title, "t");
    assert.equal(useStore.getState().bodies["local-a"]?.state, "present", "readable in this session");
    const backend = await import("../../src/lib/storage/backend.js");
    backend.setBackendForTesting(null);
    assert.equal(await readBody("local-a"), undefined, "and not after a reload");
  } finally {
    setBackendForTesting(null);
  }
});

/** Poll a predicate, for a deletion that is deliberately not awaited. */
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition never became true");
}
