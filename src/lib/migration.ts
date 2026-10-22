// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The upload half of the anonymous→account migration.
 *
 * See `migration-store.ts` for the ownership rules and why the two halves
 * are separate modules. Everything here performs network work.
 *
 * ## Three things make this safe
 *
 * **The server is the authority for idempotency.** Every import, note and
 * message carries a stable `clientKey` derived from local ids, and the
 * routes replay onto the row a previous attempt created. Local progress is
 * an optimisation — it saves a round trip for work already known to be
 * done — not the thing correctness rests on. That distinction matters
 * because the failure this defends against is "the server created the row
 * and the response was lost", where the value the client is missing is
 * exactly the value it would have recorded.
 *
 * **The session argument is verified, and every `await` is guarded.** A
 * migration runs for many seconds and issues many requests. If the
 * account changes part way through, the remaining requests would go out
 * on the *new* account's cookie carrying the *old* account's content.
 * Every loop therefore re-checks `session user === userId` before and
 * after each await, and aborts the run without touching local state when
 * they diverge.
 *
 * **A run only claims success when nothing was left behind.** Every
 * intended article, note and conversation turn must be accounted for.
 * Anything else leaves the offer standing with a reason the user can act
 * on, so pressing again resumes rather than restarts.
 *
 * The API key is never read, never sent, and never migrated.
 */

import {
  createHighlight,
  getArticle,
  importArticle,
  listArticles,
  putArticleBrief,
  putArticleMeta,
  putArticleTags,
} from "./account-articles";
import { appendMessage, createNote } from "./notes";
import { ApiRequestError } from "./api-error";
import { useSession } from "./session";
import { currentSessionEpoch } from "./session-epoch";
import { useStore } from "./store";
import {
  activateAccountSpace,
  readAnonymousWorkspace,
  useMigration,
  type MigratedVersion,
  type MigrationProgress,
} from "./migration-store";
import type { Note, NoteMessage } from "./types";

export { ANON_SPACE_KEY, useMigration } from "./migration-store";
export type { MigrationProgress, MigrationStatus } from "./migration-store";

export interface MigrationResult {
  uploadedArticles: number;
  uploadedNotes: number;
  /** Conversation turns replayed onto the created notes. */
  uploadedMessages: number;
  /** Marks carried over from the anonymous workspace. */
  uploadedHighlights: number;
  failedArticles: number;
  failedNotes: number;
  failedMessages: number;
  failedHighlights: number;
  completed: boolean;
  error?: string;
}

export function articleClientKey(userId: string, localArticleId: string): string {
  return `anon:${userId}:${localArticleId}`;
}

export function noteClientKey(
  userId: string,
  localArticleId: string,
  localNoteId: string,
): string {
  return `anon:${userId}:${localArticleId}:${localNoteId}`;
}

/** Idempotency key for a migrated mark; same shape as the note key. */
export function highlightClientKey(
  userId: string,
  localArticleId: string,
  localHighlightId: string,
): string {
  return `anon:hl:${userId}:${localArticleId}:${localHighlightId}`;
}

export function messageClientKey(
  userId: string,
  localArticleId: string,
  localNoteId: string,
  turnIndex: number,
): string {
  return `anon:${userId}:${localArticleId}:${localNoteId}:m${turnIndex}`;
}

/** The account this run is allowed to act for, or null. */
function trustedUserId(expected: string): string | null {
  if (!useSession.getState().user?.id) return null;
  if (useSession.getState().user!.id !== expected) return null;
  return expected;
}

export async function confirmMigration(userId: string): Promise<MigrationResult> {
  const epochAtStart = currentSessionEpoch();
  const ownerAtStart = useStore.getState().ownerUserId;

  /** True while this run is still authorised to act for `userId`. */
  const stillAuthorised = (): boolean =>
    currentSessionEpoch() === epochAtStart &&
    useSession.getState().user?.id === userId &&
    trustedUserId(userId) !== null;

  if (!trustedUserId(userId)) {
    return {
      uploadedArticles: 0,
      uploadedNotes: 0,
      uploadedMessages: 0,
      uploadedHighlights: 0,
      failedArticles: 0,
      failedNotes: 0,
      failedMessages: 0,
      failedHighlights: 0,
      completed: false,
      error: "当前登录账号与迁移目标不一致，未执行任何同步。",
    };
  }
  void ownerAtStart;

  useMigration.getState().markRunning(userId);
  const progress: MigrationProgress = useMigration.getState().progressFor(userId);

  const workspace = await readAnonymousWorkspace();
  if (!workspace) {
    useMigration.getState().markDone(userId);
    return {
      uploadedArticles: 0,
      uploadedNotes: 0,
      uploadedMessages: 0,
      uploadedHighlights: 0,
      failedArticles: 0,
      failedNotes: 0,
      failedMessages: 0,
      failedHighlights: 0,
      completed: true,
    };
  }

  const result: MigrationResult = {
    uploadedArticles: 0,
    uploadedNotes: 0,
    uploadedMessages: 0,
    uploadedHighlights: 0,
    failedArticles: 0,
    failedNotes: 0,
    failedMessages: 0,
    failedHighlights: 0,
    completed: false,
  };

  /** Stop the run without touching local state. */
  const abort = (reason: string): MigrationResult => {
    result.error = reason;
    useMigration.getState().markFailed(userId, reason);
    return result;
  };

  const articles = Object.values(workspace.articles);
  const notes = Object.values(workspace.notes);
  const articleMap = new Map<string, string>(Object.entries(progress.articleMap));
  const versionMap = new Map<string, MigratedVersion>(Object.entries(progress.versionMap));

  // ── Articles ──────────────────────────────────────────────────────────
  for (const article of articles) {
    if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");
    if (articleMap.has(article.id) && versionMap.has(articleMap.get(article.id)!)) continue;
    if (!article.id.startsWith("local-")) {
      articleMap.set(article.id, article.id);
      continue;
    }
    try {
      const body = workspace.bodies[article.id];
      if (!body || body.paragraphs.length === 0) {
        // The record survived but its text did not — an article whose body was
        // never archived, or was evicted before the archive existed. Uploading
        // an empty document would come back as `EMPTY_ARTICLE`, which reads
        // like a bug in the article rather than a missing body; naming the real
        // reason is more useful, and it counts as a failure either way.
        useMigration.getState().recordArticleFailure(userId, article.id);
        result.failedArticles += 1;
        result.error ??= "有文章只有记录、正文不在本机，未上传。";
        continue;
      }
      const imported = await importArticle({
        kind: "text",
        content: body.paragraphs.map((p) => p.text).join("\n\n"),
        title: article.title,
        clientKey: articleClientKey(userId, article.id),
      });
      if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");
      articleMap.set(article.id, imported.article.id);
      versionMap.set(imported.article.id, {
        versionId: imported.version.id,
        paragraphs: imported.version.paragraphs.map((p) => ({
          index: p.index,
          id: p.id,
          text: p.text,
        })),
      });
      useMigration.getState().recordArticle(userId, article.id, imported.article.id);
      useMigration.getState().recordVersion(userId, imported.article.id, versionMap.get(imported.article.id)!);
      result.uploadedArticles += 1;
    } catch (err) {
      useMigration.getState().recordArticleFailure(userId, article.id);
      result.failedArticles += 1;
      result.error ??= describe(err, "文章");
    }
  }

  // ── Notes ─────────────────────────────────────────────────────────────
  for (const note of notes) {
    if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");
    const serverArticleId = articleMap.get(note.articleId);
    if (!serverArticleId) {
      result.failedNotes += 1;
      continue;
    }
    const version = versionMap.get(serverArticleId);
    if (!version) {
      result.failedNotes += 1;
      continue;
    }
    const key = noteClientKey(userId, note.articleId, note.id);
    const alreadyDone = useMigration
      .getState()
      .progressFor(userId)
      .completedNoteKeys.includes(key);
    if (alreadyDone) continue;

    const anchor = mapAnchorToImportedVersion(
      note,
      workspace.bodies[note.articleId]?.paragraphs ?? [],
      version,
    );
    if (!anchor) {
      // The imported version does not contain the text this note was
      // anchored to at the coordinates it names. Anchoring it anyway
      // would attach the note to a coincidence; leaving it unmigrated
      // and reporting it is the honest outcome.
      useMigration.getState().recordNoteFailure(userId, key);
      result.failedNotes += 1;
      result.error ??= `笔记「${note.question.slice(0, 20)}」在原版本中的位置无法在导入版本中确认，未同步。`;
      continue;
    }

    try {
      const created = await createNote(serverArticleId, {
        paragraphIndex: anchor.paragraphIndex,
        ...(anchor.startParagraphIndex !== undefined
          ? { startParagraphIndex: anchor.startParagraphIndex }
          : {}),
        ...(anchor.startOffset !== undefined ? { startOffset: anchor.startOffset } : {}),
        ...(anchor.endParagraphIndex !== undefined
          ? { endParagraphIndex: anchor.endParagraphIndex }
          : {}),
        ...(anchor.endOffset !== undefined ? { endOffset: anchor.endOffset } : {}),
        ...(anchor.startBlockId ? { startBlockId: anchor.startBlockId } : {}),
        ...(anchor.endBlockId ? { endBlockId: anchor.endBlockId } : {}),
        articleVersionId: version.versionId,
        selectionText: note.selectionText,
        type: note.type,
        question: note.question,
        model: note.model,
        clientKey: key,
      });
      if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");

      // The note row exists; the turns are a separate obligation. It is
      // deliberately *not* recorded as complete until every turn is in,
      // because a note with no answer is not migrated content.
      const turnsWritten = await replayTurns(
        userId,
        note,
        created.note.id,
        stillAuthorised,
      );
      if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");
      result.uploadedMessages += turnsWritten.written;

      if (turnsWritten.failed > 0) {
        useMigration.getState().recordNoteFailure(userId, key);
        result.failedNotes += 1;
        result.failedMessages += turnsWritten.failed;
        result.error ??= `笔记「${note.question.slice(0, 20)}」的回答未能完整同步，可重试。`;
        continue;
      }

      useMigration.getState().recordNote(userId, key);
      result.uploadedNotes += 1;
    } catch (err) {
      useMigration.getState().recordNoteFailure(userId, key);
      result.failedNotes += 1;
      result.error ??= describe(err, "笔记");
    }
  }

  if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");

  // ── Account metadata (tags / summary / cover) ─────────────────────────
  //
  // Best-effort and not counted as article failures: an article whose text
  // migrated is migrated, and its metadata can be regenerated (or backfilled
  // by the next open). An article still waiting on its upload has no server id
  // and is skipped — its metadata will be pushed by `pushArticleMetadata` when
  // the reader opens it signed in.
  for (const article of articles) {
    if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");
    const serverArticleId = articleMap.get(article.id);
    if (!serverArticleId) continue;
    try {
      if (article.tags && article.tags.length > 0) {
        await putArticleTags(serverArticleId, {
          tags: article.tags,
          ...(article.tagsModel ? { model: article.tagsModel } : {}),
          ...(article.tagsAt ? { at: article.tagsAt } : {}),
        });
      }
      if (article.brief) {
        await putArticleBrief(serverArticleId, {
          brief: article.brief,
          at: article.brief.generatedAt,
        });
      }
      if (article.coverImage || article.publishedAt) {
        await putArticleMeta(serverArticleId, {
          ...(article.coverImage ? { coverImage: article.coverImage } : {}),
          ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
        });
      }
    } catch {
      // Retried on the next open; not worth failing the migration over.
    }
  }

  // ── Highlights ────────────────────────────────────────────────────────
  //
  // A mark is only migrated when its paragraph exists in the imported version
  // and its offsets still land inside that paragraph's text. `clientKey` makes
  // the create idempotent, so a retried migration (a lost response, a resumed
  // run) does not paint the same line twice.
  for (const highlight of Object.values(workspace.highlights)) {
    if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");
    const serverArticleId = articleMap.get(highlight.articleId);
    const version = serverArticleId ? versionMap.get(serverArticleId) : undefined;
    if (!serverArticleId || !version) {
      result.failedHighlights += 1;
      continue;
    }
    const paragraph = version.paragraphs.find(
      (entry) => entry.index === highlight.paragraphIndex,
    );
    if (
      !paragraph ||
      highlight.startOffset < 0 ||
      highlight.endOffset <= highlight.startOffset ||
      highlight.endOffset > paragraph.text.length
    ) {
      result.failedHighlights += 1;
      continue;
    }
    try {
      await createHighlight(serverArticleId, {
        paragraphIndex: highlight.paragraphIndex,
        startOffset: highlight.startOffset,
        endOffset: highlight.endOffset,
        blockId: paragraph.id,
        articleVersionId: version.versionId,
        clientKey: highlightClientKey(userId, highlight.articleId, highlight.id),
        // Re-derived from the server-side text rather than taken from the
        // local record: the create is validated against exactly this range.
        selectionText: paragraph.text.slice(highlight.startOffset, highlight.endOffset),
        color: highlight.color,
        ...(highlight.style ? { style: highlight.style } : {}),
        ...(highlight.note ? { note: highlight.note } : {}),
      });
      result.uploadedHighlights += 1;
    } catch {
      result.failedHighlights += 1;
    }
  }

  if (!stillAuthorised()) return abort("账号已切换，已停止同步且未改动本机数据。");

  if (
    result.failedArticles > 0 ||
    result.failedNotes > 0 ||
    result.failedMessages > 0 ||
    result.failedHighlights > 0
  ) {
    useMigration.getState().markFailed(userId, result.error ?? "部分内容未能同步，请重试。");
    return result;
  }

  // The account's space is activated, and the anonymous snapshot is
  // deliberately *kept*: the rule is that the anonymous workspace stays
  // independent ("保留独立匿名本地空间"), so signing out returns to it.
  if (!(await activateAccountSpace(userId))) {
    const reason = "无法保存匿名空间的备份，未清空本机数据。";
    useMigration.getState().markFailed(userId, reason);
    result.error = reason;
    return result;
  }
  useMigration.getState().markDone(userId);
  result.completed = true;
  return result;
}

/**
 * Re-express a note's anchor against the *imported* version.
 *
 * Block ids are version-scoped (`b<index>-<hash8>`, where the hash is over
 * that version's own text). Re-importing a document can therefore produce
 * different ids — joining paragraphs with blank lines changes how a list
 * or a code block is split, for instance. Sending the *old* ids would make
 * every ranged note fail validation with a confusing "选区文本与当前版本
 * 不符".
 *
 * So the anchor is rebuilt from the imported version: the start and end
 * block are located by index, their text is compared with what the note
 * was originally anchored to, and only an exact match is accepted. When
 * the text does not match, the note falls back to the un-ranged shape
 * (validated by containment against the start paragraph) rather than being
 * dropped — or, if even the paragraph is gone, is reported as unmigrated.
 */
function mapAnchorToImportedVersion(
  note: Note,
  localParagraphs: { index: number; text: string }[],
  version: MigratedVersion,
):
  | {
      paragraphIndex: number;
      startParagraphIndex?: number;
      startOffset?: number;
      endParagraphIndex?: number;
      endOffset?: number;
      startBlockId?: string;
      endBlockId?: string;
    }
  | null {
  const byIndex = new Map(version.paragraphs.map((p) => [p.index, p]));
  const startIndex = note.startParagraphIndex ?? note.paragraphIndex;
  const endIndex = note.endParagraphIndex ?? startIndex;
  const startBlock = byIndex.get(startIndex);
  if (!startBlock) return null;

  const hasRange =
    note.startOffset !== undefined &&
    note.endOffset !== undefined &&
    note.startParagraphIndex !== undefined &&
    note.endParagraphIndex !== undefined;

  if (!hasRange) {
    // A note with no range is validated by containment; it only needs the
    // paragraph to still hold the text.
    const stillThere = startBlock.text.includes(note.selectionText);
    return stillThere
      ? { paragraphIndex: startIndex }
      : null;
  }

  const endBlock = byIndex.get(endIndex);
  if (!endBlock) return null;

  // Confirm the coordinates describe the same text they did originally.
  const localStart = localParagraphs.find((p) => p.index === startIndex)?.text ?? null;
  const localEnd = localParagraphs.find((p) => p.index === endIndex)?.text ?? null;
  const rebuilt =
    endIndex === startIndex
      ? startBlock.text.slice(note.startOffset!, note.endOffset!)
      : [
          startBlock.text.slice(note.startOffset!),
          ...version.paragraphs
            .filter((p) => p.index > startIndex && p.index < endIndex)
            .map((p) => p.text),
          endBlock.text.slice(0, note.endOffset!),
        ].join("\n");

  const sameShape =
    localStart !== null &&
    localEnd !== null &&
    localStart === startBlock.text &&
    localEnd === endBlock.text &&
    rebuilt.length > 0;

  if (sameShape) {
    return {
      paragraphIndex: startIndex,
      startParagraphIndex: startIndex,
      startOffset: note.startOffset!,
      endParagraphIndex: endIndex,
      endOffset: note.endOffset!,
      startBlockId: startBlock.id,
      endBlockId: endBlock.id,
    };
  }

  // The paragraphs shifted. Keep the content by falling back to the
  // un-ranged shape when the selection is still findable, because a
  // migrated note that is anchored loosely is worth more than one that
  // is not migrated at all — and the server still validates it.
  const fallbackIndex = version.paragraphs.find((p) =>
    p.text.includes(note.selectionText),
  )?.index;
  if (fallbackIndex === undefined) return null;
  return { paragraphIndex: fallbackIndex };
}

interface TurnReplayResult {
  written: number;
  failed: number;
}

/**
 * Replay a note's conversation onto the server note.
 *
 * The seeded turn is handled explicitly rather than by "skip sequence 1":
 * the server always creates the *first user message* as the seed, so that
 * is what is skipped, and only when it actually matches the note's
 * question. Anything else — a note whose first recorded turn is an
 * assistant answer, or a question that differs — is sent with its own key,
 * so nothing is silently dropped.
 *
 * Every turn gets a `clientKey` derived from its own index, which is what
 * makes a lost response safe: the retry replays onto the same message
 * instead of appending a duplicate to the conversation.
 */
async function replayTurns(
  userId: string,
  note: Note,
  remoteNoteId: string,
  stillAuthorised: () => boolean,
): Promise<TurnReplayResult> {
  const progress = useMigration.getState().progressFor(userId);
  const result: TurnReplayResult = { written: 0, failed: 0 };

  const turns: NoteMessage[] = note.turns ?? [];
  const ordered: { role: "user" | "assistant"; content: string; index: number }[] =
    turns.length > 0
      ? turns.map((t, i) => ({ role: t.role, content: t.content, index: i + 1 }))
      : note.answer.trim().length > 0
        ? [{ role: "assistant", content: note.answer, index: 2 }]
        : [];

  for (const turn of ordered) {
    if (!stillAuthorised()) return result;
    const key = messageClientKey(userId, note.articleId, note.id, turn.index);

    // The server seeds the note's first user message itself when
    // `createNote` runs, so that one is already present.
    const isSeed =
      turn.index === 1 && turn.role === "user" && turn.content === note.question;
    if (isSeed) {
      useMigration.getState().recordMessage(userId, key);
      continue;
    }
    if (progress.completedMessageKeys.includes(key)) continue;

    try {
      await appendMessage(remoteNoteId, {
        role: turn.role,
        content: turn.content,
        ...(turn.role === "assistant"
          ? { status: (note.remoteStatus === "running" ? "succeeded" : note.remoteStatus ?? "succeeded") }
          : {}),
        clientKey: key,
      });
      if (!stillAuthorised()) return result;
      useMigration.getState().recordMessage(userId, key);
      result.written += 1;
    } catch {
      useMigration.getState().recordMessageFailure(userId, key);
      result.failed += 1;
    }
  }

  return result;
}

function describe(err: unknown, what: string): string {
  if (err instanceof ApiRequestError) return `${what}同步失败：${err.message}`;
  return `${what}同步失败，请检查网络后重试。`;
}

/** Server-side article count, used by the acceptance test's checks. */
export async function serverArticleCount(): Promise<number> {
  const response = await listArticles();
  return response.articles.length;
}

/** Re-exported so a caller can fetch a server article without a second import. */
export { getArticle };

/** The live store, re-exported so callers do not import two modules. */
export { useStore };
