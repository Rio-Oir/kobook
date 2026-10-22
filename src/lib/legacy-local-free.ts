// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The legacy standalone reader's local space (`local-free:v1`).
 *
 * Before this release the free product was a separate app (`apps/local-free`)
 * that stored its own articles and highlights under `local-free:v1` in
 * localStorage. That space still exists on the machine of anyone who used it,
 * and this release reads a different key (`gloss-storage`, via `src/lib/store.ts`).
 *
 * So there are two obligations, and this module is both of them:
 *
 *   1. **The old data is never deleted.** Nothing here calls `removeItem` on
 *      `local-free:v1`, on import or on dismissal. The raw blob stays exactly
 *      where it was, and a one-click download makes a copy of it.
 *   2. **The migration is explicit and one-way-visible.** The user is told
 *      what is there, can take the lossless copy first, and only then may
 *      press import. Import is additive: it never clears the new space, and
 *      re-importing the same legacy blob is idempotent because article and
 *      highlight ids are carried over unchanged.
 *
 * What is deliberately *not* done: no silent conversion at startup, no
 * "if the key exists, migrate". A background rewrite of a user's data is the
 * exact behaviour that becomes a data-loss bug the first time it is wrong.
 *
 * ## Note text
 *
 * The old `Highlight` carried a `noteText` field; the current model separates
 * a highlight (an anchor) from a note (a question and an answer). Rather than
 * invent an answer that was never generated, a legacy note becomes a note
 * card labelled as such: `model: "local-free-legacy"` and a question that
 * says it is a free-text note carried over. The Reader shows the original
 * text; nothing pretends a model produced it. The lossless copy is still the
 * download, which is offered first.
 */

import type { ArticleDraft, Highlight, Paragraph } from "./types";
import { useStore } from "./store";
import { readBody } from "./storage/bodies";

export const LEGACY_STORAGE_KEY = "local-free:v1";
export const LEGACY_NOTICE_DISMISSED_KEY = "gloss-legacy-local-free-notice-dismissed";

/** Legacy `schemaVersion` we know how to read. Anything else is left alone. */
const LEGACY_SCHEMA_VERSION = 1;

export interface LegacySummary {
  present: boolean;
  /** Why the blob could not be read, when `present` is true but unusable. */
  unreadable: string | null;
  articles: number;
  highlights: number;
  notes: number;
  bytes: number;
}

const EMPTY: LegacySummary = {
  present: false,
  unreadable: null,
  articles: 0,
  highlights: 0,
  notes: 0,
  bytes: 0,
};

interface LegacyArticle {
  id: string;
  title: string;
  url?: string;
  author?: string;
  createdAt: number;
  paragraphs: Paragraph[];
}

interface LegacyHighlight {
  id: string;
  articleId: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  selectionText: string;
  color: Highlight["color"];
  style?: Highlight["style"];
  createdAt: number;
  noteText?: string;
}

interface LegacySpace {
  articles: LegacyArticle[];
  highlights: LegacyHighlight[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRaw(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}

const HIGHLIGHT_COLORS = new Set(["yellow", "green", "blue", "red"]);
const HIGHLIGHT_STYLES = new Set(["watercolor", "line", "curve"]);
const PARA_TYPES = new Set(["heading", "paragraph", "listItem", "code", "quote"]);

function parseParagraph(raw: unknown): Paragraph | null {
  if (!isObject(raw)) return null;
  const index = raw["index"];
  const text = raw["text"];
  const hash = raw["hash"];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1) return null;
  if (typeof text !== "string" || text.length === 0) return null;
  if (typeof hash !== "string" || hash.length === 0 || hash.length > 64) return null;
  const paragraph: Paragraph = { index, text, hash };
  const blockId = raw["blockId"];
  if (typeof blockId === "string") paragraph.blockId = blockId;
  const type = raw["type"];
  if (typeof type === "string" && PARA_TYPES.has(type)) {
    paragraph.type = type as Paragraph["type"];
  }
  const level = raw["level"];
  if (typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6) {
    paragraph.level = level;
  }
  const lang = raw["lang"];
  if (typeof lang === "string" || lang === null) paragraph.lang = lang as string | null;
  const ordered = raw["ordered"];
  if (typeof ordered === "boolean") paragraph.ordered = ordered;
  return paragraph;
}

/**
 * Parse the legacy blob without trusting it.
 *
 * Every field is checked; a single malformed article makes the whole blob
 * unreadable rather than importing a partial article, because a partially
 * imported article is worse than none: its note anchors would silently point
 * at the wrong text.
 */
function parseLegacy(raw: string): { ok: true; space: LegacySpace } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "旧空间不是合法 JSON。" };
  }
  if (!isObject(parsed)) return { ok: false, reason: "旧空间的根不是对象。" };
  if (parsed["schemaVersion"] !== LEGACY_SCHEMA_VERSION) {
    return { ok: false, reason: `旧空间 schemaVersion=${String(parsed["schemaVersion"])}，本版不识别。` };
  }
  const articlesRaw = parsed["articles"];
  const highlightsRaw = parsed["highlights"];
  if (!isObject(articlesRaw) || !isObject(highlightsRaw)) {
    return { ok: false, reason: "旧空间缺少 articles / highlights。" };
  }

  const articles: LegacyArticle[] = [];
  for (const [id, value] of Object.entries(articlesRaw)) {
    if (!isObject(value)) return { ok: false, reason: `文章 ${id} 不是对象。` };
    if (value["id"] !== id) return { ok: false, reason: `文章 ${id} 的 id 与键不一致。` };
    const title = value["title"];
    const createdAt = value["createdAt"];
    const paragraphsRaw = value["paragraphs"];
    if (typeof title !== "string" || title.length === 0) return { ok: false, reason: `文章 ${id} 缺少标题。` };
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
      return { ok: false, reason: `文章 ${id} 的 createdAt 非法。` };
    }
    if (!Array.isArray(paragraphsRaw) || paragraphsRaw.length === 0) {
      return { ok: false, reason: `文章 ${id} 没有段落。` };
    }
    const paragraphs: Paragraph[] = [];
    for (const p of paragraphsRaw) {
      const parsedParagraph = parseParagraph(p);
      if (!parsedParagraph) return { ok: false, reason: `文章 ${id} 有段落形状不合法。` };
      paragraphs.push(parsedParagraph);
    }
    if (paragraphs.some((p, i) => p.index !== i + 1)) {
      return { ok: false, reason: `文章 ${id} 的段落序号不连续。` };
    }
    const url = value["url"];
    const author = value["author"];
    articles.push({
      id,
      title,
      createdAt,
      paragraphs,
      ...(typeof url === "string" ? { url } : {}),
      ...(typeof author === "string" ? { author } : {}),
    });
  }

  const articlesById = new Map(articles.map((a) => [a.id, a]));
  const highlights: LegacyHighlight[] = [];
  for (const [id, value] of Object.entries(highlightsRaw)) {
    if (!isObject(value)) return { ok: false, reason: `划线 ${id} 不是对象。` };
    if (value["id"] !== id) return { ok: false, reason: `划线 ${id} 的 id 与键不一致。` };
    const articleId = value["articleId"];
    const paragraphIndex = value["paragraphIndex"];
    const startOffset = value["startOffset"];
    const endOffset = value["endOffset"];
    const selectionText = value["selectionText"];
    const color = value["color"];
    const createdAt = value["createdAt"];
    if (typeof articleId !== "string" || !articlesById.has(articleId)) {
      return { ok: false, reason: `划线 ${id} 指向不存在的文章。` };
    }
    if (
      typeof paragraphIndex !== "number" ||
      typeof startOffset !== "number" ||
      typeof endOffset !== "number" ||
      !Number.isInteger(paragraphIndex) ||
      !Number.isInteger(startOffset) ||
      !Number.isInteger(endOffset) ||
      endOffset <= startOffset
    ) {
      return { ok: false, reason: `划线 ${id} 的偏移非法。` };
    }
    if (typeof selectionText !== "string" || selectionText.length === 0) {
      return { ok: false, reason: `划线 ${id} 缺少选中文本。` };
    }
    // The anchor must still resolve against the article it claims, or the
    // highlight would render over the wrong characters.
    const article = articlesById.get(articleId)!;
    const paragraph = article.paragraphs.find((p) => p.index === paragraphIndex);
    if (!paragraph) return { ok: false, reason: `划线 ${id} 指向不存在的段落。` };
    if (endOffset > paragraph.text.length) return { ok: false, reason: `划线 ${id} 的偏移越界。` };
    if (paragraph.text.slice(startOffset, endOffset) !== selectionText) {
      return { ok: false, reason: `划线 ${id} 的引文与段落文本不一致。` };
    }
    if (typeof color !== "string" || !HIGHLIGHT_COLORS.has(color)) {
      return { ok: false, reason: `划线 ${id} 的颜色非法。` };
    }
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
      return { ok: false, reason: `划线 ${id} 的 createdAt 非法。` };
    }
    const style = value["style"];
    const noteText = value["noteText"];
    highlights.push({
      id,
      articleId,
      paragraphIndex,
      startOffset,
      endOffset,
      selectionText,
      color: color as Highlight["color"],
      createdAt,
      ...(typeof style === "string" && HIGHLIGHT_STYLES.has(style)
        ? { style: style as Highlight["style"] }
        : {}),
      ...(typeof noteText === "string" && noteText.length > 0 ? { noteText } : {}),
    });
  }

  return { ok: true, space: { articles, highlights } };
}

/** Read-only summary for the notice. Never mutates anything. */
export function readLegacySummary(): LegacySummary {
  const raw = readRaw();
  if (raw === null) return EMPTY;
  const bytes = new TextEncoder().encode(raw).byteLength;
  const parsed = parseLegacy(raw);
  if (!parsed.ok) {
    return { present: true, unreadable: parsed.reason, articles: 0, highlights: 0, notes: 0, bytes };
  }
  return {
    present: true,
    unreadable: null,
    articles: parsed.space.articles.length,
    highlights: parsed.space.highlights.length,
    notes: parsed.space.highlights.filter((h) => typeof h.noteText === "string").length,
    bytes,
  };
}

export function isLegacyNoticeDismissed(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(LEGACY_NOTICE_DISMISSED_KEY) === "1";
  } catch {
    return true;
  }
}

export function dismissLegacyNotice(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LEGACY_NOTICE_DISMISSED_KEY, "1");
  } catch {
    /* Nothing to do: the notice simply reappears next time. */
  }
}

/**
 * Download the untouched `local-free:v1` value.
 *
 * This is the lossless option and the reason the key is never rewritten: a
 * user who is unsure can keep this file and decide later.
 */
export function downloadLegacyRaw(): { ok: true; bytes: number; filename: string } | { ok: false; message: string } {
  const raw = readRaw();
  if (raw === null) return { ok: false, message: "没有检测到旧版本机数据。" };
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return { ok: false, message: "当前环境不支持下载。" };
  }
  const bytes = new TextEncoder().encode(raw).byteLength;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `local-free-legacy-raw-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true, bytes, filename };
}

export interface LegacyImportResult {
  ok: boolean;
  message: string;
  articles: number;
  highlights: number;
  notes: number;
}

/**
 * One-time, additive import into the current store.
 *
 * Idempotent by construction: ids are carried over verbatim, so importing the
 * same blob twice updates the same rows instead of duplicating them. It never
 * clears the current space and never removes the legacy key.
 */
export async function importLegacyIntoStore(): Promise<LegacyImportResult> {
  const raw = readRaw();
  if (raw === null) {
    return { ok: false, message: "没有检测到旧版本机数据。", articles: 0, highlights: 0, notes: 0 };
  }
  const parsed = parseLegacy(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `旧数据未能通过校验，未导入任何内容：${parsed.reason}`,
      articles: 0,
      highlights: 0,
      notes: 0,
    };
  }

  const store = useStore.getState();
  let notes = 0;

  // Refuse collisions before making any writes. Reimporting an old backup
  // must never replace a newer article or move an existing annotation.
  //
  // The comparison needs the article's *text*, which is no longer on the
  // record — so this step reads the body. That is why the import is async now:
  // the alternative was to skip the check for every article whose body had not
  // already been loaded, which would silently turn "refuse collisions" into
  // "refuse collisions sometimes".
  for (const legacy of parsed.space.articles) {
    const existing = store.articles[legacy.id];
    if (!existing) continue;
    const body = await readBody(legacy.id);
    if (JSON.stringify(body?.paragraphs) !== JSON.stringify(legacy.paragraphs)) {
      return { ok: false, message: "旧文章与当前同名记录冲突，未导入；请先保留原始备份。", articles: 0, highlights: 0, notes: 0 };
    }
  }
  for (const legacy of parsed.space.highlights) {
    const existing = store.highlights[legacy.id];
    if (existing && (existing.articleId !== legacy.articleId || existing.selectionText !== legacy.selectionText || existing.startOffset !== legacy.startOffset || existing.endOffset !== legacy.endOffset)) {
      return { ok: false, message: "旧划线与当前记录冲突，未导入；请先保留原始备份。", articles: 0, highlights: 0, notes: 0 };
    }
  }

  for (const legacy of parsed.space.articles) {
    const existing = store.articles[legacy.id];
    if (existing) continue;
    const article: ArticleDraft = {
      id: legacy.id,
      title: legacy.title,
      createdAt: legacy.createdAt,
      ...(legacy.url ? { url: legacy.url } : {}),
      ...(legacy.author ? { author: legacy.author } : {}),
    };
    await useStore.getState().saveArticle(article, legacy.paragraphs);
  }

  for (const legacy of parsed.space.highlights) {
    // Written straight into the store rather than through `addHighlight`: the
    // legacy id and `createdAt` are part of what makes the import idempotent
    // and keeps the user's timeline intact, and `addHighlight` mints both.
    if (!useStore.getState().highlights[legacy.id]) useStore.setState((state) => ({
      highlights: {
        ...state.highlights,
        [legacy.id]: {
          id: legacy.id,
          articleId: legacy.articleId,
          paragraphIndex: legacy.paragraphIndex,
          startOffset: legacy.startOffset,
          endOffset: legacy.endOffset,
          selectionText: legacy.selectionText,
          color: legacy.color,
          style: legacy.style ?? "watercolor",
          createdAt: legacy.createdAt,
        },
      },
    }));

    if (legacy.noteText) {
      const noteId = `legacy-${legacy.id}`;
      if (!useStore.getState().notes[noteId]) {
        const noteText = legacy.noteText;
        useStore.setState((state) => ({
          notes: {
            ...state.notes,
            [noteId]: {
              id: noteId,
              articleId: legacy.articleId,
              paragraphIndex: legacy.paragraphIndex,
              type: "ask",
              selectionText: legacy.selectionText,
              // Labelled, not disguised: nothing here claims a model wrote it.
              question: "（旧版本机阅读器的自由笔记）",
              answer: noteText,
              model: "local-free-legacy",
              isStreaming: false,
              createdAt: legacy.createdAt,
              startParagraphIndex: legacy.paragraphIndex,
              startOffset: legacy.startOffset,
              endParagraphIndex: legacy.paragraphIndex,
              endOffset: legacy.endOffset,
            },
          },
        }));
        notes += 1;
      }
    }
  }

  return {
    ok: true,
    message: `已导入 ${parsed.space.articles.length} 篇文章、${parsed.space.highlights.length} 条划线、${notes} 条旧笔记。旧空间未被删除，可随时再次导出。`,
    articles: parsed.space.articles.length,
    highlights: parsed.space.highlights.length,
    notes,
  };
}
