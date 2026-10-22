// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Notebook gates: the rules that decide what the drawer shows, in what
 * order, and what the export says.
 *
 * Every one of these is a decision about the reader's own data that has a
 * silent failure mode, which is why they are asserted here rather than
 * observed in the browser:
 *
 *   - the list is the *article's* order, not the order the reader happened
 *     to make the marks — getting it wrong produces a plausible-looking
 *     list that is simply wrong;
 *   - an answer that is still arriving must appear exactly once (the turn
 *     and the flattened `answer` carry the same text), and an answer that
 *     stopped early must be labelled as incomplete rather than presented as
 *     the whole reply;
 *   - an anchor that no longer describes the text must resolve to "stale"
 *     rather than to a nearby paragraph, because a wrong jump reads as
 *     "this is what the note is about";
 *   - the export must contain every entry regardless of the filter on
 *     screen, and must contain nothing that is not about the text.
 *
 * Pure functions over plain records, so they run in the same suite as the
 * rest of the reader's rules.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANCHOR_STALE_MESSAGE,
  comparePositions,
  filterEntries,
  notebookCounts,
  notebookEntries,
  notebookFilename,
  notebookMarkdown,
  notebookSummary,
  pairStatusNote,
  paragraphOrder,
  qaPairs,
  resolveHighlightAnchor,
  resolveNoteAnchor,
  type EntryPosition,
} from "../../src/lib/notebook.js";
import type { Highlight, Note, Paragraph } from "../../src/lib/types.js";

const paragraphs: Paragraph[] = [
  { index: 1, text: "世尊说：世尊。", hash: "a", blockId: "a" },
  { index: 2, text: "须菩提回答。", hash: "b", blockId: "b" },
  { index: 3, text: "应无所住而生其心。", hash: "c", blockId: "c" },
];

const note = (patch: Partial<Note> = {}): Note => ({
  id: "n1",
  articleId: "local-a",
  paragraphIndex: 2,
  selectionText: "须菩提",
  question: "解释",
  answer: "",
  model: "SECRET-MODEL-NAME",
  type: "explain",
  isStreaming: false,
  createdAt: 1_000,
  ...patch,
});

const highlight = (patch: Partial<Highlight> = {}): Highlight => ({
  id: "h1",
  articleId: "local-a",
  paragraphIndex: 2,
  startOffset: 0,
  endOffset: 3,
  selectionText: "须菩提",
  color: "yellow",
  createdAt: 1_000,
  ...patch,
});

const position = (patch: Partial<EntryPosition> = {}): EntryPosition => ({
  order: 0,
  paragraphIndex: 1,
  offset: 0,
  createdAt: 0,
  id: "x",
  ...patch,
});

test("reading order is the article's own order, not creation order", () => {
  // The array is the order the reader sees; the `index` numbers are a
  // separate thing a re-import may renumber.
  const shuffled: Paragraph[] = [
    { index: 3, text: "丙", hash: "c" },
    { index: 1, text: "甲", hash: "a" },
    { index: 2, text: "乙", hash: "b" },
  ];
  const order = paragraphOrder(shuffled);
  assert.deepEqual([...order.entries()], [
    [3, 0],
    [1, 1],
    [2, 2],
  ]);

  // Created first, but anchored to ¶1, which the array puts *second*.
  const createdEarlier = note({
    id: "created-earlier",
    paragraphIndex: 1,
    selectionText: "甲",
    createdAt: 10,
  });
  // Created last, but anchored to ¶3, which the array puts *first*.
  const createdLater = note({
    id: "created-later",
    paragraphIndex: 3,
    selectionText: "丙",
    createdAt: 999,
  });
  const entries = notebookEntries({
    notes: [createdEarlier, createdLater],
    highlights: [],
    paragraphs: shuffled,
  });
  assert.deepEqual(
    entries.map((e) => e.id),
    ["created-later", "created-earlier"],
  );
});

test("offsets order entries inside one paragraph, then time, then id", () => {
  const entries = notebookEntries({
    notes: [],
    highlights: [
      highlight({ id: "later", startOffset: 5, endOffset: 7, selectionText: "世尊", paragraphIndex: 1, createdAt: 5 }),
      highlight({ id: "earlier", startOffset: 0, endOffset: 2, selectionText: "世尊", paragraphIndex: 1, createdAt: 900 }),
      // Same range, same paragraph: the tie is broken by time, then by id,
      // so two entries on one character never swap between renders.
      highlight({ id: "b-tie", startOffset: 5, endOffset: 7, selectionText: "世尊", paragraphIndex: 1, createdAt: 5 }),
      highlight({ id: "a-tie", startOffset: 5, endOffset: 7, selectionText: "世尊", paragraphIndex: 1, createdAt: 5 }),
    ],
    paragraphs,
  });
  assert.deepEqual(
    entries.map((e) => e.id),
    ["earlier", "a-tie", "b-tie", "later"],
  );
});

test("the comparator is total: an unplaced entry sorts last instead of scrambling the list", () => {
  assert.equal(comparePositions(position({ order: 0 }), position({ order: 1 })), -1);
  assert.equal(
    comparePositions(
      position({ order: Number.POSITIVE_INFINITY }),
      position({ order: 0 }),
    ),
    1,
  );
  // Infinity - Infinity is NaN, which would make `sort` order-dependent.
  assert.equal(
    comparePositions(
      position({ order: Number.POSITIVE_INFINITY, id: "a" }),
      position({ order: Number.POSITIVE_INFINITY, id: "b" }),
    ),
    -1,
  );
  assert.equal(comparePositions(position(), position()), 0);
});

test("a note anchored to a paragraph the document no longer has still lists", () => {
  const entries = notebookEntries({
    notes: [note({ id: "gone", paragraphIndex: 42 })],
    highlights: [],
    paragraphs,
  });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.anchor, { ok: false, reason: "stale" });
});

test("anchors resolve only when the stored range still slices out the quote", () => {
  // Exact offsets: the second "世尊", the one the reader actually dragged.
  assert.deepEqual(
    resolveNoteAnchor(
      note({ paragraphIndex: 1, startOffset: 4, endOffset: 6, selectionText: "世尊" }),
      paragraphs,
    ),
    { ok: true, paragraphIndex: 1, start: 4, end: 6 },
  );
  // A legacy note with no offsets recovers its quote when it is unambiguous…
  assert.deepEqual(
    resolveNoteAnchor(note({ paragraphIndex: 2, selectionText: "菩提" }), paragraphs),
    { ok: true, paragraphIndex: 2, start: 1, end: 3 },
  );
  // …and refuses when it is not. No guessing at the first occurrence.
  assert.deepEqual(
    resolveNoteAnchor(note({ paragraphIndex: 1, selectionText: "世尊" }), paragraphs),
    { ok: false, reason: "stale" },
  );
  // Offsets that are in range but cover different characters than the quote.
  assert.deepEqual(
    resolveNoteAnchor(note({ paragraphIndex: 1, startOffset: 0, endOffset: 2, selectionText: "须菩提" }), paragraphs),
    { ok: false, reason: "stale" },
  );
});

test("a highlight anchor is validated against the paragraph's current text", () => {
  assert.deepEqual(resolveHighlightAnchor(highlight(), paragraphs), {
    ok: true,
    paragraphIndex: 2,
    start: 0,
    end: 3,
  });
  for (const patch of [
    { paragraphIndex: 42 },
    // In range, different characters: the document was re-parsed.
    { startOffset: 1, endOffset: 4 },
    { startOffset: -1, endOffset: 3 },
    { startOffset: 2, endOffset: 2 },
    { startOffset: 0, endOffset: 999 },
    { startOffset: 0.5, endOffset: 3 },
  ]) {
    assert.deepEqual(
      resolveHighlightAnchor(highlight(patch), paragraphs),
      { ok: false, reason: "stale" },
      `patch ${JSON.stringify(patch)} must not resolve`,
    );
  }
});

test("structured turns produce one pair per question, in order", () => {
  const pairs = qaPairs(
    note({
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "第一问", sequence: 1, createdAt: "x" },
        { id: "t2", noteId: "n1", role: "assistant", content: "第一答", sequence: 2, createdAt: "x", status: "succeeded" },
        { id: "t3", noteId: "n1", role: "user", content: "追问一", sequence: 3, createdAt: "x" },
        { id: "t4", noteId: "n1", role: "assistant", content: "追问答", sequence: 4, createdAt: "x", status: "succeeded" },
      ],
      // The flattened answer holds the same text; using it as well would
      // show every reply twice.
      answer: "第一答\n\n---\n\n追问：追问一\n\n追问答",
    }),
  );
  assert.deepEqual(pairs, [
    { question: "第一问", answer: "第一答", status: "succeeded", live: false, answered: true },
    { question: "追问一", answer: "追问答", status: "succeeded", live: false, answered: true },
  ]);
});

test("a legacy note with no turns falls back to its flattened question and answer", () => {
  const pairs = qaPairs(note({ question: "旧问题", answer: "旧回答", turns: undefined }));
  assert.deepEqual(pairs, [
    { question: "旧问题", answer: "旧回答", status: "succeeded", live: false, answered: true },
  ]);
  // A record with nothing at all contributes nothing rather than an empty
  // pair that would render as a blank card.
  assert.deepEqual(qaPairs(note({ question: "", answer: "", turns: undefined })), []);
});

test("the answer still arriving appears exactly once, as the last pair", () => {
  const streaming = note({
    isStreaming: true,
    localStatus: "running",
    turns: [
      { id: "t1", noteId: "n1", role: "user", content: "第一问", sequence: 1, createdAt: "x" },
      { id: "t2", noteId: "n1", role: "assistant", content: "第一答", sequence: 2, createdAt: "x", status: "succeeded" },
      { id: "t3", noteId: "n1", role: "user", content: "追问一", sequence: 3, createdAt: "x" },
    ],
    activeTurnText: "正在写的",
    answer: "第一答\n\n---\n\n追问：追问一\n\n正在写的",
  });
  const pairs = qaPairs(streaming);
  assert.deepEqual(pairs, [
    { question: "第一问", answer: "第一答", status: "succeeded", live: false, answered: true },
    { question: "追问一", answer: "正在写的", status: "running", live: true, answered: false },
  ]);
  // The load-bearing assertion: the partial text is not also read back out
  // of the flattened answer.
  const flat = pairs.map((p) => p.answer).join("\n");
  assert.equal(flat.split("正在写的").length - 1, 1);
});

test("each pair carries its own terminal status", () => {
  const pairs = qaPairs(
    note({
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "第一问", sequence: 1, createdAt: "x" },
        { id: "t2", noteId: "n1", role: "assistant", content: "半截", sequence: 2, createdAt: "x", status: "cancelled" },
        { id: "t3", noteId: "n1", role: "user", content: "追问一", sequence: 3, createdAt: "x" },
        { id: "t4", noteId: "n1", role: "assistant", content: "完整", sequence: 4, createdAt: "x", status: "interrupted" },
      ],
      // The note-level status only ever describes the latest run; the
      // per-pair status is what keeps the first one honest.
      localStatus: "interrupted",
    }),
  );
  assert.deepEqual(
    pairs.map((p) => p.status),
    ["cancelled", "interrupted"],
  );
});

test("a question with no answer yet is kept, and reports how its run actually ended", () => {
  const pairs = qaPairs(
    note({
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "第一问", sequence: 1, createdAt: "x" },
      ],
    }),
  );
  assert.deepEqual(pairs, [
    { question: "第一问", answer: "", status: "succeeded", live: false, answered: false },
  ]);
  // A run that was interrupted before producing a turn must report that,
  // not an indefinite "生成中": the question stays, nothing arrived, and
  // the record knows which of the two it is.
  const swept = qaPairs(
    note({
      localStatus: "interrupted",
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "第一问", sequence: 1, createdAt: "x" },
      ],
    }),
  );
  assert.equal(swept[0]?.status, "interrupted");
  assert.equal(swept[0]?.answered, false);
});

test("the status line never claims text is incomplete when there is none", () => {
  const answered = qaPairs(
    note({
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "问", sequence: 1, createdAt: "x" },
        { id: "t2", noteId: "n1", role: "assistant", content: "半截", sequence: 2, createdAt: "x", status: "failed" },
      ],
    }),
  )[0]!;
  assert.equal(pairStatusNote(answered), "回答失败，内容不完整。");

  const unanswered = qaPairs(
    note({
      localStatus: "interrupted",
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "问", sequence: 1, createdAt: "x" },
      ],
    }),
  )[0]!;
  assert.equal(pairStatusNote(unanswered), "回答已中断，没有收到内容。");

  const live = qaPairs(
    note({
      isStreaming: true,
      activeTurnText: "半",
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "问", sequence: 1, createdAt: "x" },
      ],
    }),
  )[0]!;
  assert.equal(pairStatusNote(live), "回答正在生成，以上为已收到的部分内容。");
  assert.equal(
    pairStatusNote(
      qaPairs(
        note({
          isStreaming: true,
          turns: [
            { id: "t1", noteId: "n1", role: "user", content: "问", sequence: 1, createdAt: "x" },
          ],
        }),
      )[0]!,
    ),
    "回答正在生成。",
  );

  const done = qaPairs(
    note({
      turns: [
        { id: "t1", noteId: "n1", role: "user", content: "问", sequence: 1, createdAt: "x" },
        { id: "t2", noteId: "n1", role: "assistant", content: "完整", sequence: 2, createdAt: "x", status: "succeeded" },
      ],
    }),
  )[0]!;
  assert.equal(pairStatusNote(done), null);
});

test("filters and counts are over the whole list", () => {
  const entries = notebookEntries({
    notes: [note({ id: "n1", paragraphIndex: 2, selectionText: "须菩提" })],
    highlights: [
      highlight({ id: "h1" }),
      highlight({ id: "h2", paragraphIndex: 3, startOffset: 0, endOffset: 3, selectionText: "应无所" }),
    ],
    paragraphs,
  });
  assert.deepEqual(notebookCounts(entries), { all: 3, qa: 1, highlight: 2 });
  assert.equal(filterEntries(entries, "all").length, 3);
  assert.deepEqual(
    filterEntries(entries, "qa").map((e) => e.id),
    ["n1"],
  );
  assert.deepEqual(
    filterEntries(entries, "highlight").map((e) => e.id),
    ["h1", "h2"],
  );
  assert.equal(notebookSummary({ all: 3, qa: 1, highlight: 2 }), "1 条 AI 问答，2 条高亮与备注");
  assert.equal(notebookSummary({ all: 0, qa: 0, highlight: 0 }), "还没有任何记录");
});

test("the export carries every entry, the article's source and the honest status", () => {
  const entries = notebookEntries({
    notes: [
      note({
        id: "n1",
        paragraphIndex: 2,
        selectionText: "须菩提",
        type: "ask",
        question: "这是什么意思？",
        turns: [
          { id: "t1", noteId: "n1", role: "user", content: "这是什么意思？", sequence: 1, createdAt: "x" },
          { id: "t2", noteId: "n1", role: "assistant", content: "半截回答", sequence: 2, createdAt: "x", status: "interrupted" },
        ],
        usage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
      }),
    ],
    highlights: [
      highlight({
        id: "h1",
        paragraphIndex: 1,
        startOffset: 4,
        endOffset: 6,
        selectionText: "世尊",
        note: "这里要再读一遍",
      }),
    ],
    paragraphs,
  });

  const markdown = notebookMarkdown({
    meta: {
      title: "金刚经",
      url: "https://example.test/sutra",
      author: "佚名",
      publishedAt: "2026-01-02",
      paragraphCount: paragraphs.length,
    },
    entries,
    otherVersionNotes: [
      note({ id: "old", remoteVersionId: "v0", question: "旧版本的问题", answer: "旧版本的回答" }),
    ],
    now: Date.UTC(2026, 9, 19, 12),
  });

  // The article's identity and where it came from.
  assert.match(markdown, /^# 金刚经$/m);
  assert.match(markdown, /原文来源：https:\/\/example\.test\/sutra/);
  assert.match(markdown, /正文段落：3 段/);
  // Paragraph references, quotes and the reader's own words.
  assert.match(markdown, /## ¶1 · 高亮/);
  assert.match(markdown, /> 世尊/);
  assert.match(markdown, /\*\*我的备注\*\*/);
  assert.match(markdown, /这里要再读一遍/);
  assert.match(markdown, /## ¶2 · AI问答（提问）/);
  assert.match(markdown, /> 须菩提/);
  // The full exchange, and the truth about how it ended.
  assert.match(markdown, /\*\*问：\*\* 这是什么意思？/);
  assert.match(markdown, /半截回答/);
  assert.match(markdown, /（回答已中断，内容不完整。）/);
  // Other-version notes are listed as such, and pointed at nothing.
  assert.match(markdown, /## 其他版本的笔记/);
  assert.match(markdown, /旧版本的问题/);
  // Nothing about the reader's machine, their provider, or the run's cost.
  assert.ok(!markdown.includes("SECRET-MODEL-NAME"), "the model name must not be exported");
  assert.ok(!markdown.includes("33"), "token usage must not be exported");
  assert.ok(!markdown.includes("remoteVersionId"), "sync identifiers must not be exported");
  // Reading order: the highlight at ¶1 precedes the question at ¶2.
  assert.ok(markdown.indexOf("## ¶1 · 高亮") < markdown.indexOf("## ¶2 · AI问答"));
});

test("other-version notes are exported in full, not flattened to one answer", () => {
  // The notes the reader can no longer reach from the article are exactly
  // the ones the file is often the only way back to, so their follow-ups and
  // their terminal status have to survive the export too.
  const markdown = notebookMarkdown({
    meta: { title: "金刚经", paragraphCount: paragraphs.length },
    entries: [],
    otherVersionNotes: [
      note({
        id: "old",
        remoteVersionId: "v0",
        paragraphIndex: 4,
        selectionText: "旧版本的引文",
        question: "旧问题一",
        answer: "旧回答一\n\n---\n\n追问：旧追问\n\n旧追问的半截",
        turns: [
          { id: "o1", noteId: "old", role: "user", content: "旧问题一", sequence: 1, createdAt: "x" },
          { id: "o2", noteId: "old", role: "assistant", content: "旧回答一", sequence: 2, createdAt: "x", status: "succeeded" },
          { id: "o3", noteId: "old", role: "user", content: "旧追问", sequence: 3, createdAt: "x" },
          { id: "o4", noteId: "old", role: "assistant", content: "旧追问的半截", sequence: 4, createdAt: "x", status: "cancelled" },
        ],
      }),
    ],
    now: 0,
  });
  assert.match(markdown, /## 其他版本的笔记/);
  assert.match(markdown, /## ¶4 · AI问答（其它版本）/);
  assert.match(markdown, /> 旧版本的引文/);
  assert.match(markdown, /\*\*问 1：\*\* 旧问题一/);
  assert.match(markdown, /旧回答一/);
  assert.match(markdown, /\*\*问 2：\*\* 旧追问/);
  assert.match(markdown, /旧追问的半截/);
  assert.match(markdown, /（回答已取消，内容不完整。）/);
  // The flattened `answer` carries the same text; reading both would print
  // the first reply twice.
  assert.equal(markdown.split("旧回答一").length - 1, 1);
  // An export of nothing but other-version notes is still an export, and the
  // header says what it holds rather than claiming reading order it has not.
  assert.match(markdown, /共 1 条记录：当前正文 0 条，其他版本 1 条。/);
});

test("the export marks an answer that is still arriving, and one that never came", () => {
  const live = notebookMarkdown({
    meta: { title: "T", paragraphCount: 1 },
    entries: notebookEntries({
      notes: [
        note({
          id: "live",
          isStreaming: true,
          turns: [{ id: "t1", noteId: "live", role: "user", content: "问", sequence: 1, createdAt: "x" }],
          activeTurnText: "半",
        }),
      ],
      highlights: [],
      paragraphs,
    }),
    now: 0,
  });
  assert.match(live, /（回答正在生成，以上为已收到的部分内容。）/);

  const empty = notebookMarkdown({
    meta: { title: "T", paragraphCount: 1 },
    entries: notebookEntries({
      notes: [note({ id: "empty", turns: [] })],
      highlights: [],
      paragraphs,
    }),
    now: 0,
  });
  assert.match(empty, /（尚无回答）/);
});

test("an entry whose anchor is stale says so in the export instead of pointing somewhere", () => {
  const markdown = notebookMarkdown({
    meta: { title: "T", paragraphCount: 1 },
    entries: notebookEntries({
      notes: [],
      highlights: [
        // Offsets that no longer describe the paragraph's text.
        highlight({ id: "h", paragraphIndex: 1, startOffset: 1, endOffset: 3, selectionText: "世尊" }),
      ],
      paragraphs,
    }),
    now: 0,
  });
  assert.match(markdown, new RegExp(`（${ANCHOR_STALE_MESSAGE}）`));
});

test("the download name keeps the Chinese title and drops only what a filesystem cannot take", () => {
  const name = notebookFilename("金刚经 / 说什么？*", Date.UTC(2026, 9, 19, 12));
  assert.match(name, /金刚经/);
  assert.ok(!/[\\/:*?"<>|]/.test(name), "no path or glob characters may survive");
  assert.match(name, /-笔记本-\d{4}-\d{2}-\d{2}\.md$/);
  // An untitled article still produces a usable name rather than "-.md".
  assert.match(notebookFilename("", 0), /^笔记本-笔记本-\d{4}-\d{2}-\d{2}\.md$/);
});
