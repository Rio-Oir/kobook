// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Export and restore of the reader's local library.
 *
 * ## What is in a backup, and what is deliberately not
 *
 * Articles (with their text), notes and highlights. Never settings, provider
 * choices, API keys, the owner stamp or any cloud identity: a backup is meant
 * to be a file someone can keep in a folder, mail to themselves, or open in a
 * text editor, and none of those are safe for a credential.
 *
 * ## The two versions
 *
 * The format is `1` when every article's text is in the file — which is the
 * behaviour every existing backup and every existing test asserts, byte for
 * byte. It only becomes `2` when at least one article's text could not be
 * included, and that article carries `body: "omitted"` in place of
 * `paragraphs`.
 *
 * The split is not cosmetic. A file that silently dropped a body would restore
 * an article whose notes point at paragraphs that are not there, and the reader
 * would have no way to tell that from a corrupt restore. Naming the omission in
 * the format — and bumping the version so a v1 reader cannot mistake it for a
 * complete file — is what keeps "your backup is incomplete" a thing the reader
 * can be told.
 *
 * A `version: 1` file may never contain an omitted body; the schema enforces
 * it. That asymmetry is the point of having two versions at all.
 *
 * ## Why the functions are asynchronous now
 *
 * The text lives in IndexedDB, so reading it (export) and writing it (restore)
 * cannot be synchronous. What is preserved is the property that matters for
 * restore: **nothing is published until everything has succeeded**. Bodies are
 * written first, then the workspace blob, then memory — so a failure at any
 * point leaves the previous state in place, which is the same guarantee the
 * synchronous version had.
 */

import { z } from "zod";
import { useStore, persistedState } from "./store";
import { WORKSPACE_KEY, STORAGE_VERSION } from "./storage/migrate";
import { makeBody, readBody, writeBody } from "./storage/bodies";
import type { Article, ArticleBody, ArticleDraft, Paragraph } from "./types";
import { MAX_HIGHLIGHT_NOTE_LENGTH } from "./types";

const text = z.string().max(2_000_000);
const id = z.string().min(1).max(500).refine((v) => v !== "prototype" && !Object.hasOwn(Object.prototype, v));
const num = z.number().finite().nonnegative();
const offset = num.int();
/**
 * A reader-typed remark, bounded by the one constant the editor and the
 * store also use. The bound exists so a hand-edited backup cannot turn one
 * highlight's note into a second article: it is a personal annotation, not
 * content. Keeping it in `types.ts` is what stops the schema from being
 * stricter than the UI that feeds it — the failure mode being a remark the
 * reader could type but that makes the whole backup refuse to build.
 */
const remark = z.string().max(MAX_HIGHLIGHT_NOTE_LENGTH);
const status = z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]);
const span = z
  .object({
    start: offset,
    end: offset,
    kinds: z.array(z.enum(["strong", "em", "code", "del", "link"])),
    href: text.optional(),
  })
  .strict();
const paragraph = z
  .object({
    index: offset,
    text,
    hash: text,
    blockId: text.optional(),
    type: z
      .enum(["heading", "paragraph", "listItem", "code", "quote", "image", "table", "hr"])
      .optional(),
    level: z.number().int().min(1).max(6).optional(),
    lang: text.nullable().optional(),
    ordered: z.boolean().optional(),
    depth: z.number().int().min(0).max(100).optional(),
    task: z.boolean().optional(),
    checked: z.boolean().optional(),
    // Image metadata and table cells ride along with the paragraph. Without
    // them a restore would turn an image into an empty figure and a table
    // into a text-only block, and `.strict()` would refuse the backup file
    // outright instead.
    src: text.optional(),
    alt: text.optional(),
    title: text.optional(),
    rows: z.array(z.array(text)).optional(),
    spans: z.array(span).optional(),
  })
  .strict();

/** The fields a backup carries about an article, shared by both variants. */
const articleRecordShape = {
  id,
  title: text,
  url: text.optional(),
  author: text.optional(),
  publishedAt: text.optional(),
  createdAt: num,
  /**
   * AI tags are part of the library's browsing state, not a cloud-only
   * convenience: a restored library that silently lost every tag would
   * re-open with an empty filter bar and no way to tell whether the tagger
   * had ever run. They are cheap to regenerate, but the backup is the
   * "everything is still here" promise, so they travel with it.
   *
   * The model/timestamp are diagnostics; keeping them means a restored
   * library can show when and by which model it was classified.
   */
  tags: z.array(text).max(6).optional(),
  tagsModel: text.optional(),
  tagsAt: num.optional(),
  brief: z
    .object({
      gist: text,
      claims: z.array(z.object({ text, paragraphRef: text }).strict()),
      generatedAt: num,
    })
    .strict()
    .optional(),
} as const;

/** An article whose text is in the file. */
const articleIncluded = z.object({ ...articleRecordShape, paragraphs: z.array(paragraph).min(1) }).strict();
/** An article whose text could not be included, and says so. */
const articleOmitted = z.object({ ...articleRecordShape, body: z.literal("omitted") }).strict();
const article = z.union([articleIncluded, articleOmitted]);

const turn = z
  .object({
    id,
    noteId: id,
    sequence: offset,
    role: z.enum(["user", "assistant"]),
    content: text,
    createdAt: text,
    clientTurnId: text.optional(),
    status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]).optional(),
  })
  .strict();
const note = z
  .object({
    id,
    articleId: id,
    paragraphIndex: offset,
    type: z.enum(["explain", "ask"]),
    selectionText: text,
    question: text,
    answer: text,
    model: text,
    isStreaming: z.literal(false),
    createdAt: num,
    startParagraphIndex: offset.optional(),
    startOffset: offset.optional(),
    endParagraphIndex: offset.optional(),
    endOffset: offset.optional(),
    startBlockId: text.optional(),
    endBlockId: text.optional(),
    localStatus: status.optional(),
    turns: z.array(turn).optional(),
  })
  .strict();
const highlight = z
  .object({
    id,
    articleId: id,
    paragraphIndex: offset,
    startOffset: offset,
    endOffset: offset,
    selectionText: text,
    color: z.enum(["yellow", "green", "blue", "red"]),
    style: z.enum(["watercolor", "line", "curve"]).optional(),
    note: remark.optional(),
    createdAt: num,
  })
  .strict();

const schema = z
  .object({
    format: z.literal("gloss-local-backup"),
    // 1 = every body included; 2 = at least one `body: "omitted"`.
    version: z.union([z.literal(1), z.literal(2)]),
    articles: z.record(article),
    notes: z.record(note),
    highlights: z.record(highlight),
  })
  .strict()
  .refine(
    (value) =>
      value.version === 2 || Object.values(value.articles).every((a) => "paragraphs" in a),
    { message: "备份版本 1 必须包含全部正文。" },
  );

/** A parsed, validated backup. */
export type Backup = z.infer<typeof schema>;

const ARTICLE_RECORD_FIELDS = Object.keys(articleRecordShape) as Array<keyof typeof articleRecordShape>;
const NOTE_FIELDS = Object.keys(note.shape);
const TURN_FIELDS = Object.keys(turn.shape);
const HIGHLIGHT_FIELDS = Object.keys(highlight.shape);

function pick(value: object, fields: string[]) {
  return Object.fromEntries(
    fields.filter((k) => Object.hasOwn(value, k)).map((k) => [k, (value as Record<string, unknown>)[k]]),
  );
}

/**
 * The text for one article, from memory if it is already there.
 *
 * The store's copy is preferred because it is the one the user is looking at;
 * a body that has been written but whose in-memory entry is stale would
 * otherwise export an older revision. Falling back to storage covers the
 * ordinary case of exporting a library the reader has not opened this session.
 */
async function bodyFor(articleId: string): Promise<ArticleBody | undefined> {
  const entry = useStore.getState().bodies[articleId];
  if (entry?.state === "present") return entry.body;
  return await readBody(articleId);
}

/**
 * Serialise the current library.
 *
 * Rejects if a body could not be *read* — an I/O failure is not the same thing
 * as "this article has no text here", and a backup that silently treated the
 * two alike would be the exact failure this format is trying to make visible.
 * A body that is genuinely absent is recorded as omitted.
 */
export async function createLocalBackup(): Promise<string> {
  const state = useStore.getState();
  const articles: Record<string, unknown> = {};
  let omitted = 0;
  for (const [key, record] of Object.entries(state.articles)) {
    const body = await bodyFor(record.id);
    const fields = pick(record, ARTICLE_RECORD_FIELDS);
    if (body && body.paragraphs.length > 0) {
      articles[key] = { ...fields, paragraphs: body.paragraphs };
    } else {
      omitted += 1;
      articles[key] = { ...fields, body: "omitted" };
    }
  }

  const data = {
    format: "gloss-local-backup",
    version: omitted > 0 ? 2 : 1,
    articles,
    notes: Object.fromEntries(
      Object.entries(state.notes).map(([k, v]) => [
        k,
        {
          ...pick(v, NOTE_FIELDS),
          isStreaming: false,
          ...(v.isStreaming ? { localStatus: "interrupted" } : {}),
          ...(v.turns ? { turns: v.turns.map((t) => pick(t, TURN_FIELDS)) } : {}),
        },
      ]),
    ),
    highlights: Object.fromEntries(
      Object.entries(state.highlights).map(([k, v]) => [k, pick(v, HIGHLIGHT_FIELDS)]),
    ),
  };
  // Validation is shared with restore; credentials/settings/queues never enter.
  return JSON.stringify(validateLocalBackup(JSON.stringify(data)), null, 2);
}

/** Whether an article in a backup carries its text. */
export function backupArticleHasBody(
  article: Backup["articles"][string],
): article is z.infer<typeof articleIncluded> {
  return "paragraphs" in article;
}

/**
 * Validate a backup file, and check every annotation against the text it
 * claims to be about.
 *
 * An article whose body was omitted is checked **structurally only**: there is
 * no text in the file to compare a selection against. That is not a hole in the
 * check but a limit of the format, and it is why the omission is recorded in
 * the file rather than inferred — a restore from such a file carries anchors
 * that this function could not verify, and a reader that cares should say so.
 */
export function validateLocalBackup(raw: string): Backup {
  if (new TextEncoder().encode(raw).length > 20 * 1024 * 1024) throw new Error("备份超过20 MB上限。");
  const data = schema.parse(JSON.parse(raw));
  for (const [key, a] of Object.entries(data.articles)) {
    if (key !== a.id) throw new Error("文章标识不一致。");
    if (!backupArticleHasBody(a)) continue;
    for (let i = 0; i < a.paragraphs.length; i++) {
      const p = a.paragraphs[i]!;
      if (p.index !== i + 1) throw new Error("段落顺序不正确。");
      for (const s of p.spans ?? []) {
        if (s.start >= s.end || s.end > p.text.length) throw new Error("正文格式范围无效。");
      }
    }
  }
  for (const group of [data.notes, data.highlights]) {
    for (const [key, n] of Object.entries(group)) {
      const a = data.articles[n.articleId];
      if (key !== n.id || !a) throw new Error("笔记或划线所属文章无效。");
      if (!backupArticleHasBody(a)) {
        // Nothing in the file can confirm the anchor. The note is accepted —
        // refusing it would make an omitted body un-restorable — and the
        // caller is expected to have been told the file is incomplete.
        if (n.paragraphIndex !== undefined && !Number.isInteger(n.paragraphIndex)) {
          throw new Error("笔记或划线所属文章无效。");
        }
        continue;
      }
      if (!a.paragraphs.some((p) => p.index === n.paragraphIndex)) {
        throw new Error("笔记或划线所属文章无效。");
      }
      if ("color" in n) {
        const p = a.paragraphs.find((p) => p.index === n.paragraphIndex)!;
        if (n.startOffset >= n.endOffset || p.text.slice(n.startOffset, n.endOffset) !== n.selectionText) {
          throw new Error("划线范围与正文不一致。");
        }
      } else if (
        n.startParagraphIndex !== undefined ||
        n.endParagraphIndex !== undefined ||
        n.startOffset !== undefined ||
        n.endOffset !== undefined
      ) {
        const first = a.paragraphs.find((p) => p.index === n.startParagraphIndex);
        const last = a.paragraphs.find((p) => p.index === n.endParagraphIndex);
        if (
          !first ||
          !last ||
          n.startOffset === undefined ||
          n.endOffset === undefined ||
          first.index > last.index ||
          n.startOffset > first.text.length ||
          n.endOffset > last.text.length
        ) {
          throw new Error("笔记范围无效。");
        }
        const selected = a.paragraphs
          .filter((p) => p.index >= first.index && p.index <= last.index)
          .map((p) => p.text.slice(p === first ? n.startOffset : 0, p === last ? n.endOffset : undefined))
          .join("\n");
        const normalized = (v: string) => v.replace(/\s+/g, " ").trim();
        if (normalized(selected) !== normalized(n.selectionText)) throw new Error("笔记范围与引文不一致。");
      }
    }
  }
  return data;
}

/**
 * Restore a backup into the current library, additively.
 *
 * Refuses every differing collision before writing anything — a restore must
 * never replace a newer article or move an existing annotation.
 *
 * Publication order, and why it is this way round:
 *   1. every body that the file carries, to IndexedDB;
 *   2. the workspace blob, in one `setItem`, so a quota failure leaves the
 *      previous file intact;
 *   3. memory.
 *
 * A crash between 1 and 2 leaves bodies that no record points at. They are
 * unreachable and the next `clearUserCache()` sweeps them; the reverse order
 * would leave records pointing at text that is not there, which is the state
 * that makes an article look corrupt.
 */
export async function restoreLocalBackup(raw: string): Promise<{ omittedArticles: number }> {
  const backup = validateLocalBackup(raw);
  const state = useStore.getState();

  // Additive restore refuses every differing collision before writing.
  const current = JSON.parse(await createLocalBackup()) as Backup;
  for (const group of ["articles", "notes", "highlights"] as const) {
    for (const [key, value] of Object.entries(backup[group])) {
      if (current[group][key] && JSON.stringify(current[group][key]) !== JSON.stringify(value)) {
        throw new Error("备份与当前记录冲突，未恢复；请保留两份备份。");
      }
    }
  }

  const articles: Record<string, Article> = { ...state.articles };
  const bodies: Record<string, import("./store").BodyEntry> = { ...state.bodies };
  let omittedArticles = 0;

  for (const [key, stored] of Object.entries(backup.articles)) {
    // `paragraphs` becomes the body; `body` is the format's own marker for
    // "the text is not in this file" and must not survive into the record.
    const { paragraphs: included, ...record } = stored as Record<string, unknown> & {
      paragraphs?: Paragraph[];
    };
    delete record["body"];
    const articleId = String(record["id"]);
    const paragraphs = Array.isArray(included) ? included : [];
    if (paragraphs.length > 0) {
      const body = makeBody(articleId, paragraphs);
      await writeBody(body);
      bodies[articleId] = { state: "present", body };
    } else {
      omittedArticles += 1;
    }
    void key;
    articles[articleId] = {
      ...(record as unknown as ArticleDraft),
      bodyStats: {
        paragraphs: paragraphs.length,
        chars: paragraphs.reduce((total, p) => total + p.text.length, 0),
      },
    };
  }

  const next = {
    ...state,
    articles,
    bodies,
    notes: { ...backup.notes, ...state.notes } as typeof state.notes,
    highlights: { ...backup.highlights, ...state.highlights } as typeof state.highlights,
  };

  // Prove disk accepts the complete candidate before publishing memory.
  // Synchronous, and therefore cannot race another event in this tab.
  localStorage.setItem(
    WORKSPACE_KEY,
    JSON.stringify({ state: persistedState(next), version: STORAGE_VERSION }),
  );
  useStore.setState(next);
  return { omittedArticles };
}

/**
 * Download the backup as a file.
 *
 * Returns how many articles were omitted so the caller can tell the reader
 * *before* they rely on the file. A silent download of an incomplete backup is
 * the failure this return value exists to prevent.
 */
export async function downloadLocalBackup(): Promise<{ omittedArticles: number }> {
  const json = await createLocalBackup();
  const omittedArticles = Object.values(validateLocalBackup(json).articles).filter(
    (a) => !backupArticleHasBody(a),
  ).length;
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `gloss-backup-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { omittedArticles };
}
