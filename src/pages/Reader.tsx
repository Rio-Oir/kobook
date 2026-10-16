// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "@/lib/store";
import { streamChat, useModelInfo, type StreamUsage } from "@/lib/ai";
import ThemeToggle from "@/components/ThemeToggle";
import { buildExplainMessages } from "@/lib/explain";
import { buildAskMessages } from "@/lib/ask";
import { generateBrief } from "@/lib/brief";
import { rangeToOffsets, boundaryOffset, segmentBlock } from "@/lib/text-offset";
import {
  blockKindOf,
  groupBlocks,
  headingTag,
  outlineOf,
  type OutlineEntry,
} from "@/lib/blocks";
import {
  persistAnswer,
  persistFollowUpQuestion,
  persistNote,
  removeNote as removeRemoteNote,
  retryArticleSync,
  syncNotesFromServer,
} from "@/lib/cloud/bridge";
import {
  isServerArticle,
  markLocalStatus,
  markStaleStreamsInterrupted,
  mintTurnId,
  startActiveTurn,
  type NoteAnchor,
} from "@/lib/note-lifecycle";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_LABEL,
  HIGHLIGHT_STYLES,
  HIGHLIGHT_STYLE_LABEL,
  resolveHighlightColor,
  resolveHighlightStyle,
} from "@/lib/highlight";
import type {
  Article,
  Highlight,
  HighlightColor,
  HighlightStyle,
  InlineMarkKind,
  NoteType,
  Paragraph,
} from "@/lib/types";
import SettingsPanel from "@/components/SettingsPanel";
import { safeHostname } from "@/lib/utils";
import { currentSessionEpoch } from "@/lib/session-epoch";

/**
 * A guard that decides whether a stream callback may still touch the store.
 *
 * Three things can make a callback late: the note was deleted, a newer run
 * superseded this one on the same note, or the account changed underneath
 * (sign-out, switch, migration). Any of them means the text this callback
 * is about to append belongs to a different world — a card that no longer
 * exists, a run the user replaced, or an account that must not receive it.
 *
 * The check runs *before* every mutation rather than once at the end,
 * because the interesting failures are the ones that happen in between: a
 * chunk that lands after a sign-out would otherwise be written into
 * whatever store is current by then.
 */
function makeTurnGuard(noteId: string, turnId: string): () => boolean {
  const owner = useStore.getState().ownerUserId;
  const epoch = currentSessionEpoch();
  return () => {
    if (currentSessionEpoch() !== epoch) return false;
    const state = useStore.getState();
    if (state.ownerUserId !== owner) return false;
    const note = state.notes[noteId];
    if (!note) return false;
    if (note.activeTurnId !== turnId) return false;
    return true;
  };
}

type SelectionInfo = {
  /** Trimmed text — what the note/prompt shows. */
  text: string;
  paragraphIndex: number;
  /**
   * Raw `[start, end)` indices into the paragraph's stored text,
   * computed from the live Range before any trimming. `null` when the
   * range could not be mapped (see `rangeToOffsets`); highlighting
   * needs them, explain/ask do not.
   */
  startOffset: number | null;
  endOffset: number | null;
  /**
   * The paragraph the selection *ends* in, and the offsets measured
   * from that end. Equal to the start when the selection is inside one
   * paragraph — which is the common case — and different when the user
   * dragged across a paragraph boundary. The server validates the full
   * `[start:startOffset, end:endOffset)` range, so a multi-paragraph
   * note has to carry both ends or it cannot be anchored at all.
   */
  endParagraphIndex: number;
  endParagraphEndOffset: number | null;
  /** Parse-layer block ids at each end, when the paragraph has one. */
  startBlockId?: string;
  endBlockId?: string;
  rect: DOMRect;
};

export default function Reader({ articleId }: { articleId: string }) {
  const article = useStore((s) => s.articles[articleId]);
  /**
   * Notes belonging to the document currently on screen.
   *
   * A refresh writes a new version, and notes anchored to the old one still
   * describe the old text — rendering them beside the new paragraphs would
   * attribute an annotation to a sentence it was never about. So the
   * default view is the displayed version, and the ones from other versions
   * are counted and reachable rather than hidden: an old note must stay
   * readable, and "readable" cannot be allowed to mean "invisible".
   *
   * A note with no recorded version is a local-only note from before
   * versions were tracked; it is shown rather than silently dropped.
   */
  const allNotes = useStore(
    useShallow((s) =>
      Object.values(s.notes)
        .filter((n) => n.articleId === articleId)
        .sort((a, b) => a.createdAt - b.createdAt),
    ),
  );
  const displayedVersionId = article?.versionId;
  const notes = useMemo(
    () =>
      allNotes.filter(
        (n) =>
          n.remoteVersionId === undefined ||
          displayedVersionId === undefined ||
          n.remoteVersionId === displayedVersionId,
      ),
    [allNotes, displayedVersionId],
  );
  const otherVersionNotes = useMemo(
    () =>
      allNotes.filter(
        (n) =>
          n.remoteVersionId !== undefined &&
          displayedVersionId !== undefined &&
          n.remoteVersionId !== displayedVersionId,
      ),
    [allNotes, displayedVersionId],
  );
  const addNote = useStore((s) => s.addNote);
  const appendToNote = useStore((s) => s.appendToNote);
  const finishNote = useStore((s) => s.finishNote);
  const setBrief = useStore((s) => s.setBrief);
  const highlights = useStore(
    useShallow((s) =>
      Object.values(s.highlights).filter((h) => h.articleId === articleId),
    ),
  );
  const addHighlight = useStore((s) => s.addHighlight);
  const setHighlightColor = useStore((s) => s.setHighlightColor);
  const setHighlightStyle = useStore((s) => s.setHighlightStyle);
  const deleteHighlight = useStore((s) => s.deleteHighlight);
  const highlightColor = useStore((s) => s.highlightColor);
  const highlightStyle = useStore((s) => s.highlightStyle);
  const setHighlightPrefs = useStore((s) => s.setHighlightPrefs);
  const outlineOpen = useStore((s) => s.outlineOpen);
  const setOutlineOpen = useStore((s) => s.setOutlineOpen);

  // Save the token usage from a completed stream onto the note so the
  // user can see the cache hit (or miss) at the bottom of the card.
  function attachUsage(noteId: string, u: StreamUsage) {
    applyUsage(noteId, u);
  }

  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [askOpen, setAskOpen] = useState<SelectionInfo | null>(null);
  const [askQuestion, setAskQuestion] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Whether the notes anchored on *other* versions are expanded. */
  const [showOtherVersions, setShowOtherVersions] = useState(false);
  /**
   * Which highlight's manage-popover is open, plus where to draw it.
   * Only one at a time — the popover is a transient edit affordance,
   * not a panel.
   */
  const [openHighlight, setOpenHighlight] = useState<
    { id: string; rect: DOMRect } | null
  >(null);
  const articleRef = useRef<HTMLDivElement>(null);
  // Widened from `HTMLParagraphElement`: a block may now render as a
  // heading, a list item, a blockquote or a code wrapper.
  const paragraphRefs = useRef<Record<number, HTMLElement | null>>({});
  /**
   * A single AbortController per page instance. Only the in-flight
   * explain/ask request that started from the article's selection bar is
   * tracked here; NoteCard's follow-up stream has its own controller so
   * the two do not cancel each other. `abortAllStreams` is also available
   * for the global "drop everything" cases (sign-out, account switch).
   */
  const streamControllerRef = useRef<AbortController | null>(null);
  const modelInfo = useModelInfo();

  // Abort the in-flight stream on unmount, so switching articles mid-stream
  // does not keep appending to the previous note after navigation.
  useEffect(() => {
    return () => {
      streamControllerRef.current?.abort();
      streamControllerRef.current = null;
    };
  }, [articleId]);

  // Keep hooks before the missing-article return so route changes are safe.
  const wordPrompts = useMemo(() => {
    if (!selection || selection.text.split(/\s+/).length > 2) return [];
    return [
      `为什么这里使用“${selection.text}”？`,
      `“${selection.text}”有什么来源？`,
      `请用“${selection.text}”造一个句子。`,
    ];
  }, [selection]);

  // Block structure. The parse layer already classifies every block and
  // records heading depth; these two derivations are what turn that back
  // into a structured page instead of a flat stack of paragraphs.
  // `article` can be undefined here (the missing-article branch returns
  // later), hence the `?? []`.
  const blockGroups = useMemo(
    () => groupBlocks(article?.paragraphs ?? []),
    [article?.paragraphs],
  );
  const outline = useMemo(
    () => outlineOf(article?.paragraphs ?? []),
    [article?.paragraphs],
  );

  // Pull the account's server-side notes for this article, once per
  // article. Anonymous readers and locally-imported articles have
  // nothing to pull, and both cases are no-ops rather than errors.
  //
  // This is a *merge*: only rows the server returned are inserted, and
  // only matched by their remote id. A local-only note written while
  // signed out is left exactly where it is, so opening an article after
  // signing in never silently uploads it — that is a choice the user
  // makes on the account page.
  useEffect(() => {
    let cancelled = false;
    // A note still flagged streaming at mount cannot have a live stream
    // behind it (see `markStaleStreamsInterrupted`), so record it as
    // interrupted before the server list is merged — otherwise the
    // merge would overwrite the partial text with the server's
    // still-"running" row.
    markStaleStreamsInterrupted(articleId);
    void syncNotesFromServer(articleId).catch((err: unknown) => {
      if (!cancelled) {
        console.warn(
          "[reader] cloud notes unavailable:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [articleId]);

  // Open brief automatically if it already exists
  useEffect(() => {
    if (article?.brief) setBriefOpen(true);
  }, [article?.brief]);

  // Track selection within the article
  useEffect(() => {
    function onSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el =
        container.nodeType === 3
          ? (container.parentElement as HTMLElement)
          : (container as HTMLElement);
      let pEl = el.closest<HTMLElement>("[data-paragraph-index]");
      if (!pEl) {
        // A selection that spans paragraphs has `.gloss-prose` (or
        // `<main>`) as its common ancestor, and neither sits inside a
        // paragraph — so `.closest` finds nothing and the old code
        // silently dropped the whole selection: no toolbar, no way to
        // ask about the text the user had just dragged over. Fall back
        // to the paragraph the selection *starts* in so explain/ask
        // still work. Highlighting stays disabled for that case,
        // which is honest: one highlight cannot span two paragraphs.
        const startEl =
          range.startContainer.nodeType === 3
            ? (range.startContainer.parentElement as HTMLElement | null)
            : (range.startContainer as HTMLElement);
        pEl = startEl?.closest<HTMLElement>("[data-paragraph-index]") ?? null;
      }
      if (!pEl || !articleRef.current?.contains(pEl)) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 1) {
        setSelection(null);
        return;
      }
      const paragraphIndex = parseInt(
        pEl.getAttribute("data-paragraph-index") || "0",
        10,
      );
      // Offsets come from the *raw* range, before `.trim()`. Trimming
      // first would shift every offset by the number of leading
      // whitespace characters the user happened to drag across, so
      // the stored anchor would not line up with `paragraph.text`.
      const offsets = rangeToOffsets(pEl, range);
      const rect = range.getBoundingClientRect();

      // Where the selection *ends*. For a drag inside one paragraph
      // this is the same element and the same offsets; for a drag that
      // crosses a paragraph boundary it is a different `<p>`, and the
      // server needs both ends to reconstruct the range it validates.
      const endEl =
        (range.endContainer.nodeType === 3
          ? (range.endContainer.parentElement as HTMLElement | null)
          : (range.endContainer as HTMLElement))?.closest<HTMLElement>(
          "[data-paragraph-index]",
        ) ?? null;
      const endParagraphIndex = endEl?.hasAttribute("data-paragraph-index")
        ? parseInt(endEl.getAttribute("data-paragraph-index") || "0", 10)
        : paragraphIndex;
      const endOffset =
        endEl?.hasAttribute("data-paragraph-index") && endEl !== pEl
          ? boundaryOffset(endEl, range.endContainer, range.endOffset)
          : (offsets?.end ?? null);

      setSelection({
        text,
        paragraphIndex,
        startOffset: offsets?.start ?? null,
        endOffset: offsets?.end ?? null,
        endParagraphIndex,
        endParagraphEndOffset: endOffset,
        ...(pEl.getAttribute("data-block-id")
          ? { startBlockId: pEl.getAttribute("data-block-id") as string }
          : {}),
        ...(endEl?.getAttribute("data-block-id")
          ? { endBlockId: endEl.getAttribute("data-block-id") as string }
          : {}),
        rect,
      });
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  if (!article) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-gloss-textDim mb-4">文章不存在或已被删除。</div>
          <a
            href="#/"
            className="text-gloss-accent hover:underline text-sm"
          >
            ← 返回首页
          </a>
        </div>
      </div>
    );
  }

  /**
   * Mark the current selection in the given colour, using the shape
   * the user last picked (or the default).
   *
   * The stored `selectionText` is re-derived from the paragraph text
   * via the offsets rather than taken from `sel.toString()`, so the
   * anchor and its quote are guaranteed to agree — the same invariant
   * the server-side validator enforces, checked here before the value
   * ever leaves the client.
   *
   * Applying also records the colour as the *current* one, which
   * repaints the live text selection (`data-sel-color` on `<html>`)
   * so the next drag previews the colour that a click will produce.
   */
  function handleHighlight(color: HighlightColor) {
    if (!selection || !article) return;
    const { startOffset, endOffset, paragraphIndex } = selection;
    if (startOffset === null || endOffset === null || endOffset <= startOffset) {
      return;
    }
    const paragraph = article.paragraphs.find((p) => p.index === paragraphIndex);
    if (!paragraph) return;
    addHighlight({
      articleId: article.id,
      paragraphIndex,
      startOffset,
      endOffset,
      selectionText: paragraph.text.slice(startOffset, endOffset),
      color,
      style: highlightStyle,
    });
    setHighlightPrefs({ color });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  /**
   * Change the shape the next highlight will be drawn in.
   *
   * Deliberately does *not* mark anything: the selection toolbar
   * disappears as soon as a mark is created (segmenting the paragraph
   * replaces the text nodes the selection was anchored to), so a
   * shape picked here can only ever apply to the mark the user is
   * about to make. Changing an existing mark's shape is what the
   * manage-popover is for.
   */
  function handleHighlightStyle(style: HighlightStyle) {
    setHighlightPrefs({ style });
  }

  /**
   * Build the server-side anchor for a note.
   *
   * The range is the load-bearing part: the server reconstructs the
   * selection from the version's stored text along these coordinates
   * and requires the result to equal `selectionText`, so a local note
   * whose offsets were lost to a boundary the browser could not map
   * still gets *sent* — with the offsets omitted — and is then either
   * accepted under the legacy containment rule or kept local-only.
   * Sending nothing would be the worse choice: the user would have a
   * note that silently never syncs.
   */
  function anchorFor(
    sel: SelectionInfo,
    type: NoteType,
    selectionText: string,
    question: string,
  ): NoteAnchor {
    return {
      paragraphIndex: sel.paragraphIndex,
      type,
      selectionText,
      question,
      model: modelInfo.name,
      startParagraphIndex: sel.paragraphIndex,
      ...(sel.startOffset !== null ? { startOffset: sel.startOffset } : {}),
      endParagraphIndex: sel.endParagraphIndex,
      ...(sel.endParagraphEndOffset !== null
        ? { endOffset: sel.endParagraphEndOffset }
        : sel.endOffset !== null
          ? { endOffset: sel.endOffset }
          : {}),
      ...(sel.startBlockId ? { startBlockId: sel.startBlockId } : {}),
      ...(sel.endBlockId ? { endBlockId: sel.endBlockId } : {}),
    };
  }

  function handleExplain(sel = selection) {
    if (!sel || !article) return;
    const messages = buildExplainMessages(article, sel.text);
    const question = `解释：${sel.text.slice(0, 80)}`;
    const noteId = addNote({
      articleId: article.id,
      // The version this note is being anchored to. Recorded locally as
      // well as sent, so the Reader can tell which notes belong to the
      // document currently on screen.
      remoteVersionId: article.versionId,
      paragraphIndex: sel.paragraphIndex,
      type: "explain",
      selectionText: sel.text,
      question,
      answer: "",
      model: modelInfo.name,
    });
    // Mirror to the server when there is an account and a server-side
    // article to attach to. Deliberately not awaited: the card and the
    // stream must not wait on a round trip.
    void persistNote(noteId, article.id, anchorFor(sel, "explain", sel.text, question));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    streamControllerRef.current?.abort();
    const controller = new AbortController();
    streamControllerRef.current = controller;
    let streamed = "";
    // Minted once, when the turn starts, and reused by every completion
    // path and every retry: that is what makes the server-side key
    // stable. A counter recomputed later collides with an earlier turn.
    const answerTurnId = mintTurnId();
    startActiveTurn(noteId, answerTurnId);
    const guard = makeTurnGuard(noteId, answerTurnId);
    streamChat({
      signal: controller.signal,
      messages,
      onChunk: (delta) => {
        if (!guard()) return;
        streamed += delta;
        appendToNote(noteId, delta);
        useStore.getState().updateNote(noteId, { activeTurnText: streamed });
      },
      onDone: (u) => {
        if (!guard()) return;
        if (u) attachUsage(noteId, u);
        finishNote(noteId);
        markLocalStatus(noteId, "succeeded");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "succeeded",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "succeeded", answerTurnId);
      },
      onError: (err) => {
        if (!guard()) return;
        appendToNote(noteId, "\n\n[错误：" + err.message + "]");
        finishNote(noteId);
        markLocalStatus(noteId, "failed");
        // The partial text is kept — a failed stream must preserve what
        // already arrived — and the note is stored as failed rather than as
        // a success with a truncated answer.
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "failed",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "failed", answerTurnId);
      },
      // Cancellation (sign-out, endpoint switch, a new selection) and
      // interruption (the tab went away mid-stream) both keep the text
      // that already arrived and record *why* it stopped, so a reload
      // shows "interrupted" rather than a note that looks finished.
      onCancelled: () => {
        if (!guard()) return;
        finishNote(noteId);
        markLocalStatus(noteId, "cancelled");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "cancelled",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "cancelled", answerTurnId);
      },
      onInterrupted: () => {
        if (!guard()) return;
        finishNote(noteId);
        markLocalStatus(noteId, "interrupted");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "interrupted",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "interrupted", answerTurnId);
      },
    });
  }

  function handleAskSubmit() {
    if (!askOpen || !article || !askQuestion.trim()) return;
    const question = askQuestion.trim();
    const messages = buildAskMessages(
      article,
      askOpen.text,
      question,
    );
    const noteId = addNote({
      articleId: article.id,
      remoteVersionId: article.versionId,
      paragraphIndex: askOpen.paragraphIndex,
      type: "ask",
      selectionText: askOpen.text,
      question,
      answer: "",
      model: modelInfo.name,
    });
    void persistNote(noteId, article.id, anchorFor(askOpen, "ask", askOpen.text, question));
    setAskOpen(null);
    setAskQuestion("");
    window.getSelection()?.removeAllRanges();
    streamControllerRef.current?.abort();
    const controller = new AbortController();
    streamControllerRef.current = controller;
    let streamed = "";
    // Minted once, when the turn starts, and reused by every completion
    // path and every retry: that is what makes the server-side key
    // stable. A counter recomputed later collides with an earlier turn.
    const answerTurnId = mintTurnId();
    startActiveTurn(noteId, answerTurnId);
    const guard = makeTurnGuard(noteId, answerTurnId);
    streamChat({
      signal: controller.signal,
      messages,
      onChunk: (delta) => {
        if (!guard()) return;
        streamed += delta;
        appendToNote(noteId, delta);
        useStore.getState().updateNote(noteId, { activeTurnText: streamed });
      },
      onDone: (u) => {
        if (!guard()) return;
        if (u) attachUsage(noteId, u);
        finishNote(noteId);
        markLocalStatus(noteId, "succeeded");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "succeeded",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "succeeded", answerTurnId);
      },
      onError: (err) => {
        if (!guard()) return;
        appendToNote(noteId, "\n\n[错误：" + err.message + "]");
        finishNote(noteId);
        // The explain path already recorded this; ask did not, so a failed
        // question left the card with no lifecycle state at all.
        markLocalStatus(noteId, "failed");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "failed",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "failed", answerTurnId);
      },
      onCancelled: () => {
        if (!guard()) return;
        finishNote(noteId);
        markLocalStatus(noteId, "cancelled");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "cancelled",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "cancelled", answerTurnId);
      },
      onInterrupted: () => {
        if (!guard()) return;
        finishNote(noteId);
        markLocalStatus(noteId, "interrupted");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(noteId, {
            role: "assistant",
            content: streamed,
            status: "interrupted",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(noteId, streamed, "interrupted", answerTurnId);
      },
    });
  }

  async function handleGenerateBrief() {
    if (!article || briefLoading) return;
    // A brief is generated against one article *version*, and it identifies
    // paragraphs by reference. If the article is refreshed, or the account
    // changes, while the model is working, the result describes a document
    // that is no longer on screen — storing it would attach a summary of
    // version N to version N+1, and its paragraph references would point at
    // the wrong blocks.
    const ownerAtStart = useStore.getState().ownerUserId;
    const epochAtStart = currentSessionEpoch();
    const versionAtStart = article.versionId;
    const articleIdAtStart = article.id;

    setBriefLoading(true);
    try {
      const brief = await generateBrief(article);
      const now = useStore.getState().articles[articleIdAtStart];
      const stillSameArticle =
        currentSessionEpoch() === epochAtStart &&
        useStore.getState().ownerUserId === ownerAtStart &&
        now?.versionId === versionAtStart;
      if (!stillSameArticle) return;
      setBrief(articleIdAtStart, { ...brief, generatedAt: Date.now() });
      setBriefOpen(true);
    } catch (err) {
      if (currentSessionEpoch() !== epochAtStart) return;
      if (useStore.getState().ownerUserId !== ownerAtStart) return;
      alert("生成摘要失败：" + (err as Error).message);
    } finally {
      setBriefLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gloss-bg">
      {/* Top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between px-6 py-3 bg-gloss-bg/80 backdrop-blur-md border-b border-gloss-border">
        <div className="flex items-center gap-3 text-sm">
          <a
            href="#/"
            className="text-gloss-textDim hover:text-gloss-text transition-colors"
          >
            ←
          </a>
          <span className="text-gloss-accent">+</span>
          <span className="font-medium">kobook</span>
          <span className="text-gloss-textDim">·</span>
          <span className="text-gloss-textDim truncate max-w-[40ch]">
            {article.title}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gloss-textDim">
          <span>
            {notes.length} 条笔记
          </span>
          {/* Outline toggle. Only meaningful when there is an outline to
              show, so it stays hidden for a document with no headings —
              the sidebar itself explains that case when opened. */}
          {outline.length > 0 && (
            <button
              type="button"
              onClick={() => setOutlineOpen(!outlineOpen)}
              aria-pressed={outlineOpen}
              aria-label={outlineOpen ? "隐藏目录" : "显示目录"}
              title={outlineOpen ? "隐藏目录" : "显示目录"}
              className="hidden lg:flex items-center justify-center text-gloss-textDim hover:text-gloss-text transition-colors"
            >
              <OutlineIcon />
            </button>
          )}
          <ThemeToggle />
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-gloss-textDim hover:text-gloss-text text-base leading-none"
            title="设置"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="flex">
        {/* Article outline. Replaces the old scroll rail: the rail's note
            dots were placed by linear interpolation over paragraph
            ordinal, which does not line up with where a paragraph
            actually is, and it carried no structure at all. */}
        <OutlineSidebar
          articleRef={articleRef}
          outline={outline}
          notes={notes}
          open={outlineOpen}
          paragraphRefs={paragraphRefs}
          onJump={(idx) => {
            const el = paragraphRefs.current[idx];
            el?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />

        {/* Main reader */}
        <main
          ref={articleRef}
          className="flex-1 min-w-0 max-w-3xl mx-auto px-8 py-12"
        >
          {/* Title block */}
          <div className="mb-10">
            <div className="flex items-center gap-2 text-xs text-gloss-textDim mb-3">
              <span>·</span>
              <span>{article.url ? safeHostname(article.url) : "粘贴的正文"}</span>
            </div>
            <h1 className="font-serif text-4xl md:text-5xl leading-[1.15] tracking-tight">
              {article.title}
            </h1>
            <div className="mt-3 text-sm text-gloss-textDim flex items-center gap-2 flex-wrap">
              {article.author && <span>{article.author}</span>}
              {article.author && article.publishedAt && <span>·</span>}
              {article.publishedAt && <span>{article.publishedAt}</span>}
            </div>
            <div className="mt-2 text-xs text-gloss-textDim">
              {article.paragraphs.length} 个段落
            </div>
          </div>

          {/* Sync status banner. The user can paste, import, refresh,
              navigate away and come back — and the only signal they
              have for "saved locally, sync failed" is this row. The
              rejection / network-error / cancelled verdicts are surfaced
              verbatim; a successful upload clears the status so the banner
              disappears on its own. The retry button re-runs the upload
              in place: no re-paste, no key re-entry, no repaint. */}
          <SyncStatusBanner article={article} />

          {/* Brief section */}
          <BriefSection
            brief={article.brief}
            open={briefOpen}
            onToggle={() => setBriefOpen(!briefOpen)}
            onGenerate={handleGenerateBrief}
            loading={briefLoading}
            articleParagraphs={article.paragraphs}
            onJumpTo={(idx) => {
              const el = paragraphRefs.current[idx];
              el?.scrollIntoView({ behavior: "smooth", block: "start" });
              el?.classList.add("ring-2", "ring-gloss-accent/40");
              setTimeout(() => {
                el?.classList.remove("ring-2", "ring-gloss-accent/40");
              }, 1500);
            }}
          />

          {/* Article body. Blocks are grouped first so a run of list
              items shares one `<ul>`/`<ol>` — emitting one list per
              item would restart ordered numbering on every line. The
              grouping is a pure function (`lib/blocks.ts`) so the tag
              and grouping rules can be unit-tested without React. */}
          <div className="gloss-prose mt-8">
            {blockGroups.map((group) => {
              const renderBlock = (p: Paragraph) => (
                <HighlightedParagraph
                  key={p.index}
                  paragraph={p}
                  highlights={highlights}
                  hasNote={notes.some((n) => n.paragraphIndex === p.index)}
                  onMarkClick={(id, rect) => {
                    // Opening the manage-popover means the user clicked an
                    // existing mark, not made a new selection. The native
                    // selection is empty in that case, but clear it anyway
                    // so the selection toolbar cannot be left on screen.
                    setSelection(null);
                    setOpenHighlight({ id, rect });
                  }}
                  registerRef={(el) => {
                    paragraphRefs.current[p.index] = el;
                  }}
                />
              );

              if (group.kind === "block") return renderBlock(group.paragraph);

              const List = group.ordered ? "ol" : "ul";
              return (
                <List
                  key={`list-${group.items[0]!.index}`}
                  className="gloss-list"
                >
                  {group.items.map(renderBlock)}
                </List>
              );
            })}
          </div>
        </main>

        {/* Right margin: notes */}
        <aside className="hidden lg:block w-[400px] shrink-0 border-l border-gloss-border">
          <div className="sticky top-[60px] h-[calc(100vh-60px)] overflow-y-auto scrollbar-thin p-4 space-y-3">
            {notes.length === 0 && otherVersionNotes.length === 0 ? (
              <div className="text-xs text-gloss-textDim italic mt-8 px-2">
                选中正文中的文字，即可解释或提问。回答会显示在这里。
              </div>
            ) : (
              notes.map((n) => (
                <NoteCard key={n.id} note={n} />
              ))
            )}

            {/*
              Notes from other versions are counted and reachable, never
              silently dropped. Hiding them is right — they annotate text
              that is no longer on screen — but an old note must stay
              readable, and "readable" cannot be allowed to mean
              "impossible to find". They are listed under a collapsed
              heading with a note that they belong to another version.
            */}
            {otherVersionNotes.length > 0 ? (
              <div className="pt-2 mt-2 border-t border-gloss-border">
                <button
                  type="button"
                  data-testid="other-version-notes-toggle"
                  onClick={() => setShowOtherVersions((v) => !v)}
                  className="text-xs text-gloss-textDim hover:text-gloss-text"
                >
                  {showOtherVersions ? "收起" : "显示"}
                  {" "}其他版本的笔记（{otherVersionNotes.length} 条）
                </button>
                {showOtherVersions ? (
                  <div className="mt-3 space-y-3" data-testid="other-version-notes">
                    <div className="text-[11px] text-gloss-textDim italic">
                      以下笔记锚定在文章的其它版本上，不是当前正文的内容。
                    </div>
                    {otherVersionNotes.map((n) => (
                      <NoteCard key={n.id} note={n} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {/* Selection toolbar */}
      {selection && !askOpen && !openHighlight && (
        <SelectionToolbar
          selection={selection}
          wordPrompts={wordPrompts}
          color={highlightColor}
          style={highlightStyle}
          onExplain={() => handleExplain()}
          onAsk={() => {
            setAskOpen(selection);
            setAskQuestion("");
          }}
          onHighlight={handleHighlight}
          onStyle={handleHighlightStyle}
          onDismiss={() => {
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}

      {/* Manage an existing highlight (recolour / reshape / remove) */}
      {openHighlight &&
        (() => {
          const target = highlights.find((h) => h.id === openHighlight.id);
          // The highlight can disappear underneath the popover (another
          // tab, a sign-out). Rendering nothing is better than a
          // popover pointed at a row that no longer exists.
          if (!target) return null;
          return (
            <HighlightPopover
              highlight={target}
              rect={openHighlight.rect}
              onColor={(color) => {
                setHighlightColor(target.id, color);
                setHighlightPrefs({ color });
              }}
              onStyle={(style) => {
                setHighlightStyle(target.id, style);
                setHighlightPrefs({ style });
              }}
              onDelete={() => {
                deleteHighlight(target.id);
                setOpenHighlight(null);
              }}
              onClose={() => setOpenHighlight(null)}
            />
          );
        })()}

      {/* Ask input popover */}
      {askOpen && (
        <AskPopover
          selection={askOpen}
          question={askQuestion}
          setQuestion={setAskQuestion}
          onSubmit={handleAskSubmit}
          onCancel={() => {
            setAskOpen(null);
            setAskQuestion("");
          }}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

// ──────────────────────────── Sub-components ────────────────────────────

/**
 * Copy a stream's token usage onto its note.
 *
 * `StreamUsage`'s counters are optional — a provider is allowed to
 * finish without reporting them — while the stored `NoteUsage` the
 * card renders needs all three. Attaching nothing when any is missing
 * is the honest bridge: defaulting to 0 would print "0 个 Token" for a
 * provider that simply stayed quiet, and the card already renders no
 * token line at all when `usage` is absent.
 */
function applyUsage(noteId: string, u: StreamUsage) {
  const { promptTokens, completionTokens, totalTokens } = u;
  if (
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined
  ) {
    return;
  }
  useStore.getState().updateNote(noteId, {
    usage: { promptTokens, completionTokens, totalTokens, cachedTokens: u.cachedTokens },
  });
}

/**
 * One article paragraph, rendered with its highlights and inline emphasis.
 *
 * The body text is split at every boundary of either kind — highlight, or
 * emphasis found in the source — by `segmentBlock`, and mapped to
 * `<strong>` / `<mark>` / plain text nodes. This is deliberately a pure
 * `text -> segments -> JSX` transform instead of wrapping the range in DOM
 * nodes imperatively: the old `Range.surroundContents` approach mutates nodes
 * React owns and gets wiped on the next render, which is exactly the class of
 * bug this avoids. Cutting once for both kinds, rather than once each, is what
 * keeps a highlight from sliding a character off the word it was drawn on.
 *
 * The paragraph-number `<span>` carries `data-paragraph-marker` so
 * `rangeToOffsets` can skip it when mapping a later selection back to
 * offsets. Without that attribute the marker's digits would be
 * counted as paragraph text and every offset would drift.
 */

/**
 * One inline emphasis, as the element the source asked for.
 *
 * A switch rather than a lookup table of tag names because each arm needs its
 * own props — only the link has an `href` — and because the JSX element type
 * for a dynamic tag name is not something to route through a cast.
 *
 * **None of these may render a character.** A link is underlined and coloured,
 * never given an ↗ or a domain badge: `rangeToOffsets` measures a selection
 * with `Range.toString()`, so one generated glyph would shift every stored
 * offset after it in the block. Styling only — see `index.css`.
 */
function Emphasis({
  kind,
  href,
  children,
}: {
  kind: InlineMarkKind;
  href?: string;
  children: ReactNode;
}) {
  switch (kind) {
    case "strong":
      return <strong>{children}</strong>;
    case "em":
      return <em>{children}</em>;
    case "code":
      return <code>{children}</code>;
    case "del":
      return <del>{children}</del>;
    case "link":
      return (
        <a
          href={href}
          // A link in a reader opens away from the article rather than
          // replacing it — losing your place to a footnote is the one thing
          // a reading view must not do. `noreferrer` also keeps the article
          // URL out of the destination's logs.
          target="_blank"
          rel="noreferrer noopener"
        >
          {children}
        </a>
      );
  }
}

function HighlightedParagraph({
  paragraph,
  highlights,
  hasNote,
  onMarkClick,
  registerRef,
}: {
  paragraph: Paragraph;
  highlights: Highlight[];
  hasNote: boolean;
  onMarkClick: (id: string, rect: DOMRect) => void;
  registerRef: (el: HTMLElement | null) => void;
}) {
  const kind = blockKindOf(paragraph);

  const marks = useMemo(
    () =>
      highlights
        .filter((h) => h.paragraphIndex === paragraph.index)
        .map((h) => ({ id: h.id, start: h.startOffset, end: h.endOffset })),
    [highlights, paragraph.index],
  );

  const segments = useMemo(
    () => segmentBlock(paragraph.text, marks, paragraph.spans ?? []),
    [paragraph.text, marks, paragraph.spans],
  );

  // Colour and shape lookup for a segment: the last entry in `marks`
  // is the innermost, and "innermost wins" is what nested highlights
  // should look like. Both fall back rather than trusting the stored
  // value: `style` is absent on highlights written before shapes
  // shipped, and either field can have been hand-edited in
  // localStorage — a value with no matching CSS rule would render as
  // an invisible mark, which reads as data loss.
  const markOf = (markId: string): { color: HighlightColor; style: HighlightStyle } => {
    const found = highlights.find((h) => h.id === markId);
    return {
      color: resolveHighlightColor(found?.color ?? "yellow"),
      style: resolveHighlightStyle(found?.style),
    };
  };

  /**
   * The innermost layer of a slice: a `<mark>` when a highlight covers it,
   * bare text when not.
   *
   * `markIds` is outermost-first, so the last entry is the innermost — and
   * "innermost wins" is what a nested highlight should look like.
   */
  const markedText = (markIds: string[], text: string): ReactNode => {
    if (markIds.length === 0) return text;
    const topMarkId = markIds[markIds.length - 1]!;
    const mark = markOf(topMarkId);
    return (
      <mark
        data-color={mark.color}
        data-style={mark.style}
        data-highlight-id={topMarkId}
        className="gloss-mark cursor-pointer"
        onClick={(e) => {
          // `currentTarget`, not `target`: the mark is what the handler is
          // attached to and what should be measured, even when the click
          // lands on a descendant.
          onMarkClick(topMarkId, e.currentTarget.getBoundingClientRect());
        }}
      >
        {text}
      </mark>
    );
  };

  const body = segments.map((segment, i) => {
    // Emphasis wraps the highlight rather than the other way round: the
    // emphasis is a property of the text, the highlight is an annotation
    // drawn over it. Folded from the inside out so the first kind in the
    // contract's canonical order ends up outermost, which is what makes
    // `**_x_**` render `<strong><em>` and never the reverse.
    let node: ReactNode = markedText(segment.markIds, segment.text);
    for (let k = segment.kinds.length - 1; k >= 0; k -= 1) {
      node = (
        <Emphasis kind={segment.kinds[k]!} href={segment.href}>
          {node}
        </Emphasis>
      );
    }
    return <span key={i}>{node}</span>;
  });

  // The margin gutter. A list item shows nothing there unless it carries
  // a note: the list bullet already marks the line, and two marks would
  // land in the same 2rem gutter (the CSS drops the bullet when the note
  // dot is shown, keyed off `data-has-note`).
  //
  // The span must stay present for every kind — `rangeToOffsets`
  // subtracts its text, and an empty one is a cheap no-op.
  const marker = (
    <span
      data-paragraph-marker=""
      className={`absolute left-0 top-0 text-xs font-mono select-none ${
        hasNote ? "text-gloss-accent" : "text-gloss-textDim/40"
      }`}
    >
      {hasNote ? "•" : kind === "listItem" ? "" : paragraph.index}
    </span>
  );

  // Every branch below must render `paragraph.text` and nothing else:
  // `rangeToOffsets` measures a selection with `Range.toString()`, so a
  // glyph introduced here — including a CSS `::before { content }`,
  // which Chromium *does* count — would shift every stored offset in the
  // block. See `lib/blocks.ts`.
  const blockProps = {
    ref: registerRef,
    "data-paragraph-index": paragraph.index,
    "data-block-kind": kind,
    // The parse layer's block id, when this paragraph came from the
    // server. It is what makes a selection anchor survive a document
    // that contains the same sentence twice: the note records the id
    // of the occurrence the user actually dragged over, and the
    // server refuses an anchor naming a different one.
    ...(paragraph.blockId ? { "data-block-id": paragraph.blockId } : {}),
  };
  const gutter = "relative pl-8 transition-all";

  if (kind === "code") {
    // The marker sits *outside* the `<pre>`: inside it, `white-space:
    // pre` turns the whitespace around the span into real characters
    // and every offset in the block shifts by their length.
    return (
      <div {...blockProps} className={`gloss-code ${gutter}`}>
        {marker}
        <pre className="gloss-pre">
          <code>{body}</code>
        </pre>
      </div>
    );
  }

  if (kind === "heading") {
    const Tag = headingTag(paragraph.level);
    return (
      <Tag {...blockProps} className={`gloss-heading ${gutter}`}>
        {marker}
        {body}
      </Tag>
    );
  }

  if (kind === "quote") {
    return (
      <blockquote {...blockProps} className={`gloss-quote ${gutter}`}>
        {marker}
        {body}
      </blockquote>
    );
  }

  if (kind === "listItem") {
    return (
      <li
        {...blockProps}
        {...(hasNote ? { "data-has-note": "" } : {})}
        className={gutter}
      >
        {marker}
        {body}
      </li>
    );
  }

  return (
    <p {...blockProps} className={gutter}>
      {marker}
      {body}
    </p>
  );
}

/**
 * Manage-popover for an existing highlight: recolour, reshape, remove.
 *
 * Deliberately not a note editor. A highlight is an anchor; turning
 * it into an AI answer is what the "解释 / 提问" actions do, and
 * coupling the two would mean every mark costs tokens.
 */
function HighlightPopover({
  highlight,
  rect,
  onColor,
  onStyle,
  onDelete,
  onClose,
}: {
  highlight: Highlight;
  rect: DOMRect;
  onColor: (color: HighlightColor) => void;
  onStyle: (style: HighlightStyle) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const top = Math.max(80, rect.top - 52);
  const left = Math.max(16, rect.left);
  return (
    <>
      {/* Click-away layer. `fixed inset-0` with no visual, so the
          popover closes the way a native one does. */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="fixed z-40 bg-gloss-surface border border-gloss-border rounded-lg shadow-2xl p-1 animate-fade-in"
        style={{ top, left }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-1">
          <ColorSwatches
            value={resolveHighlightColor(highlight.color)}
            onPick={onColor}
            label={(c) => `改为${HIGHLIGHT_COLOR_LABEL[c]}`}
          />
          <div className="w-px h-4 bg-gloss-border mx-1" />
          <StyleSwatches
            value={resolveHighlightStyle(highlight.style)}
            onPick={onStyle}
          />
          <div className="w-px h-4 bg-gloss-border mx-1" />
          <button
            onClick={onDelete}
            className="px-2 py-1.5 text-xs rounded hover:bg-gloss-surface2 text-gloss-textDim hover:text-gloss-accent"
          >
            取消划线
          </button>
          <button
            onClick={onClose}
            className="px-2 py-1.5 text-xs rounded hover:bg-gloss-surface2 text-gloss-textDim"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The four colour swatches. Shared by the selection toolbar and the
 * manage-popover so the two rows cannot drift apart — the colour set
 * is one list (`lib/highlight.ts`) and one rendering.
 *
 * A swatch is a flat chip of the *pure* colour, not a preview of the
 * wash: at 16px a 30%-alpha wash of yellow on a cream page is
 * indistinguishable from a wash of green, which is the one thing the
 * control exists to tell apart.
 */
function ColorSwatches({
  value,
  onPick,
  label,
  disabled,
  disabledHint,
}: {
  value: HighlightColor;
  onPick: (color: HighlightColor) => void;
  /** Always names the colour — four identical labels are useless to a
   *  screen reader, so the disabled state is carried by `disabled`
   *  and the tooltip, never by replacing the name. */
  label: (color: HighlightColor) => string;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-1" role="group" aria-label="划线颜色">
      {HIGHLIGHT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          disabled={disabled}
          onClick={() => onPick(color)}
          title={disabled ? disabledHint : label(color)}
          aria-label={label(color)}
          aria-pressed={value === color}
          className={`gloss-swatch h-4 w-4 rounded-full transition-transform hover:scale-110 disabled:opacity-30 disabled:hover:scale-100 ${
            value === color
              ? "ring-2 ring-gloss-text/50 ring-offset-1 ring-offset-gloss-surface"
              : "border border-gloss-border"
          }`}
          data-color={color}
        />
      ))}
    </div>
  );
}

/** The three mark shapes, as a segmented control. */
function StyleSwatches({
  value,
  onPick,
}: {
  value: HighlightStyle;
  onPick: (style: HighlightStyle) => void;
}) {
  const Icon = { watercolor: WashIcon, line: LineIcon, curve: CurveIcon };
  return (
    <div className="flex items-center gap-0.5 px-1" role="group" aria-label="划线样式">
      {HIGHLIGHT_STYLES.map((style) => {
        const Glyph = Icon[style];
        const active = value === style;
        return (
          <button
            key={style}
            type="button"
            onClick={() => onPick(style)}
            title={`${HIGHLIGHT_STYLE_LABEL[style]}${active ? "（当前）" : ""}`}
            aria-label={`划线样式：${HIGHLIGHT_STYLE_LABEL[style]}`}
            aria-pressed={active}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
              active
                ? "bg-gloss-surface2 text-gloss-text"
                : "text-gloss-textDim hover:text-gloss-text"
            }`}
          >
            <Glyph />
          </button>
        );
      })}
    </div>
  );
}

/*
 * Shape glyphs. A filled blob reads as "washed over", a stroke reads
 * as "a line was drawn", and the wave is the drawn line that bends —
 * so the three stay tellable apart at 16px and in greyscale.
 */
function WashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="4.5" width="13" height="7" rx="2.5" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function LineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <line
        x1="1.5"
        y1="11"
        x2="14.5"
        y2="11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CurveIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1.5 10.5c1.5-2.6 3-2.6 4.3 0s2.9 2.6 4.4 0 2.9-2.6 4.3 0"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NoteCard({ note }: { note: ReturnType<typeof useStore.getState>["notes"][string] }) {
  const deleteNote = useStore((s) => s.deleteNote);
  const article = useStore((s) => s.articles[note.articleId]);
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  // One controller per card: a follow-up stream is unrelated to the article
  // selection bar stream, so the two do not cancel each other.
  const followUpControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      followUpControllerRef.current?.abort();
      followUpControllerRef.current = null;
    };
  }, []);

  function sendFollowUp() {
    // One generation at a time per note. The input is disabled while busy,
    // but the button and the Enter key reach the same handler, and a note
    // whose *first* run is still streaming is busy in exactly the same
    // sense — two streams on one note would interleave their chunks into
    // the same answer and race each other's terminal state.
    if (!followUp.trim() || !article) return;
    if (busy || note.isStreaming) return;
    setBusy(true);
    const userQ = followUp.trim();

    // Build the full message chain so the LLM sees the prior exchange as
    // context. `turns` is the authoritative history: the original question
    // plus every follow-up. The previous version of this used
    // `[question, answer]`, which is only correct for the *first*
    // follow-up — after that the model saw the original question and the
    // whole flattened answer with no boundary between turns.
    const priorMessages =
      note.turns && note.turns.length > 0
        ? note.turns.map((t) => ({ role: t.role, content: t.content }))
        : [
            { role: "user" as const, content: note.question },
            { role: "assistant" as const, content: note.answer },
          ];
    const messages = buildAskMessages(
      article,
      note.selectionText,
      userQ,
      priorMessages,
    );

    // Append the question to the rendered answer for the in-card
    // transcript, and record it as a turn so the *structure* survives.
    // `note.question` itself is deliberately left alone: it is the note's
    // original question, and overwriting it (as this used to) destroyed it
    // locally — the card header, the migrated copy and the next follow-up's
    // context all lost the question the note was created for.
    useStore.getState().appendToNote(
      note.id,
      "\n\n---\n\n追问：" + userQ + "\n\n",
    );
    const questionTurnId = mintTurnId();
    useStore.getState().appendTurn(note.id, { role: "user", content: userQ, turnId: questionTurnId });
    // The follow-up question is its own turn. Storing the original question
    // and each follow-up separately is what lets the next follow-up reach the
    // model with the earlier exchange as context; a flattened answer loses
    // the boundaries between turns.
    void persistFollowUpQuestion(note.id, userQ, questionTurnId);

    followUpControllerRef.current?.abort();
    const controller = new AbortController();
    followUpControllerRef.current = controller;
    let streamed = "";
    // Minted once, when the turn starts, and reused by every completion
    // path and every retry: that is what makes the server-side key
    // stable. A counter recomputed later collides with an earlier turn.
    const answerTurnId = mintTurnId();
    startActiveTurn(note.id, answerTurnId);
    const guard = makeTurnGuard(note.id, answerTurnId);
    streamChat({
      signal: controller.signal,
      messages,
      onChunk: (delta) => {
        if (!guard()) return;
        streamed += delta;
        useStore.getState().appendToNote(note.id, delta);
        useStore.getState().updateNote(note.id, { activeTurnText: streamed });
      },
      onDone: (u) => {
        if (!guard()) return;
        useStore.getState().finishNote(note.id);
        if (u) {
          // Stash usage on the note so the card can show cache-hit info
          applyUsage(note.id, u);
        }
        setBusy(false);
        setFollowUp("");
        markLocalStatus(note.id, "succeeded");
        // A follow-up is its own assistant turn on the note, so it is
        // appended as a message rather than overwriting the previous
        // answer — the server keeps the whole conversation.
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(note.id, {
            role: "assistant",
            content: streamed,
            status: "succeeded",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(note.id, streamed, "succeeded", answerTurnId);
      },
      onError: (err) => {
        if (!guard()) return;
        useStore.getState().appendToNote(note.id, "\n\n[错误：" + err.message + "]");
        useStore.getState().finishNote(note.id);
        setBusy(false);
        markLocalStatus(note.id, "failed");
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(note.id, {
            role: "assistant",
            content: streamed,
            status: "failed",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(note.id, streamed, "failed", answerTurnId);
      },
      onCancelled: () => {
        useStore.getState().finishNote(note.id);
        markLocalStatus(note.id, "cancelled");
        setBusy(false);
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(note.id, {
            role: "assistant",
            content: streamed,
            status: "cancelled",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(note.id, streamed, "cancelled", answerTurnId);
      },
      onInterrupted: () => {
        useStore.getState().finishNote(note.id);
        markLocalStatus(note.id, "interrupted");
        setBusy(false);
        if (streamed.trim().length > 0) {
          useStore.getState().appendTurn(note.id, {
            role: "assistant",
            content: streamed,
            status: "interrupted",
            turnId: answerTurnId,
          });
        }
        void persistAnswer(note.id, streamed, "interrupted", answerTurnId);
      },
    });
  }

  return (
    <div
      data-testid="note-card"
      data-note-id={note.id}
      data-note-remote={note.remoteId ? "cloud" : "local"}
      // The card's *original* question, exposed so a test can prove a
      // follow-up did not overwrite it — the defect this attribute exists
      // to make observable was silent, because the question is not
      // rendered anywhere on the card.
      data-note-question={note.question}
      data-note-streaming={note.isStreaming ? "true" : "false"}
      data-note-status={note.localStatus ?? note.remoteStatus ?? ""}
      className="rounded-lg bg-gloss-surface border border-gloss-border p-3 animate-slide-up"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gloss-accent font-mono">¶{note.paragraphIndex}</span>
          <span className="text-gloss-textDim uppercase tracking-wider">
            {note.type === "explain" ? "解释" : "提问"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              navigator.clipboard.writeText(note.answer);
            }}
            className="text-gloss-textDim hover:text-gloss-text p-1 text-xs"
            title="复制回答"
          >
            ⧉
          </button>
          <button
            onClick={() => void removeRemoteNote(note.id)}
            className="text-gloss-textDim hover:text-gloss-accent p-1 text-xs"
            title="删除笔记"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="text-xs italic text-gloss-textDim mb-2 border-l-2 border-gloss-border pl-2 leading-relaxed">
        "{note.selectionText.slice(0, 120)}{note.selectionText.length > 120 ? "…" : ""}"
      </div>
      <div
        className={`text-sm leading-relaxed text-gloss-text ${
          note.isStreaming ? "streaming-cursor" : ""
        }`}
      >
        {note.answer || (
          <span className="text-gloss-textDim italic">正在思考…</span>
        )}
      </div>
      {note.usage && !note.isStreaming && (
        <div className="mt-2 text-[10px] font-mono text-gloss-textDim/70 flex items-center gap-2">
          <span>
            {note.usage.totalTokens.toLocaleString()} 个 Token
            {note.usage.cachedTokens
              ? ` · ${note.usage.cachedTokens.toLocaleString()} 已缓存`
              : ""}
          </span>
          {note.usage.cachedTokens && note.usage.promptTokens > 0 && (
            <span className="text-gloss-accent/70">
              ({Math.round(
                (note.usage.cachedTokens / note.usage.promptTokens) * 100,
              )}% 缓存命中)
            </span>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendFollowUp();
            }
          }}
          placeholder="继续追问…"
          disabled={busy}
          className="flex-1 bg-transparent border border-gloss-border rounded px-2 py-1 text-xs outline-none focus:border-gloss-accent/50 disabled:opacity-40"
        />
        <button
          onClick={sendFollowUp}
          disabled={busy || !followUp.trim()}
          className="text-gloss-textDim hover:text-gloss-text text-sm disabled:opacity-30"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function SelectionToolbar({
  selection,
  wordPrompts,
  color,
  style,
  onExplain,
  onAsk,
  onHighlight,
  onStyle,
  onDismiss,
}: {
  selection: SelectionInfo;
  wordPrompts: string[];
  color: HighlightColor;
  style: HighlightStyle;
  onExplain: () => void;
  onAsk: () => void;
  onHighlight: (color: HighlightColor) => void;
  onStyle: (style: HighlightStyle) => void;
  onDismiss: () => void;
}) {
  // Position above the selection, but never above the viewport
  const top = Math.max(80, selection.rect.top - 56);
  const left = Math.max(16, selection.rect.left + selection.rect.width / 2 - 80);
  const isWord = selection.text.split(/\s+/).length <= 2;
  // Highlighting needs an anchor. A selection that could not be mapped
  // to paragraph offsets can still be explained or asked about, but
  // there is nothing to store a mark against. That happens when the
  // selection spans two paragraphs — one highlight cannot, and the
  // swatches say so through their tooltip rather than looking
  // arbitrarily dead.
  const canHighlight =
    selection.startOffset !== null &&
    selection.endOffset !== null &&
    selection.endOffset > selection.startOffset;
  const disabledHint = "跨段落或跨文章的选择无法划线，只能解释或提问";

  return (
    <>
      <div
        className="fixed z-30 max-w-[92vw] bg-gloss-surface border border-gloss-border rounded-lg shadow-2xl p-1 animate-fade-in"
        style={{ top, left }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-1 flex-wrap">
          <button
            onClick={onExplain}
            className="px-3 py-1.5 text-xs font-medium rounded hover:bg-gloss-surface2 text-gloss-text"
          >
            解释
          </button>
          <button
            onClick={onAsk}
            className="px-3 py-1.5 text-xs font-medium rounded hover:bg-gloss-surface2 text-gloss-text"
          >
            提问…
          </button>
          <div className="w-px h-4 bg-gloss-border mx-1" />
          {/* Highlight controls. A click on a colour marks the
              selection and dismisses — the same shape as Kindle /
              Medium, where colour is chosen at mark time rather than
              through a second dialog. The shape buttons only set what
              the *next* mark will look like: the toolbar is gone the
              instant a mark exists, because segmenting the paragraph
              replaces the very text nodes the selection was anchored
              to. Reshaping an existing mark is the popover's job. */}
          <ColorSwatches
            value={color}
            onPick={onHighlight}
            disabled={!canHighlight}
            disabledHint={disabledHint}
            label={(c) => `用${HIGHLIGHT_COLOR_LABEL[c]}划线`}
          />
          <div className="w-px h-4 bg-gloss-border mx-1" />
          <StyleSwatches value={style} onPick={onStyle} />
          <div className="w-px h-4 bg-gloss-border mx-1" />
          <button
            onClick={onDismiss}
            className="px-2 py-1.5 text-xs rounded hover:bg-gloss-surface2 text-gloss-textDim"
          >
            ✕
          </button>
        </div>
        {isWord && wordPrompts.length > 0 && (
          <div className="border-t border-gloss-border mt-1 pt-1 px-1">
            {wordPrompts.map((p, i) => (
              <button
                key={i}
                onClick={() => {
                  // treat as Ask with the preset question
                  onAsk();
                }}
                className="block w-full text-left px-2 py-1 text-[11px] text-gloss-textDim hover:text-gloss-text rounded hover:bg-gloss-surface2"
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Visible cloud-sync state.
 *
 * Three things the user must be able to read in the Reader without
 * opening DevTools:
 *
 *   - The article is on the server: nothing to show.
 *   - The upload failed: a short Chinese message naming the verdict
 *     (rejected / network-error / cancelled) and a retry button.
 *   - The duplicate verdict (now retired, but kept for older rows
 *     that landed before the 409 → `rejected` change): a row that
 *     says "已存在" without a retry, because the server has the
 *     article — the user can navigate to "我的文章" to read it.
 *
 * The retry button calls `retryArticleSync` with the *current*
 * (owner, epoch) — the frozen `submitIdentity` from the original
 * paste is for the moment of submit, not for an arbitrary later
 * click. A user who signed out between the upload attempt and
 * the click gets a no-op (the cloud bridge's identity
 * check rejects it) plus a "请登录后重试" hint.
 */
function SyncStatusBanner({ article }: { article: Article }) {
  const [retrying, setRetrying] = useState(false);
  const status = article.remoteSyncStatus;
  if (!status || status === "uploaded") return null;

  let message: string;
  let allowRetry = true;
  switch (status) {
    case "rejected":
      message = "本机已保存，云端同步失败，请重试。";
      break;
    case "network-error":
      message = "本机已保存，云端同步失败（网络问题）。";
      break;
    case "cancelled":
      message = "本机已保存，云端同步被取消。";
      allowRetry = true;
      break;
    case "duplicate":
      message = "本机已保存，云端同步尚未确认。";
      allowRetry = true;
      break;
    case "stale-owner":
      message = "本机已保存，但同步发生在账号切换之前，已被丢弃。";
      allowRetry = true;
      break;
    default:
      message = "本机已保存，云端同步状态未知。";
      allowRetry = true;
  }

  function handleRetry() {
    setRetrying(true);
    retryArticleSync(article);
    // The status flips back to "uploaded" (banner disappears) or
    // one of the failure verdicts on the next microtask; the
    // `retrying` flag is just visual feedback that the click was
    // registered and the network call is on its way.
    setTimeout(() => setRetrying(false), 1500);
  }

  return (
    <div
      data-testid="sync-status-banner"
      className="mb-6 px-4 py-3 rounded-lg border border-gloss-accent/40 bg-gloss-accent/5 text-sm"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-gloss-accent">{message}</span>
        {allowRetry && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="px-3 py-1 text-xs rounded border border-gloss-accent/40 text-gloss-accent hover:bg-gloss-accent/10 disabled:opacity-40"
          >
            {retrying ? "重试中…" : "重试云端同步"}
          </button>
        )}
      </div>
    </div>
  );
}

function AskPopover({
  selection,
  question,
  setQuestion,
  onSubmit,
  onCancel,
}: {
  selection: SelectionInfo;
  question: string;
  setQuestion: (q: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const top = Math.max(80, selection.rect.top - 70);
  const left = Math.max(16, selection.rect.left + selection.rect.width / 2 - 200);
  return (
    <div
      className="fixed z-30 bg-gloss-surface border border-gloss-border rounded-lg shadow-2xl p-2 w-[420px] animate-fade-in"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <input
        autoFocus
        type="text"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="针对这段文字提问…"
        className="w-full bg-transparent outline-none text-sm px-2 py-1.5 text-gloss-text placeholder:text-gloss-textDim"
      />
      <div className="flex items-center justify-between mt-1">
        <div className="text-[11px] text-gloss-textDim truncate max-w-[260px]">
          "{selection.text.slice(0, 60)}…"
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onCancel}
            className="px-2 py-1 text-xs text-gloss-textDim hover:text-gloss-text"
          >
            取消
          </button>
          <button
            onClick={onSubmit}
            disabled={!question.trim()}
            className="px-2 py-1 text-xs bg-gloss-text text-gloss-bg rounded font-medium hover:bg-gloss-text/85 disabled:opacity-30"
          >
            提问
          </button>
        </div>
      </div>
    </div>
  );
}

function BriefSection({
  brief,
  open,
  onToggle,
  onGenerate,
  loading,
  articleParagraphs,
  onJumpTo,
}: {
  brief: ReturnType<typeof useStore.getState>["articles"][string]["brief"];
  open: boolean;
  onToggle: () => void;
  onGenerate: () => void;
  loading: boolean;
  articleParagraphs: Paragraph[];
  onJumpTo: (idx: number) => void;
}) {
  if (!brief) {
    return (
      <div className="mb-10 p-4 rounded-lg border border-dashed border-gloss-border bg-gloss-surface/30">
        <button
          onClick={onGenerate}
          disabled={loading}
          className="flex items-center justify-between w-full text-left group"
        >
          <div>
            <div className="font-medium text-sm">
              {loading ? "正在生成…" : "生成文章摘要 →"}
            </div>
            <div className="text-xs text-gloss-textDim mt-1">
              先了解文章概要和关键观点，再深入阅读。
            </div>
          </div>
          <span className="text-gloss-textDim group-hover:text-gloss-accent transition-colors">
            {loading ? "…" : "→"}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="mb-10 rounded-lg border border-gloss-border bg-gloss-surface/50">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gloss-surface2/50 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">文章摘要</span>
          <span className="text-gloss-textDim">
            {articleParagraphs.length} 个段落 · {brief.claims.length} 个观点
          </span>
        </div>
        <span className="text-gloss-textDim text-xs">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 animate-fade-in">
          <p className="font-serif text-base leading-relaxed text-gloss-text mb-4">
            {brief.gist}
          </p>
          <div className="text-xs uppercase tracking-wider text-gloss-textDim mb-2">
            关键观点
          </div>
          <ol className="space-y-2">
            {brief.claims.map((c, i) => {
              // parse "¶3" or "¶13-26"
              const m = c.paragraphRef.match(/¶(\d+)(?:-(\d+))?/);
              if (!m) return null;
              const start = parseInt(m[1], 10);
              return (
                <li
                  key={i}
                  className="flex gap-3 text-sm leading-relaxed"
                >
                  <span className="text-gloss-textDim font-mono text-xs shrink-0 mt-0.5">
                    {i + 1}.
                  </span>
                  <div className="flex-1">
                    <span className="text-gloss-text">{c.text}</span>{" "}
                    <button
                      onClick={() => onJumpTo(start)}
                      className="text-gloss-accent font-mono text-xs hover:underline ml-1"
                    >
                      {c.paragraphRef}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

/** Outline glyph, matching `ThemeToggle`'s inline-SVG convention. */
function OutlineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none">
        <line x1="2" y1="3.5" x2="14" y2="3.5" />
        <line x1="5" y1="8" x2="14" y2="8" />
        <line x1="8" y1="12.5" x2="14" y2="12.5" />
      </g>
    </svg>
  );
}

/**
 * The article outline.
 *
 * Shows the heading tree the parse layer already produced, so the
 * document's hierarchy is navigable and not merely typographic. Two
 * things it deliberately does *not* do:
 *
 *   - it does not invent structure. A document with no headings gets an
 *     explicit line saying so rather than a fabricated table of
 *     contents. Research showed the hierarchy is captured correctly at
 *     extraction time, so this is a rare state, and the honest
 *     presentation of it is to say it rather than to guess.
 *   - it does not block reading. Nothing here can prevent an article
 *     from opening.
 */
function OutlineSidebar({
  articleRef,
  outline,
  notes,
  open,
  paragraphRefs,
  onJump,
}: {
  articleRef: React.RefObject<HTMLDivElement | null>;
  outline: OutlineEntry[];
  notes: { paragraphIndex: number }[];
  open: boolean;
  paragraphRefs: React.RefObject<Record<number, HTMLElement | null>>;
  onJump: (idx: number) => void;
}) {
  const [scrollPct, setScrollPct] = useState(0);
  /**
   * The heading whose section currently occupies the top of the
   * viewport. Tracked with an `IntersectionObserver` over the heading
   * elements rather than by interpolating `scrollTop`: paragraphs are
   * not equal height (a heading, a code block and a one-line paragraph
   * differ by an order of magnitude), so a scroll-fraction estimate
   * points at the wrong section.
   */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const noteIndexes = useMemo(
    () => notes.map((n) => n.paragraphIndex),
    [notes],
  );

  useEffect(() => {
    if (!open || outline.length === 0) return;
    const targets = outline
      .map((entry) => paragraphRefs.current?.[entry.index])
      .filter((el): el is HTMLElement => Boolean(el));
    if (targets.length === 0) return;

    // Track every heading that is currently on screen, and pick the
    // topmost one. `isIntersecting` alone is not enough: with several
    // headings visible the observer fires per element with no ordering.
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.paragraphIndex);
          if (entry.isIntersecting) visible.add(index);
          else visible.delete(index);
        }
        if (visible.size === 0) return;
        setActiveIndex(Math.min(...visible));
      },
      // A heading counts as "current" once it reaches the top third of
      // the viewport, which is where a reader's eye sits.
      { rootMargin: "0px 0px -66% 0px", threshold: 0 },
    );
    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, [open, outline, paragraphRefs]);

  useEffect(() => {
    const handler = () => {
      const el = articleRef.current;
      if (!el) return;
      const max = el.scrollHeight - window.innerHeight;
      setScrollPct(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
    };
    if (!articleRef.current) return;
    window.addEventListener("scroll", handler, { passive: true });
    handler();
    return () => window.removeEventListener("scroll", handler);
  }, [articleRef]);

  if (!open) return null;

  // Notes that sit before the first heading have no section to hang off,
  // so they get a synthetic leading row that jumps to the top.
  const leadingNotes = outline.length
    ? noteIndexes.filter((i) => i < outline[0]!.index).length
    : noteIndexes.length;

  return (
    <aside className="hidden lg:block w-56 shrink-0">
      <div className="sticky top-[60px] h-[calc(100vh-60px)] flex gap-2 px-3 py-6">
        {/* Scroll progress, kept from the old rail — it is the one part
            of it that was accurate. */}
        <div className="relative w-0.5 shrink-0 bg-gloss-border/40 rounded-full">
          <div
            className="absolute w-0.5 bg-gloss-textDim/60 rounded-full transition-all"
            style={{ top: `${scrollPct * 100}%`, height: "20%" }}
          />
        </div>

        <nav className="min-w-0 flex-1 overflow-y-auto scrollbar-thin" aria-label="文章目录">
          {outline.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-gloss-textDim px-1">
              这篇文章没有小标题，正文按段排列。
            </p>
          ) : (
            <ul className="space-y-0.5">
              {leadingNotes > 0 && (
                <li>
                  <button
                    type="button"
                    onClick={() => onJump(1)}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] text-gloss-textDim hover:text-gloss-text hover:bg-gloss-surface2"
                  >
                    <span className="truncate">开头</span>
                    <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-gloss-accent" />
                  </button>
                </li>
              )}
              {outline.map((entry, i) => {
                const until = entry.untilIndex ?? Number.POSITIVE_INFINITY;
                const hasNote = noteIndexes.some(
                  (n) => n >= entry.index && n <= until,
                );
                const active =
                  activeIndex === entry.index ||
                  // Until the observer reports, treat the first entry as
                  // current so the panel is never blank-looking at rest.
                  (activeIndex === null && i === 0);
                return (
                  <li key={entry.index}>
                    <button
                      type="button"
                      onClick={() => onJump(entry.index)}
                      title={`¶${entry.index} ${entry.text}`}
                      aria-current={active ? "true" : undefined}
                      // Indent by depth. Padding rather than margin so the
                      // click target stays full-width.
                      style={{ paddingLeft: `${(entry.level - 1) * 0.75 + 0.375}rem` }}
                      className={`flex w-full items-center gap-1.5 rounded py-1 pr-1.5 text-left text-[11px] leading-snug transition-colors ${
                        active
                          ? "text-gloss-text bg-gloss-surface2"
                          : "text-gloss-textDim hover:text-gloss-text hover:bg-gloss-surface2"
                      }`}
                    >
                      <span className="truncate">{entry.text}</span>
                      {hasNote && (
                        <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-gloss-accent" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </div>
    </aside>
  );
}
