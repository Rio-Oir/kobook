// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Legacy `local-free:v1` handling.
 *
 * The two properties that matter, and that a later refactor could quietly
 * break: the old space is never written to or deleted, and importing it twice
 * does not duplicate anything.
 */

import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { installLocalStorage } from "./byok-fake-provider.js";

const memory = installLocalStorage();

const { LEGACY_STORAGE_KEY, downloadLegacyRaw, importLegacyIntoStore, readLegacySummary } = await import(
  "../../src/lib/legacy-local-free.js"
);
const { useStore } = await import("../../src/lib/store.js");

function legacyBlob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    articles: {
      "local-abc123": {
        id: "local-abc123",
        title: "旧版文章标题",
        paragraphs: [
          { index: 1, text: "第一段文字", hash: "hash0001", type: "paragraph" },
          { index: 2, text: "第二段文字", hash: "hash0002", type: "paragraph" },
        ],
        createdAt: 1000,
        source: "local",
        versionId: "v1",
        textHash: "deadbeefdeadbeef",
      },
    },
    highlights: {
      "hl-legacy-1": {
        id: "hl-legacy-1",
        articleId: "local-abc123",
        paragraphIndex: 1,
        startOffset: 0,
        endOffset: 3,
        selectionText: "第一段",
        color: "yellow",
        style: "line",
        createdAt: 2000,
        noteText: "这是旧版的自由笔记。",
      },
    },
    theme: "dark",
    updatedAt: 3000,
    ...overrides,
  });
}

beforeEach(() => {
  memory.clear();
  useStore.getState().clearUserCache();
});

after(() => {
  useStore.getState().clearUserCache();
});

test("legacy: an absent key is reported as absent and offers nothing", () => {
  const summary = readLegacySummary();
  assert.equal(summary.present, false);
  assert.equal(summary.articles, 0);
  const result = importLegacyIntoStore();
  assert.equal(result.ok, false);
  assert.match(result.message, /没有检测到/);
});

test("legacy: an unreadable blob is reported, and never treated as empty-but-fine", () => {
  memory.set(LEGACY_STORAGE_KEY, "{not json");
  const summary = readLegacySummary();
  assert.equal(summary.present, true);
  assert.ok(summary.unreadable);
  assert.equal(importLegacyIntoStore().ok, false);
});

test("legacy: an unknown schemaVersion is refused rather than guessed at", () => {
  memory.set(LEGACY_STORAGE_KEY, legacyBlob({ schemaVersion: 99 }));
  const summary = readLegacySummary();
  assert.equal(summary.present, true);
  assert.match(String(summary.unreadable), /schemaVersion=99/);
  assert.equal(importLegacyIntoStore().ok, false);
});

test("legacy: a highlight whose quote does not match its anchor makes the whole blob unreadable", () => {
  const blob = JSON.parse(legacyBlob());
  blob.highlights["hl-legacy-1"].selectionText = "完全对不上的文字";
  memory.set(LEGACY_STORAGE_KEY, JSON.stringify(blob));
  const summary = readLegacySummary();
  assert.ok(summary.unreadable);
  const before = useStore.getState().articles;
  assert.equal(importLegacyIntoStore().ok, false);
  assert.equal(useStore.getState().articles, before, "a refused import must not touch the store");
});

test("legacy: a valid import lands articles, anchors and a labelled note, and leaves the old key alone", () => {
  const blob = legacyBlob();
  memory.set(LEGACY_STORAGE_KEY, blob);

  const summary = readLegacySummary();
  assert.equal(summary.present, true);
  assert.equal(summary.articles, 1);
  assert.equal(summary.highlights, 1);
  assert.equal(summary.notes, 1);
  assert.ok(summary.bytes > 0);

  const result = importLegacyIntoStore();
  assert.equal(result.ok, true);
  assert.equal(result.articles, 1);
  assert.equal(result.highlights, 1);
  assert.equal(result.notes, 1);

  const state = useStore.getState();
  const article = state.articles["local-abc123"];
  assert.ok(article, "the legacy article must be imported under its original id");
  assert.equal(article.title, "旧版文章标题");
  assert.equal(article.paragraphs.length, 2);
  // The legacy id and the original timestamp survive, so the user's timeline
  // does not silently reorder.
  const highlight = state.highlights["hl-legacy-1"];
  assert.ok(highlight, "the legacy highlight must keep its own id");
  assert.equal(highlight.createdAt, 2000);
  assert.equal(highlight.selectionText, "第一段");
  const note = state.notes["legacy-hl-legacy-1"];
  assert.ok(note, "the legacy note must be imported under a stable id");
  assert.equal(note.answer, "这是旧版的自由笔记。");
  assert.equal(note.model, "local-free-legacy");
  assert.equal(note.isStreaming, false);
  assert.match(note.question, /旧版本机阅读器的自由笔记/);

  assert.equal(memory.get(LEGACY_STORAGE_KEY), blob, "the old space must be byte-identical after an import");
});

test("legacy: importing the same blob twice is idempotent", () => {
  memory.set(LEGACY_STORAGE_KEY, legacyBlob());
  assert.equal(importLegacyIntoStore().ok, true);
  const first = useStore.getState();
  const firstArticles = Object.keys(first.articles).length;
  const firstHighlights = Object.keys(first.highlights).length;
  const firstNotes = Object.keys(first.notes).length;

  const second = importLegacyIntoStore();
  assert.equal(second.ok, true);
  assert.equal(second.notes, 0, "the second import must not add a second copy of the note");

  const after = useStore.getState();
  assert.equal(Object.keys(after.articles).length, firstArticles);
  assert.equal(Object.keys(after.highlights).length, firstHighlights);
  assert.equal(Object.keys(after.notes).length, firstNotes);
});

test("legacy: importing does not clear what the new space already holds", () => {
  memory.set(LEGACY_STORAGE_KEY, legacyBlob());
  useStore.getState().saveArticle({
    id: "local-existing",
    title: "新版文章",
    paragraphs: [{ index: 1, text: "新版第一段", hash: "newhash01" }],
    createdAt: 5000,
  });
  assert.equal(importLegacyIntoStore().ok, true);
  const state = useStore.getState();
  assert.ok(state.articles["local-existing"], "the pre-existing article must survive the import");
  assert.ok(state.articles["local-abc123"], "and the legacy article must be added alongside it");
});

test("legacy: the raw download returns the untouched bytes", () => {
  const blob = legacyBlob();
  memory.set(LEGACY_STORAGE_KEY, blob);
  // No DOM in this runner, so the download reports its inability rather than
  // throwing — the surface must degrade, not crash the page.
  const result = downloadLegacyRaw();
  if (!result.ok) {
    assert.match(result.message, /不支持下载/);
  } else {
    assert.ok(result.bytes > 0);
  }
  assert.equal(memory.get(LEGACY_STORAGE_KEY), blob);
});

test('a legacy article collision refuses before overwriting current content', () => {
  localStorage.setItem(LEGACY_STORAGE_KEY, legacyBlob());
  assert.equal(importLegacyIntoStore().ok, true);
  const existing = useStore.getState().articles['local-abc123']!;
  useStore.getState().saveArticle({...existing, paragraphs: [{...existing.paragraphs[0]!, text: '更新后的正文'}]});
  const before = JSON.stringify(useStore.getState().articles);
  assert.equal(importLegacyIntoStore().ok, false);
  assert.equal(JSON.stringify(useStore.getState().articles), before);
});
