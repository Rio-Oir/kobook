// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The notebook: everything the reader marked or asked about one article,
 * as one list in the article's own reading order.
 *
 * ## Why the whole thing is pure
 *
 * The panel is the only place in the reader where two independent record
 * kinds — AI notes and highlights — are merged, ordered, filtered and
 * exported. Every one of those steps is a decision about *the reader's own
 * data* that must be the same in the drawer, in the Markdown export and in
 * the tests, so all four live here as functions over plain records and the
 * component only renders what they return. A comparator that sorted the
 * drawer one way and the export another is exactly the class of bug this
 * shape rules out.
 *
 * ## Reading order, not creation order
 *
 * The plan is explicit: the list is the *original text's* order — where the
 * passage sits in the article — not the order the user happened to make the
 * marks. So the primary key is the paragraph's position in
 * `article.paragraphs` (its actual order, not its `index` number: a
 * re-import may renumber, and the array is what the reader sees). Offset
 * within the paragraph is the second key, and `createdAt` then `id` break
 * the remaining ties deterministically, so two entries on the same character
 * never swap places between renders.
 *
 * ## Anchors are resolved, never guessed
 *
 * Every entry carries a resolved anchor or an explicit `stale` verdict.
 * The resolution reuses `lib/note-anchors.ts` for notes — the same
 * never-guess rule the article's underline uses, so the drawer and the text
 * can never disagree about which sentence a note is about — and applies the
 * equivalent check to a highlight: the stored offsets must still slice the
 * paragraph's current text into exactly the quote that was captured. An
 * entry whose anchor fails is still listed and still readable; it simply
 * says 原文位置已失效 instead of jumping somewhere plausible.
 */

import { noteSlices } from "./note-anchors";
import type { Highlight, Note, NoteStatus, Paragraph } from "./types";

/** Which slice of the list the reader is looking at. */
export type NotebookFilter = "all" | "qa" | "highlight";

/**
 * The filter row, in display order.
 *
 * Labels are Chinese and name the two record kinds by what the reader made,
 * not by the store's vocabulary: an AI note is 问答 (the question and its
 * answer), a highlight is 高亮与备注 (the mark, plus the remark if any).
 */
export const NOTEBOOK_FILTERS: { key: NotebookFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "qa", label: "AI问答" },
  { key: "highlight", label: "高亮与备注" },
];

/**
 * The one sentence shown when an anchor can no longer be placed.
 *
 * Deliberately a statement about the *record*, not about the reader's
 * action: the note is intact, it is the original text that moved. Shown
 * verbatim by the drawer, the popover and the export so the same failure
 * never reads two different ways.
 */
export const ANCHOR_STALE_MESSAGE = "原文位置已失效";

/** Human labels for a run's lifecycle, shared by the drawer and the export. */
export const NOTE_STATUS_LABEL: Record<NoteStatus, string> = {
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** Where an entry sits in the article, as the sort key. */
export type EntryPosition = {
  /** Index of the paragraph in `article.paragraphs`; `UNPLACED` when absent. */
  order: number;
  paragraphIndex: number;
  offset: number;
  createdAt: number;
  id: string;
};

/**
 * The verdict on one entry's stored anchor.
 *
 * `ok` carries the exact range, so the caller never has to re-derive it —
 * and so a test can assert the *numbers* rather than inferring them from
 * where something ended up on screen.
 */
export type AnchorResolution =
  | { ok: true; paragraphIndex: number; start: number; end: number }
  | { ok: false; reason: "stale" };

export type NotebookEntry =
  | {
      kind: "qa";
      /** Stable React key; the two id spaces are independent. */
      key: string;
      id: string;
      note: Note;
      position: EntryPosition;
      anchor: AnchorResolution;
      status: NoteStatus;
    }
  | {
      kind: "highlight";
      key: string;
      id: string;
      highlight: Highlight;
      position: EntryPosition;
      anchor: AnchorResolution;
    };

export type NotebookCounts = { all: number; qa: number; highlight: number };

/** Sorts after every placed entry. */
const UNPLACED = Number.POSITIVE_INFINITY;

/** Paragraph index → its position in the article's own array. */
export function paragraphOrder(paragraphs: Paragraph[]): Map<number, number> {
  const order = new Map<number, number>();
  paragraphs.forEach((paragraph, i) => {
    // First occurrence wins: a document that repeated an index would
    // otherwise order by the last one, and the renderer draws both.
    if (!order.has(paragraph.index)) order.set(paragraph.index, i);
  });
  return order;
}

/**
 * The reading-order comparator.
 *
 * Total and stable: every branch falls through to `createdAt` and then to
 * the id, so two entries can never compare equal unless they are the same
 * record. `UNPLACED` is handled explicitly rather than by arithmetic —
 * `Infinity - Infinity` is `NaN`, and a `NaN` comparator silently leaves the
 * array in whatever order `sort` happened to produce.
 */
export function comparePositions(a: EntryPosition, b: EntryPosition): number {
  if (a.order !== b.order) {
    if (a.order === UNPLACED) return 1;
    if (b.order === UNPLACED) return -1;
    return a.order - b.order;
  }
  if (a.offset !== b.offset) return a.offset - b.offset;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Where a highlight still sits in the current text, or why it does not.
 *
 * The offsets have to be whole, in range and to slice out *exactly* the
 * quote captured at creation time. Anything else means the paragraph was
 * re-parsed and the same numbers now name different characters — the case
 * where jumping would look right and be wrong.
 */
export function resolveHighlightAnchor(
  highlight: Highlight,
  paragraphs: Paragraph[],
): AnchorResolution {
  const paragraph = paragraphs.find((p) => p.index === highlight.paragraphIndex);
  if (!paragraph) return { ok: false, reason: "stale" };
  const start = highlight.startOffset;
  const end = highlight.endOffset;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > paragraph.text.length
  ) {
    return { ok: false, reason: "stale" };
  }
  if (paragraph.text.slice(start, end) !== highlight.selectionText) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, paragraphIndex: paragraph.index, start, end };
}

/**
 * Where a note's quote still sits, or why it does not.
 *
 * Delegated to `noteSlices`, which is the reader's own rule for drawing the
 * underline: a repeated quote with no offsets, offsets that no longer match,
 * a block id that now names a different paragraph — all of them resolve to
 * "no anchor" there, and therefore to `stale` here. A note with several
 * slices (a selection that crossed a paragraph boundary) resolves to its
 * first, which is where the reader began.
 */
export function resolveNoteAnchor(
  note: Note,
  paragraphs: Paragraph[],
): AnchorResolution {
  const [slice] = noteSlices(note, paragraphs);
  if (!slice) return { ok: false, reason: "stale" };
  return {
    ok: true,
    paragraphIndex: slice.paragraphIndex,
    start: slice.start,
    end: slice.end,
  };
}

/** This client's terminal-or-live state for a note. */
export function noteStatus(note: Note): NoteStatus {
  if (note.isStreaming) return "running";
  return note.localStatus ?? note.remoteStatus ?? "succeeded";
}

/**
 * Merge the two record kinds into one list, in reading order.
 *
 * The caller decides which notes belong to the displayed version; notes
 * anchored to another version describe text that is not on screen and are
 * passed separately so they can be listed without a jump.
 */
export function notebookEntries(input: {
  notes: Note[];
  highlights: Highlight[];
  paragraphs: Paragraph[];
}): NotebookEntry[] {
  const order = paragraphOrder(input.paragraphs);
  const entries: NotebookEntry[] = [];

  for (const note of input.notes) {
    // Ordering uses the *start* of a cross-paragraph selection; the label
    // still shows `note.paragraphIndex`, which is what the rail shows.
    const anchorIndex = note.startParagraphIndex ?? note.paragraphIndex;
    entries.push({
      kind: "qa",
      key: `qa:${note.id}`,
      id: note.id,
      note,
      position: {
        order: order.get(anchorIndex) ?? UNPLACED,
        paragraphIndex: anchorIndex,
        offset: note.startOffset ?? 0,
        createdAt: note.createdAt,
        id: note.id,
      },
      anchor: resolveNoteAnchor(note, input.paragraphs),
      status: noteStatus(note),
    });
  }

  for (const highlight of input.highlights) {
    entries.push({
      kind: "highlight",
      key: `hl:${highlight.id}`,
      id: highlight.id,
      highlight,
      position: {
        order: order.get(highlight.paragraphIndex) ?? UNPLACED,
        paragraphIndex: highlight.paragraphIndex,
        offset: highlight.startOffset,
        createdAt: highlight.createdAt,
        id: highlight.id,
      },
      anchor: resolveHighlightAnchor(highlight, input.paragraphs),
    });
  }

  return entries.sort((a, b) => comparePositions(a.position, b.position));
}

export function filterEntries(
  entries: NotebookEntry[],
  filter: NotebookFilter,
): NotebookEntry[] {
  if (filter === "all") return entries;
  if (filter === "qa") return entries.filter((e) => e.kind === "qa");
  return entries.filter((e) => e.kind === "highlight");
}

/** Counts for the filter row. Always over the unfiltered list. */
export function notebookCounts(entries: NotebookEntry[]): NotebookCounts {
  let qa = 0;
  let highlight = 0;
  for (const entry of entries) {
    if (entry.kind === "qa") qa += 1;
    else highlight += 1;
  }
  return { all: entries.length, qa, highlight };
}

export function notebookSummary(counts: NotebookCounts): string {
  if (counts.all === 0) return "还没有任何记录";
  const parts: string[] = [];
  if (counts.qa) parts.push(`${counts.qa} 条 AI 问答`);
  if (counts.highlight) parts.push(`${counts.highlight} 条高亮与备注`);
  return parts.join("，");
}

/**
 * One exchange: a question and the answer that belongs to it.
 *
 * `status` and `live` are carried per pair, not per note, because a note's
 * turns can end differently — a first answer cancelled, a follow-up that
 * succeeded — and the note-level `localStatus` only ever describes the
 * latest run.
 */
export type QaPair = {
  question: string;
  answer: string;
  status: NoteStatus;
  /** The answer is still arriving; what is shown is a prefix. */
  live: boolean;
  /**
   * An assistant turn exists for this question.
   *
   * The distinction matters after a run that ended without producing
   * anything: the question is still there, no answer was recorded, and the
   * pair must say which of those it is rather than implying that text is on
   * its way.
   */
  answered: boolean;
};

/**
 * The line that qualifies a pair's answer, or `null` when none is needed.
 *
 * Written once and used by both the drawer and the export, so a run that
 * failed reads the same way in both — and so "incomplete" is never claimed
 * about a pair that has no text to be incomplete.
 */
export function pairStatusNote(pair: QaPair): string | null {
  if (pair.live) {
    return pair.answer.trim()
      ? "回答正在生成，以上为已收到的部分内容。"
      : "回答正在生成。";
  }
  if (pair.status === "succeeded") return null;
  const label = NOTE_STATUS_LABEL[pair.status];
  return pair.answer.trim() || pair.answered
    ? `回答${label}，内容不完整。`
    : `回答${label}，没有收到内容。`;
}

/**
 * The note's exchanges, structured when the record has structure.
 *
 * `turns` is authoritative whenever it is present: the reader keeps it for
 * every note, anonymous ones included, and it is the only thing that
 * preserves where one exchange ends and the next begins.
 *
 * The flattened `answer` is used **only** when there are no turns — a note
 * restored from an older backup, or one the server returned without a
 * history. Rendering both would double every answer, because `answer`
 * accumulates the same text the turns carry.
 *
 * The answer currently streaming is likewise *not* read from `answer`: the
 * assistant turn is appended when the run ends, so while it is in flight the
 * partial text exists only in `activeTurnText`. That is what keeps the live
 * row from appearing twice — once as the turn, once as the flattened answer.
 */
export function qaPairs(note: Note): QaPair[] {
  const turns = note.turns ?? [];

  if (turns.length === 0) {
    if (!note.question && !note.answer) return [];
    return [
      {
        question: note.question,
        answer: note.answer,
        status: noteStatus(note),
        live: note.isStreaming,
        answered: note.answer.trim().length > 0,
      },
    ];
  }

  const pairs: QaPair[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      pairs.push({
        question: turn.content,
        answer: "",
        status: "running",
        live: false,
        answered: false,
      });
      continue;
    }
    const pair = pairs[pairs.length - 1];
    const status: NoteStatus = turn.status ?? "succeeded";
    if (!pair) {
      // An assistant turn with no question before it: a history the reader
      // cannot explain, kept rather than dropped.
      pairs.push({
        question: "",
        answer: turn.content,
        status,
        live: false,
        answered: true,
      });
      continue;
    }
    pair.answer = turn.content;
    pair.status = status;
    pair.answered = true;
  }

  // A question whose run has not finished. The status comes from the note
  // rather than from the placeholder, so a run that was interrupted or
  // cancelled without producing a turn reports *that* instead of an
  // indefinite "生成中".
  const last = pairs[pairs.length - 1];
  if (last && !last.answered) {
    last.live = note.isStreaming;
    last.status = note.isStreaming ? "running" : noteStatus(note);
    if (note.isStreaming && !last.answer) {
      last.answer = note.activeTurnText ?? "";
    }
  }
  return pairs;
}

/** One line, so a quote cannot break out of a Markdown blockquote. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** `YYYY-MM-DD` in the reader's own timezone. */
export function formatDay(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type NotebookMeta = {
  title: string;
  url?: string;
  author?: string;
  publishedAt?: string;
  paragraphCount: number;
};

/**
 * The whole notebook as Markdown.
 *
 * Takes the **unfiltered** entry list on purpose: the filter is a way of
 * looking at the notes, not a way of choosing which of them the reader owns,
 * so what is copied is always everything. The reading order is whatever the
 * caller sorted by, which is the same order the drawer shows.
 *
 * Only article metadata, quotes, remarks and the conversation itself are
 * written. No settings, no provider configuration, no keys, no token
 * counts, no sync identifiers — an export is a document about the text.
 */
export function notebookMarkdown(input: {
  meta: NotebookMeta;
  entries: NotebookEntry[];
  /** Notes anchored to another version: listed, never pointed at. */
  otherVersionNotes?: Note[];
  now?: number;
}): string {
  const { meta, entries } = input;
  const others = input.otherVersionNotes ?? [];
  const now = input.now ?? Date.now();
  const lines: string[] = [];

  lines.push(`# ${meta.title}`);
  const by = [meta.author, meta.publishedAt].filter(Boolean).join(" · ");
  if (by) lines.push(by);
  lines.push(meta.url ? `原文来源：${meta.url}` : "原文来源：本机粘贴或导入的正文");
  lines.push(`正文段落：${meta.paragraphCount} 段`);
  lines.push("");
  lines.push(`KoBook 笔记本导出 · ${formatDay(now)}`);
  lines.push(
    others.length > 0
      ? `共 ${entries.length + others.length} 条记录：当前正文 ${entries.length} 条，其他版本 ${others.length} 条。`
      : `共 ${entries.length} 条记录，按原文阅读顺序排列。`,
  );

  for (const entry of entries) {
    lines.push("", "---", "");

    if (entry.kind === "highlight") {
      const highlight = entry.highlight;
      lines.push(`## ¶${entry.position.paragraphIndex} · 高亮`);
      lines.push("");
      lines.push(`> ${oneLine(highlight.selectionText)}`);
      if (!entry.anchor.ok) lines.push("", `（${ANCHOR_STALE_MESSAGE}）`);
      const remark = highlight.note?.trim();
      if (remark) lines.push("", "**我的备注**", "", remark);
      continue;
    }

    const note = entry.note;
    lines.push(
      `## ¶${entry.position.paragraphIndex} · AI问答${
        note.type === "explain" ? "（解释）" : "（提问）"
      }`,
    );
    lines.push("");
    if (note.selectionText.trim()) {
      lines.push(`> ${oneLine(note.selectionText)}`);
    }
    if (!entry.anchor.ok) lines.push("", `（${ANCHOR_STALE_MESSAGE}）`);
    pushPairs(lines, note);
  }

  if (others.length > 0) {
    lines.push("", "---", "");
    lines.push("## 其他版本的笔记");
    lines.push("");
    lines.push("以下笔记锚定在文章的其它版本上，不属于当前正文，因此没有原文位置。");
    for (const note of others) {
      lines.push("", "---", "");
      lines.push(`## ¶${note.paragraphIndex} · AI问答（其它版本）`);
      lines.push("");
      if (note.selectionText.trim()) {
        lines.push(`> ${oneLine(note.selectionText)}`);
      }
      // The same structured renderer as the notes on screen. An export that
      // flattened a conversation to `note.answer` here would silently drop
      // every follow-up — and those notes are the ones the reader can no
      // longer reach from the article, so the file is often the only place
      // they can read them.
      pushPairs(lines, note);
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

/**
 * Write one note's whole conversation.
 *
 * Shared by the notes anchored to the text on screen and the ones anchored
 * to another version, so a follow-up and a run's terminal status read the
 * same way in both places. The status line is what keeps an export honest:
 * a run that failed, was cancelled or was cut off by a closed tab produced
 * only part of an answer — or none at all — and the file has to say which
 * rather than present the fragment as the whole reply.
 */
function pushPairs(lines: string[], note: Note): void {
  const pairs = qaPairs(note);
  if (pairs.length === 0) {
    lines.push("", "（没有可导出的问答内容）");
    return;
  }
  pairs.forEach((pair, i) => {
    lines.push("");
    lines.push(
      `**问${pairs.length > 1 ? ` ${i + 1}` : ""}：** ${pair.question || "（空）"}`,
    );
    lines.push("");
    lines.push(pair.answer.trim() || "（尚无回答）");
    const status = pairStatusNote(pair);
    if (status) lines.push("", `（${status}）`);
  });
}

/**
 * A download name that keeps the article's own title.
 *
 * Only characters a filesystem cannot take are replaced, and control
 * characters are dropped; CJK is left alone, because a Chinese title
 * transliterated into ASCII would be a different title. The date makes two
 * exports of the same article distinguishable without overwriting.
 */
export function notebookFilename(title: string, now: number): string {
  const safe = (title || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
    .slice(0, 80);
  return `${safe || "笔记本"}-笔记本-${formatDay(now)}.md`;
}
