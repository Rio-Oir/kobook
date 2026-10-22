// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Article library — 我的文章.
 *
 * The library **is** the local store. Rows come from `useStore().articles`,
 * opening a row is `#/r/<id>`, deleting a row is `store.deleteArticle`
 * (article + its notes + its highlights). No request is made — there is no
 * account to read a server-side list from, and no server-side list to read.
 *
 * The list is `components/post-list.tsx`: date-grouped article cards with a
 * generated cover and the article's AI tags. Clicking a card opens the
 * article through a shared-element view transition (cover / title / surface
 * morph into the reader's header card), so rows navigate with
 * `navigate(..., "post-open")` rather than by assigning `location.hash`.
 *
 * ## Why there is no teaser text here
 *
 * Since the body moved out of the record (`Article.bodyStats` + IndexedDB,
 * see `lib/storage/bodies.ts`), listing articles must not load bodies: a
 * library of 200 articles would otherwise deserialise 200 books just to draw
 * 200 three-line previews. The card therefore shows the title, the *record's*
 * stats (chars / paragraphs), its tags and — when a brief exists — the brief's
 * one-line gist. That is the only prose available without touching a body.
 *
 * ## Grouping and filtering
 *
 * Rows are grouped by the reader's local calendar day (今天 / 昨天 / date)
 * via `lib/library-groups.ts`, and filtered by tag through the chip bar.
 * Tags are generated on-device by `lib/tagging.ts` with the reader's own
 * BYOK key, so an article that has never been read on this device has no
 * tags yet; the bar appears once at least one article carries a tag. The
 * selected tag lives in the URL (`#/library?tag=…`) so a tag chip in the
 * Reader can deep-link into a filtered library; in-page changes use
 * `replaceState` and do not remount the page.
 *
 * ## What the DOM keeps
 *
 * `local-library-list` / `local-library-item` and the delete dialog's
 * `local-delete-dialog` / `local-delete-confirm` test ids are unchanged, and
 * each row's first `<button>` is still the one that opens the article.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { useStore } from "@/lib/store";
import {
  dismissLegacyNotice,
  downloadLegacyRaw,
  importLegacyIntoStore,
  isLegacyNoticeDismissed,
  readLegacySummary,
} from "@/lib/legacy-local-free";
import type { Article } from "@/lib/types";
import ThemeToggle from "@/components/ThemeToggle";
import { navigate } from "@/lib/navigate";
import { coverArtFor } from "@/lib/covers";
import {
  aggregateTags,
  filterRowsByTag,
  groupRowsByDay,
  readingMinutes,
} from "@/lib/library-groups";
import { PostList, type PostCardData, type PostGroup } from "@/components/post-list";
import { filterRowsByQuery, normalizeQuery } from "@/lib/taxonomy";
import { useSession } from "@/lib/session";
import type { ArticleSummary } from "@/lib/cloud/contracts";
import { mergeLibraryRows, type LocalLibraryRow } from "@/lib/library-merge";
import {
  deleteArticleEverywhere,
  flushPendingDeletes,
  listCloudLibrary,
  pullCloudArticle,
  syncLocalLibrary,
} from "@/lib/library-sync";

/**
 * Wait (bounded) for the uploads `syncLocalLibrary` handed over to settle.
 *
 * `retryArticleSync` is fire-and-forget by design — the article is already
 * readable — but the *list* wants the verdicts: an uploaded row gains
 * `remoteId` and its summary must then be dropped. Polling is the smallest
 * honest bridge between those two facts; a rejected upload records a terminal
 * `remoteSyncStatus`, so a failure does not hold the page for the whole
 * timeout.
 */
async function waitForUploads(timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = useStore.getState();
    const pending = Object.values(state.articles).filter(
      (article) =>
        !article.remoteId &&
        !article.remoteSyncStatus &&
        state.bodies[article.id]?.state === "present",
    );
    if (pending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-gloss-border p-10 text-center">
      <p className="text-sm text-gloss-textDim mb-4">还没有保存的文章。</p>
      <a
        href="#/"
        className="inline-block px-4 py-1.5 rounded-lg bg-gloss-text text-gloss-bg text-sm font-medium hover:bg-gloss-text/85 transition-colors"
      >
        导入一篇
      </a>
    </div>
  );
}

/** A chip in the tag bar. `aria-pressed` is what makes the filter state
 *  audible to a screen reader without a second text label. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-gloss-text bg-gloss-text text-gloss-bg"
          : "border-gloss-border text-gloss-textDim hover:border-gloss-textDim hover:text-gloss-text"
      }`}
    >
      {children}
    </button>
  );
}

export default function Library({ initialTag = null }: { initialTag?: string | null }) {
  const setCurrentArticle = useStore((s) => s.setCurrentArticle);
  const localArticlesById = useStore((s) => s.articles);
  /**
   * A delete that is waiting for confirmation. Cloud-only rows are represented
   * too: they have no local record, but the reader can still delete them and
   * both ends have to go.
   */
  const [pendingDelete, setPendingDelete] = useState<{
    title: string;
    localId?: string;
    remoteId?: string;
    /** True when the row exists only in the account list. */
    cloudOnly: boolean;
  } | null>(null);
  // Read once on mount: the summary is a snapshot of a space this page never
  // writes to, so there is nothing to re-read after an import (the import
  // reads the blob again itself).
  const [legacy] = useState(() => readLegacySummary());
  const [legacyNoticeHidden, setLegacyNoticeHidden] = useState(() => isLegacyNoticeDismissed());
  const [legacyMessage, setLegacyMessage] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(initialTag);
  /**
   * The search box. Session state on purpose: a query is a question you asked
   * once, not a view you configured, so it does not belong in the URL next to
   * the tag filter (which *is* a view — `#/library?tag=…`).
   */
  const [query, setQuery] = useState("");

  // ── The account half of the shelf ──────────────────────────────────────
  //
  // Signed in, the library is local rows ∪ account rows (see
  // `lib/library-merge.ts`). The account is read only when the local space
  // actually belongs to this session: mid sign-in/out the two disagree, and
  // listing an account that is not the owner of what is on screen would either
  // show another account's rows or hide the reader's own.
  const sessionStatus = useSession((s) => s.status);
  const sessionUserId = useSession((s) => s.user?.id);
  const ownerUserId = useStore((s) => s.ownerUserId);
  const signedIn =
    sessionStatus === "authed" && !!sessionUserId && ownerUserId === sessionUserId;
  const [cloudSummaries, setCloudSummaries] = useState<ArticleSummary[]>([]);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn || !sessionUserId) {
      setCloudSummaries([]);
      setCloudError(null);
      setSyncing(false);
      return;
    }
    let alive = true;
    (async () => {
      setSyncing(true);
      setCloudError(null);
      try {
        // Deletes the reader asked for while offline go first: an article that
        // is already gone from the account must not be re-listed and then
        // "synced" back into existence.
        await flushPendingDeletes();
        const outcome = await syncLocalLibrary();
        if (alive && (outcome.migrated > 0 || outcome.queued > 0)) {
          setCloudNotice(
            `正在把 ${outcome.migrated + outcome.queued} 篇同步到账号…` +
              (outcome.skipped > 0
                ? `（${outcome.skipped} 篇正文不在本机，暂未上传）`
                : ""),
          );
        }
        // Give the uploads a moment to land so their rows arrive in this same
        // listing instead of the list flickering from half to whole. A rejected
        // upload is terminal and stops the wait early.
        await waitForUploads();
        const list = await listCloudLibrary();
        if (!alive) return;
        setCloudSummaries(list);
        if (outcome.queued > 0 || outcome.migrated > 0) {
          setCloudNotice(
            `已同步 ${outcome.migrated + outcome.queued} 篇到账号` +
              (outcome.skipped > 0
                ? `；${outcome.skipped} 篇正文不在本机，未上传`
                : ""),
          );
        }
      } catch (err) {
        if (alive) setCloudError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setSyncing(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [signedIn, sessionUserId]);


  // Annotation counts for the card badge. Subscribed rather than read once so
  // deleting a note elsewhere is reflected when the library is opened; the
  // page never renders while a note streams, so the extra subscription does
  // not turn into per-token renders here.
  const notesById = useStore((s) => s.notes);
  const highlightsById = useStore((s) => s.highlights);
  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of Object.values(notesById)) {
      counts.set(note.articleId, (counts.get(note.articleId) ?? 0) + 1);
    }
    for (const highlight of Object.values(highlightsById)) {
      counts.set(highlight.articleId, (counts.get(highlight.articleId) ?? 0) + 1);
    }
    return counts;
  }, [notesById, highlightsById]);

  // The local half, in import order (newest first). Derived on render rather
  // than copied into state so a delete or a new import elsewhere in the SPA
  // cannot leave this page showing a stale list.
  const localRows = useMemo<LocalLibraryRow[]>(
    () =>
      Object.values(localArticlesById)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((a) => ({
          id: a.id,
          title: a.title,
          url: a.url,
          createdAt: a.createdAt,
          tags: a.tags ?? [],
          // The only prose available without loading the body. Absent for
          // most articles; the card then simply omits the teaser line.
          excerpt: a.brief?.gist ?? "",
          charCount: a.bodyStats.chars,
          readMinutes: readingMinutes(a.bodyStats.chars),
          annotationCount: annotationCounts.get(a.id) ?? 0,
          source: "local" as const,
          remoteId: a.remoteId,
          ...(a.coverImage ? { coverImage: a.coverImage } : {}),
        })),
    [localArticlesById, annotationCounts],
  );

  // One shelf: local rows and account-only rows, deduplicated by identity.
  // Anonymous readers get exactly the local part — the merge is a no-op.
  const rows = useMemo(
    () => mergeLibraryRows(localRows, cloudSummaries),
    [localRows, cloudSummaries],
  );

  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    // Coming back to the tab is when another device's changes are likely: the
    // list is cheap to re-read (summaries only) and the alternative is a shelf
    // that silently disagrees with the account until a reload.
    const refresh = () => {
      void listCloudLibrary().then(
        (list) => {
          if (alive) setCloudSummaries(list);
        },
        () => undefined,
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [signedIn]);

  const tagCounts = useMemo(() => aggregateTags(rows), [rows]);
  // 搜索在前、标签在后：两条窄条件依次收窄，和界面上的顺序一致。
  const searchedRows = useMemo(() => filterRowsByQuery(rows, query), [rows, query]);
  const visibleRows = useMemo(
    () => filterRowsByTag(searchedRows, activeTag),
    [searchedRows, activeTag],
  );
  /** 查询是否真的在起作用（纯空白不算）。 */
  const searching = normalizeQuery(query).length > 0;

  const groups = useMemo<PostGroup[]>(
    () =>
      groupRowsByDay(visibleRows).map((day) => ({
        key: day.key,
        label: day.label,
        items: day.items.map<PostCardData>((row) => ({
          id: row.id,
          title: row.title,
          excerpt: row.excerpt,
          tags: row.tags,
          createdAt: row.createdAt,
          url: row.url,
          charCount: row.charCount,
          readMinutes: row.readMinutes,
          annotationCount: row.annotationCount,
          cover: coverArtFor(row.title || row.id, row.id, row.coverImage),
          // Only worth saying once the two drawers can differ: an anonymous
          // reader's shelf has no second drawer.
          ...(signedIn
            ? {
                badge:
                  row.source === "cloud"
                    ? "云端"
                    : localArticlesById[row.id]?.remoteId
                      ? undefined
                      : "仅本机",
              }
            : {}),
        })),
      })),
    [visibleRows, signedIn, localArticlesById],
  );

  /** Open one row, downloading the body first when it lives only in the account. */
  async function openRow(id: string, title: string): Promise<void> {
    if (localArticlesById[id]) {
      setCurrentArticle(id);
      navigate(`#/r/${id}`, "post-open");
      return;
    }
    setOpeningId(id);
    setCloudError(null);
    try {
      await pullCloudArticle(id);
      setCurrentArticle(id);
      navigate(`#/r/${id}`, "post-open");
    } catch (err) {
      setCloudError(
        `取回《${title || "这篇文章"}》失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setOpeningId(null);
    }
  }

  /** Delete from both ends; the account copy may be queued when offline. */
  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    setCloudError(null);
    const outcome = await deleteArticleEverywhere({
      ...(target.localId ? { localId: target.localId } : {}),
      ...(target.remoteId ? { remoteId: target.remoteId } : {}),
    });
    if (target.cloudOnly) {
      setCloudSummaries((prev) => prev.filter((row) => row.id !== target.remoteId));
    }
    if (outcome.queued) {
      setCloudNotice("已从这台设备删除；账号里的这份会在恢复连接后删除。");
    }
  }


  /**
   * Filter state and URL stay in step.
   *
   * `replaceState` rather than `navigate`: a filter is not a new page, and a
   * history entry per chip would make the back button walk through filter
   * states. It also leaves `App`'s route untouched, so the list is not
   * remounted and no view transition fires.
   */
  function selectTag(tag: string | null): void {
    setActiveTag(tag);
    const hash = tag ? `#/library?tag=${encodeURIComponent(tag)}` : "#/library";
    if (window.location.hash !== hash) {
      window.history.replaceState(null, "", hash);
    }
  }

  return (
    <div className="min-h-screen flex flex-col px-5 py-10 sm:px-6 sm:py-12">
      <main className="w-full max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-10">
          <a href="#/" className="flex items-center gap-2 text-sm font-medium hover:opacity-80">
            <span className="text-gloss-accent">+</span>
            <span>KoBook</span>
          </a>
          <div className="flex items-center gap-3">
            <ThemeToggle />
          </div>
        </header>

        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 mb-2">
          <div className="flex items-baseline gap-3">
            <h1 className="font-serif text-3xl tracking-tight">我的文章</h1>
            {rows.length > 0 && (
              <span className="text-xs text-gloss-textDim">
                共 {rows.length} 篇
                {!searching && activeTag && visibleRows.length !== rows.length
                  ? ` · 筛选出 ${visibleRows.length} 篇`
                  : ""}
                {searching ? ` · 匹配 ${visibleRows.length} 篇` : ""}
              </span>
            )}
          </div>

          {/*
            搜索：标题或分类标签。

            和标签筛选是两条独立的窄条件，同时生效（先搜索、再按标签），
            因为「在佛教这个分类里搜某本书」和「在全部文章里搜佛教」是两个
            真实的问题，不能只留一个。输入立即过滤，不做防抖：本地几百条
            文章的一次 includes 比一次 setTimeout 还便宜。
          */}
          <label className="relative block w-full shrink-0 sm:w-72">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-gloss-textDim"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query.length > 0) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="搜索标题或分类标签"
              aria-label="搜索文章"
              data-testid="library-search"
              className="w-full rounded-lg border border-gloss-border bg-transparent py-1.5 pl-8 pr-8 text-sm text-gloss-text outline-none transition-colors placeholder:text-gloss-textDim/70 focus:border-gloss-accent [&::-webkit-search-cancel-button]:hidden"
            />
            {query.length > 0 && (
              <button
                type="button"
                aria-label="清除搜索"
                data-testid="library-search-clear"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-gloss-textDim transition-colors hover:text-gloss-text"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </label>
        </div>

        {/* The account half's state: syncing, how many rows wait in the account,
            and any failure. One line rather than a banner — the shelf below is
            still usable in every one of these states. */}
        {signedIn && (
          <p
            role="status"
            data-testid="library-cloud-status"
            className="mb-6 text-xs text-gloss-textDim"
          >
            {cloudError
              ? `账号文章读取失败：${cloudError}`
              : syncing
                ? "正在同步账号文章…"
                : openingId
                  ? "正在取回正文…"
                  : cloudNotice ??
                    (cloudSummaries.length > 0
                      ? `账号里共 ${cloudSummaries.length} 篇；未取回的打开时会自动下载。`
                      : null)}
          </p>
        )}

        {legacyMessage && (
          <p role="status" className="mb-4 text-xs text-gloss-textDim">
            {legacyMessage}
          </p>
        )}

        {legacy.present && !legacyNoticeHidden && (
          <section
            data-testid="legacy-notice"
            className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
          >
            <p className="font-medium mb-1">检测到旧版独立阅读器的本机数据</p>
            <p className="text-gloss-textDim">
              旧版本机数据中包含：
              {legacy.unreadable ? (
                <>未能读取（{legacy.unreadable}），仍可下载原始文件保留。</>
              ) : (
                <>
                  {legacy.articles} 篇文章 · {legacy.highlights} 条划线 · {legacy.notes} 条旧笔记 ·{" "}
                  {(legacy.bytes / 1024).toFixed(1)} KB。
                </>
              )}
            </p>
            <p className="text-gloss-textDim mt-1">
              旧空间不会被删除或覆盖。要做迁移请先下载原始备份，再选择是否一次性导入到当前空间（只增不减）。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="legacy-download"
                onClick={() => {
                  const r = downloadLegacyRaw();
                  setLegacyMessage(
                    r.ok
                      ? `已下载原始备份（${(r.bytes / 1024).toFixed(1)} KB）：${r.filename}`
                      : r.message,
                  );
                }}
                className="px-3 py-1.5 rounded-lg border border-amber-500/50 hover:bg-amber-500/10 text-xs"
              >
                下载原始备份
              </button>
              {!legacy.unreadable && (
                <button
                  type="button"
                  data-testid="legacy-import"
                  onClick={async () => {
                    const confirmed = window.confirm(
                      "把这批旧数据一次性导入当前空间？\n\n" +
                        "· 只新增，不会清空你现在的内容；\n" +
                        "· 旧空间与它的原始文件都保留不动；\n" +
                        "· 旧的自由笔记会以「本机自由笔记」的标注出现，不会被伪装成 AI 回答。",
                    );
                    if (!confirmed) return;
                    const r = await importLegacyIntoStore();
                    setLegacyMessage(r.message);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-gloss-text text-gloss-bg text-xs font-medium"
                >
                  一次性导入到当前空间
                </button>
              )}
              <button
                type="button"
                data-testid="legacy-dismiss"
                onClick={() => {
                  dismissLegacyNotice();
                  setLegacyNoticeHidden(true);
                }}
                className="px-3 py-1.5 rounded-lg text-xs text-gloss-textDim hover:text-gloss-text"
              >
                暂时不处理
              </button>
            </div>
            {legacyMessage && (
              <p role="status" data-testid="legacy-message" className="mt-2 text-xs text-gloss-text">
                {legacyMessage}
              </p>
            )}
          </section>
        )}

        {rows.length === 0 && <EmptyState />}

        {rows.length > 0 && (
          <>
            {/* Tag bar. Shown only once something in the library has a tag: an
                empty "全部 3" chip row would suggest a filter that cannot do
                anything yet. The hint line explains how tags arrive. */}
            {tagCounts.length > 0 && (
              <div
                className="mb-6 flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="按标签筛选"
              >
                <FilterChip active={activeTag === null} onClick={() => selectTag(null)}>
                  全部
                  <span className="tabular-nums opacity-60">{rows.length}</span>
                </FilterChip>
                {tagCounts.map(({ tag, count }) => (
                  <FilterChip key={tag} active={activeTag === tag} onClick={() => selectTag(tag)}>
                    {tag}
                    <span className="tabular-nums opacity-60">{count}</span>
                  </FilterChip>
                ))}
              </div>
            )}

            <PostList
              groups={groups}
              itemTestId="local-library-item"
              listTestId="local-library-list"
              onOpen={(post) => {
                // Local rows are a route hop; account-only rows download first
                // (see `openRow`). One click either way.
                void openRow(post.id, post.title);
              }}
              onDelete={(post) => {
                const row = localArticlesById[post.id];
                if (row) {
                  // A row pulled from the account before `remoteId` was
                  // recorded still has the server id itself; `local-` is the
                  // only id shape that is device-only (see `localArticleKeyFor`).
                  const remoteId =
                    row.remoteId ?? (row.id.startsWith("local-") ? undefined : row.id);
                  setPendingDelete({
                    title: row.title,
                    localId: row.id,
                    ...(remoteId ? { remoteId } : {}),
                    cloudOnly: false,
                  });
                  return;
                }
                // A cloud-only row: no local record, but delete is still a
                // two-ended operation.
                setPendingDelete({
                  title: post.title,
                  remoteId: post.id,
                  cloudOnly: true,
                });
              }}
              empty={
                searching ? (
                  // 搜索为空时先说清楚「是搜索没命中」，而不是说书库是空的：
                  // 读者刚打的字还贴在搜索框里，两种空状态的话术必须不同。
                  <div className="rounded-xl border border-dashed border-gloss-border p-8 text-center">
                    <p className="text-sm text-gloss-textDim">
                      没有标题或分类标签匹配「{query.trim()}」的文章。
                    </p>
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="mt-3 text-xs text-gloss-accent hover:underline"
                    >
                      清除搜索
                    </button>
                  </div>
                ) : activeTag ? (
                  <div className="rounded-xl border border-dashed border-gloss-border p-8 text-center">
                    <p className="text-sm text-gloss-textDim">
                      没有带「{activeTag}」标签的文章。
                    </p>
                    <button
                      type="button"
                      onClick={() => selectTag(null)}
                      className="mt-3 text-xs text-gloss-accent hover:underline"
                    >
                      查看全部
                    </button>
                  </div>
                ) : null
              }
            />
          </>
        )}
      </main>

      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="local-delete-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="bg-gloss-surface border border-gloss-border rounded-xl p-6 max-w-sm w-full mx-4">
            <h2 className="font-medium mb-2">删除这篇文章？</h2>
            <p className="text-sm text-gloss-textDim mb-6">
              {pendingDelete.cloudOnly
                ? `《${pendingDelete.title}》会从账号中移除。`
                : signedIn && pendingDelete.remoteId
                  ? `《${pendingDelete.title}》以及它的划线、笔记会从这台设备和账号中一起移除。`
                  : `《${pendingDelete.title}》以及它的划线、笔记会从这台设备上移除。`}
              此操作不可撤销，如需保留请先导出备份。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gloss-border hover:border-gloss-textDim"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="local-delete-confirm"
                onClick={() => {
                  void confirmDelete();
                }}
                className="px-3 py-1.5 text-sm rounded-lg bg-gloss-accent text-white hover:opacity-90"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
