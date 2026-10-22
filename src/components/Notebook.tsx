// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 笔记本 — the drawer that gathers everything marked or asked about the
 * article currently open.
 *
 * ## What it is, and what it is not
 *
 * It is a *view* of records that already exist: the same `notes` and
 * `highlights` the reader's rail renders, read straight out of the one store
 * this app has. Opening it creates nothing, copies nothing into a second
 * place and rewrites nothing, which is why an article annotated before this
 * panel existed shows up in it complete and immediately. The only writes it
 * performs are the ones the reader asks for: saving or deleting a personal
 * remark on a highlight.
 *
 * ## Why the notes rail is not replaced
 *
 * The rail is the reading surface — a card there is what the passage's
 * underline points at, and the generation running inside a card must not be
 * disturbed by opening a panel beside it. The notebook is therefore an
 * *addition*: a fixed overlay that takes no space in the reading grid, so
 * the column keeps its width, the drag handles keep their geometry, and the
 * scroll position does not move. A stream that is mid-answer when the drawer
 * opens keeps streaming into its card.
 *
 * ## Drafts
 *
 * A remark being typed is held by the caller, not by this component, and
 * this component stays mounted while closed. Both matter: a draft survives
 * the drawer closing, the article re-rendering, and a jump to the passage —
 * typing something and then pressing Escape must not throw it away.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Article, Highlight, Note, NoteStatus } from "@/lib/types";
import { MAX_HIGHLIGHT_NOTE_LENGTH } from "@/lib/types";
import { resolveHighlightColor, resolveHighlightStyle } from "@/lib/highlight";
import { useArticleParagraphs } from "@/lib/article-body";
import {
  ANCHOR_STALE_MESSAGE,
  NOTEBOOK_FILTERS,
  NOTE_STATUS_LABEL,
  filterEntries,
  notebookCounts,
  notebookEntries,
  notebookFilename,
  notebookMarkdown,
  notebookSummary,
  noteStatus,
  pairStatusNote,
  qaPairs,
  type NotebookEntry,
  type NotebookFilter,
} from "@/lib/notebook";

/** What a jump from the drawer is about, so the reader can place it. */
export type NotebookJump = { kind: "qa" | "highlight"; id: string };

/** Five lines at the answer's line height, as the folded height. */
const CLAMP_EM = "7.75em";

function ago(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

export default function Notebook({
  open,
  article,
  notes,
  otherVersionNotes,
  highlights,
  activeNoteId,
  topOffset,
  onClose,
  onJump,
  onDeleteNote,
  onDeleteHighlight,
  draftFor,
  onDraftChange,
  onSaveRemark,
  onDeleteRemark,
}: {
  open: boolean;
  article: Article;
  /** Notes anchored to the version on screen. */
  notes: Note[];
  /** Notes anchored to another version: listed, never jumped to. */
  otherVersionNotes: Note[];
  highlights: Highlight[];
  activeNoteId: string | null;
  /** Where the app's own top bar ends, so the drawer starts below it. */
  topOffset: number;
  onClose: () => void;
  onJump: (jump: NotebookJump) => void;
  onDeleteNote: (id: string) => void;
  onDeleteHighlight: (id: string) => void;
  draftFor: (highlightId: string) => string;
  onDraftChange: (highlightId: string, value: string) => void;
  onSaveRemark: (highlightId: string) => void;
  onDeleteRemark: (highlightId: string) => void;
}) {
  const [filter, setFilter] = useState<NotebookFilter>("all");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  /** Which highlight's remark is open in the editor, if any. */
  const [editingRemark, setEditingRemark] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The article's text, which is no longer part of its record. The drawer is
  // opened from the reader, so the body is already in memory; if it is not,
  // anchors resolve as unplaced rather than throwing — the notes themselves
  // are local and never at risk.
  const paragraphs = useArticleParagraphs(article.id);
  const entries = useMemo(
    () => notebookEntries({ notes, highlights, paragraphs: [...paragraphs] }),
    [notes, highlights, paragraphs],
  );
  const counts = useMemo(() => notebookCounts(entries), [entries]);
  const shown = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  /**
   * Whether there is anything to export at all.
   *
   * Not `entries.length`: a note anchored to another version is still the
   * reader's note, and the filter row's "current article only" scope is a
   * way of *reading* the list, not a reason to withhold their own words
   * from a file they asked for. Withholding it here was a real bug — an
   * article whose only surviving notes belong to an older version had two
   * dead buttons and no way to get them out.
   */
  const exportable = entries.length > 0 || otherVersionNotes.length > 0;

  /**
   * Escape closes the drawer — but never while the reader is typing.
   *
   * A remark or a question being written is text in flight; swallowing the
   * key to close a panel would be the drawer taking a keystroke away from
   * the field it just focused.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(input|textarea|select)$/i.test(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /**
   * Move focus into the drawer when it opens.
   *
   * `preventScroll` is the load-bearing part: focusing an element normally
   * scrolls it into view, and the drawer covers the right of the viewport —
   * a focus that scrolled the article would move the passage the reader was
   * on. The caller restores focus to whatever was focused before.
   */
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      closeRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  // Everything, regardless of the filter. The filter decides what is on
  // screen; the export is the reader's notes, and none of them are excluded
  // by a view control.
  const markdown = () =>
    notebookMarkdown({
      meta: {
        title: article.title,
        url: article.url,
        author: article.author,
        publishedAt: article.publishedAt,
        paragraphCount: article.bodyStats.paragraphs,
      },
      entries,
      otherVersionNotes,
    });

  async function copyAll() {
    setCopyError(null);
    const text = markdown();
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("当前环境不支持剪贴板");
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      // Never swallowed: a copy that silently did nothing is the failure
      // mode this exists to prevent, so the reason is shown and the
      // download button is named as the way that always works.
      setCopyError(
        `复制失败：${error instanceof Error ? error.message : String(error)}。可改用“下载 Markdown”。`,
      );
    }
  }

  function download() {
    const now = Date.now();
    const blob = new Blob([markdown()], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = notebookFilename(article.title, now);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on a later task so the download has the URL in hand; revoked
    // at all so a long reading session does not accumulate blobs.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <aside
      aria-label="笔记本"
      data-testid="notebook"
      className="fixed right-0 bottom-0 z-40 flex w-full flex-col overflow-hidden border-l border-gloss-border bg-gloss-surface shadow-2xl sm:w-[420px]"
      style={{ top: topOffset }}
    >
      <header className="shrink-0 border-b border-gloss-border px-4 pb-3 pt-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-lg leading-tight">笔记本</h2>
            <p
              className="mt-1 text-xs text-gloss-textDim"
              data-testid="notebook-summary"
            >
              {counts.all === 0 && otherVersionNotes.length > 0
                ? `${otherVersionNotes.length} 条其他版本的笔记`
                : notebookSummary(counts)}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭笔记本"
            data-testid="notebook-close"
            className="grid h-8 w-8 place-items-center rounded-full text-gloss-textDim hover:bg-gloss-surface2 hover:text-gloss-text"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copyAll()}
            disabled={!exportable}
            aria-label="复制 Markdown"
            data-testid="notebook-copy"
            className="rounded border border-gloss-border px-2 py-1 text-xs text-gloss-textDim hover:text-gloss-text disabled:opacity-40"
          >
            {copied ? "已复制 ✓" : "复制 Markdown"}
          </button>
          <button
            type="button"
            onClick={download}
            disabled={!exportable}
            aria-label="下载 Markdown"
            data-testid="notebook-download"
            className="rounded border border-gloss-border px-2 py-1 text-xs text-gloss-textDim hover:text-gloss-text disabled:opacity-40"
          >
            下载 Markdown
          </button>
        </div>

        {copyError ? (
          <p
            role="alert"
            data-testid="notebook-copy-error"
            className="mt-2 text-xs text-gloss-accent"
          >
            {copyError}
          </p>
        ) : null}

        {/* The filter is always present, not only when both kinds exist:
            the counts are the answer to "is anything in here", and a row
            that appears and disappears is a row the reader has to hunt for. */}
        <div
          role="group"
          aria-label="筛选"
          className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-gloss-surface2 p-[3px]"
        >
          {NOTEBOOK_FILTERS.map(({ key, label }) => {
            const count =
              key === "all" ? counts.all : key === "qa" ? counts.qa : counts.highlight;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                data-testid={`notebook-filter-${key}`}
                onClick={() => setFilter(key)}
                className={`flex h-7 items-center justify-center gap-1 rounded-md text-xs transition-colors ${
                  filter === key
                    ? "bg-gloss-surface text-gloss-text shadow-sm"
                    : "text-gloss-textDim hover:text-gloss-text"
                }`}
              >
                {label}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div
        data-testid="notebook-body"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin px-3 pb-6 pt-3"
      >
        {entries.length === 0 && otherVersionNotes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <p className="font-serif text-base text-gloss-text">
              还没有任何记录
            </p>
            <p className="mt-2 text-xs leading-relaxed text-gloss-textDim">
              选中正文里的文字提问或划线，每一条都会按原文顺序出现在这里。
            </p>
          </div>
        ) : entries.length === 0 ? null : shown.length === 0 ? (
          <p
            data-testid="notebook-filter-empty"
            className="px-2 py-8 text-center text-xs text-gloss-textDim"
          >
            此分类下暂无内容。
          </p>
        ) : (
          <ol className="space-y-2.5">
            {shown.map((entry) => (
              <li key={entry.key}>
                {entry.kind === "qa" ? (
                  <QaEntry
                    entry={entry}
                    active={activeNoteId === entry.id}
                    onJump={() => onJump({ kind: "qa", id: entry.id })}
                    onDelete={() => onDeleteNote(entry.id)}
                  />
                ) : (
                  <HighlightEntry
                    entry={entry}
                    editing={editingRemark === entry.id}
                    draft={draftFor(entry.id)}
                    onEdit={() => setEditingRemark(entry.id)}
                    onDraftChange={(value) => onDraftChange(entry.id, value)}
                    onSave={() => {
                      onSaveRemark(entry.id);
                      setEditingRemark(null);
                    }}
                    // Escape dismisses the editor without discarding what
                    // was typed; 取消 is the button that discards. The two
                    // are deliberately different: a keystroke should not be
                    // able to destroy text, and only an explicit, labelled
                    // action should.
                    onDismiss={() => setEditingRemark(null)}
                    onCancel={() => {
                      onDraftChange(entry.id, entry.highlight.note ?? "");
                      setEditingRemark(null);
                    }}
                    onDeleteRemark={() => {
                      onDeleteRemark(entry.id);
                      setEditingRemark(null);
                    }}
                    onJump={() => onJump({ kind: "highlight", id: entry.id })}
                    onDelete={() => onDeleteHighlight(entry.id)}
                  />
                )}
              </li>
            ))}
          </ol>
        )}

        {/* Other-version notes are a separate, labelled group: they belong to
            this article but not to the text on screen, so they are readable
            and carry no jump at all rather than a jump that lands on a
            sentence they were never about. */}
        {otherVersionNotes.length > 0 && filter !== "highlight" ? (
          <section
            aria-labelledby="notebook-other-versions"
            data-testid="notebook-other-versions"
            className="mt-4 border-t border-gloss-border pt-3"
          >
            <h3
              id="notebook-other-versions"
              className="px-1 text-xs font-medium text-gloss-textDim"
            >
              其他版本的笔记（{otherVersionNotes.length} 条）
            </h3>
            <p className="mt-1 px-1 text-[11px] leading-relaxed text-gloss-textDim">
              这些笔记锚定在文章的其它版本上，不是当前正文的内容，因此没有原文位置。
            </p>
            <ul className="mt-2 space-y-2">
              {otherVersionNotes.map((note) => (
                <li
                  key={note.id}
                  data-testid="notebook-other-version-note"
                  className="rounded-lg border border-gloss-border bg-gloss-bg p-3"
                >
                  <div className="flex items-center gap-2 text-[11px] text-gloss-textDim">
                    <span className="rounded bg-gloss-surface2 px-1.5 py-0.5">
                      其它版本
                    </span>
                    <span>{ago(note.createdAt)}</span>
                    <span>{NOTE_STATUS_LABEL[noteStatus(note)]}</span>
                  </div>
                  <p className="mt-2 text-xs italic text-gloss-textDim [overflow-wrap:anywhere]">
                    “{note.selectionText.slice(0, 120)}
                    {note.selectionText.length > 120 ? "…" : ""}”
                  </p>
                  <Pairs note={note} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

/** The status chip, named once so the drawer and the export agree. */
function StatusChip({ status }: { status: NoteStatus }) {
  // Only two tones: "still going" is the one the reader is waiting on, and
  // every terminal state — done, failed, cancelled, interrupted — is
  // reported in the answer's own status line rather than by colour here.
  const tone =
    status === "running" ? "text-gloss-accent" : "text-gloss-textDim";
  return (
    <span
      data-testid="notebook-status"
      data-status={status}
      className={`rounded bg-gloss-surface2 px-1.5 py-0.5 ${tone}`}
    >
      {NOTE_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * One AI note: where it is about, what was asked, what came back.
 *
 * The exchanges are rendered from the note's turns (`qaPairs`), so a
 * follow-up is a separate Q/A block rather than one run-on answer — and the
 * answer still arriving appears exactly once, as the last pair.
 */
function QaEntry({
  entry,
  active,
  onJump,
  onDelete,
}: {
  entry: Extract<NotebookEntry, { kind: "qa" }>;
  active: boolean;
  onJump: () => void;
  onDelete: () => void;
}) {
  const note = entry.note;
  return (
    <article
      data-testid="notebook-entry-qa"
      data-entry-id={note.id}
      data-entry-status={entry.status}
      data-entry-active={active ? "true" : "false"}
      className={`rounded-lg border bg-gloss-bg p-3 ${
        active ? "border-gloss-accent" : "border-gloss-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gloss-textDim">
        <JumpButton entry={entry} onJump={onJump} />
        <span className="uppercase tracking-wider">
          {note.type === "explain" ? "解释" : "提问"}
        </span>
        <StatusChip status={entry.status} />
        <span className="ml-auto">{ago(note.createdAt)}</span>
        <button
          type="button"
          onClick={onDelete}
          aria-label="删除这条问答"
          className="text-gloss-textDim hover:text-gloss-accent"
        >
          ✕
        </button>
      </div>

      {note.selectionText.trim() ? (
        <p className="mt-2 border-l-2 border-gloss-border pl-2 text-xs italic leading-relaxed text-gloss-textDim [overflow-wrap:anywhere]">
          “{note.selectionText.slice(0, 120)}
          {note.selectionText.length > 120 ? "…" : ""}”
        </p>
      ) : null}

      <Pairs note={note} />
    </article>
  );
}

/**
 * One note's conversation, as Q/A blocks.
 *
 * Shared by the notes on screen and the ones anchored to another version,
 * so a follow-up and a run's terminal status cannot read two different ways
 * depending on which group a note happens to be in. The exchanges come from
 * `qaPairs`, which is also what the Markdown export writes — one renderer
 * for the conversation, in both directions.
 */
function Pairs({ note }: { note: Note }) {
  const pairs = qaPairs(note);
  if (pairs.length === 0) {
    return (
      <p className="mt-3 text-xs italic text-gloss-textDim">（没有内容）</p>
    );
  }
  return (
    <div className="mt-3 space-y-3">
      {pairs.map((pair, i) => (
        <div
          key={i}
          data-testid="notebook-qa-pair"
          data-pair-status={pair.status}
          data-pair-live={pair.live ? "true" : "false"}
          className={i > 0 ? "border-t border-gloss-border pt-3" : ""}
        >
          <div className="grid grid-cols-[16px_minmax(0,1fr)] items-baseline gap-x-2">
            <span
              aria-hidden="true"
              className="text-[11px] font-semibold leading-none text-gloss-accent"
            >
              Q
            </span>
            <p className="font-serif text-sm leading-snug text-gloss-text [overflow-wrap:anywhere]">
              {pair.question || "（空）"}
            </p>
          </div>
          <div className="mt-1.5 grid grid-cols-[16px_minmax(0,1fr)] items-baseline gap-x-2">
            <span
              aria-hidden="true"
              className="text-[11px] font-semibold leading-none text-gloss-textDim"
            >
              A
            </span>
            <div className="min-w-0">
              {pair.answer.trim() ? (
                <Clamp watch={pair.answer} label="回答">
                  <p
                    className={`whitespace-pre-wrap text-sm leading-relaxed text-gloss-text [overflow-wrap:anywhere] ${
                      pair.live ? "streaming-cursor" : ""
                    }`}
                  >
                    {pair.answer}
                  </p>
                </Clamp>
              ) : (
                <p className="text-sm italic text-gloss-textDim">
                  {pair.live ? "正在思考…" : "（尚无回答）"}
                </p>
              )}
              {pairStatusNote(pair) ? (
                <p className="mt-1 text-[11px] text-gloss-accent">
                  {pairStatusNote(pair)}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Fold a long answer to five lines, with one control to open it.
 *
 * Measured rather than assumed: the button appears only when the content
 * actually overflows, because a "展开全文" that expands nothing is a control
 * that lies about what is on screen.
 */
function Clamp({
  watch,
  label,
  children,
}: {
  watch: string;
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOver(el.scrollHeight > el.clientHeight + 2);
  }, [watch, open]);
  return (
    <>
      <div
        ref={ref}
        style={open ? undefined : { maxHeight: CLAMP_EM, overflow: "hidden" }}
      >
        {children}
      </div>
      {over || open ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "收起" : "展开"}${label}全文`}
          data-testid="notebook-clamp-toggle"
          className="mt-1 text-[11px] font-medium text-gloss-textDim hover:text-gloss-text"
        >
          {open ? "收起" : "展开全文"}
        </button>
      ) : null}
    </>
  );
}

/**
 * One highlight, its personal remark, and the two separate delete actions.
 *
 * The distinction the labels carry is the whole point: 删除备注 removes only
 * what the reader wrote and leaves the mark exactly where it was, while
 * 删除高亮 removes the mark — and, with it, the remark, because a remark
 * about a passage that is no longer marked has nothing to hang off.
 */
function HighlightEntry({
  entry,
  editing,
  draft,
  onEdit,
  onDraftChange,
  onSave,
  onDismiss,
  onCancel,
  onDeleteRemark,
  onJump,
  onDelete,
}: {
  entry: Extract<NotebookEntry, { kind: "highlight" }>;
  editing: boolean;
  draft: string;
  onEdit: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  /** Close the editor, keeping the draft. */
  onDismiss: () => void;
  /** Close the editor and discard the draft. */
  onCancel: () => void;
  onDeleteRemark: () => void;
  onJump: () => void;
  onDelete: () => void;
}) {
  const highlight = entry.highlight;
  const remark = highlight.note?.trim() ?? "";
  const dirty = draft.trim() !== remark;
  return (
    <article
      data-testid="notebook-entry-highlight"
      data-entry-id={highlight.id}
      data-entry-has-remark={remark ? "true" : "false"}
      className="rounded-lg border border-gloss-border bg-gloss-bg p-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-gloss-textDim">
        <JumpButton entry={entry} onJump={onJump} />
        <span className="uppercase tracking-wider">
          {remark ? "高亮与备注" : "高亮"}
        </span>
        <span className="ml-auto">{ago(highlight.createdAt)}</span>
        <button
          type="button"
          onClick={onDelete}
          aria-label="删除这条高亮"
          className="text-gloss-textDim hover:text-gloss-accent"
        >
          ✕
        </button>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-gloss-text [overflow-wrap:anywhere]">
        <mark
          className="gloss-mark"
          data-color={resolveHighlightColor(highlight.color)}
          data-style={resolveHighlightStyle(highlight.style)}
        >
          {highlight.selectionText}
        </mark>
      </p>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            rows={3}
            // The same bound the backup schema and the store use, so a
            // remark can never be typed to a length the format refuses.
            maxLength={MAX_HIGHLIGHT_NOTE_LENGTH}
            aria-label="个人备注"
            data-testid="notebook-remark-input"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Dismiss, do not discard: the drawer's own Escape closes
                // the drawer, and neither keystroke should be able to
                // destroy text the reader typed.
                event.preventDefault();
                event.stopPropagation();
                onDismiss();
              }
            }}
            placeholder="写一条只属于自己的备注…"
            className="w-full resize-y rounded border border-gloss-border bg-transparent px-2 py-1 text-xs outline-none focus:border-gloss-accent/50"
          />
          <div className="mt-1 flex items-center gap-1">
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty}
              data-testid="notebook-remark-save"
              className="rounded bg-gloss-text px-2 py-1 text-xs font-medium text-gloss-bg disabled:opacity-30"
            >
              保存备注
            </button>
            <button
              type="button"
              onClick={onCancel}
              data-testid="notebook-remark-cancel"
              className="rounded px-2 py-1 text-xs text-gloss-textDim hover:text-gloss-text"
            >
              取消
            </button>
            {remark ? (
              <button
                type="button"
                onClick={onDeleteRemark}
                data-testid="notebook-remark-delete"
                className="ml-auto rounded px-2 py-1 text-xs text-gloss-textDim hover:text-gloss-accent"
              >
                删除备注（保留高亮）
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-2">
          {remark ? (
            <p
              data-testid="notebook-remark"
              className="whitespace-pre-wrap text-sm leading-relaxed text-gloss-text [overflow-wrap:anywhere]"
            >
              {remark}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onEdit}
            data-testid="notebook-remark-edit"
            className="mt-1 text-[11px] font-medium text-gloss-textDim hover:text-gloss-text"
          >
            {remark ? "编辑备注" : "添加备注"}
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * The passage link, or the reason there is none.
 *
 * A resolved anchor yields the exact range, and it is exposed as data
 * attributes so what the drawer resolved is inspectable rather than
 * inferred. An unresolved one is not a dead button with a tooltip: the
 * label *is* the message, and the control is disabled so nothing suggests a
 * jump that will not happen.
 */
function JumpButton({
  entry,
  onJump,
}: {
  entry: NotebookEntry;
  onJump: () => void;
}) {
  const anchor = entry.anchor;
  return (
    <button
      type="button"
      disabled={!anchor.ok}
      onClick={onJump}
      data-testid="notebook-jump"
      data-jump-kind={entry.kind}
      data-jump-id={entry.id}
      data-jump-paragraph={anchor.ok ? anchor.paragraphIndex : undefined}
      data-jump-start={anchor.ok ? anchor.start : undefined}
      data-jump-end={anchor.ok ? anchor.end : undefined}
      title={anchor.ok ? "定位到原文" : ANCHOR_STALE_MESSAGE}
      className="rounded px-1.5 py-0.5 text-gloss-accent hover:bg-gloss-surface2 disabled:text-gloss-textDim disabled:hover:bg-transparent"
    >
      {anchor.ok ? `¶${entry.position.paragraphIndex} 定位原文` : ANCHOR_STALE_MESSAGE}
    </button>
  );
}
