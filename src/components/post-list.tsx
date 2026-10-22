// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The library's article cards.
 *
 * A collection surface rather than a list of rows: a responsive grid of
 * vertical cards, each with a generated cover, a title, an optional teaser
 * and a footer carrying the source, age and annotation count. Opening a card
 * morphs its surface / cover / title into the reader's article header through
 * a shared-element view transition — the same three names on both sides, see
 * `lib/view-transition.ts`.
 *
 * Three things are deliberate:
 *
 *   1. **The open control is the first `<button>` in the row.** The release
 *      acceptance suite clicks it by position (`local-library-item` row →
 *      first button) to prove a library row reopens its article. The delete
 *      control is a sibling overlay that follows it in DOM order.
 *   2. **Delete stays visible without hover.** Mouse-only affordances are
 *      unreachable on touch; the button is a quiet circle over the cover and
 *      brightens on hover/focus instead of appearing from nothing.
 *   3. **Only the three shared elements carry a `view-transition-name`.**
 *      `enter` / `exit` are `none` on each card so the other cards do not
 *      animate individually when the route unmounts; the list-level
 *      `ViewTransition` owns the enter/exit blur.
 *
 * `PostCardData` is produced by the page (which owns the local store), so the
 * card itself knows nothing about how a row was loaded.
 */

import { useState, ViewTransition, type ReactNode } from "react";
import type { CoverArt } from "@/lib/covers";
import { POST_VT_SHARE, postVtName } from "@/lib/view-transition";
import { relativeTimeLabel } from "@/lib/library-groups";

export type PostCardData = {
  id: string;
  title: string;
  /** Empty for a record whose body has not been loaded on this device. */
  excerpt: string;
  tags: string[];
  createdAt: number;
  url?: string;
  charCount: number;
  readMinutes: number;
  /** Notes + highlights anchored to this article; drives the footer badge. */
  annotationCount: number;
  cover: CoverArt;
  /**
   * Optional status chip in the footer. The unified library uses it for
   * 「仅本机」/「云端」; an anonymous library has only local rows and passes
   * nothing.
   */
  badge?: string;
};

export type PostGroup = {
  key: string;
  label: string;
  items: PostCardData[];
};

export type PostListProps = {
  groups: PostGroup[];
  onOpen: (post: PostCardData) => void;
  onDelete?: (post: PostCardData) => void;
  /** `local-library-item` in the free channel; omitted for cloud rows. */
  itemTestId?: string;
  listTestId?: string;
  /** Optional empty state rendered below the heading area. */
  empty?: ReactNode;
};

/** `www.lingyinsi.com` → `lingyinsi.com`, or null for a pasted article. */
function domainOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

function LinkIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 4.9" />
      <path d="M14 11a5 5 0 0 0-7.1 0L4.5 13.4a5 5 0 0 0 7.1 7.1l1.4-1.4" />
    </svg>
  );
}

function DocIcon({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

/**
 * Cover art for one card.
 *
 * The generated wash is the image; the first title glyph is the mark, and a
 * quiet "KoBook" line anchors the bottom. Everything uses `cover.foreground`
 * (theme-relative ink) rather than a fixed white, so the same tile reads on
 * day's pale paper and night's dark wash.
 *
 * Taxonomy is **not** drawn here any more. It used to sit top-left as
 * white-on-black chips, which had two problems: the chips fought the delete
 * button for the same corner, and their legibility depended on whatever
 * picture happened to be underneath — unreadable on the pale watercolours,
 * fine on the dark ones. The chips now live in the card body, on the card's
 * own surface, where contrast is the theme's job rather than the image's.
 */
function Cover({ post }: { post: PostCardData }) {
  // A remote picture can fail (hotlink protection, dead host). Falling back to
  // the generated wash is better than the browser's broken-image glyph, and
  // the scrim/ink are chosen from what is actually painted.
  const [imageFailed, setImageFailed] = useState(false);
  const image = imageFailed ? undefined : post.cover.image;
  // The bundled paintings are full-colour, so the quiet theme ink used on the
  // generated wash would be unreadable on them; the dark scrim below is what
  // makes white legible instead.
  const ink = image ? "rgb(255 255 255 / 0.92)" : post.cover.foreground;
  return (
    <div className="relative aspect-[3/4] w-full overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: post.cover.background }}
      />
      {image ? (
        <img
          src={image}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
        />
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center font-serif text-[64px] leading-none select-none"
          style={{ color: post.cover.foreground }}
        >
          {post.cover.glyph}
        </div>
      )}
      {image && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/50 via-black/15 to-transparent"
        />
      )}
      <div
        aria-hidden
        className="absolute inset-x-3 bottom-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em]"
        style={{ color: ink }}
      >
        <span>KoBook</span>
      </div>
    </div>
  );
}

function PostCard({
  post,
  onOpen,
  onDelete,
  itemTestId,
}: {
  post: PostCardData;
  onOpen: (post: PostCardData) => void;
  onDelete?: (post: PostCardData) => void;
  itemTestId?: string;
}) {
  const label = post.title || "(无标题)";
  const domain = domainOf(post.url);
  // `tags` is always an array on the wire, but a row built by hand (tests, a
  // half-migrated record) may omit it; the chips are a display nicety and must
  // never be the reason a card fails to render.
  const tags = post.tags ?? [];
  return (
    <li
      data-testid={itemTestId}
      data-article-id={itemTestId ? post.id : undefined}
      className="group relative min-w-0"
    >
      <ViewTransition
        name={postVtName("shell", post.id)}
        share={POST_VT_SHARE.shell}
        enter="none"
        exit="none"
      >
        <article className="relative flex h-full flex-col overflow-hidden rounded-xl bg-gloss-surface ring-1 ring-gloss-border shadow-sm transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md">
          {/* The open action: first button, whole card except the delete
              overlay. */}
          <button
            type="button"
            onClick={() => onOpen(post)}
            aria-label={`打开《${label}》`}
            className="flex h-full w-full flex-1 flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gloss-accent/50"
          >
            <ViewTransition
              name={postVtName("cover", post.id)}
              share={POST_VT_SHARE.cover}
              enter="none"
              exit="none"
            >
              <Cover post={post} />
            </ViewTransition>

            <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 pt-2.5 pb-2.5">
              <ViewTransition
                name={postVtName("title", post.id)}
                share={POST_VT_SHARE.title}
                enter="none"
                exit="none"
              >
                <h3 className="line-clamp-2 text-[15px] leading-6 font-medium tracking-tight text-gloss-text">
                  {label}
                </h3>
              </ViewTransition>

              {post.excerpt && (
                <p className="line-clamp-2 text-[12px] leading-5 text-gloss-textDim">
                  {post.excerpt}
                </p>
              )}

              {/*
                分类 + 标签。分类是标签列表的第一项（规则在 `lib/taxonomy.ts`），
                所以用 accent 色把它和普通标签区分开——卡片上不写「分类」二字，
                位置和颜色就是它的标签。

                放在正文而不是封面：封面对比度取决于底下是哪张图，这类信息
                不该跟着图片一起变好看或变看不清。
              */}
              {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 pt-0.5" data-testid="post-card-tags">
                  {tags.slice(0, 3).map((tag, index) => (
                    <span
                      key={tag}
                      title={index === 0 ? `分类：${tag}` : `标签：${tag}`}
                      className={
                        index === 0
                          ? "rounded-full bg-gloss-accent/10 px-1.5 py-0.5 text-[10px] leading-4 text-gloss-accent ring-1 ring-gloss-accent/25"
                          : "rounded-full bg-gloss-surface2 px-1.5 py-0.5 text-[10px] leading-4 text-gloss-textDim ring-1 ring-gloss-border"
                      }
                    >
                      {tag}
                    </span>
                  ))}
                  {tags.length > 3 && (
                    <span className="text-[10px] leading-4 text-gloss-textDim">
                      +{tags.length - 3}
                    </span>
                  )}
                </div>
              )}

              <div className="mt-auto flex items-center gap-1.5 pt-2 text-[11px] leading-4 text-gloss-textDim">
                {domain ? (
                  <LinkIcon className="h-3 w-3 shrink-0 opacity-70" />
                ) : (
                  <DocIcon className="h-3 w-3 shrink-0 opacity-70" />
                )}
                <span className="min-w-0 truncate">{domain ?? "本机文章"}</span>
                <span aria-hidden className="shrink-0 opacity-50">
                  ·
                </span>
                <span className="shrink-0 whitespace-nowrap">
                  {relativeTimeLabel(post.createdAt)}
                </span>
                {post.badge && (
                  <span
                    data-testid="post-card-badge"
                    className="shrink-0 rounded border border-gloss-border px-1 text-[10px] leading-4 text-gloss-textDim"
                  >
                    {post.badge}
                  </span>
                )}
                {post.annotationCount > 0 && (
                  <span
                    className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[3px] bg-amber-400/90 px-1 text-[10px] font-medium text-amber-950 tabular-nums"
                    title={`${post.annotationCount} 条笔记与划线`}
                  >
                    {post.annotationCount}
                  </span>
                )}
              </div>
            </div>
          </button>

          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(post)}
              aria-label={`删除文章 ${label}`}
              title="删除文章"
              className="absolute top-2 right-2 z-10 rounded-full bg-black/30 p-1.5 text-white/90 opacity-80 backdrop-blur-sm transition-colors hover:bg-black/55 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
            >
              <svg
                aria-hidden
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 7h16" />
                <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
                <path d="M10 11v5M14 11v5" />
              </svg>
            </button>
          )}
        </article>
      </ViewTransition>
    </li>
  );
}

export function PostList({
  groups,
  onOpen,
  onDelete,
  itemTestId,
  listTestId,
  empty,
}: PostListProps) {
  if (groups.length === 0) return <>{empty ?? null}</>;

  return (
    <ViewTransition
      enter={{ "post-close": "none", default: "vt-blur" }}
      exit="vt-blur"
      default="none"
    >
      <div data-testid={listTestId} className="space-y-8">
        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`library-day-${group.key}`}>
            <div className="sticky top-0 z-10 -mx-1 flex items-baseline gap-2 bg-gloss-bg/85 px-1 py-2 backdrop-blur-sm">
              <h2
                id={`library-day-${group.key}`}
                className="text-[15px] leading-6 font-semibold text-gloss-text"
              >
                {group.label}
              </h2>
              <span className="text-[11px] text-gloss-textDim">{group.items.length} 篇</span>
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {group.items.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  itemTestId={itemTestId}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ViewTransition>
  );
}
