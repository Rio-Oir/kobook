// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  ViewTransition,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { NotebookPen, Pencil } from "lucide-react";
import { useStore } from "@/lib/store";
import { EMPTY_PARAGRAPHS, useArticleBody, useArticleParagraphs } from "@/lib/article-body";
import { streamChat, useModelInfo, type StreamUsage } from "@/lib/ai";
import TopBarMenu from "@/components/TopBarMenu";
import ReadingSettings from "@/components/ReadingSettings";
import { ColumnGrip, type GripSide } from "@/components/ColumnGrip";
import NoteConnection from "@/components/NoteConnection";
import Notebook, { type NotebookJump } from "@/components/Notebook";
import ParagraphReferences from "@/components/ParagraphReferences";
import { noteSlices, type NoteSlice } from "@/lib/note-anchors";
import {
  NOTE_RAIL_EDGE_PX,
  NOTE_RAIL_HEADER_PX,
  isNoteAnchorAway,
  layoutNoteRail,
  noteCardShift,
} from "@/lib/note-rail";
import {
  MEASURE_RANGE,
  RAIL_LANE_PX,
  RAIL_MIN_PX,
  columnWidthFor,
  dragColumnLayout,
  measureForColumnWidth,
  railBalanceFor,
  railCollapsed,
  readingCssVars,
  useReadingPrefs,
  type ReadingPrefs,
} from "@/lib/reading-prefs";
import { buildExplainMessages } from "@/lib/explain";
import { buildAskMessages } from "@/lib/ask";
import { generateBrief } from "@/lib/brief";
import { rangeToOffsets, boundaryOffset, segmentBlock, type BlockSlice } from "@/lib/text-offset";
import {
  blockKindOf,
  groupBlocks,
  headingTag,
  outlineOf,
  titleSizeClass,
  type OutlineEntry,
} from "@/lib/blocks";
import {
  persistAnswer,
  persistFollowUpQuestion,
  persistNote,
  removeNote as removeRemoteNote,
  retryArticleSync,
  syncArticleEdit,
  syncNotesFromServer,
} from "@/lib/cloud/bridge";
import {
  persistHighlight,
  pushHighlightUpdate,
  removeRemoteHighlight,
  syncHighlightsForArticle,
} from "@/lib/cloud-highlights";
import { pushArticleMetadata, pushBriefNow } from "@/lib/cloud-article-meta";
import { useSession } from "@/lib/session";
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
  InlineSpan,
  NoteType,
  Paragraph,
} from "@/lib/types";
import { MAX_HIGHLIGHT_NOTE_LENGTH } from "@/lib/types";
import { noteColorRgb } from "@/lib/note-color";
import { safeHostname } from "@/lib/utils";
import { currentSessionEpoch } from "@/lib/session-epoch";
import type { DocumentBlock } from "@/lib/editing/document";
// 路由与共享元素接口。`navigate` 走 `pushState` + 显式 transition，
// 书库卡片的 shared-element 名字由 `lib/view-transition.ts` 统一给出。
import { navigate, setPostTransitionFocus } from "@/lib/navigate";
import { postVtName, POST_VT_SHARE } from "@/lib/view-transition";
// 文章头卡的封面派生与 AI 标签由并行模块提供，本页只负责渲染。
import { coverArtFor } from "@/lib/covers";
import { coverImageFromParagraphs } from "@/lib/articles";
import { ensureArticleTags } from "@/lib/tagging";
import { MAX_TAGS, categoryOf, tagsBesidesCategory } from "@/lib/taxonomy";

// Editing is a mode, not the default surface. Loading Tiptap statically would
// put the whole editor into the bundle every reader downloads to read; the
// chunk is fetched the first time someone enters edit mode — by
// `useEditorChunk`, which turns a hung request into a visible error with a
// retry instead of an endless "正在载入编辑器…".
import { useEditorChunk } from "@/components/editor-chunk";

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

/**
 * The block the reader's eye is on: the first one still on screen.
 *
 * Any block would do for the correction in `useReadingPositionAnchor` — the
 * delta is identical for all of them — but anchoring to the topmost visible
 * one means the block that visibly moves is the block being read.
 */
function captureReadingAnchor(
  root: HTMLElement | null,
): { index: number; top: number } | null {
  if (!root) return null;
  for (const block of root.querySelectorAll<HTMLElement>(
    "[data-paragraph-index]",
  )) {
    const rect = block.getBoundingClientRect();
    if (rect.bottom > 0) {
      return { index: Number(block.dataset.paragraphIndex), top: rect.top };
    }
  }
  return null;
}

/**
 * Whether a focused element is a field the reader is typing into.
 *
 * Used by the note rail's "is this card in use?" check. The distinction
 * matters because focus is sticky: after a click on any button the button
 * keeps focus, so a rule of "focus is somewhere inside the card" would
 * keep that card expanded for the rest of the session — including after
 * the reader has scrolled into unrelated text. Only an editable control
 * (a text field, a select, or a contenteditable region) means the reader
 * is mid-input and the card must not be taken away.
 */
function isEditableControl(element: Element): boolean {
  const tag = element.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * `YYYY-MM-DD HH:mm:ss`，本地时区、24 小时制。
 *
 * 手写而不是 `toLocaleString`：头卡里这是一列定宽时间戳，而 locale 的
 * 默认排版会随设备把字段换位。坏值（老数据、迁移留下的脏时间）显示
 * `—`，不显示 `Invalid Date`。
 */
function formatStamp(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** `<time dateTime>` 要机器可读的值；坏值就不写这个属性。 */
function isoStamp(ms: number): string | undefined {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 地址行的显示文本：主机名 + 路径，过长截断。
 *
 * 只写主机名会丢掉文章路径，而同站两篇文章的差别恰恰在路径上；完整
 * URL 放在 `title` 里，截断时才不至于无从查证。
 */
function displayAddress(url: string): string {
  let tail = "";
  try {
    const parsed = new URL(url);
    tail = (parsed.pathname === "/" ? "" : parsed.pathname) + parsed.search;
  } catch {
    // 解析不了就只显示主机名兜底，不编造路径。
  }
  const text = safeHostname(url) + tail;
  return text.length > 56 ? `${text.slice(0, 55)}…` : text;
}

export default function Reader({ articleId }: { articleId: string }) {
  const article = useStore((s) => s.articles[articleId]);
  /**
   * The article's text, which is no longer part of its record.
   *
   * `paragraphs` is a stable reference: `EMPTY_PARAGRAPHS` while the body is
   * loading or absent, and the body object's own array once it is here. Every
   * `useMemo` below depends on it, so an unstable empty array would recompute
   * the outline and the block groups on every render.
   */
  const bodyEntry = useArticleBody(articleId);
  const paragraphs = bodyEntry?.state === "present" ? bodyEntry.body.paragraphs : EMPTY_PARAGRAPHS;
  /**
   * Notes belonging to the document currently on screen.
   *
   * A refresh writes a new version, and notes anchored to the old one still
   * describe the old text — rendering them beside the new paragraphs would
   * attribute an annotation to a sentence it was never about. So the
   * default view is the displayed version, and the ones from other versions
   * are counted and reachable rather than hidden: the plan requires the old
   * notes to stay readable, and "readable" cannot mean "invisible".
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
  const setHighlightNote = useStore((s) => s.setHighlightNote);
  const deleteHighlight = useStore((s) => s.deleteHighlight);
  const applyParagraphEdit = useStore((s) => s.applyParagraphEdit);
  const replaceArticleBody = useStore((s) => s.replaceArticleBody);
  const highlightColor = useStore((s) => s.highlightColor);
  const highlightStyle = useStore((s) => s.highlightStyle);
  const setHighlightPrefs = useStore((s) => s.setHighlightPrefs);
  const outlineOpen = useStore((s) => s.outlineOpen);
  const setOutlineOpen = useStore((s) => s.setOutlineOpen);

  // ── Reading typography ─────────────────────────────────────────
  // The preference set is read field by field through `useShallow` so a
  // change to one control does not re-render the article twice.
  const articleRef = useRef<HTMLDivElement>(null);
  const readingPrefs = useReadingPrefs(
    useShallow((s) => ({
      font: s.font,
      fontSizePx: s.fontSizePx,
      lineHeight: s.lineHeight,
      measure: s.measure,
      paragraphGap: s.paragraphGap,
      railBalance: s.railBalance,
      notesOpen: s.notesOpen,
    })),
  );
  const updateReadingPrefs = useReadingPrefs((s) => s.update);
  const resetReadingPrefs = useReadingPrefs((s) => s.reset);
  const [readingSettingsOpen, setReadingSettingsOpen] = useState(false);

  const outlineRef = useRef<HTMLElement>(null);
  /** The three-track grid itself; the drag writes its custom properties. */
  const layoutRef = useRef<HTMLDivElement>(null);

  /**
   * The reading position, captured just before a change that reflows the
   * column.
   *
   * `null` means "nothing pending", which is also the state on first mount —
   * that is what keeps the restore effect from scrolling on load.
   */
  const pendingAnchorRef = useRef<{ index: number; top: number } | null>(null);

  /**
   * Apply a preference, keeping the reader where they were.
   *
   * A font size or line height change reflows the entire article, so every
   * block below the change moves. Without this, picking 22px from the top of
   * a long article is fine and picking it from paragraph 300 throws the
   * reader back to roughly the same *pixel*, i.e. to a different sentence.
   * Capturing before the write and correcting after the commit is exact
   * rather than an approximation: the block is the same DOM node, so the
   * difference between its two positions is precisely how far the content
   * above it grew.
   */
  function applyReadingPrefs(patch: Partial<ReadingPrefs>) {
    pendingAnchorRef.current = captureReadingAnchor(articleRef.current);
    updateReadingPrefs(patch);
  }

  function resetReadingPrefsKeepingPlace() {
    pendingAnchorRef.current = captureReadingAnchor(articleRef.current);
    resetReadingPrefs();
  }

  // ── Dragging the column edges ──────────────────────────────────
  //
  // The drag writes CSS custom properties straight onto the grid rather
  // than calling `updateReadingPrefs`, because a preference write
  // re-renders the whole article: at one update per `pointermove` that is
  // sixty re-renders a second of every paragraph on the page, for a change
  // the browser can apply to one track. The store is written once, on
  // release.
  //
  // That leaves the reading position unguarded during the gesture — the
  // anchor effect below only fires on a preference change — so the drag
  // corrects the scroll itself, against the same anchor, on every frame.

  /** Everything the drag needs to know, frozen when the pointer went down. */
  const columnDragRef = useRef<{
    side: GripSide;
    /** The block the reader was on, and where it was. */
    anchor: { index: number; top: number } | null;
    /** Article column width and the two rail widths, all at drag start. */
    columnWidth: number;
    leftRailWidth: number;
    rightRailWidth: number;
    viewportWidth: number;
    /** The article's own padding, and the paragraph-number gutter. */
    sidePad: number;
    gutter: number;
    fontSize: number;
  } | null>(null);

  /**
   * The three-track row, as it currently stands.
   *
   * Everything is read off the DOM rather than recomputed from the stored
   * preference, because the two can legitimately disagree: a viewport too
   * narrow for the requested measure caps the column, and the drag has to
   * start from what is on screen or the first pixel of movement would jump.
   */
  function readColumnGeometry() {
    const layout = layoutRef.current;
    const main = articleRef.current;
    if (!layout || !main) return null;

    const layoutRect = layout.getBoundingClientRect();
    const columnWidth = main.getBoundingClientRect().width;
    const notesRail = layout.querySelector<HTMLElement>(
      '[data-testid="notes-panel"]',
    );
    const rightRailWidth = notesRail
      ? notesRail.getBoundingClientRect().width
      : 0;
    // The outline rail is not rendered at all while the outline is closed
    // (`OutlineSidebar` returns null), so its track is empty and cannot be
    // measured. Whatever is not the article and not the notes rail is it.
    const leftRailWidth = outlineRef.current
      ? outlineRef.current.getBoundingClientRect().width
      : layoutRect.width - columnWidth - rightRailWidth;

    const mainStyle = getComputedStyle(main);
    const prose = main.querySelector<HTMLElement>(".gloss-prose");
    // The base size comes from the prose container, not from a block: a
    // heading's computed size is its own multiple of the body size, and
    // the first block is as likely to be a heading as a paragraph.
    const fontSize = parseFloat(prose ? getComputedStyle(prose).fontSize : "") || 20;
    // The gutter is read as the paragraph's resolved `padding-left` rather
    // than by parsing `--reading-gutter`, which is the string "2rem" — a
    // `parseFloat` of that is 2, and every width in the drag would be
    // 30px short. The padding is the same number after the cascade has
    // had its say.
    const para = main.querySelector<HTMLElement>("[data-paragraph-index]");
    const gutter = para ? parseFloat(getComputedStyle(para).paddingLeft) || 0 : 0;
    return {
      columnWidth,
      leftRailWidth,
      rightRailWidth,
      viewportWidth: layoutRect.width,
      // Read rather than assumed: the article's padding steps at `md`.
      sidePad: parseFloat(mainStyle.paddingLeft),
      gutter,
      fontSize,
    };
  }

  function beginColumnDrag(side: GripSide) {
    const geometry = readColumnGeometry();
    if (!geometry) return;
    columnDragRef.current = {
      side,
      anchor: captureReadingAnchor(articleRef.current),
      ...geometry,
    };
  }

  /** The narrowest the article may be dragged: the bottom of the range. */
  function minColumnWidthFor(drag: {
    fontSize: number;
    gutter: number;
    sidePad: number;
  }) {
    return columnWidthFor(
      MEASURE_RANGE[0],
      drag.fontSize,
      drag.gutter,
      drag.sidePad,
    );
  }

  function moveColumnDrag(dx: number) {
    const drag = columnDragRef.current;
    const layout = layoutRef.current;
    if (!drag || !layout) return;

    // The dragged edge follows the pointer and the opposite edge stays put,
    // so the rail on the dragged side takes the movement, the far rail does
    // not move at all, and the article is whatever is between them. The
    // arithmetic — including where the article's own minimum stops the
    // gesture — is `dragColumnLayout`'s business, because the same function
    // decides what gets stored when the pointer comes up.
    const draggedRailPx =
      drag.side === "left" ? drag.leftRailWidth + dx : drag.rightRailWidth - dx;
    const next = dragColumnLayout({
      side: drag.side,
      draggedRailPx,
      farRailPx: drag.side === "left" ? drag.rightRailWidth : drag.leftRailWidth,
      viewportPx: drag.viewportWidth,
      minColumnPx: minColumnWidthFor(drag),
    });

    // The article's width *is* written here, unlike on release: the pointer
    // lands between characters and the stylesheet only knows whole ones, so
    // mid-drag the track has to follow the pixels.
    layout.style.setProperty("--reading-column-w", `${next.columnPx}px`);
    applyRailGeometry(layout, drag.viewportWidth, next);
    restoreDragAnchor(drag.anchor);
  }

  /**
   * Paint the two rails for one arrangement of the three tracks.
   *
   * The *article's* width is deliberately not written here. While a drag is
   * in flight it has to be — the pointer lands between characters and the
   * stylesheet only knows whole ones — but on release the property has to
   * come off again so the track goes back to being derived from the stored
   * measure. Leaving it pinned would mean the drag's width outlived the
   * preference it produced: change the measure afterwards and nothing would
   * move, because the inline value still won.
   *
   * Everything else goes through custom properties rather than through
   * React: a drag runs at frame rate and re-rendering a whole article per
   * frame to move one track is not a trade worth making. The properties are
   * the same ones `readingCssVars` emits, so the stored preference
   * reproduces exactly what the last frame of the drag showed.
   */
  function applyRailGeometry(
    layout: HTMLElement,
    viewportWidth: number,
    next: {
      leftRailPx: number;
      columnPx: number;
      rightRailPx: number;
      leftCollapsed: boolean;
      rightCollapsed: boolean;
    },
  ) {
    layout.style.setProperty(
      "--reading-rail-balance",
      railBalanceFor(next.leftRailPx, next.columnPx, viewportWidth).toFixed(4),
    );
    layout.style.setProperty(
      "--reading-rail-left-content",
      next.leftCollapsed ? "hidden" : "visible",
    );
    layout.style.setProperty(
      "--reading-rail-right-content",
      next.rightCollapsed ? "hidden" : "visible",
    );
  }

  /** Keep the block the reader was on where it was, mid-drag. */
  function restoreDragAnchor(anchor: { index: number; top: number } | null) {
    if (!anchor) return;
    const block = articleRef.current?.querySelector<HTMLElement>(
      `[data-paragraph-index="${anchor.index}"]`,
    );
    if (!block) return;
    const delta = block.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
  }

  /** Put the rail properties back to what the store says they are. */
  function applyStoredRailVars(layout: HTMLElement) {
    layout.style.setProperty(
      "--reading-rail-balance",
      readingPrefs.railBalance.toFixed(4),
    );
    layout.style.setProperty(
      "--reading-rail-left-content",
      outlineOpen ? "visible" : "hidden",
    );
    layout.style.setProperty(
      "--reading-rail-right-content",
      readingPrefs.notesOpen ? "visible" : "hidden",
    );
    layout.style.removeProperty("--reading-column-w");
  }

  function endColumnDrag() {
    const drag = columnDragRef.current;
    const layout = layoutRef.current;
    if (!drag || !layout) return;
    columnDragRef.current = null;

    const main = articleRef.current;
    const live = readColumnGeometry();
    if (!main || !live) return;

    // A gesture the viewport refused to honour writes nothing.
    //
    // The article can already be sitting on a limit — its own narrowest, or
    // the room the rails leave — so dragging further leaves every track
    // exactly where it was. Deriving a measure from that width would still
    // "work", and would quietly rewrite a stored 30 down to the 26 this
    // viewport can draw, losing a choice the reader made on a wider screen.
    // Nothing moved, so the drag has nothing to report.
    const columnMoved = Math.abs(live.columnWidth - drag.columnWidth) >= 0.5;
    const railsChanged =
      railCollapsed(live.leftRailWidth) === outlineOpen ||
      railCollapsed(live.rightRailWidth) === readingPrefs.notesOpen;
    if (!columnMoved && !railsChanged) {
      applyStoredRailVars(layout);
      return;
    }

    const measure = measureForColumnWidth(
      live.columnWidth,
      drag.fontSize,
      drag.gutter,
      drag.sidePad,
    );
    // Snap: the column the pointer landed on is generally not a whole
    // number of characters, so the width the stylesheet derives from the
    // stored measure is up to half a character away from it. Landing on
    // the snapped width here — rather than letting the property removal
    // and the React commit land at slightly different moments — means the
    // handle and the rails are already in their final places.
    const snappedColumn = columnWidthFor(
      measure,
      drag.fontSize,
      drag.gutter,
      drag.sidePad,
    );
    // The half character the snap gives back comes out of the edge the
    // reader was dragging, so the far rail does not twitch on release —
    // unless that rail has been pushed out of the way, where there is no
    // width to give back. A lane is a fixed size, so the far rail takes the
    // difference instead and the article keeps the whole snap.
    const delta = live.columnWidth - snappedColumn;
    const leftRailPx =
      drag.side === "left" && !railCollapsed(live.leftRailWidth)
        ? Math.max(RAIL_LANE_PX, live.leftRailWidth + delta)
        : live.leftRailWidth;
    const rightRailPx =
      drag.side === "right" && !railCollapsed(live.rightRailWidth)
        ? Math.max(RAIL_LANE_PX, live.rightRailWidth + delta)
        : live.rightRailWidth;
    const leftCollapsed = railCollapsed(leftRailPx);
    const rightCollapsed = railCollapsed(rightRailPx);
    const railBalance = railBalanceFor(
      leftRailPx,
      snappedColumn,
      drag.viewportWidth,
    );

    // The inline width was the un-snapped one. Dropping it hands the track
    // back to the stylesheet, which derives it from the measure — that is
    // the snap. The rail properties are deliberately left in place: they
    // already hold the snapped values, and leaving them means the geometry
    // is right even in the case where the store write changes nothing and
    // React therefore does not re-render.
    //
    // The anchor is captured *before* the property is removed, because
    // removing it reflows the column — the position to restore is the one
    // from before the snap.
    pendingAnchorRef.current = captureReadingAnchor(main);
    layout.style.removeProperty("--reading-column-w");
    applyRailGeometry(layout, drag.viewportWidth, {
      leftRailPx,
      columnPx: snappedColumn,
      rightRailPx,
      leftCollapsed,
      rightCollapsed,
    });

    // A rail that the drag pushed out of the way is recorded where the
    // reader can find it again: the toolbar's outline button and the notes
    // preference. Two stores, because that is where the two switches have
    // always lived — but one gesture, and the button agrees with what is
    // on screen either way.
    if (outlineOpen === leftCollapsed) setOutlineOpen(!leftCollapsed);
    updateReadingPrefs({
      measure,
      railBalance,
      notesOpen: !rightCollapsed,
    });
  }

  /**
   * One keyboard step, in characters. Positive widens.
   *
   * The same geometry as a drag, read fresh rather than frozen: a key press
   * has no gesture to hold onto, and each press starts from where the last
   * one left the edges. It moves one edge and leaves the other, so a
   * keyboard user ends up with the same off-centre column a pointer user
   * does.
   *
   * Committed through `applyReadingPrefs` rather than the inline-property
   * path: a key press is one discrete change, so re-rendering the article
   * once is the right cost, and the anchor correction comes for free.
   */
  function nudgeColumnEdge(side: GripSide, characters: number) {
    const geometry = readColumnGeometry();
    if (!geometry) return;
    const measure = Math.min(
      MEASURE_RANGE[1],
      Math.max(MEASURE_RANGE[0], readingPrefs.measure + characters),
    );
    if (measure === readingPrefs.measure) return;
    const delta = (measure - readingPrefs.measure) * geometry.fontSize;
    const leftRailWidth =
      side === "left"
        ? geometry.leftRailWidth - delta
        : geometry.leftRailWidth;
    // Clamped to the lane rather than left to go negative: a key step
    // taken while the rail is shut must leave it shut, not put the balance
    // somewhere the stylesheet would read as a rail on the wrong side of
    // its floor.
    const railBalance = railBalanceFor(
      Math.max(RAIL_LANE_PX, leftRailWidth),
      geometry.columnWidth + delta,
      geometry.viewportWidth,
    );
    applyReadingPrefs({ measure, railBalance });
  }

  /**
   * Show or hide a side rail from the toolbar.
   *
   * Deliberately *not* the same thing as a drag, and the difference is the
   * point. A drag moves a boundary — that is the reader deciding how wide
   * their line is, and nothing else is allowed to touch it. The button is
   * only about whether the rail is drawn: hiding the outline leaves the
   * reading area exactly where it was, at the width the reader chose,
   * because the position is not the outline's to move. That is what keeps a
   * document with no outline, or a reader who keeps the outline closed,
   * from ending up with the article shoved against the left edge.
   *
   * Showing a rail that had been dragged shut is the one case that has to
   * touch the width. A rail sitting on its lane would come back hidden, and
   * a button that appears to do nothing is worse than one that moves a
   * boundary — so it widens the rail to `RAIL_MIN_PX`, the narrowest width
   * at which there is anything to see, and takes the room from the article.
   */
  function toggleRail(rail: "outline" | "notes") {
    const open = rail === "outline" ? !outlineOpen : !readingPrefs.notesOpen;
    const setOpen = (value: boolean) => {
      if (rail === "outline") setOutlineOpen(value);
      else updateReadingPrefs({ notesOpen: value });
    };

    if (!open) {
      setOpen(false);
      return;
    }

    const geometry = readColumnGeometry();
    const current =
      rail === "outline" ? geometry?.leftRailWidth : geometry?.rightRailWidth;
    if (!geometry || current === undefined || current >= RAIL_MIN_PX) {
      setOpen(true);
      return;
    }

    const side: GripSide = rail === "outline" ? "left" : "right";
    const next = dragColumnLayout({
      side,
      // One pixel over the threshold, not on it: the rail is placed by a
      // balance ratio rounded to four decimals, and at a fractional slack
      // that can leave the drawn width a hundredth of a pixel under
      // `RAIL_MIN_PX` — which `railCollapsed` reads as "shut", so the button
      // would appear to do nothing. Aiming just past the threshold makes the
      // rounding unable to undo the gesture.
      draggedRailPx: RAIL_MIN_PX + 1,
      farRailPx:
        side === "left" ? geometry.rightRailWidth : geometry.leftRailWidth,
      viewportPx: geometry.viewportWidth,
      minColumnPx: minColumnWidthFor(geometry),
    });
    const measure = measureForColumnWidth(
      next.columnPx,
      geometry.fontSize,
      geometry.gutter,
      geometry.sidePad,
    );
    // The balance is measured against the width the *stored* measure
    // produces, not the one the gesture landed on. The two differ by up to
    // half a character and the stylesheet will draw the former.
    const railBalance = railBalanceFor(
      next.leftRailPx,
      columnWidthFor(
        measure,
        geometry.fontSize,
        geometry.gutter,
        geometry.sidePad,
      ),
      geometry.viewportWidth,
    );

    pendingAnchorRef.current = captureReadingAnchor(articleRef.current);
    setOpen(true);
    updateReadingPrefs({ measure, railBalance });
  }

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    pendingAnchorRef.current = null;
    const block = articleRef.current?.querySelector<HTMLElement>(
      `[data-paragraph-index="${anchor.index}"]`,
    );
    if (!block) return;
    const delta = block.getBoundingClientRect().top - anchor.top;
    // Sub-pixel differences are rounding, not reflow; scrolling for them
    // would fight the browser's own layout.
    if (Math.abs(delta) > 0.5) window.scrollBy(0, delta);
  }, [
    readingPrefs.font,
    readingPrefs.fontSizePx,
    readingPrefs.lineHeight,
    readingPrefs.measure,
    readingPrefs.paragraphGap,
    readingPrefs.railBalance,
    // Both rails reflow the article when they open or shut, so the reading
    // position has to be corrected for the toggle as well as for the drag —
    // the toolbar button now gives the outline's width back to the text
    // instead of leaving an empty track behind.
    readingPrefs.notesOpen,
    outlineOpen,
  ]);

  // Save the token usage from a completed stream onto the note so the
  // user can see the cache hit (or miss) at the bottom of the card.
  function attachUsage(noteId: string, u: StreamUsage) {
    applyUsage(noteId, u);
  }

  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [askOpen, setAskOpen] = useState<SelectionInfo | null>(null);
  const [askQuestion, setAskQuestion] = useState("");
  const [editMode, setEditMode] = useState(false);
  // A remote cover picture that fails to load falls back to the generated wash
  // rather than the browser's broken-image glyph. Declared with the component's
  // other state so it is not called conditionally.
  const [coverFailed, setCoverFailed] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  /**
   * 编辑器 chunk 的加载状态。
   *
   * 它必须是显式的三态（loading / ready / error），而不是交给 `<Suspense>`：
   * 请求挂住时 Suspense 只会永远停在 fallback 上，用户既看不到原因也没有
   * 重试入口。见 `components/editor-chunk.ts`。
   */
  const editorChunk = useEditorChunk(editMode);
  /**
   * 「重试」会重新加载页面；这个 effect 让加载完的页面自动回到编辑模式。
   *
   * 标志只活一次：读取即删除。等正文就绪（`paragraphs.length > 0`）再进，
   * 否则编辑器会以空文档挂上，正文一到也不回填。
   */
  useEffect(() => {
    const id = article?.id;
    if (!id || paragraphs.length === 0) return;
    const key = `gloss-editor-retry:${id}`;
    if (sessionStorage.getItem(key) !== "1") return;
    sessionStorage.removeItem(key);
    setEditMode(true);
  }, [article?.id, paragraphs.length]);

  /**
   * Commit a whole-document edit.
   *
   * The local write happens first and is durable; the cloud pass (a new version
   * of an already-uploaded article) is queued by the store's `editStatus` flag
   * and reported separately. Detached highlights are surfaced in the notice bar
   * rather than silently disappearing.
   */
  async function saveDocument(blocks: DocumentBlock[]): Promise<void> {
    if (!article) return;
    setSavingEdit(true);
    setEditError(null);
    const outcome = await replaceArticleBody(article.id, blocks);
    setSavingEdit(false);
    if (!outcome.ok) {
      setEditError(outcome.message);
      return;
    }
    setEditMode(false);
    setSelection(null);
    setAskOpen(null);
    if (outcome.detached > 0) {
      setEditNotice(`有 ${outcome.detached} 条高亮因这次编辑失效，已保留但不再显示。`);
    } else if (outcome.reanchored > 0) {
      setEditNotice(`${outcome.reanchored} 条高亮已按文本重新定位。`);
    } else {
      setEditNotice(null);
    }

    if (article.remoteId) {
      setEditNotice("已保存到本机，正在同步云端…");
      void syncArticleEdit(article.id).then((verdict) => {
        if (verdict.status === "uploaded") {
          setEditNotice("已保存并同步到云端。");
        } else if (verdict.status === "conflict") {
          setEditNotice(`已保存到本机；${verdict.message ?? "云端已有更新的版本"}。`);
        } else if (verdict.status === "stale-owner") {
          setEditNotice("已保存到本机；账号已切换，这次编辑未同步。");
        } else if (verdict.status !== "missing") {
          setEditNotice(
            `已保存到本机；云端同步失败：${verdict.message ?? "稍后重试"}。`,
          );
        }
      });
    }
  }
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefLoading, setBriefLoading] = useState(false);
  /**
   * 标签生成状态。
   *
   * 自动补标签（打开文章时）和“重新生成”按钮共用这一份状态：页面上
   * 只有一行标签，两个入口同时跑没有意义，用户要看的也只是“正在
   * 进行”这一件事。
   */
  const [tagging, setTagging] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  /**
   * 每次发起生成时自增的序号。回来时序号对不上，说明这次结果已经
   * 过期（组件卸载、换了文章，或被新的一次调用顶掉），不再 setState。
   */
  const tagRunRef = useRef(0);
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
  /**
   * The element both halves of the note link live in: the article column
   * *and* the notes rail. `NoteConnection` measures one against the other
   * through this ref, so it has to be the shared ancestor rather than
   * either end. The reading grid is exactly that element, and it is
   * already held for the column drag — one ref, not a second wrapper.
   */
  const connectionRoot = layoutRef;
  /**
   * The note whose passage is currently underlined and, when both ends are
   * on screen, connected by a curve.
   *
   * It is *not* derived from the selection: the note the user just asked
   * about stays active after the selection is cleared, and clicking a card
   * or an underline moves it. `null` means nothing is emphasised.
   */
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  /**
   * The note the reader is *pointing at*: the card under the pointer, or
   * the card whose controls hold keyboard focus.
   *
   * This is a temporary association, not an identity. It never writes
   * `activeNoteId`, never expands a card and never scrolls: it exists so
   * that hovering a record can highlight the exact passage it is about,
   * and so the connector curve can follow the card under the pointer
   * instead of whichever record was clicked last. Leaving the card
   * restores the emphasis that was there before.
   *
   * Kept as an id (not an element) so a deleted note simply stops
   * resolving; the `allNotes` effect below drops it as well.
   */
  const [associatedNoteId, setAssociatedNoteId] = useState<string | null>(null);
  /**
   * Which note conversations are expanded in the rail.
   *
   * Normally one: clicking a compact record, an underline, or creating a
   * new note opens that record and closes the others. A card that is
   * protected — its follow-up input has focus, it holds a non-empty
   * draft, or it is streaming — is allowed to stay open beside the new
   * one. Forcing it shut would throw away the thing the reader is doing,
   * which is exactly the failure this lifecycle must not introduce.
   */
  const [expandedNoteIds, setExpandedNoteIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /**
   * Follow-up drafts, keyed by note id.
   *
   * Held here rather than inside `NoteCard` so collapsing the card (or
   * the rail growing/shrinking under a scroll) cannot discard a
   * half-typed question. The card itself stays mounted either way; this
   * is what makes the value survive even if the compact view never
   * renders the input.
   */
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  /** Measured card heights, by note id (see the ResizeObserver below). */
  const [noteHeights, setNoteHeights] = useState<Record<string, number>>({});
  /** Document-relative `top` for every current note card. */
  const [notePositions, setNotePositions] = useState<Record<string, number>>({});
  /** The positioning layer's minimum height, so the rail can hold the last card. */
  const [noteStageHeight, setNoteStageHeight] = useState(0);
  const noteStageRef = useRef<HTMLDivElement>(null);
  const noteSlotsRef = useRef(new Map<string, HTMLDivElement>());
  /** Latest values for the scroll listener, which is subscribed once. */
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const draftsRef = useRef(noteDrafts);
  draftsRef.current = noteDrafts;
  const expandedRef = useRef(expandedNoteIds);
  expandedRef.current = expandedNoteIds;
  const notesOpenRef = useRef(readingPrefs.notesOpen);
  notesOpenRef.current = readingPrefs.notesOpen;
  const headerHeightRef = useRef(0);
  const noteVisibilityScheduleRef = useRef<(() => void) | null>(null);
  /**
   * Where every note's quote still sits in the text on screen.
   *
   * Recomputed when the notes or the paragraphs change — a re-import, a
   * delete, a new note — and never mutated in place. A note whose stored
   * anchor no longer matches the text (see `lib/note-anchors.ts`)
   * contributes nothing rather than contributing a guess.
   */
  const anchoredSlices = useMemo(
    () => notes.flatMap((n) => noteSlices(n, paragraphs)),
    [notes, paragraphs],
  );
  const anchoredNoteIds = useMemo(
    () => new Set(anchoredSlices.map((slice) => slice.id)),
    [anchoredSlices],
  );

  function noteDraftFor(id: string): string {
    return noteDrafts[id] ?? "";
  }

  function setNoteDraft(id: string, value: string) {
    setNoteDrafts((drafts) => ({ ...drafts, [id]: value }));
  }

  function clearNoteDraft(id: string) {
    setNoteDrafts((drafts) => {
      if (!(id in drafts)) return drafts;
      const { [id]: _cleared, ...rest } = drafts;
      return rest;
    });
  }

  /**
   * Whether a card must stay expanded even when its passage is away.
   *
   * All three conditions are read live rather than snapshotted: the
   * scroll handler can fire between a keystroke and its render, and the
   * question it is asking is "is the reader *now* using this card?".
   */
  /**
   * Whether a card must stay expanded even when its passage is away.
   *
   * All three conditions are read live rather than snapshotted: the
   * scroll handler can fire between a keystroke and its render, and the
   * question it is asking is "is the reader *now* using this card?".
   *
   * "Using" means *editing*. Focus on an ordinary control — the copy,
   * collapse, delete or paragraph buttons, or the compact record's own
   * 展开 button, which is what opening a card focuses — must not count:
   * a reader who clicked copy and then scrolled on is reading the
   * article, and a button that is still focused is not a draft. Treating
   * any focus inside the card as use made every record that was ever
   * opened stay open for the rest of the session, because the last
   * clicked control keeps focus. Only an editable field is a reason to
   * hold the conversation on screen.
   */
  function noteIsProtected(id: string): boolean {
    const note = notesRef.current.find((n) => n.id === id);
    if (note?.isStreaming) return true;
    if ((draftsRef.current[id] ?? "").trim().length > 0) return true;
    const slot = noteSlotsRef.current.get(id);
    const active = document.activeElement;
    return Boolean(
      slot &&
        active &&
        slot.contains(active) &&
        isEditableControl(active),
    );
  }

  /**
   * Open a note: make it active, expand it, and close the others that
   * are not in use.
   */
  function openNote(id: string) {
    setActiveNoteId(id);
    setExpandedNoteIds((previous) => {
      const next = new Set(previous);
      for (const other of previous) {
        if (other !== id && !noteIsProtected(other)) next.delete(other);
      }
      next.add(id);
      return next;
    });
  }

  /**
   * Open the conversation for a question the reader just asked.
   *
   * A new question is the one case where the reader's "keep the rail
   * closed" choice is overridden: the answer is about to stream into a
   * card, and a card in a rail that is not on screen cannot be read. The
   * rail is reopened through the same geometry as its toolbar button, so
   * the width the article gets back is the width the button would give.
   */
  function openNoteForNewQuestion(id: string) {
    if (window.innerWidth >= 1024 && !readingPrefs.notesOpen) toggleRail("notes");
    openNote(id);
  }

  /** Collapse without touching the saved record, the draft, or a stream. */
  function collapseNote(id: string) {
    setExpandedNoteIds((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }

  /** Remove the view state for a note that has been explicitly deleted. */
  function forgetNoteView(id: string) {
    collapseNote(id);
    setActiveNoteId((current) => (current === id ? null : current));
    setAssociatedNoteId((current) => (current === id ? null : current));
    clearNoteDraft(id);
  }

  /**
   * The one action that deletes a note.
   *
   * Routed through the cloud bridge's `removeNote` — the existing deletion
   * boundary — rather than the store directly, so a note that also exists
   * on the server has its remote row removed too. The card's ✕ does not
   * come here: it only collapses, which is why this is reachable solely
   * from the explicit delete control (two clicks, second one confirmed).
   */
  function deleteNoteExplicitly(id: string) {
    void removeRemoteNote(id);
    forgetNoteView(id);
  }

  function setNoteSlot(id: string, element: HTMLDivElement | null) {
    if (element) noteSlotsRef.current.set(id, element);
    else noteSlotsRef.current.delete(id);
  }

  /** Scroll to a paragraph and flash it, for a `¶N` reference in an answer. */
  function jumpToParagraph(index: number) {
    const el = paragraphRefs.current[index];
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.animate(
      [
        { backgroundColor: "rgba(100,133,220,.18)" },
        { backgroundColor: "transparent" },
      ],
      { duration: 1800 },
    );
  }

  /**
   * Go to the passage a note is about, from its card.
   *
   * The anchor element is the precise target, so it is preferred; a note
   * whose quote could not be placed (an ambiguous legacy quote, a stale
   * anchor) falls back to its recorded paragraph, which is what the note
   * knew even when the offsets did not survive.
   */
  function jumpToNote(id: string) {
    openNote(id);
    const note = notes.find((n) => n.id === id);
    const anchor = Array.from(
      connectionRoot.current?.querySelectorAll<HTMLElement>("[data-note-anchor]") ?? [],
    ).find((el) => el.dataset.noteAnchor === id);
    if (anchor) anchor.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (note) jumpToParagraph(note.paragraphIndex);
  }

  /**
   * Place every note card at its passage in document space.
   *
   * Called after every render because almost anything can move a passage:
   * a font change, a rail opening, a card above growing, a note being
   * deleted. The measurement is a read, and the state write is skipped
   * when nothing moved, so it settles rather than looping.
   *
   * Two passes, both deterministic, so this cannot oscillate: the first
   * resolves collisions alone and gives every card its unadjusted top; the
   * second asks `noteCardShift` whether an *open* record needs the bounded
   * nudge that keeps its top edge clear of the sticky header, and resolves
   * collisions again with that request in hand. Doing it in this order is
   * what keeps the nudge from being able to overlap the card above it — the
   * second pass can only push later records further down.
   *
   * It is a plain function rather than the effect body because scrolling
   * has to re-run it: the nudge is measured against the viewport, and a
   * scroll fires no render, so an open record would otherwise keep the
   * adjustment it was given at a scroll position the reader has left.
   */
  function placeNoteCards() {
    const stage = noteStageRef.current;
    if (!stage) return;
    const stageTop = stage.getBoundingClientRect().top;
    const firstAnchor = new Map<string, HTMLElement>();
    for (const element of
      connectionRoot.current?.querySelectorAll<HTMLElement>("[data-note-anchor]") ?? []) {
      const id = element.dataset.noteAnchor;
      if (id && !firstAnchor.has(id)) firstAnchor.set(id, element);
    }
    const anchorRects = new Map<string, { top: number; bottom: number }>();
    const items = notes.map((note, order) => {
      const paragraphIndex = note.startParagraphIndex ?? note.paragraphIndex;
      const element =
        firstAnchor.get(note.id) ??
        articleRef.current?.querySelector<HTMLElement>(
          `[data-paragraph-index="${paragraphIndex}"]`,
        ) ??
        null;
      const rect = element?.getBoundingClientRect();
      if (rect) anchorRects.set(note.id, { top: rect.top, bottom: rect.bottom });
      return {
        id: note.id,
        anchorTop: rect ? Math.max(0, rect.top - stageTop) : null,
        height: noteHeights[note.id] ?? 0,
        order,
      };
    });
    const options = { gap: 12, top: 12 };
    const base = layoutNoteRail(items, options);
    const layout = layoutNoteRail(
      items.map((item) => {
        if (!expandedNoteIds.has(item.id)) return { ...item, shift: 0 };
        return {
          ...item,
          // Relative to the position the first pass already resolved —
          // collision included — so a record that is both pushed down and
          // still under the header is nudged from where it actually is
          // rather than having the nudge recomputed away.
          nudgeFrom: base[item.id] ?? null,
          shift: noteCardShift({
            anchor: anchorRects.get(item.id) ?? null,
            documentTop: base[item.id] ?? 0,
            stageTop,
            height: item.height,
            viewportHeight: window.innerHeight,
            headerPx: headerHeightRef.current,
          }),
        };
      }),
      options,
    );
    setNotePositions((previous) => {
      const same =
        Object.keys(layout).length === Object.keys(previous).length &&
        Object.entries(layout).every(
          ([id, top]) => Math.abs((previous[id] ?? Number.NaN) - top) < 0.5,
        );
      return same ? previous : layout;
    });
    const bottom = notes.reduce(
      (max, note) =>
        Math.max(max, (layout[note.id] ?? 0) + (noteHeights[note.id] ?? 0)),
      0,
    );
    const height = Math.ceil(bottom + 24);
    setNoteStageHeight((previous) =>
      Math.abs(previous - height) < 0.5 ? previous : height,
    );
  }

  const placeNoteCardsRef = useRef(placeNoteCards);
  placeNoteCardsRef.current = placeNoteCards;

  useLayoutEffect(() => {
    placeNoteCards();
  });

  /**
   * Re-place the cards while the page scrolls.
   *
   * Coalesced to one measurement per frame, and it writes no state when
   * nothing moved, so a scroll storm costs one layout read per frame and
   * no renders at all unless a nudge actually changes.
   */
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        placeNoteCardsRef.current();
      });
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  /**
   * Keep the measured heights current.
   *
   * The card is the same React element in compact and expanded form, so
   * a collapse changes its border-box height without an animation; the
   * observer is what lets the layout below close the gap and let later
   * records return to their own passages.
   */
  useLayoutEffect(() => {
    const measure = () => {
      setNoteHeights((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const [id, element] of noteSlotsRef.current) {
          const height = element.getBoundingClientRect().height;
          if (Math.abs((next[id] ?? 0) - height) >= 0.5) {
            next[id] = height;
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of noteSlotsRef.current.values()) observer.observe(element);
    return () => observer.disconnect();
  });

  /**
   * Collapse a conversation whose passage has left the reading area.
   *
   * The subscription is stable; the values it reads (expanded ids,
   * drafts, notes, streaming flags, rail visibility) go through refs so
   * typing in a follow-up does not rebind the scroll listener on every
   * keystroke. `isNoteAnchorAway` supplies the hysteresis, and the short
   * timer keeps a smooth jump from collapsing mid-flight.
   */
  useEffect(() => {
    const timers = new Map<string, number>();
    let frame = 0;
    let disposed = false;

    const clearTimer = (id: string) => {
      const timer = timers.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(id);
      }
    };

    const isAway = (id: string): boolean => {
      if (window.innerWidth < 1024 || !notesOpenRef.current) return false;
      const note = notesRef.current.find((n) => n.id === id);
      let element: HTMLElement | null = null;
      for (const candidate of
        connectionRoot.current?.querySelectorAll<HTMLElement>("[data-note-anchor]") ?? []) {
        if (candidate.dataset.noteAnchor === id) {
          element = candidate;
          break;
        }
      }
      if (!element && note) {
        const paragraphIndex = note.startParagraphIndex ?? note.paragraphIndex;
        element =
          articleRef.current?.querySelector<HTMLElement>(
            `[data-paragraph-index="${paragraphIndex}"]`,
          ) ?? null;
      }
      if (!element) element = noteSlotsRef.current.get(id) ?? null;
      if (!element) return false;
      return isNoteAnchorAway(element.getBoundingClientRect(), window.innerHeight, {
        headerPx: Math.max(headerHeightRef.current, NOTE_RAIL_HEADER_PX - 4),
        edgePx: NOTE_RAIL_EDGE_PX,
      });
    };

    const check = () => {
      frame = 0;
      if (disposed) return;
      if (window.innerWidth < 1024 || !notesOpenRef.current) {
        for (const timer of timers.values()) window.clearTimeout(timer);
        timers.clear();
        return;
      }
      for (const id of Array.from(timers.keys())) {
        if (!expandedRef.current.has(id)) clearTimer(id);
      }
      for (const id of expandedRef.current) {
        if (noteIsProtected(id) || !isAway(id)) {
          clearTimer(id);
          continue;
        }
        if (timers.has(id)) continue;
        const timer = window.setTimeout(() => {
          timers.delete(id);
          if (disposed) return;
          if (!expandedRef.current.has(id)) return;
          if (noteIsProtected(id) || !isAway(id)) return;
          collapseNote(id);
        }, 180);
        timers.set(id, timer);
      }
    };

    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(check);
    };
    noteVisibilityScheduleRef.current = schedule;
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      noteVisibilityScheduleRef.current = null;
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
    };
    // Re-subscribed only when the set of open conversations changes.
    // Everything else the check reads is behind a ref on purpose.
  }, [expandedNoteIds]);

  // Note state can change while the page is still (stream finished,
  // draft cleared, a note deleted); re-evaluate without waiting for a
  // scroll event.
  useEffect(() => {
    noteVisibilityScheduleRef.current?.();
  }, [notes, expandedNoteIds, noteDrafts, readingPrefs.notesOpen]);

  // View state belongs to one article; a route change starts clean.
  useEffect(() => {
    setExpandedNoteIds(new Set());
    setNoteDrafts({});
    setActiveNoteId(null);
    setAssociatedNoteId(null);
  }, [articleId]);

  // A note deleted elsewhere (the notebook, another tab) must not leave
  // its id behind in the open set or its draft behind in the map.
  useEffect(() => {
    const alive = new Set(allNotes.map((note) => note.id));
    setExpandedNoteIds((previous) => {
      const kept = [...previous].filter((id) => alive.has(id));
      return kept.length === previous.size ? previous : new Set(kept);
    });
    setNoteDrafts((previous) => {
      const keys = Object.keys(previous);
      if (keys.every((key) => alive.has(key))) return previous;
      const next = { ...previous };
      for (const key of keys) if (!alive.has(key)) delete next[key];
      return next;
    });
    // The pointer cannot be "on" a card that no longer exists; dropping it
    // here is what keeps a deleted record from leaving the connector
    // pointing at nothing.
    setAssociatedNoteId((current) =>
      current !== null && !alive.has(current) ? null : current,
    );
  }, [allNotes]);
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

  /**
   * Stop the explain/ask run currently in flight, for the note card's stop
   * button. Cleared before `abort()` so a second click cannot land on a
   * controller whose run is already unwinding.
   */
  const stopActiveStream = useCallback(() => {
    const controller = streamControllerRef.current;
    if (!controller) return;
    streamControllerRef.current = null;
    controller.abort();
  }, []);

  /** 密钥和端点都确认之后才能打标签，否则请求必然失败。 */
  const canTag = modelInfo.hasKey && modelInfo.endpointConfirmed;
  /** 现有标签；`tags === undefined` 与空数组在这里同样表示“还没有”。 */
  const articleTags = article?.tags ?? [];
  const articleTagCount = articleTags.length;
  /**
   * 分类 = 标签列表的第一项（模型被要求按相关度从高到低给标签）。
   * 规则住在 `lib/taxonomy.ts`，书库和这里不各写一套。
   */
  const articleCategory = categoryOf(article);
  /** 分类之外的标签：分类本身不在这一行里重复出现。 */
  const articleOtherTags = tagsBesidesCategory(article);

  /**
   * 跑一次标签生成。
   *
   * `force` 只给“重新生成”用：自动流程只在文章还没有标签时触发，
   * 否则每次打开都会重跑一遍，把用户已经看到的标签换掉。
   *
   * 结果由 `lib/tagging.ts` 直接写回 store；本组件订阅的 `article`
   * 随之更新并自动重渲染，所以这里不另存一份标签副本。
   */
  async function runTagging(force: boolean) {
    if (!article) return;
    const run = ++tagRunRef.current;
    setTagging(true);
    setTagError(null);
    try {
      const tags = await ensureArticleTags(
        article.id,
        force ? { force: true } : undefined,
      );
      if (tagRunRef.current !== run) return;
      // `null` 表示这次没跑成（没有密钥、端点未确认或请求失败）。
      // 具体原因由 tagging 层记录；这里只留一行 muted 文案，不弹窗、
      // 不打断阅读。
      if (tags === null) setTagError("这次没有生成标签");
    } catch (err) {
      if (tagRunRef.current !== run) return;
      setTagError(err instanceof Error ? err.message : String(err));
    } finally {
      if (tagRunRef.current === run) setTagging(false);
    }
  }

  // “等有了 K 之后再读这篇文章时再打标签”：只补没有标签的文章。
  // 生成成功后 store 写入标签，数量从 0 变成非 0，这个 effect 重跑
  // 时会从上面的判断退出，不会循环。
  useEffect(() => {
    if (!article?.id || !canTag || articleTagCount > 0) return;
    void runTagging(false);
    // runTagging 每次渲染都是新函数，放进依赖会无限触发；它只依赖
    // article.id 和 canTag，两者已经在下面的依赖里。
  }, [article?.id, canTag, articleTagCount]);

  // 卸载/换文章时让在飞的标签请求作废：序号变了，回调不再 setState。
  useEffect(() => {
    return () => {
      tagRunRef.current += 1;
    };
  }, [articleId]);

  // Abort the in-flight stream on unmount, so switching articles mid-stream
  // does not keep appending to the previous note after navigation.
  useEffect(() => {
    return () => {
      streamControllerRef.current?.abort();
      streamControllerRef.current = null;
    };
  }, [articleId]);

  // Block structure. The parse layer already classifies every block and
  // records heading depth; these two derivations are what turn that back
  // into a structured page instead of a flat stack of paragraphs.
  // `article` can be undefined here (the missing-article branch returns
  // later), hence the `?? []`.
  const blockGroups = useMemo(
    () => groupBlocks(paragraphs),
    [paragraphs],
  );
  const outline = useMemo(
    () => outlineOf(paragraphs),
    [paragraphs],
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
  // Cloud sync has to wait for the session probe. On a reload the persisted
  // store hydrates before `/api/me` answers, and `isCloudEnabled()` is false
  // until the session resolves — a pull fired at mount would silently no-op
  // and the reader would keep a stale local copy until the next navigation.
  const sessionStatus = useSession((s) => s.status);

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
    // Marks sync both ways: unsent local marks are pushed, the account's are
    // merged in. Metadata (tags, summary, cover) is offered once per open so
    // an article imported before those columns existed gets backfilled.
    void syncHighlightsForArticle(articleId).catch((err: unknown) => {
      if (!cancelled) {
        console.warn(
          "[reader] cloud highlights unavailable:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
    void pushArticleMetadata(articleId).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [articleId, sessionStatus]);

  // Open brief automatically if it already exists
  useEffect(() => {
    if (article?.brief) setBriefOpen(true);
  }, [article?.brief]);

  const pointerDownRef = useRef(false);
  const [pointerDown, setPointerDown] = useState(false);
  /** Reads the live DOM selection into state. Assigned by the effect
   *  below so the pointer handlers can commit the finished selection. */
  const readSelectionRef = useRef<() => void>(() => {});

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("[data-selection-toolbar]")) return;
      pointerDownRef.current = true;
      setPointerDown(true);
    };
    const up = () => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      setPointerDown(false);
      // The drag is over, so the selection it produced is final now.
      readSelectionRef.current();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    // A drag that ends outside the window never delivers `pointerup`.
    document.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
    };
  }, []);

  // Track selection within the article
  useEffect(() => {
    function readSelection() {
      // The inline editor owns the selection while it is open: its ranges are
      // ProseMirror's, not the rendered block's, and measuring them against
      // `[data-paragraph-index]` would either fail or produce offsets for text
      // the reader is in the middle of changing.
      if (editMode) return;
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
    readSelectionRef.current = readSelection;
    function onSelectionChange() {
      if (pointerDownRef.current) return;
      readSelection();
    }
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      readSelectionRef.current = () => {};
    };
  }, [editMode]);

  // ── 笔记本 (the notebook drawer) ────────────────────────────────
  //
  // A view over the notes and highlights this article *already has*, opened
  // beside the reading column rather than in place of anything. It is
  // deliberately additive: the notes rail keeps rendering — a card there is
  // what a passage's underline points at, and a stream running inside one
  // must not be disturbed — the column keeps its width, and the drawer is
  // `position: fixed`, so nothing in the reading grid reflows and the
  // reader's place in the article does not move.
  const [notebookOpen, setNotebookOpen] = useState(false);
  /**
   * Where the drawer starts, measured from the app's own top bar.
   *
   * Measured rather than assumed: the bar's height depends on the resolved
   * font and on the browser's minimum text size, and a hard-coded offset
   * would either tuck a strip of the drawer under the bar or float it below
   * one.
   */
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  /** What had focus before the drawer opened, so it can be handed back. */
  const notebookReturnFocusRef = useRef<HTMLElement | null>(null);
  const notebookWasOpenRef = useRef(false);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setHeaderHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The auto-collapse threshold reads the header through a ref: the
  // listener is subscribed once, and the measured height changes when the
  // browser's minimum font size does.
  headerHeightRef.current = headerHeight;

  function toggleNotebook() {
    // Captured before the state change, while focus is still where the
    // reader left it — which is the whole point of remembering it.
    if (!notebookOpen) {
      const active = document.activeElement;
      notebookReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
    setNotebookOpen(!notebookOpen);
  }

  function closeNotebook() {
    setNotebookOpen(false);
  }

  // Hand focus back once the drawer is gone. Restoring it from the close
  // handler would focus an element that is still in the document; waiting
  // for the state to settle is what makes the return land on the control
  // the reader actually opened the drawer from.
  useEffect(() => {
    if (notebookOpen) {
      notebookWasOpenRef.current = true;
      return;
    }
    if (!notebookWasOpenRef.current) return;
    notebookWasOpenRef.current = false;
    const el = notebookReturnFocusRef.current;
    notebookReturnFocusRef.current = null;
    el?.focus?.({ preventScroll: true });
  }, [notebookOpen]);

  /**
   * The `N` shortcut.
   *
   * Ignored while the reader is typing — in an input, a textarea, or any
   * contenteditable — and while a modifier is held, and during an IME
   * composition. Without those three guards the key would swallow a
   * keystroke from a Chinese pinyin buffer or from a browser shortcut,
   * which is a far worse failure than a shortcut that does not fire.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "n" && event.key !== "N") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(input|textarea|select)$/i.test(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      toggleNotebook();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Re-subscribed on toggle only so the handler closes over the current
    // open state; nothing else in it depends on a render.
  }, [notebookOpen]);

  /**
   * Jump from the notebook to the exact passage an entry is about.
   *
   * The drawer only offers this when its own resolver proved the stored
   * anchor still describes the text on screen, so what is looked up here is
   * the same underline the article draws — the precise range, not the
   * paragraph. Nothing is scrolled when it is missing: a jump to "roughly
   * there" would be a claim about which sentence a note is about, and not
   * making that claim is the entire point of resolving the anchor first.
   */
  function jumpFromNotebook(jump: NotebookJump) {
    // Opening the record is the point of the jump: the drawer is a second
    // view of the same notes, and a reader who picks one there expects the
    // rail card to be open when they land, not a compact stub.
    if (jump.kind === "qa") openNote(jump.id);
    const selector =
      jump.kind === "qa"
        ? `[data-note-anchor="${jump.id}"]`
        : `[data-highlight-id="${jump.id}"]`;
    const target = articleRef.current?.querySelector<HTMLElement>(selector);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.animate(
        [
          { backgroundColor: "rgba(100,133,220,.28)" },
          { backgroundColor: "transparent" },
        ],
        { duration: 1400 },
      );
    }
    // Below `lg` the drawer is the whole viewport, so leaving it open would
    // hide the passage the reader just asked for. At `lg` and above it sits
    // over the notes rail and the article stays visible beside it.
    if (window.innerWidth < 1024) closeNotebook();
  }

  /**
   * Delete an AI note from the notebook.
   *
   * Routed through the cloud bridge's `removeNote`, which is the existing
   * deletion boundary: it deletes the local record and *then* offers the
   * remote one. Reaching past it into `deleteNote` would skip the remote
   * half and leave a server row for the next sync to resurrect.
   *
   * A stream still running for that note needs no abort here. The store's
   * own guards already absorb it: `appendToNote`, `appendTurn` and
   * `finishNote` all no-op on a missing id, and `makeTurnGuard` re-checks
   * the note and its active turn on every chunk — so a callback that lands
   * after this click is a no-op rather than a resurrection.
   */
  function deleteNoteFromNotebook(id: string) {
    void removeRemoteNote(id);
  }

  /**
   * Personal-remark drafts, keyed by highlight id.
   *
   * Held here rather than inside either editor so a half-typed remark is not
   * thrown away by closing the notebook, closing the manage-popover, or
   * jumping to the passage — the three things a reader does mid-sentence.
   * A draft is *unsaved text*: it is dropped on save (the store holds it
   * from then on), on cancel, and on an explicit delete.
   */
  const [remarkDrafts, setRemarkDrafts] = useState<Record<string, string>>({});

  function remarkDraftFor(highlightId: string): string {
    const draft = remarkDrafts[highlightId];
    if (draft !== undefined) return draft;
    return highlights.find((h) => h.id === highlightId)?.note ?? "";
  }

  function setRemarkDraft(highlightId: string, value: string) {
    setRemarkDrafts((drafts) => ({ ...drafts, [highlightId]: value }));
  }

  function dropRemarkDraft(highlightId: string) {
    setRemarkDrafts((drafts) => {
      if (!(highlightId in drafts)) return drafts;
      const { [highlightId]: _dropped, ...rest } = drafts;
      return rest;
    });
  }

  /** Commit the draft. An empty remark deletes the field rather than
   *  storing whitespace, so "no remark" stays one state. */
  function saveRemark(highlightId: string) {
    const text = remarkDraftFor(highlightId).trim();
    setHighlightNote(highlightId, text.length > 0 ? text : undefined);
    dropRemarkDraft(highlightId);
    void pushHighlightUpdate(highlightId);
  }

  /** Remove only the remark. The highlight itself is untouched — that is
   *  what `deleteHighlight` is for, and the two are offered separately. */
  function deleteRemark(highlightId: string) {
    setHighlightNote(highlightId, undefined);
    dropRemarkDraft(highlightId);
    void pushHighlightUpdate(highlightId);
  }

  /**
   * Delete a mark, on both ends.
   *
   * The account is told *before* the local record goes away, because the
   * remote id lives on the record that is about to be deleted; the local
   * delete itself stays synchronous so the underline disappears at once.
   */
  function removeHighlight(highlightId: string) {
    void removeRemoteHighlight(highlightId);
    deleteHighlight(highlightId);
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
    const paragraph = paragraphs.find((p) => p.index === paragraphIndex);
    if (!paragraph) return;
    const highlightId = addHighlight({
      articleId: article.id,
      paragraphIndex,
      startOffset,
      endOffset,
      selectionText: paragraph.text.slice(startOffset, endOffset),
      color,
      style: highlightStyle,
      ...(paragraph.blockId ? { blockId: paragraph.blockId } : {}),
    });
    // Push to the account in the background; a failure parks the mark in the
    // highlight queue and the next open replays it.
    void persistHighlight(highlightId, article.id);
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
    const messages = buildExplainMessages(article, paragraphs, sel.text);
    const question = `解释：${sel.text.slice(0, 80)}`;
    const noteId = addNote({
      articleId: article.id,
      // The version this note is being anchored to. Recorded locally as
      // well as sent, so the Reader can tell which notes belong to the
      // document currently on screen.
      remoteVersionId: article.versionId,
      // Frozen here, not read at paint time. `highlightColor` says what the
      // reader's *next* highlight will be; a note's own colour says what
      // this note is. Reading the live setting at render is what made every
      // question block on the page change together when one was armed.
      color: highlightColor,
      // The anchor travels with the *local* note as well as the upload:
      // without the offsets in the stored record the reader cannot
      // underline the quote this answer is about, and a note that came
      // back from the server would behave differently from the one just
      // created. Same shape, same values, one call.
      ...anchorFor(sel, "explain", sel.text, question),
      selectionText: sel.text,
      question,
      answer: "",
      model: modelInfo.name,
    });
    // Mirror to the server when there is an account and a server-side
    // article to attach to. Deliberately not awaited: the card and the
    // stream must not wait on a round trip.
    void persistNote(noteId, article.id, anchorFor(sel, "explain", sel.text, question));
    // The new note becomes the active one, which is what underlines its
    // passage and opens its conversation at that passage. The rail is
    // brought back if the reader had pushed it away — a new question
    // cannot answer into a rail that is not on screen.
    openNoteForNewQuestion(noteId);
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
        // The partial text is kept — the plan requires a failed stream
        // to preserve what already arrived — and the note is stored as
        // failed rather than as a success with a truncated answer.
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
      paragraphs,
      askOpen.text,
      question,
    );
    const noteId = addNote({
      articleId: article.id,
      remoteVersionId: article.versionId,
      // Frozen here, not read at paint time. `highlightColor` says what the
      // reader's *next* highlight will be; a note's own colour says what
      // this note is. Reading the live setting at render is what made every
      // question block on the page change together when one was armed.
      color: highlightColor,
      ...anchorFor(askOpen, "ask", askOpen.text, question),
      selectionText: askOpen.text,
      question,
      answer: "",
      model: modelInfo.name,
    });
    void persistNote(noteId, article.id, anchorFor(askOpen, "ask", askOpen.text, question));
    openNoteForNewQuestion(noteId);
    // Same as the explain path: the answer has to be visible.
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
      const brief = await generateBrief(article, paragraphs);
      const now = useStore.getState().articles[articleIdAtStart];
      const stillSameArticle =
        currentSessionEpoch() === epochAtStart &&
        useStore.getState().ownerUserId === ownerAtStart &&
        now?.versionId === versionAtStart;
      if (!stillSameArticle) return;
      setBrief(articleIdAtStart, { ...brief, generatedAt: Date.now() });
      setBriefOpen(true);
      // The summary is a model call; store it on the account so the reader
      // does not pay for it again on the next device.
      void pushBriefNow(articleIdAtStart);
    } catch (err) {
      if (currentSessionEpoch() !== epochAtStart) return;
      if (useStore.getState().ownerUserId !== ownerAtStart) return;
      alert("生成摘要失败：" + (err as Error).message);
    } finally {
      setBriefLoading(false);
    }
  }

  /**
   * A value that changes whenever a rail card moves without resizing.
   *
   * The connector re-measures on scroll and resize, but collapsing a card
   * *above* the active one moves it with neither — the rail is in
   * document space and nothing scrolls. Passing the computed positions
   * into `NoteConnection` is what keeps the curve on the card in that
   * case.
   */
  const noteRailRevision = useMemo(
    () =>
      `${Math.round(noteStageHeight)}|${notes
        .map((n) => `${n.id}:${Math.round(notePositions[n.id] ?? 0)}`)
        .join(",")}`,
    [notes, notePositions, noteStageHeight],
  );

  /**
   * The note the connector curve is drawn for, and the note whose passage
   * is emphasised *temporarily*.
   *
   * Two different questions, so two different answers:
   *
   *   - the curve follows the card under the pointer, falling back to the
   *     active one — the reader's pointer says which record they mean;
   *   - the strong emphasis belongs to the temporary association only. If
   *     the active note were fed in as a fallback, the note the reader last
   *     clicked would be painted as if they were pointing at it, and
   *     "leaving the card restores the previous emphasis" would have
   *     nothing left to restore.
   *
   * `associatedLive` is the association filtered against the notes that
   * still exist: an id left behind by a deleted record must not keep
   * emphasising (or connecting) anything.
   */
  const { connectorNoteId, associatedLive } = useMemo(() => {
    const alive = new Set(notes.map((n) => n.id));
    const associated =
      associatedNoteId !== null && alive.has(associatedNoteId) ? associatedNoteId : null;
    const active = activeNoteId !== null && alive.has(activeNoteId) ? activeNoteId : null;
    return { connectorNoteId: associated ?? active, associatedLive: associated };
  }, [notes, associatedNoteId, activeNoteId]);

  // The note the connector aims at, and its colour. Same colour for the
  // curve, the underline and the card border is what lets a reader see one
  // note as one thing across the article and the rail. `undefined`
  // resolves to the default blue inside the connector itself.
  const connectorColor = connectorNoteId
    ? notes.find((n) => n.id === connectorNoteId)?.color
    : undefined;

  // The document-space rail.
  //
  // Each card is absolutely placed at the passage it resolves to, so it
  // scrolls with the article instead of following the reader. The stage is
  // a positioning layer only: its height is the measured bottom of the
  // last card, and it does not clip, so a card that reaches past the end
  // of a short article still paints and still scrolls.
  const noteRailStage = (
    <div
      ref={noteStageRef}
      className="relative"
      data-testid="notes-stage"
      style={{ minHeight: noteStageHeight }}
    >
      {notes.length === 0 && otherVersionNotes.length === 0 ? (
        <div className="absolute left-4 right-4 top-8 text-xs text-gloss-textDim italic">
          选中正文中的文字，即可解释或提问。回答会显示在这里。
        </div>
      ) : null}
      {notes.map((n) => {
        const anchored = anchoredNoteIds.has(n.id);
        return (
          <div
            key={n.id}
            ref={(element) => setNoteSlot(n.id, element)}
            className="absolute left-4 right-4"
            data-note-slot={n.id}
            data-note-position={anchored ? "resolved" : "unresolved"}
            style={{ top: notePositions[n.id] ?? 12 }}
          >
            <NoteCard
              note={n}
              active={activeNoteId === n.id}
              associated={associatedNoteId === n.id}
              expanded={expandedNoteIds.has(n.id)}
              anchored={anchored}
              draft={noteDraftFor(n.id)}
              onDraftChange={(value) => setNoteDraft(n.id, value)}
              onDraftConsumed={() => clearNoteDraft(n.id)}
              onActivate={() => setActiveNoteId(n.id)}
              onAssociate={() => setAssociatedNoteId(n.id)}
              onDisassociate={() =>
                setAssociatedNoteId((current) => (current === n.id ? null : current))
              }
              onOpen={() => openNote(n.id)}
              onCollapse={() => collapseNote(n.id)}
              onDelete={() => deleteNoteExplicitly(n.id)}
              onJump={jumpToParagraph}
              onJumpAnchor={() => jumpToNote(n.id)}
              onStopActive={stopActiveStream}
            />
          </div>
        );
      })}
    </div>
  );

  /*
    Notes from other versions are counted and reachable, never silently
    dropped. Hiding them is right — they annotate text that is no longer
    on screen — but "旧笔记仍能读原版本" means they must stay readable,
    and "readable" cannot mean "impossible to find". They keep their own
    group below the document-space rail, because they have no position in
    this document to be placed at.
  */
  const otherVersionNotesBody =
    otherVersionNotes.length > 0 ? (
      <div className="px-4 pb-8 pt-2 mt-2 border-t border-gloss-border">
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
              <NoteCard
                key={n.id}
                note={n}
                expanded
                draft={noteDraftFor(n.id)}
                onDraftChange={(value) => setNoteDraft(n.id, value)}
                onDraftConsumed={() => clearNoteDraft(n.id)}
                onDelete={() => deleteNoteExplicitly(n.id)}
                onJump={jumpToParagraph}
                onStopActive={stopActiveStream}
              />
            ))}
          </div>
        ) : null}
      </div>
    ) : null;


  /**
   * The missing-article branch, deliberately **after every hook in this
   * component**.
   *
   * It used to sit above the two `useMemo`s further down. Hooks are matched by
   * call order, so a render that took this branch called two fewer of them than
   * the render before it and React threw `Rendered fewer hooks than expected`,
   * taking the page down. The trigger is ordinary: `clearUserCache()` empties
   * `articles` while this component is still mounted, which is exactly what a
   * sign-out does — and deleting the article you are reading does it too.
   *
   * Neither of the two hooks below reads `article`, so running them for an
   * article that no longer exists is a wasted `useMemo`, not a crash. **If a
   * hook is ever added below this point it must go above this return**, or the
   * crash comes back.
   */
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

  // 封面横幅的配色/首字由标题派生，和书库卡片的缩略图是同一个函数，
  // 所以转场前后看起来是同一张封面在长个儿。
  // 文章自带的图（抓取页的 og:image 或正文第一张图）优先；老文章记录里
  // 没有这个字段时，从已经加载的正文里再找一次。都没有就退到插画库
  // （按文章 id 挑，见 `covers.ts`），所以每篇都有封面。
  const coverArt = coverArtFor(
    article.title,
    article.id,
    article.coverImage ?? coverImageFromParagraphs(paragraphs),
  );
  // A remote picture that fails to load falls back to the generated wash
  // rather than the browser's broken-image glyph.
  const coverImage = coverFailed ? undefined : coverArt.image;

  // 页头笔记本徽标上的数字：面板里列的就是「AI 问答 + 高亮」两样，所以徽标
  // 数这两样的合计，打开面板对得上号。它替代了原来单独一段「N 条笔记」。
  const notebookCount = notes.length + highlights.length;

  return (
    <div className="min-h-screen bg-gloss-bg">
      {/* Top bar */}
      {/* Top bar. `min-w-0` on the left group is what lets the title
          truncate: without it a flex item refuses to shrink below its
          content, and a long title pushes the whole row — and therefore the
          page — wider than the phone. `shrink-0` on the controls keeps them
          from being squeezed instead. */}
      <header
        ref={headerRef}
        className="sticky top-0 z-20 flex items-center justify-between gap-2 px-4 py-3 bg-gloss-bg/80 backdrop-blur-md border-b border-gloss-border md:px-6"
      >
        <div className="flex items-center gap-2 sm:gap-3 text-sm min-w-0">
          {/* 返回书库。用按钮而不是 `<a href="#/">`：返回页是一次全新
              挂载，书库无从知道该给哪张卡挂共享元素名，所以先把本页
              的文章 id 记到 in-flight 槽位里（`lib/navigate.ts`），再
              以 `post-close` 转场跳回去。 */}
          <button
            type="button"
            aria-label="返回书库"
            title="返回书库"
            onClick={() => {
              setPostTransitionFocus(article.id);
              navigate("#/library", "post-close");
            }}
            className="text-gloss-textDim hover:text-gloss-text transition-colors"
          >
            ←
          </button>
          <span className="text-gloss-accent">+</span>
          {/* 品牌名回到首页入口。返回书库的“←”让出之后，这里就是
              回首页的锚点；它没有共享元素，所以是一次普通路由跳转。
              手机宽度下让位给右侧控件：标题已在正文开头完整出现。 */}
          <a
            href="#/"
            className="hidden sm:inline font-medium hover:text-gloss-accent transition-colors"
          >
            KoBook
          </a>
          <span className="hidden md:inline text-gloss-textDim">·</span>
          <span className="hidden md:inline text-gloss-textDim truncate max-w-[40ch]">
            {article.title}
          </span>
        </div>
        {/*
          页头右端。三个槽位，顺序固定：

            编辑 → 笔记本 → 登录 / 账号

          账号永远写在最后一个，所以它永远贴在最右：前面增删任何控件都
          挤不动它。它也是整站身份，不属于这篇文章，夹在阅读控件中间既
          容易被误读成“和这篇有关”，又会在窄屏被先挤掉。

          这里曾经是七个控件（条笔记、笔记本、目录、笔记栏、登录、Aa、
          编辑），文字和图标交替排开、间距一律 gap-3 —— 那是这条栏显得
          乱的原因，逐条处理：

            · “N 条笔记”并进笔记本的徽标，不再单独占一段文字；
            · 目录 / 笔记栏 是两个 *视图开关*，不是文章操作，搬进「阅读
              设置」面板（见 `ReadingSettings` 顶部注释）；
            · 「阅读设置」的 Aa 按钮也从这条栏撤掉了，入口改在账号菜单里
              （`TopBarMenu` 的「阅读设置」），栏里只留文章本身的动作；
            · 编辑是低频动作，文字换成铅笔，宽度让给标题。
        */}
        <div className="flex items-center gap-1 sm:gap-1.5 text-xs text-gloss-textDim shrink-0">
          {/* Edit mode. A pencil rather than the word: this is the one action
              in the bar nobody reaches for twice, and the word cost 24px of
              title width to say what the icon says. */}
          {!editMode && paragraphs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setEditMode(true);
                setEditError(null);
                setEditNotice(null);
                setSelection(null);
                setAskOpen(null);
              }}
              aria-label="编辑整篇文章"
              title="编辑整篇文章"
              data-testid="enter-edit-mode"
              className="grid size-7 place-items-center rounded-md text-gloss-textDim transition-colors hover:bg-gloss-text/[0.05] hover:text-gloss-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40"
            >
              <Pencil className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {/* 笔记本. The entry point to the drawer: everything marked and
              asked in this article, in the article's own reading order.
              Icon + label rather than icon alone — of everything left in
              this bar it is the one control an icon would not carry — and
              the count rides on it as a badge instead of sitting in the bar
              as its own piece of text. The badge counts what the panel
              lists: AI answers plus highlights. */}
          <button
            type="button"
            onClick={toggleNotebook}
            aria-pressed={notebookOpen}
            aria-keyshortcuts="N"
            aria-label={`笔记本，${notebookCount} 条记录`}
            title="笔记本（按 N 打开或关闭）"
            data-testid="notebook-toggle"
            className={`flex h-7 items-center gap-1.5 rounded-md px-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40 ${
              notebookOpen
                ? "bg-gloss-text/[0.06] text-gloss-text"
                : "text-gloss-textDim hover:bg-gloss-text/[0.05] hover:text-gloss-text"
            }`}
          >
            <NotebookPen className="size-4" strokeWidth={1.6} aria-hidden="true" />
            <span className="hidden sm:inline">笔记本</span>
            {notebookCount > 0 && (
              <span className="grid h-[1.15rem] min-w-[1.15rem] place-items-center rounded-full bg-gloss-accent px-1 text-[10px] font-medium leading-none tabular-nums text-gloss-bg">
                {notebookCount > 99 ? "99+" : notebookCount}
              </span>
            )}
          </button>
          {/* 账号 / 登录。Last child, always: see the block comment above.
              The extra left margin is the only grouping cue it gets — the
              account is a different kind of thing, and at 6px it read as one
              more reading control. */}
          <div className="ml-0.5 flex items-center sm:ml-1">
            <TopBarMenu showLibrary={false} />
          </div>
        </div>
      </header>

      {editNotice && (
        <div
          role="status"
          data-testid="edit-notice"
          className="flex items-center justify-between gap-3 border-b border-gloss-border bg-gloss-surface/60 px-4 py-2 text-xs text-gloss-textDim md:px-6"
        >
          <span>{editNotice}</span>
          <button
            type="button"
            onClick={() => setEditNotice(null)}
            className="shrink-0 hover:text-gloss-text"
          >
            知道了
          </button>
        </div>
      )}

      <div
        ref={layoutRef}
        className="gloss-reading-layout"
        data-testid="reading-row"
        style={
          readingCssVars(readingPrefs, { outlineOpen }) as React.CSSProperties
        }
      >
        {/* The note link, drawn from the emphasised note's passage to its
            card — the card under the pointer first, the active one only
            when nothing is pointed at. The svg it renders is portalled to
            `document.body` (see `NoteConnection`), so its viewport
            coordinates cannot be reinterpreted by any ancestor of this
            grid; it stays *here* only so it shares this component's
            lifecycle. */}
        <NoteConnection
          root={connectionRoot}
          revision={noteRailRevision}
          headerPx={headerHeight}
          noteId={
            // The connector is suppressed while the drawer is open: at `lg`
            // and above the drawer sits exactly over the notes rail, so a
            // curve drawn to a card underneath it would point at a card the
            // reader cannot see. An association that no longer resolves
            // draws nothing rather than falling back to a different card.
            notebookOpen ? null : connectorNoteId
          }
          color={notebookOpen ? undefined : connectorColor}
        />
        {/* The two draggable seams. Grid items, placed into the rails'
            own tracks by `index.css` — see `ColumnGrip` for why they are
            not nested inside the rails. */}
        <ColumnGrip
          side="left"
          measure={readingPrefs.measure}
          collapsed={!outlineOpen}
          onDragStart={() => beginColumnDrag("left")}
          onDragMove={moveColumnDrag}
          onDragEnd={endColumnDrag}
          onNudge={(characters) => nudgeColumnEdge("left", characters)}
        />
        <ColumnGrip
          side="right"
          measure={readingPrefs.measure}
          collapsed={!readingPrefs.notesOpen}
          onDragStart={() => beginColumnDrag("right")}
          onDragMove={moveColumnDrag}
          onDragEnd={endColumnDrag}
          onNudge={(characters) => nudgeColumnEdge("right", characters)}
        />

        {/* Article outline. Replaces the old scroll rail: the rail's note
            dots were placed by linear interpolation over paragraph
            ordinal, which does not line up with where a paragraph
            actually is, and it carried no structure at all. */}
        <OutlineSidebar
          asideRef={outlineRef}
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

        {/* Main reader. `overflow-x-clip` is a guard, not a layout: a block
            that renders wider than the column — a pasted URL, a very long
            code line — must not turn into a page-wide horizontal scrollbar.
            The two places it could have happened are handled directly
            (`overflow-wrap: anywhere` on links, `overflow-x: auto` on
            `<pre>`); this catches the case neither anticipated. */}
        <main
          ref={articleRef}
          className="flex-1 min-w-0 overflow-x-clip px-5 py-12 md:px-8"
        >
          {/* The reading column. Its width is the measure — 30 full-width
              characters by default, at whatever font size is in effect —
              plus the gutter the paragraph numbers live in. Both are
              custom properties so the settings panel can change them
              without this element re-rendering its children. */}
          <div
            className="gloss-reading-column mx-auto"
            data-testid="reading-column"
          >
            {/* 文章头卡。
                三个共享元素名与书库卡片一一对应（`lib/view-transition.ts`），
                所以从书库点进来时，是“缩略图长成这张头卡”，而不是整页淡入。
                名字里带文章 id：view-transition-name 必须全文档唯一。 */}
            <ViewTransition
              name={postVtName("shell", article.id)}
              share={POST_VT_SHARE.shell}
            >
              {/* 头卡自身封顶 720px 并居中：它跟着正文列走，但不上不封顶。
                  否则把行宽拖到 60 字（正文 1264px）时，封面还是 187px，
                  卡片却被拉到 1264，标题一行 1200px——读者拖的是正文行宽，
                  不是在给头卡换尺寸。窄于 720 时它仍随列收缩（不能真固定：
                  列只有 464 时会溢出）。 */}
              <div className="mx-auto mb-10 w-full max-w-[45rem] overflow-hidden rounded-2xl bg-gloss-surface ring-1 ring-gloss-border">
                <div className="px-6 pb-6 pt-5 md:px-8 md:pt-6">
                  {/* 封面。
                      有默认图库的插画时，做成「书封」浮在标题左侧：这些画是
                      竖幅，「旅人」在画面中间，横过来裁成横幅会把人裁掉。
                      没有图时退回标题派生的渐变色块，仍占同一块位置。
                      封面尺寸固定，不随正文列拖动变化；拖的是行宽，不是封面。 */}
                  <ViewTransition
                    name={postVtName("cover", article.id)}
                    share={POST_VT_SHARE.cover}
                  >
                    {/* Narrow screens: the cover sits above the title as a
                        centred book plate — floating it next to a 350px
                        column squeezes the metadata labels into columns one
                        character wide. From `md` up it floats left. */}
                    <div
                      aria-hidden="true"
                      className="relative mx-auto mb-5 h-[210px] w-[140px] overflow-hidden rounded-lg ring-1 ring-gloss-border md:float-left md:mr-7 md:mb-4 md:h-[280px] md:w-[187px]"
                      style={{ background: coverArt.background }}
                    >
                      {coverImage ? (
                        <img
                          src={coverImage}
                          alt=""
                          referrerPolicy="no-referrer"
                          decoding="async"
                          onError={() => setCoverFailed(true)}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span
                          className="absolute inset-0 flex select-none items-center justify-center font-serif text-4xl opacity-20 md:text-5xl"
                          style={{ color: coverArt.foreground }}
                        >
                          {coverArt.glyph}
                        </span>
                      )}
                    </div>
                  </ViewTransition>

                  {/* The size steps down as the title grows — see
                      `titleSizeClass`. `text-balance` evens out the line
                      lengths of whatever it wraps to, which is what keeps a
                      two-line title from ending in a single orphaned word. */}
                  <ViewTransition
                    name={postVtName("title", article.id)}
                    share={POST_VT_SHARE.title}
                  >
                    <h1
                      className={`font-serif tracking-normal break-words text-balance ${titleSizeClass(article.title)}`}
                    >
                      {article.title}
                    </h1>
                  </ViewTransition>

                  {/* 元信息：分类 / 标签 / 地址 / 创建时间。左列是 12px 图标 +
                      灰标签（定宽对齐），右列是内容本身。

                      分类与标签是两行而不是一行，因为它们是两种用法：分类
                      回答「这属于哪一类」，点一下就进书库看同类；标签是这篇
                      文章的关键词，只用来标记。分类取的是 AI 标签的第一项，
                      所以两行的内容不会重复。 */}
                  <dl className="mt-5 space-y-2.5 border-t border-gloss-border pt-4">
                    <div className="flex items-start gap-3">
                      <dt className="flex w-20 shrink-0 items-center gap-1.5 pt-[3px] text-xs text-gloss-textDim">
                        <TagIcon />
                        <span>分类</span>
                      </dt>
                      <dd className="min-w-0 flex-1">
                        {articleCategory ? (
                          // 分类筛选是一次普通路由跳转，和后文的标签按钮一样：
                          // 不参与卡片转场。
                          <button
                            type="button"
                            title={`查看分类「${articleCategory}」下的文章`}
                            data-testid="article-category"
                            onClick={() =>
                              navigate(
                                "#/library?tag=" + encodeURIComponent(articleCategory),
                              )
                            }
                            className="inline-flex items-center rounded-full bg-gloss-accent/10 px-2.5 py-0.5 text-xs text-gloss-accent ring-1 ring-gloss-accent/25 transition-colors hover:bg-gloss-accent/15"
                          >
                            {articleCategory}
                          </button>
                        ) : (
                          <span className="text-sm text-gloss-textDim">未分类</span>
                        )}
                      </dd>
                    </div>

                    <div className="flex items-start gap-3">
                      <dt className="flex w-20 shrink-0 items-center gap-1.5 pt-[3px] text-xs text-gloss-textDim">
                        <TagIcon />
                        <span>标签</span>
                      </dt>
                      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        {articleOtherTags.length === 0 ? (
                          <span className="text-sm text-gloss-textDim">
                            {articleCategory ? "—" : "未分类"}
                          </span>
                        ) : (
                          articleOtherTags.slice(0, MAX_TAGS - 1).map((tag) => (
                            // 标签筛选是一次普通路由跳转，不参与卡片转场。
                            <button
                              key={tag}
                              type="button"
                              title={`查看标签「${tag}」`}
                              onClick={() =>
                                navigate(
                                  "#/library?tag=" + encodeURIComponent(tag),
                                )
                              }
                              className="rounded-full bg-gloss-surface2 px-2.5 py-0.5 text-xs text-gloss-text ring-1 ring-gloss-border transition-colors hover:ring-gloss-accent/60"
                            >
                              {tag}
                            </button>
                          ))
                        )}
                        {canTag ? (
                          <button
                            type="button"
                            onClick={() => void runTagging(true)}
                            disabled={tagging}
                            className="ml-auto shrink-0 text-xs text-gloss-textDim transition-colors hover:text-gloss-text disabled:opacity-60"
                          >
                            {tagging
                              ? "生成中…"
                              : articleTagCount > 0
                                ? "重新生成"
                                : "生成标签"}
                          </button>
                        ) : (
                          // 没有可用密钥时不假装能生成，直接指向设置页——
                          // 填好密钥后，下次打开这篇文章会自动补标签。
                          <a
                            href="#/settings"
                            className="ml-auto shrink-0 text-xs text-gloss-textDim transition-colors hover:text-gloss-text"
                          >
                            填写 AI 密钥后自动生成
                          </a>
                        )}
                        {tagError ? (
                          <span className="w-full text-[11px] text-gloss-textDim/80">
                            {tagError}
                          </span>
                        ) : null}
                      </dd>
                    </div>

                    <div className="flex items-start gap-3">
                      <dt className="flex w-20 shrink-0 items-center gap-1.5 pt-[3px] text-xs text-gloss-textDim">
                        <LinkIcon />
                        <span>地址</span>
                      </dt>
                      <dd className="min-w-0 flex-1 text-sm">
                        {article.url ? (
                          // 外链：target=_blank，不碰 hash，因此不会触发
                          // 书库/阅读页之间的卡片转场。
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={article.url}
                            className="block truncate text-gloss-text transition-colors hover:text-gloss-accent"
                          >
                            {displayAddress(article.url)}
                          </a>
                        ) : (
                          <span className="text-gloss-textDim">粘贴的正文</span>
                        )}
                      </dd>
                    </div>

                    <div className="flex items-start gap-3">
                      <dt className="flex w-20 shrink-0 items-center gap-1.5 pt-[3px] text-xs text-gloss-textDim">
                        <ClockIcon />
                        <span>创建时间</span>
                      </dt>
                      <dd className="min-w-0 flex-1 text-sm text-gloss-text">
                        <time
                          dateTime={isoStamp(article.createdAt)}
                          className="tabular-nums"
                        >
                          {formatStamp(article.createdAt)}
                        </time>
                      </dd>
                    </div>
                  </dl>

                  {/* 作者 / 发布日期 / 段落数：原来标题下方的信息，挪到卡内
                      元信息之后，别让它们消失在这次改版里。段落数取自
                      `bodyStats`（正文与文章记录分离后它不在 article 上）。 */}
                  <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gloss-textDim">
                    {article.author && <span>{article.author}</span>}
                    {article.author && article.publishedAt && <span>·</span>}
                    {article.publishedAt && <span>{article.publishedAt}</span>}
                    {(article.author || article.publishedAt) && <span>·</span>}
                    <span>{article.bodyStats.paragraphs} 个段落</span>
                  </div>
                </div>
              </div>
            </ViewTransition>

            {/* Sync status banner. The user can paste, import, refresh,
                navigate away and come back — and the only signal they
                have for "本机已保存，云端同步失败" is this row. The
                server's rejection / network-error / cancelled verdicts
                are surfaced verbatim; a successful upload clears the
                status so the banner disappears on its own. The retry
                button is the entry point the audit asks for: no
                re-paste, no AI key, no repaint. */}
            <SyncStatusBanner article={article} />

            {/* Brief section */}
            <BriefSection
              brief={article.brief}
              open={briefOpen}
              onToggle={() => setBriefOpen(!briefOpen)}
              onGenerate={handleGenerateBrief}
              loading={briefLoading}
              articleParagraphs={paragraphs}
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
                and grouping rules can be unit-tested without React.

                `prose` is the Typography plugin's scope; `gloss-prose` is
                this project's. Element typography comes from the plugin
                (configured in `tailwind.config.js` against the reading
                variables), and `gloss-prose` adds only what the plugin
                cannot know: the number gutter, the highlight marks and the
                code-block box. */}
            {editMode ? (
              editorChunk.status === "ready" ? (
                <editorChunk.Component
                  paragraphs={paragraphs}
                  saving={savingEdit}
                  error={editError}
                  onSave={saveDocument}
                  onCancel={() => {
                    setEditMode(false);
                    setEditError(null);
                  }}
                />
              ) : editorChunk.status === "error" ? (
                <div
                  role="alert"
                  data-testid="editor-load-error"
                  className="mt-10 rounded-lg border border-gloss-border bg-gloss-surface px-5 py-4 text-sm"
                >
                  <p className="font-medium text-gloss-text">编辑器没有加载出来</p>
                  <p className="mt-1 text-gloss-textDim">{editorChunk.message}</p>
                  <p className="mt-2 text-xs text-gloss-textDim">
                    重试会重新加载页面，并回到这篇文章的编辑模式。
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        // 重新加载是唯一可靠的重试：同一个 URL 的动态 import
                        // 失败结果会被浏览器缓存，原地再 import 只会立刻失败。
                        sessionStorage.setItem(
                          `gloss-editor-retry:${article.id}`,
                          "1",
                        );
                        window.location.reload();
                      }}
                      data-testid="retry-editor-chunk"
                      className="rounded bg-gloss-accent/15 px-3 py-1.5 text-xs text-gloss-accent transition-colors hover:bg-gloss-accent/25"
                    >
                      重试
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditMode(false);
                        setEditError(null);
                      }}
                      className="ml-auto text-xs text-gloss-textDim transition-colors hover:text-gloss-text"
                    >
                      退出编辑
                    </button>
                  </div>
                </div>
              ) : (
                <div className="py-16 text-center text-sm text-gloss-textDim">
                  正在载入编辑器…
                </div>
              )
            ) : (
            <div className="prose gloss-prose mt-8">
              {blockGroups.map((group) => {
                const renderBlock = (p: Paragraph) => (
                  <HighlightedParagraph
                    key={p.index}
                    paragraph={p}
                    highlights={highlights}
                    noteAnchors={anchoredSlices}
                    activeNoteId={activeNoteId}
                    emphasisNoteId={associatedLive}
                    onNoteClick={openNote}
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
            )}
          </div>
        </main>

        {/* Original notes sidebar. The rail itself no longer scrolls: the
            records live in document space, so the page scroll is what
            moves them. `overflow-x-clip` is a guard against a long
            unbroken quote widening the page, not a layout choice. */}
        {!editMode && (
          <aside
            aria-label="笔记"
            data-testid="notes-panel"
            className="gloss-reader-rail gloss-notes-rail hidden lg:block border-l border-gloss-border overflow-x-clip"
          >
            {noteRailStage}
            {otherVersionNotesBody}
          </aside>
        )}
      </div>

      {/* Selection toolbar */}
      {selection && !askOpen && !openHighlight && !editMode && (
        <SelectionToolbar
          selection={selection}
          dragging={pointerDown}
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
              remarkDraft={remarkDraftFor(target.id)}
              onRemarkDraft={(value) => setRemarkDraft(target.id, value)}
              onSaveRemark={() => saveRemark(target.id)}
              onDeleteRemark={() => deleteRemark(target.id)}
              onColor={(color) => {
                setHighlightColor(target.id, color);
                setHighlightPrefs({ color });
                void pushHighlightUpdate(target.id);
              }}
              onStyle={(style) => {
                setHighlightStyle(target.id, style);
                setHighlightPrefs({ style });
                void pushHighlightUpdate(target.id);
              }}
              onDelete={() => {
                removeHighlight(target.id);
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

      {/* 笔记本. Rendered unconditionally so the component stays mounted
          while closed — that is what keeps an in-progress remark draft alive
          across a close and reopen. It renders nothing at all when closed. */}
      <Notebook
        open={notebookOpen}
        article={article}
        notes={notes}
        otherVersionNotes={otherVersionNotes}
        highlights={highlights}
        activeNoteId={activeNoteId}
        topOffset={headerHeight}
        onClose={closeNotebook}
        onJump={jumpFromNotebook}
        onDeleteNote={deleteNoteFromNotebook}
        onDeleteHighlight={removeHighlight}
        draftFor={remarkDraftFor}
        onDraftChange={setRemarkDraft}
        onSaveRemark={saveRemark}
        onDeleteRemark={deleteRemark}
      />

      <ReadingSettings
        open={readingSettingsOpen}
        prefs={readingPrefs}
        onChange={applyReadingPrefs}
        onReset={resetReadingPrefsKeepingPlace}
        onClose={() => setReadingSettingsOpen(false)}
        rails={{
          outlineAvailable: outline.length > 0,
          outlineOpen,
          notesOpen: readingPrefs.notesOpen,
          onToggleOutline: () => toggleRail("outline"),
          onToggleNotes: () => toggleRail("notes"),
        }}
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

/**
 * Namespace for a note anchor inside a paragraph's mark list.
 *
 * Highlights and note anchors are cut by the same call to `segmentBlock`,
 * and the slices report a single id list. The prefix is what keeps the two
 * apart: a note id and a highlight id are both opaque strings from the same
 * generator, so without it a note anchor could be looked up in the
 * highlight table (and painted as a highlight) or vice versa.
 */
const NOTE_MARK_PREFIX = "note:";

/**
 * One body image, with a reader-facing fallback.
 *
 * Remote images fail for reasons the extractor cannot predict (hotlink
 * protection, dead host, mixed content). A broken `<img>` leaves the browser's
 * "broken image" glyph and no explanation, so a failure is replaced by the
 * alt text — the reader still knows what was there, and the paragraph keeps its
 * height instead of collapsing to nothing.
 */
function ArticleImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="block rounded-md bg-gloss-surface2 px-3 py-2 text-center text-xs text-gloss-textDim">
        {alt.length > 0 ? `图片加载失败：${alt}` : "图片加载失败"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      {...(title ? { title } : {})}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function HighlightedParagraph({
  paragraph,
  highlights,
  noteAnchors,
  activeNoteId,
  emphasisNoteId = null,
  onNoteClick,
  hasNote,
  onMarkClick,
  registerRef,
  onEdit,
}: {
  paragraph: Paragraph;
  highlights: Highlight[];
  /** Slices of a note's quote that still match this document. */
  noteAnchors: NoteSlice[];
  activeNoteId: string | null;
  /**
   * The note the reader is *temporarily* associated with — the card under
   * the pointer, or holding keyboard focus — or `null` when there is none.
   *
   * Slices covered by it are painted more strongly than the active note's,
   * and it takes precedence as the slice's click target, so the underline
   * the reader sees emphasised is the one a click opens. It is deliberately
   * *not* `activeNoteId` falling back: the strong paint means "you are
   * pointing at this", and the active record must keep its own quieter
   * emphasis for "leaving restores the previous emphasis" to mean anything.
   */
  emphasisNoteId?: string | null;
  onNoteClick: (id: string) => void;
  hasNote: boolean;
  onMarkClick: (id: string, rect: DOMRect) => void;
  registerRef: (el: HTMLElement | null) => void;
  /** Enter inline edit mode for this block. */
  onEdit?: () => void;
}) {
  const kind = blockKindOf(paragraph);

  const editButton = onEdit ? (
    <button
      type="button"
      className="gloss-edit-trigger"
      aria-label={`编辑第 ${paragraph.index} 段`}
      title="编辑这一段"
      // Preventing the default keeps the caret where it was and stops the
      // button from becoming the selection anchor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M11.5 2.5l2 2L5 13l-2.5.5L3 11l8.5-8.5z" />
      </svg>
    </button>
  ) : null;

  /**
   * Note anchors are fed through the *same* segmentation as highlights, so
   * an underline and a highlight on the same sentence are cut at the same
   * boundaries and cannot overlap inconsistently.
   *
   * Their ids are namespaced (`note:<id>`) because the two id spaces are
   * independent — a note id and a highlight id are both nanoids and could
   * collide — and the namespace is what lets the renderer tell the two
   * kinds apart without a second lookup table.
   *
   * Note anchors come first so that, at equal range, a highlight sorts as
   * the innermost mark and keeps its own paint.
   */
  const marks = useMemo(
    () => [
      ...noteAnchors
        .filter((a) => a.paragraphIndex === paragraph.index)
        .map((a) => ({
          id: `${NOTE_MARK_PREFIX}${a.id}`,
          start: a.start,
          end: a.end,
        })),
      ...highlights
        .filter((h) => h.paragraphIndex === paragraph.index && !h.detached)
        .map((h) => ({ id: h.id, start: h.startOffset, end: h.endOffset })),
    ],
    [highlights, noteAnchors, paragraph.index],
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
   * The innermost *highlight* covering a slice, or `null` when none does.
   *
   * `markIds` is outermost-first, so the last entry is the innermost — and
   * "innermost wins" is what a nested highlight should look like. Note
   * anchors share the list but are not highlights: they are drawn as an
   * underline on the text rather than as a wash over it, so they are
   * filtered out here and picked up separately in `emphasisOf`.
   */
  const innermostMark = (segment: BlockSlice): string | null =>
    segment.markIds.filter((id) => !id.startsWith(NOTE_MARK_PREFIX)).at(-1) ??
    null;

  /**
   * One slice's content: its text, wrapped in the emphasis the source
   * asked for, and then in the note underline when a note covers it.
   *
   * Folded from the inside out so the first kind in the
   * contract's canonical order ends up outermost, which is what makes
   * `**_x_**` render `<strong><em>` and never the reverse. The note
   * underline is applied outside that fold, so it stays continuous across
   * a bold word or a link inside the quote instead of restarting at each
   * emphasis boundary.
   */
  const emphasisOf = (segment: BlockSlice): ReactNode => {
    let node: ReactNode = segment.text;
    for (let k = segment.kinds.length - 1; k >= 0; k -= 1) {
      node = (
        <Emphasis kind={segment.kinds[k]!} href={segment.href}>
          {node}
        </Emphasis>
      );
    }
    const noteIds = segment.markIds
      .filter((id) => id.startsWith(NOTE_MARK_PREFIX))
      .map((id) => id.slice(NOTE_MARK_PREFIX.length));
    // A slice can carry more than one note (two notes over the same words).
    // The one the reader is pointing at wins, then the active one, so that
    // clicking the underline the reader sees emphasised opens *that* note
    // rather than a different card; otherwise the first is used, which is
    // stable for a given document.
    const noteId =
      emphasisNoteId !== null && noteIds.includes(emphasisNoteId)
        ? emphasisNoteId
        : noteIds.includes(activeNoteId ?? "")
          ? activeNoteId!
          : noteIds[0];
    if (!noteId) return node;
    // Emphasis is per *slice*, not per chosen id: a note's underline can be
    // cut into several spans by a highlight or a bold word inside the quote,
    // and "the exact resolved selection" is every one of those slices that
    // the note covers — which is why this is `includes` and not `===`.
    const emphasised = emphasisNoteId !== null && noteIds.includes(emphasisNoteId);
    const active = !emphasised && activeNoteId !== null && noteIds.includes(activeNoteId);
    // The underline wears the colour of *this* note, read off the slice it
    // came from rather than off the note table: a paragraph can carry
    // slices from several notes, and they are drawn one span at a time.
    // The anchor span used to be a fixed blue, which is what made a
    // coloured note look uncoloured in the text it annotates.
    const noteColor = noteAnchors.find((a) => a.id === noteId)?.color;
    return (
      <span
        data-note-anchor={noteId}
        data-note-emphasis={emphasised ? "true" : undefined}
        role="button"
        tabIndex={0}
        aria-label="查看这段文字的旁注"
        title="查看对应旁注"
        style={{
          textDecoration: "underline",
          textDecorationColor: noteColorRgb(noteColor),
          textDecorationThickness: emphasised || active ? "2px" : "1px",
          textUnderlineOffset: "5px",
          backgroundColor: emphasised
            ? noteColorRgb(noteColor, 0.22)
            : active
              ? noteColorRgb(noteColor, 0.08)
              : undefined,
          cursor: "pointer",
        }}
        // A drag that ends on the underline still delivers a click here,
        // and this handler would then steal the selection the user just
        // made. A collapsed selection is what a genuine click looks like
        // by the time it lands. `stopPropagation` keeps the paragraph's
        // own handlers from also firing.
        onClick={(e) => {
          if (!window.getSelection()?.isCollapsed) return;
          e.stopPropagation();
          onNoteClick(noteId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onNoteClick(noteId);
          }
        }}
      >
        {node}
      </span>
    );
  };

  /**
   * The body, as runs rather than one element per slice.
   *
   * `segmentBlock` cuts the text at every highlight boundary *and* every
   * emphasis boundary, so a single highlight that crosses a bold word or a
   * link arrives here as several slices. Emitting a `<mark>` per slice put
   * several adjacent inline boxes on screen where the user drew one, and a
   * background sized `100% 100%` is stretched to each box *separately* —
   * so a two-character slice painted a visibly darker blob than the long
   * slice beside it, with a seam at every join.
   *
   * Consecutive slices resolving to the same mark are therefore merged
   * back into one `<mark>`, with the emphasis nested inside it.
   */
  const runs: { markId: string | null; nodes: ReactNode[] }[] = [];
  for (const segment of segments) {
    const markId = innermostMark(segment);
    const last = runs[runs.length - 1];
    if (last && last.markId === markId) {
      last.nodes.push(emphasisOf(segment));
    } else {
      runs.push({ markId, nodes: [emphasisOf(segment)] });
    }
  }

  const body = runs.map((run, i) => {
    // One `<span>` per slice inside the run, so the elements in `nodes`
    // carry keys. The mark remains continuous across these inline spans.
    const content = run.nodes.map((node, j) => <span key={j}>{node}</span>);
    if (run.markId === null) return <span key={i}>{content}</span>;

    const markId = run.markId;
    const mark = markOf(markId);
    return (
      <mark
        key={i}
        data-color={mark.color}
        data-style={mark.style}
        data-highlight-id={markId}
        className="gloss-mark cursor-pointer"
        onClick={(e) => {
          // A drag that starts and ends inside one mark still delivers a
          // `click` on it, and this handler would then throw away the
          // selection the user just made and open the manage-popover
          // instead — every attempt to select text inside an existing
          // highlight was being swallowed. A genuine click on a mark has
          // already collapsed the selection by the time the click lands,
          // so a live selection here means the user was selecting.
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) return;
          // `currentTarget`, not `target`: the mark is what the handler is
          // attached to and what should be measured, even when the click
          // lands on a descendant.
          onMarkClick(markId, e.currentTarget.getBoundingClientRect());
        }}
      >
        {content}
      </mark>
    );
  });

  // The margin gutter. A list item shows nothing there unless it carries
  // a note: the list bullet already marks the line, and two marks would
  // land in the same gutter (the CSS drops the bullet when the note
  // dot is shown, keyed off `data-has-note`).
  //
  // The span must stay present for every kind — `rangeToOffsets`
  // subtracts its text, and an empty one is a cheap no-op.
  //
  // Marker appearance stays in index.css, using the original desktop/mobile placement.
  const marker = (
    <span
      data-paragraph-marker=""
      {...(hasNote ? { "data-has-note": "" } : {})}
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
  // Keep the original 2rem gutter. Only the jump highlight animates;
  // typography changes must settle before restoring reading position.
  const gutter = "relative transition-shadow";

  if (kind === "image") {
    const src = paragraph.src ?? "";
    const safe = /^(https?:\/\/|\/)/i.test(src);
    return (
      <figure {...blockProps} className={`gloss-figure ${gutter}`}>
        {marker}
        {safe ? (
          <ArticleImage
            src={src}
            alt={paragraph.alt ?? ""}
            {...(paragraph.title ? { title: paragraph.title } : {})}
          />
        ) : (
          <span className="text-sm text-gloss-textDim">[图片地址不受支持]</span>
        )}
      </figure>
    );
  }

  if (kind === "table") {
    const rows = paragraph.rows ?? [];
    // A table block with no rows has no text to render. Its `text` join is
    // only there for hashing, so there is nothing sensible to show.
    if (rows.length === 0) return null;
    const [header, ...body] = rows;
    // Deliberately no `data-paragraph-index`, no marker and no ref: a table
    // is not prose, so it must not become the anchor of a selection, note or
    // highlight. `rangeToOffsets` measures a block by `Range.toString()`,
    // which would count cell text with tab/newline separators that do not
    // exist in the stored `text` — a highlight created there could never be
    // validated. Leaving the attribute off makes `closest()` skip the table.
    return (
      <div
        className={`gloss-table-wrap ${gutter}`}
        data-block-kind="table"
        {...(paragraph.blockId ? { "data-block-id": paragraph.blockId } : {})}
      >
        <table className="gloss-table">
          <thead>
            <tr>
              {(header ?? []).map((cell, cellIndex) => (
                <th key={cellIndex}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (kind === "hr") {
    // A rule carries no text, so it contributes nothing to a selection and
    // needs no marker. The block index stays on the element so scrolling to
    // it still works.
    return <hr {...blockProps} className={`gloss-hr ${gutter}`} />;
  }

  if (kind === "code") {
    // The marker sits *outside* the `<pre>`: inside it, `white-space:
    // pre` turns the whitespace around the span into real characters
    // and every offset in the block shifts by their length.
    return (
      <div {...blockProps} className={`gloss-code ${gutter}`}>
        {marker}
        {editButton}
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
        {editButton}
        {body}
      </Tag>
    );
  }

  if (kind === "quote") {
    return (
      <blockquote {...blockProps} className={`gloss-quote ${gutter}`}>
        {marker}
        {editButton}
        {body}
      </blockquote>
    );
  }

  if (kind === "listItem") {
    // Nesting is restored as indentation rather than real `<ul>` nesting: the
    // flat model emits every item as its own block, and re-nesting here would
    // change the block grouping that notes anchor to. Depth is clamped so a
    // malformed document cannot push a line off the page.
    const depth = Math.min(8, Math.max(0, Math.floor(paragraph.depth ?? 0)));
    // The task box is an empty `<span>`: a real `<input>` or a text glyph
    // would either add a control inside the block's text range or add
    // characters `rangeToOffsets` would count. `aria-hidden` keeps a
    // decorative box out of the accessibility tree; the item's own text is
    // what the reader hears.
    const taskBox = paragraph.task ? (
      <span
        className="gloss-task-box"
        data-checked={paragraph.checked === true ? "true" : "false"}
        aria-hidden="true"
      />
    ) : null;
    return (
      <li
        {...blockProps}
        {...(hasNote ? { "data-has-note": "" } : {})}
        {...(paragraph.task ? { "data-task": "" } : {})}
        {...(depth > 0 ? { "data-depth": String(depth) } : {})}
        className={gutter}
        style={depth > 0 ? { marginInlineStart: `${depth * 1.25}rem` } : undefined}
      >
        {marker}
        {editButton}
        {taskBox}
        {body}
      </li>
    );
  }

  return (
    <p {...blockProps} className={gutter}>
      {marker}
      {editButton}
      {body}
    </p>
  );
}

/**
 * Manage-popover for an existing highlight: recolour, reshape, remark,
 * remove.
 *
 * Deliberately not a note editor. A highlight is an anchor; turning
 * it into an AI answer is what the "解释 / 提问" actions do, and
 * coupling the two would mean every mark costs tokens. The remark it *does*
 * offer is the other kind of text entirely — the reader's own words, typed
 * locally, sent nowhere — which is why it can live here without the mark
 * ever costing anything.
 *
 * The draft is owned by the Reader (`remarkDraft`/`onRemarkDraft`) rather
 * than by this component, so clicking away, closing the popover or opening
 * the notebook mid-sentence cannot discard what has been typed.
 */
function HighlightPopover({
  highlight,
  rect,
  remarkDraft,
  onRemarkDraft,
  onSaveRemark,
  onDeleteRemark,
  onColor,
  onStyle,
  onDelete,
  onClose,
}: {
  highlight: Highlight;
  rect: DOMRect;
  /** The text currently in the editor — saved value, or an unsaved draft. */
  remarkDraft: string;
  onRemarkDraft: (value: string) => void;
  onSaveRemark: () => void;
  onDeleteRemark: () => void;
  onColor: (color: HighlightColor) => void;
  onStyle: (style: HighlightStyle) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const saved = highlight.note?.trim() ?? "";
  // An unsaved change is the only thing the save button is for; comparing
  // against the stored remark is what makes "nothing to save" honest.
  const dirty = remarkDraft.trim() !== saved;
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
        onMouseDown={(e) => {
          // The blanket `preventDefault` that keeps a click on a swatch from
          // collapsing the live selection would also stop the remark
          // textarea from ever taking a caret. Text fields are exempt.
          const target = e.target as HTMLElement | null;
          if (target?.closest("textarea, input")) return;
          e.preventDefault();
        }}
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
            type="button"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            aria-label={saved ? "编辑备注" : "添加备注"}
            data-testid="highlight-remark-toggle"
            className={`px-2 py-1.5 text-xs rounded hover:bg-gloss-surface2 ${
              saved ? "text-gloss-text" : "text-gloss-textDim hover:text-gloss-text"
            }`}
          >
            {saved ? "备注 ✓" : "备注"}
          </button>
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

        {editing ? (
          <div className="mt-1 w-[280px] border-t border-gloss-border px-1 pt-1">
            <textarea
              autoFocus
              rows={3}
              value={remarkDraft}
              // The same bound the backup schema and the store use, so a
              // remark can never be typed to a length the format refuses.
              maxLength={MAX_HIGHLIGHT_NOTE_LENGTH}
              aria-label="个人备注"
              data-testid="highlight-remark-input"
              onChange={(e) => onRemarkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Escape closes the editor, not the popover: the draft is
                // already safe in the Reader, and losing the popover would
                // take the colour controls with it.
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }}
              placeholder="写一条只属于自己的备注…"
              className="w-full resize-y bg-transparent border border-gloss-border rounded px-2 py-1 text-xs outline-none focus:border-gloss-accent/50"
            />
            <div className="mt-1 flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onSaveRemark();
                  setEditing(false);
                }}
                disabled={!dirty}
                data-testid="highlight-remark-save"
                className="px-2 py-1 text-xs rounded bg-gloss-text text-gloss-bg font-medium disabled:opacity-30"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => {
                  // Cancel restores the saved value, so the next open shows
                  // the remark that is actually stored rather than an
                  // abandoned draft.
                  onRemarkDraft(highlight.note ?? "");
                  setEditing(false);
                }}
                data-testid="highlight-remark-cancel"
                className="px-2 py-1 text-xs rounded text-gloss-textDim hover:text-gloss-text"
              >
                取消
              </button>
              {saved ? (
                <button
                  type="button"
                  onClick={() => {
                    onDeleteRemark();
                    setEditing(false);
                  }}
                  data-testid="highlight-remark-delete"
                  className="ml-auto px-2 py-1 text-xs rounded text-gloss-textDim hover:text-gloss-accent"
                >
                  删除备注（保留划线）
                </button>
              ) : null}
            </div>
          </div>
        ) : saved ? (
          <p
            data-testid="highlight-remark-preview"
            className="mt-1 max-w-[280px] whitespace-pre-wrap border-t border-gloss-border px-1 pt-1 text-xs leading-relaxed text-gloss-textDim"
          >
            {saved}
          </p>
        ) : null}
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

/**
 * One note: the quote it was made from, the answer, and the follow-up box.
 *
 * `active` is the note the reader last touched — the one whose passage is
 * underlined in the article. `onActivate` fires on any click or focus
 * inside the card, which is how "click a note to see where it came from"
 * works without a dedicated button for it; `onJumpAnchor` is the explicit
 * one, for the reader who wants to leave the rail.
 *
 * `associated` is the *temporary* half of that: the card under the pointer
 * or holding keyboard focus. It is a separate channel on purpose — see the
 * Reader's `associatedNoteId`. Hovering only associates; it must never
 * expand the card or scroll the page, because a card that opens under the
 * pointer is a card the reader did not ask to open.
 */
/**
 * The failure line a stream appended to `note.answer`.
 *
 * `NoteTranscript` paints the conversation from `note.turns`, and an error
 * marker is not a turn — it is spliced into the flat `answer` by the
 * `onError` paths, and the assistant turn recorded there carries only the
 * text that had already arrived. Without this, a failure on a note that has
 * turns would render as nothing at all.
 */
function streamErrorSuffix(answer: string): string | null {
  const at = answer.lastIndexOf("\n\n[错误：");
  return at === -1 ? null : answer.slice(at + 2);
}

/** The reader's own words, quoted and tinted so they cannot read as the
 * model's — the whole point of the split, since both used to be one blob.
 * The tint follows the highlight colour the user had selected in the
 * toolbar, so the bubble's hue matches the underline in the article body:
 * both come from the same `--hl-*` channel via `data-color` (see
 * `src/index.css`). A note with no swatch (legacy data, or a colour the
 * user has never picked) leaves `data-color` unset and the CSS falls back
 * to the theme accent — the sidebar's pre-existing look.
 */
function UserQuestion({ text, color }: { text: string; color?: HighlightColor }) {
  const swatch = color && HIGHLIGHT_COLORS.includes(color) ? color : undefined;
  return (
    <div
      data-color={swatch}
      className="note-question rounded-r border-l-2 px-2 py-1.5"
    >
      <div className="note-question-label mb-0.5 text-[10px] uppercase tracking-wider">
        提问
      </div>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gloss-text [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  );
}

/**
 * One model reply. `live` marks the turn still being streamed, so the cursor
 * rides here instead of on the whole card — it sits at the end of the text
 * that is actually arriving.
 */
function AnswerTurn({ text, live, indices, onJump }: {
  text: string;
  live?: boolean;
  indices: Set<number>;
  onJump?: (index: number) => void;
}) {
  return (
    <div className={live ? "streaming-cursor" : undefined}>
      {text ? (
        <ParagraphReferences text={text} indices={indices} onJump={onJump} />
      ) : live ? (
        <span className="animate-pulse text-gloss-textDim italic">正在思考…</span>
      ) : null}
    </div>
  );
}

/**
 * A note's conversation, one block per turn.
 *
 * `note.turns` has always held role, content and sequence — it is what the
 * follow-up builds its LLM context from — but rendering ignored it and
 * painted the flat `note.answer` instead, splicing each follow-up in as the
 * literal `"\n\n---\n\n追问：…"`. Two speakers then shared one block at one
 * size and colour, so nothing said where an exchange ended and the next
 * began, and a second question was indistinguishable from the first. Worse,
 * the splice did not survive a reload: `remoteNoteToLocal` rebuilds `answer`
 * from the *assistant* turns alone, so after a sync the question text was
 * gone and only a bare `---` was left. The boundaries lived in a string;
 * this draws them, from the structure that was already correct.
 */
function NoteTranscript({ note, indices, onJump }: {
  note: ReturnType<typeof useStore.getState>["notes"][string];
  indices: Set<number>;
  onJump?: (index: number) => void;
}) {
  const turns = note.turns ?? [];

  // A note from before `turns` existed has none, and its `answer` is then the
  // only record of the exchange. Keep painting that — an old note must not
  // lose its answer to a layout change.
  if (turns.length === 0) {
    return note.answer ? (
      <ParagraphReferences text={note.answer} indices={indices} onJump={onJump} />
    ) : (
      <span className="text-gloss-textDim italic">正在思考…</span>
    );
  }

  /*
    The assistant turn is appended when the stream *ends* — every completion
    path calls `appendTurn` from `onDone`/`onError`/`onCancelled`/
    `onInterrupted`. While it runs, `turns` still ends at the user's
    question, so without the synthesised block below the arriving chunks
    would land nowhere on screen. Drawing the live turn from
    `activeTurnText` is also what makes the stream legible: each delta grows
    this one block, instead of nudging the tail of a wall of text that never
    looked like it was moving.
  */
  const items: {
    key: string;
    role: "user" | "assistant";
    content: string;
    live: boolean;
  }[] = turns.map((t) => ({
    key: t.id,
    role: t.role,
    content: t.content,
    live: false,
  }));
  if (note.isStreaming) {
    items.push({
      key: note.activeTurnId ?? `${note.id}-live`,
      role: "assistant",
      content: note.activeTurnText ?? "",
      live: true,
    });
  }

  const error = streamErrorSuffix(note.answer);

  return (
    <div className="space-y-3">
      {items.map((item) =>
        item.role === "user" ? (
          <UserQuestion key={item.key} text={item.content} color={note.color} />
        ) : (
          <AnswerTurn
            key={item.key}
            text={item.content}
            live={item.live}
            indices={indices}
            onJump={onJump}
          />
        ),
      )}
      {error ? (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gloss-textDim [overflow-wrap:anywhere]">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function NoteCard({
  note,
  active = false,
  associated = false,
  expanded = false,
  anchored = true,
  draft = "",
  onDraftChange,
  onDraftConsumed,
  onActivate,
  onAssociate,
  onDisassociate,
  onOpen,
  onCollapse,
  onDelete,
  onJump,
  onJumpAnchor,
  onStopActive,
}: {
  note: ReturnType<typeof useStore.getState>["notes"][string];
  active?: boolean;
  /** Whether the pointer is on this card, or focus is inside it. */
  associated?: boolean;
  /**
   * Whether the conversation is open. The card is mounted either way —
   * collapsing only hides the expanded half — so a follow-up stream and
   * its draft survive a collapse, a scroll-away and a re-open.
   */
  expanded?: boolean;
  /** Whether the note still resolves to a passage in this document. */
  anchored?: boolean;
  /** The follow-up draft, owned by the Reader so it outlives the view. */
  draft?: string;
  onDraftChange?: (value: string) => void;
  /** The draft has been used (a follow-up finished): drop it. */
  onDraftConsumed?: () => void;
  onActivate?: () => void;
  onAssociate?: () => void;
  onDisassociate?: () => void;
  onOpen?: () => void;
  onCollapse?: () => void;
  onDelete?: () => void;
  onJump?: (index: number) => void;
  onJumpAnchor?: () => void;
  /**
   * Stop a first-run stream. That controller lives in the Reader, which also
   * aborts it on a new selection, so a card cannot reach it on its own — and
   * `abortAllStreams` is not an option here: it would take every other
   * note's answer down with it.
   */
  onStopActive?: () => void;
}) {
  const article = useStore((s) => s.articles[note.articleId]);
  // Same article body the page loaded; the hook is a store read, so this does
  // not trigger a second load. Falls back to the empty list rather than
  // throwing when the text is not on this device.
  const paragraphs = useArticleParagraphs(note.articleId);
  const followUp = draft;
  const [busy, setBusy] = useState(false);
  /**
   * Deleting is two clicks. The first arms the control and it disarms
   * itself after a few seconds, so a mis-click on a control that sits
   * beside copy and collapse cannot remove a note outright — the whole
   * reason the ✕ no longer deletes is that the two actions were one.
   */
  const [deleteArmed, setDeleteArmed] = useState(false);
  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => setDeleteArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);
  // One controller per card: a follow-up stream is unrelated to the article
  // selection bar stream, so the two do not cancel each other.
  const followUpControllerRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      followUpControllerRef.current?.abort();
      followUpControllerRef.current = null;
    };
  }, []);

  /** True while *any* run owns this note, whoever started it. */
  const generating = busy || note.isStreaming;

  /**
   * Stop whichever run is in flight. The two live in different places — a
   * follow-up's controller is this card's, a first run's belongs to the
   * Reader — so whichever handle is present is the one to pull. The ref is
   * cleared before `abort()` so a second click cannot land on a controller
   * whose run is already unwinding.
   */
  function stop() {
    const own = followUpControllerRef.current;
    if (own) {
      followUpControllerRef.current = null;
      own.abort();
      return;
    }
    onStopActive?.();
  }

  const statusLabel = note.isStreaming
    ? "生成中"
    : note.localStatus === "succeeded" || note.remoteStatus === "succeeded"
      ? "已完成"
      : note.localStatus === "failed" || note.remoteStatus === "failed"
        ? "失败"
        : note.localStatus === "cancelled" || note.remoteStatus === "cancelled"
          ? "已取消"
          : note.localStatus === "interrupted" || note.remoteStatus === "interrupted"
            ? "已中断"
            : "";

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
      [...paragraphs],
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
    // The follow-up question is its own turn: the plan requires the
    // original question and each follow-up to be stored separately, and
    // without it the next follow-up reaches the model without the
    // earlier exchange as context.
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
        onDraftConsumed?.();
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
      // Clicking a compact record opens it; clicking inside an open one
      // only keeps it active. Clicking is the *only* thing that moves the
      // active note — see the focus handlers below.
      onClick={() => {
        onActivate?.();
        if (!expanded) onOpen?.();
      }}
      // Pointing at a card, or tabbing into one, is a *temporary*
      // association: it highlights the passage this record is about and
      // moves the connector curve onto this card, and nothing else.
      // `mouseleave` (not `mouseout`) keeps the association while the
      // pointer is over the card's own controls.
      onMouseEnter={onAssociate}
      onMouseLeave={onDisassociate}
      // Focus associates and deliberately does *not* activate. Focus is
      // sticky and travels: tabbing through the rail, or clicking a control
      // to copy an answer, would otherwise silently re-point the persisted
      // "active" identity at whatever card the caret passed through, and
      // the emphasis the reader left behind would be gone for good. Blur
      // therefore restores the last *clicked* record, which is what the
      // reader actually chose.
      onFocus={onAssociate}
      onBlur={(event) => {
        // A card can hold several controls; moving between them is not
        // leaving it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDisassociate?.();
        }
      }}
      // The active card is marked with an edge on the side that faces the
      // article, i.e. the side the connector curve arrives at; the
      // associated one gets the same colour without the edge, so the
      // feedback is "this is the record you are pointing at" rather than
      // "this record just became the active one". The colour is the note's
      // own, so a red note's card edge matches the red underline on the
      // passage it is about.
      style={
        active
          ? {
              borderColor: noteColorRgb(note.color),
              boxShadow: `-2px 0 0 ${noteColorRgb(note.color)}`,
            }
          : associated
            ? { borderColor: noteColorRgb(note.color) }
            : undefined
      }
      data-testid="note-card"
      data-note-id={note.id}
      data-note-active={active ? "true" : "false"}
      data-note-associated={associated ? "true" : "false"}
      data-note-expanded={expanded ? "true" : "false"}
      data-note-anchored={anchored ? "true" : "false"}
      data-note-remote={note.remoteId ? "cloud" : "local"}
      // The card's *original* question, exposed so a test can prove a
      // follow-up did not overwrite it — the defect this attribute exists
      // to make observable was silent, because the question is not
      // rendered anywhere on the card.
      data-note-question={note.question}
      data-note-streaming={note.isStreaming ? "true" : "false"}
      data-note-status={note.localStatus ?? note.remoteStatus ?? ""}
      className={`rounded-lg bg-gloss-surface border border-gloss-border animate-slide-up ${
        expanded ? "p-3" : "px-3 py-2"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen?.();
              onJumpAnchor?.();
            }}
            disabled={!onJumpAnchor}
            title={
              anchored
                ? "返回提问时选中的原文"
                : "这条笔记无法精确锚定，只能回到它记录的段落"
            }
            className="text-gloss-accent hover:underline disabled:text-gloss-textDim"
          >
            第 {note.paragraphIndex} 段 ↗
          </button>
          <span className="text-gloss-textDim uppercase tracking-wider">
            {note.type === "explain" ? "解释" : "提问"}
          </span>
          {!expanded && statusLabel ? (
            <span
              data-testid="note-compact-status"
              className={`text-[10px] ${
                note.isStreaming ? "text-gloss-accent" : "text-gloss-textDim"
              }`}
            >
              {statusLabel}
            </span>
          ) : null}
          {!anchored ? (
            <span
              className="text-[10px] text-gloss-textDim"
              title="这条笔记的原文位置已失效"
            >
              原文位置已失效
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {expanded ? (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(note.answer);
                }}
                className="text-gloss-textDim hover:text-gloss-text p-1 text-xs"
                aria-label="复制回答"
                title="复制回答"
              >
                ⧉
              </button>
              {onCollapse ? (
                <button
                  type="button"
                  data-testid="note-collapse"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCollapse();
                  }}
                  className="text-gloss-textDim hover:text-gloss-text p-1 text-xs"
                  aria-label="收起笔记"
                  title="收起（不会删除这条笔记）"
                >
                  ✕
                </button>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  data-testid="note-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!deleteArmed) {
                      setDeleteArmed(true);
                      return;
                    }
                    setDeleteArmed(false);
                    onDelete();
                  }}
                  className={`p-1 text-xs ${
                    deleteArmed
                      ? "text-gloss-accent font-medium"
                      : "text-gloss-textDim hover:text-gloss-accent"
                  }`}
                  aria-label={deleteArmed ? "确认删除笔记" : "删除笔记"}
                  title={deleteArmed ? "再点一次永久删除" : "删除这条笔记"}
                >
                  {deleteArmed ? "确认删除" : "删除"}
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              data-testid="note-expand"
              onClick={(e) => {
                e.stopPropagation();
                onOpen?.();
              }}
              className="text-gloss-textDim hover:text-gloss-text p-1 text-[11px]"
              aria-label="展开笔记"
              title="展开这条笔记"
            >
              展开
            </button>
          )}
        </div>
      </div>
      <div
        className={`text-xs italic text-gloss-textDim border-l-2 border-gloss-border pl-2 leading-relaxed [overflow-wrap:anywhere] ${
          expanded ? "mt-2 mb-2" : "mt-1 line-clamp-2"
        }`}
      >
        “{note.selectionText.slice(0, 120)}
        {note.selectionText.length > 120 ? "…" : ""}”
      </div>
      {/*
        The expanded half. Hidden with `hidden` rather than conditionally
        rendered: the follow-up input and its stream controller have to
        survive a collapse, and the draft is a controlled value the
        Reader owns, so closing a card loses neither.
      */}
      <div hidden={!expanded}>
        <div className="text-sm leading-relaxed text-gloss-text [overflow-wrap:anywhere]">
          {/* One block per turn, instead of one block per note. The model is
              asked to cite paragraphs as `¶N`, so every answer still goes
              through the reference renderer — only the boundaries moved. */}
          <NoteTranscript
            note={note}
            indices={new Set(paragraphs.map((p) => p.index))}
            onJump={onJump}
          />
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
            onChange={(e) => onDraftChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !generating) {
                e.preventDefault();
                sendFollowUp();
              }
            }}
            placeholder={generating ? "正在生成…" : "继续追问…"}
            disabled={generating}
            className="flex-1 bg-transparent border border-gloss-border rounded px-2 py-1 text-xs outline-none focus:border-gloss-accent/50 disabled:opacity-40"
          />
          {generating ? (
            <button
              onClick={stop}
              aria-label="停止生成"
              title="停止生成"
              className="text-gloss-accent hover:text-gloss-text text-sm"
            >
              ■
            </button>
          ) : (
            <button
              onClick={sendFollowUp}
              aria-label="发送追问"
              disabled={!followUp.trim()}
              className="text-gloss-textDim hover:text-gloss-text text-sm disabled:opacity-30"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


function SelectionToolbar({
  selection,
  dragging,
  color,
  style,
  onExplain,
  onAsk,
  onHighlight,
  onStyle,
  onDismiss,
}: {
  selection: SelectionInfo;
  dragging: boolean;
  color: HighlightColor;
  style: HighlightStyle;
  onExplain: () => void;
  onAsk: () => void;
  onHighlight: (color: HighlightColor) => void;
  onStyle: (style: HighlightStyle) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const measured = ref.current?.offsetHeight ?? 0;
    setHeight((prev) => (prev === measured ? prev : measured));
  });
  // Keep the measured toolbar clear of the selected text and sticky header.
  const above = selection.rect.top - 8 - height;
  const top = above >= 60 ? above : selection.rect.bottom + 8;
  const left = Math.max(16, selection.rect.left + selection.rect.width / 2 - 80);
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
        ref={ref}
        data-selection-toolbar=""
        data-testid="selection-toolbar"
        className="fixed z-30 max-w-[92vw] bg-gloss-surface border border-gloss-border rounded-lg shadow-2xl p-1 animate-fade-in"
        style={{ top, left, pointerEvents: dragging ? "none" : undefined }}
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
  // Retrying needs the text: the upload payload is rebuilt from the body, not
  // from a copy kept on the record. Already loaded — the banner only renders
  // inside the reader.
  const paragraphs = useArticleParagraphs(article.id);
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
    retryArticleSync(article, paragraphs);
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
  articleParagraphs: readonly Paragraph[];
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

/**
 * 头卡元信息行的 12px 图标。
 *
 * 与本文件其它内联图标同一套约定：`currentColor` 描边、`aria-hidden`，
 * 颜色由外层 `<dt>` 的灰字决定，所以主题切换不需要额外代码。
 */
function TagIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      <path
        d="M1.6 1.6h3.5l5.3 5.3-3.5 3.5L1.6 5.1V1.6Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="3.7" cy="3.7" r="0.8" fill="currentColor" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" fill="none">
        <path d="M5.1 6.9a2.3 2.3 0 0 0 3.3 0l1.2-1.2a2.3 2.3 0 0 0-3.3-3.3l-.7.7" />
        <path d="M6.9 5.1a2.3 2.3 0 0 0-3.3 0L2.4 6.3a2.3 2.3 0 0 0 3.3 3.3l.7-.7" />
      </g>
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="shrink-0">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" fill="none">
        <circle cx="6" cy="6" r="4.5" />
        <path d="M6 3.4V6l1.8 1.1" />
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
  asideRef,
  articleRef,
  outline,
  notes,
  open,
  paragraphRefs,
  onJump,
}: {
  /**
   * Lets the Reader measure how much width the outline is taking, which is
   * the other half of "is there room for the notes panel beside the
   * article". Measured rather than assumed: the panel is hidden entirely
   * below `lg`, so its width is 0 on a narrow screen even while the toggle
   * says "open".
   */
  asideRef: React.RefObject<HTMLElement | null>;
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
    <aside
      ref={asideRef}
      data-testid="outline-sidebar"
      className="gloss-reader-rail gloss-outline-rail hidden lg:block"
    >
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
