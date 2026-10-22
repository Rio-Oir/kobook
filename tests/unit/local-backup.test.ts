// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local backup: export, validate, restore.
 *
 * The format has two versions now. `1` is the original — every article carries
 * its text — and is what a complete library still produces, byte for byte.
 * `2` exists only for a library where some article's text is not on this device;
 * those articles carry `body: "omitted"` instead of `paragraphs`.
 *
 * The gates below are grouped by which of those they pin: the round trip and
 * its refusals (unchanged behaviour, version 1), the remark bounds (unchanged),
 * and the omission (new).
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { installLocalStorage } from "./byok-fake-provider.js";
import { resetBodyStorage } from "./storage-fixture.js";

installLocalStorage();
const { useStore } = await import("../../src/lib/store.js");
const { createLocalBackup, restoreLocalBackup, validateLocalBackup, backupArticleHasBody } = await import(
  "../../src/lib/local-backup.js"
);
const { MAX_HIGHLIGHT_NOTE_LENGTH } = await import("../../src/lib/types.js");

beforeEach(async () => {
  useStore.getState().clearUserCache();
  localStorage.clear();
  await resetBodyStorage();
});

/** One article with one paragraph, saved through the store. */
async function seed(): Promise<void> {
  await useStore.getState().saveArticle(
    { id: "local-a", title: "备份", createdAt: 1 },
    [{ index: 1, text: "正文内容", hash: "h" }],
  );
}

function mark(): string {
  return useStore.getState().addHighlight({
    articleId: "local-a",
    paragraphIndex: 1,
    startOffset: 0,
    endOffset: 2,
    selectionText: "正文",
    color: "green",
  });
}

// ── The round trip ────────────────────────────────────────────────────────

test("backup roundtrip keeps text/annotations and excludes credentials and cloud identity", async () => {
  await seed();
  mark();
  localStorage.setItem("gloss-settings", "synthetic-secret");
  const raw = await createLocalBackup();
  assert.ok(!raw.includes("synthetic-secret"));
  assert.ok(!raw.includes("ownerUserId"));
  useStore.getState().clearUserCache();
  await restoreLocalBackup(raw);
  assert.equal(await createLocalBackup(), raw);
  await restoreLocalBackup(raw);
  assert.equal(Object.keys(useStore.getState().articles).length, 1);
  // The text is back where the reader can render it, not only on disk.
  assert.equal(useStore.getState().bodies["local-a"]?.state, "present");
});

test("restore rejects conflicts, unknown credential fields, future versions and bad anchors without mutation", async () => {
  await seed();
  const raw = await createLocalBackup();
  const before = localStorage.getItem("gloss-storage");
  for (const mutate of [
    (v: any) => (v.apiKey = "secret"),
    // A version this build does not know. Not 2 — that one is valid now.
    (v: any) => (v.version = 99),
    (v: any) => (v.articles["local-a"].title = "conflict"),
    (v: any) => (v.highlights.x = { id: "x", articleId: "local-a", paragraphIndex: 1, startOffset: 0, endOffset: 2, selectionText: "错文", color: "green", createdAt: 1 }),
  ]) {
    const value = JSON.parse(raw);
    mutate(value);
    await assert.rejects(() => restoreLocalBackup(JSON.stringify(value)));
    assert.equal(localStorage.getItem("gloss-storage"), before);
    assert.equal(await createLocalBackup(), raw);
  }
});

test("storage refusal leaves memory and existing disk untouched", async () => {
  await seed();
  const raw = await createLocalBackup();
  useStore.getState().clearUserCache();
  const before = localStorage.getItem("gloss-storage");
  const original = localStorage.setItem;
  localStorage.setItem = () => {
    throw new Error("QuotaExceeded");
  };
  try {
    await assert.rejects(() => restoreLocalBackup(raw));
    assert.equal(Object.keys(useStore.getState().articles).length, 0);
    assert.equal(localStorage.getItem("gloss-storage"), before);
  } finally {
    localStorage.setItem = original;
  }
  assert.equal(validateLocalBackup(raw).version, 1);
});

test("backup preserves cancelled turns and partial answer; running snapshots restore as interrupted", async () => {
  await seed();
  useStore.setState({
    notes: {
      n: {
        id: "n", articleId: "local-a", paragraphIndex: 1, type: "ask", selectionText: "正文",
        question: "为何", answer: "部分回答", model: "synthetic", isStreaming: true, createdAt: 2,
        startParagraphIndex: 1, startOffset: 0, endParagraphIndex: 1, endOffset: 2,
        turns: [{ id: "turn-1", noteId: "n", sequence: 1, role: "assistant", content: "先前部分回答", createdAt: "2026-10-15T00:00:00Z", status: "cancelled" }],
      },
    },
  });
  const raw = await createLocalBackup();
  const data = validateLocalBackup(raw);
  assert.equal(data.notes.n?.localStatus, "interrupted");
  assert.equal(data.notes.n?.turns?.[0]?.status, "cancelled");
  useStore.getState().clearUserCache();
  await restoreLocalBackup(raw);
  assert.equal(useStore.getState().notes.n?.answer, "部分回答");
  assert.equal(useStore.getState().notes.n?.isStreaming, false);
  const invalid = JSON.parse(raw);
  invalid.notes.n.selectionText = "错误";
  assert.throws(() => validateLocalBackup(JSON.stringify(invalid)));
});

// ── Remarks ───────────────────────────────────────────────────────────────

test("a personal remark survives a backup and restore, and a backup written without one still loads", async () => {
  await seed();
  const id = mark();
  useStore.getState().setHighlightNote(id, "这是一条个人备注");
  const raw = await createLocalBackup();
  // The remark is in the file, and it is the *only* new thing that is: no
  // settings, no provider, no account.
  assert.ok(raw.includes("这是一条个人备注"));
  useStore.getState().clearUserCache();
  await restoreLocalBackup(raw);
  const restored = Object.values(useStore.getState().highlights)[0]!;
  assert.equal(restored.note, "这是一条个人备注");
  // Adding a remark must not disturb what the mark already was.
  assert.equal(restored.selectionText, "正文");
  assert.equal(restored.color, "green");
  assert.equal(restored.startOffset, 0);
  assert.equal(restored.endOffset, 2);
  // Backwards compatibility, in the direction that matters: every highlight
  // written before remarks existed has no `note` key, and the strict schema
  // has to keep accepting that rather than demanding a migration.
  const legacy = JSON.parse(raw) as any;
  delete legacy.highlights[restored.id].note;
  assert.equal(validateLocalBackup(JSON.stringify(legacy)).highlights[restored.id]?.note, undefined);
});

test("the editor, the store and the backup schema share one remark bound", async () => {
  await seed();
  const id = mark();
  const value = JSON.parse(await createLocalBackup()) as any;
  // The boundary itself: exactly the limit is accepted, one more is not.
  value.highlights[id].note = "长".repeat(MAX_HIGHLIGHT_NOTE_LENGTH);
  assert.equal(validateLocalBackup(JSON.stringify(value)).highlights[id]?.note?.length, MAX_HIGHLIGHT_NOTE_LENGTH);
  value.highlights[id].note = "长".repeat(MAX_HIGHLIGHT_NOTE_LENGTH + 1);
  assert.throws(() => validateLocalBackup(JSON.stringify(value)));
});

test("a remark past the format limit is clamped by the store, so the backup still builds", async () => {
  await seed();
  const id = mark();
  // A caller that got past the editor must not be able to write a record the
  // backup refuses: one oversized remark would take the reader's *whole*
  // backup down with it.
  useStore.getState().setHighlightNote(id, "长".repeat(MAX_HIGHLIGHT_NOTE_LENGTH + 500));
  assert.equal(useStore.getState().highlights[id]?.note?.length, MAX_HIGHLIGHT_NOTE_LENGTH);
  const raw = await createLocalBackup();
  assert.equal(validateLocalBackup(raw).highlights[id]?.note?.length, MAX_HIGHLIGHT_NOTE_LENGTH);
  // And the highlight is otherwise untouched by the clamp.
  assert.equal(useStore.getState().highlights[id]?.selectionText, "正文");
});

test("deleting a remark keeps the highlight; deleting the highlight takes the remark with it", async () => {
  await seed();
  const id = mark();
  useStore.getState().setHighlightNote(id, "备注");
  useStore.getState().setHighlightNote(id, undefined);
  const kept = useStore.getState().highlights[id]!;
  assert.ok(kept, "removing what the reader wrote must not remove the mark");
  // Absent, not blank: "no remark" is one state, not two.
  assert.equal(Object.hasOwn(kept, "note"), false);
  assert.equal(kept.selectionText, "正文");
  useStore.getState().setHighlightNote(id, "再写一条");
  assert.equal(useStore.getState().highlights[id]?.note, "再写一条");
  useStore.getState().deleteHighlight(id);
  assert.equal(useStore.getState().highlights[id], undefined);
});

// ── An article whose text is not on this device ───────────────────────────

test("an article with no text is exported as omitted, at version 2, and restores without its text", async () => {
  // The state a failed body write leaves behind: a record that is real and
  // listed, and text that is not there. A backup has to be able to say so
  // rather than either dropping the article or pretending it is complete.
  useStore.setState({
    articles: {
      "local-a": { id: "local-a", title: "没有正文", createdAt: 1, bodyStats: { paragraphs: 0, chars: 0 } },
    },
  });
  const raw = await createLocalBackup();
  const data = validateLocalBackup(raw);
  assert.equal(data.version, 2, "an incomplete backup must not claim to be version 1");
  assert.equal(backupArticleHasBody(data.articles["local-a"]!), false);
  assert.equal(data.articles["local-a"]?.title, "没有正文");
  // The article is still in the file: omitting the *text* is not omitting the
  // record, which is what would make the reader's library shrink on restore.
  assert.equal("paragraphs" in data.articles["local-a"]!, false);

  useStore.getState().clearUserCache();
  const { omittedArticles } = await restoreLocalBackup(raw);
  assert.equal(omittedArticles, 1);
  assert.equal(useStore.getState().articles["local-a"]?.title, "没有正文");
  assert.equal(useStore.getState().bodies["local-a"], undefined);
});

test("a version 1 file may not contain an omitted body", async () => {
  // The two versions exist to make exactly this distinguishable. A v1 file that
  // dropped a body would restore an article whose notes point at paragraphs
  // that are not there, with nothing in the file to say why.
  await seed();
  const value = JSON.parse(await createLocalBackup()) as any;
  value.articles["local-a"].body = "omitted";
  delete value.articles["local-a"].paragraphs;
  assert.throws(() => validateLocalBackup(JSON.stringify(value)));
  // And the same file is accepted once it admits what it is.
  value.version = 2;
  assert.equal(validateLocalBackup(JSON.stringify(value)).version, 2);
});
