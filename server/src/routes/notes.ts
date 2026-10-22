// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Notes + messages + refresh — phase 3 slice 3.
 *
 * All routes are behind `createRequireSession`. The cross-user gate is
 * always `prisma.<table>.findFirst({ where: { id, ownerUserId } })`, so
 * a guessed id never leaks across accounts. The notes table is also
 * pinned to a specific `article_version` so a refresh can write a new
 * version and leave the old notes bound to the version they were
 * created against (the plan's "重新抓取生成新版本，旧笔记仍能读原版本"
 * gate).
 *
 * Selection validation: `POST /api/articles/:id/notes` re-derives the
 * selection from the version's `paragraph.text` for the requested
 * `paragraphIndex`. A client that claims a different `selectionText`
 * than the one the parser produced gets 422 `VALIDATION_FAILED`. This
 * is the one thing the plan calls out that the client cannot be
 * trusted to do — the server is the only place the paragraph text
 * actually lives, so it is also the only place that can verify a
 * client-supplied substring.
 *
 * Refresh: slice 3 only re-parses text or html. URL refresh is a slice
 * 4 concern (it shares the Jina / SSRF code, and a refreshed URL on a
 * flaky source would do more harm than good). A refresh writes a new
 * `article_version` row, marks it `isCurrent = true`, and demotes the
 * previous one. Notes that referenced the old version are untouched
 * — the response's `retainedNoteCount` is the size of that set.
 */

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ROUTES,
  type ArticleRefreshRequest,
  type ArticleRefreshResponse,
  type NoteAppendMessageRequest,
  type NoteAppendMessageResponse,
  type NoteCreateRequest,
  type NoteCreateResponse,
  type NoteDeleteResponse,
  type NoteDetailResponse,
  type NoteListResponse,
  type NoteMessage,
  type NoteStatus,
  type NoteStatusUpdateRequest,
  type NoteSummary,
} from "../../../shared/contracts/index.js";
import type { AppPrisma } from "../db.js";
import type { Auth } from "../auth.js";
import { createRequireSession, currentSession } from "../plugins/session.js";
import { parseContent, type ParseKind } from "../lib/parse/index.js";
import { normalizeProse } from "../lib/parse/blocks.js";
import { validateRangeSelection, validateSelection } from "../lib/selection.js";
import { reserveNextVersion } from "../lib/versioning.js";
import { blockToParagraphRow, toVersionDetail } from "./articles.js";

const MAX_NOTE_QUESTION = 4_000;
const MAX_NOTE_ANSWER = 50_000;
const MAX_NOTE_MESSAGE = 50_000;
const MAX_REFRESH_BYTES = 2 * 1024 * 1024;

function hashSelection(text: string): string {
  return createHash("sha256").update(normalizeProse(text), "utf8").digest("hex");
}

function toNoteSummary(row: {
  id: string;
  articleId: string;
  versionId: string;
  paragraphIndex: number;
  startParagraphIndex: number;
  startOffset: number;
  endParagraphIndex: number;
  endOffset: number;
  startBlockId: string;
  endBlockId: string;
  type: string;
  selectionText: string;
  selectionHash: string;
  question: string;
  answer: string;
  model: string;
  status: string;
  /** Nullable: a row from before the column existed carries no colour. */
  color: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): NoteSummary {
  return {
    id: row.id,
    articleId: row.articleId,
    versionId: row.versionId,
    paragraphIndex: row.paragraphIndex,
    startParagraphIndex: row.startParagraphIndex,
    startOffset: row.startOffset,
    endParagraphIndex: row.endParagraphIndex,
    endOffset: row.endOffset,
    startBlockId: row.startBlockId,
    endBlockId: row.endBlockId,
    type: row.type as NoteSummary["type"],
    selectionText: row.selectionText,
    selectionHash: row.selectionHash,
    question: row.question,
    answer: row.answer,
    model: row.model,
    status: row.status as NoteStatus,
    // The column is free text in the database and a union on the wire.
    // Anything the Reader does not have a swatch for — including NULL on a
    // row written before the column existed — is reported as "no colour",
    // which the client renders with the default note blue. Forwarding the
    // raw string instead would put a value in a typed field that the
    // client has to re-guess the meaning of.
    color: (["yellow", "green", "blue", "red"] as const).find((c) => c === row.color) ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

function toMessage(row: {
  id: string;
  noteId: string;
  role: string;
  content: string;
  sequence: number;
  createdAt: Date;
}): NoteMessage {
  return {
    id: row.id,
    noteId: row.noteId,
    role: row.role as NoteMessage["role"],
    content: row.content,
    sequence: row.sequence,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Load a note and assert the caller owns it. Returns the row + its
 * parent article, both of which the create / append handlers need.
 * `null` means "not yours or not found", and the caller turns that into
 * 404.
 */
async function loadOwnedNote(
  prisma: AppPrisma,
  noteId: string,
  ownerUserId: string,
) {
  return prisma.note.findFirst({
    where: { id: noteId, ownerUserId },
  });
}

export function registerNoteRoutes(
  app: FastifyInstance,
  prisma: AppPrisma,
  auth: Auth,
): void {
  const requireSession = createRequireSession(auth);

  // ── Refresh (creates a new article_version, demotes the old one) ─────
  app.post<{ Params: { id: string }; Body: ArticleRefreshRequest }>(
    ROUTES.articleRefresh,
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["kind", "content"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["text", "html"] },
            content: { type: "string", minLength: 1, maxLength: MAX_REFRESH_BYTES },
            title: { type: "string", maxLength: 512 },
          },
        },
      },
    },
    async (req): Promise<ArticleRefreshResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      // The public API speaks `text` (Markdown) and `html`; the parse
      // layer speaks `markdown` and `html`. Translate at the boundary
      // so the user-facing `text` name stays stable.
      const parseKind: ParseKind = req.body.kind === "text" ? "markdown" : req.body.kind;
      const parsed = parseContent(parseKind, req.body.content, {
        title: req.body.title,
      });
      if (!parsed.ok) {
        const code = parsed.code === "EMPTY_CONTENT" ? "EMPTY_ARTICLE" : "VALIDATION_FAILED";
        throw Object.assign(new Error(parsed.message), { statusCode: code === "EMPTY_ARTICLE" ? 422 : 400 });
      }
      const hasBody = parsed.document.blocks.some((b) => b.type !== "heading");
      if (parsed.document.blocks.length === 0 || !hasBody) {
        throw Object.assign(new Error("未能提取任何正文段落。"), {
          statusCode: 422,
          code: "EMPTY_ARTICLE",
        });
      }

      // Pin the new version to the next integer; transaction so the
      // `isCurrent` flip is atomic. Slice 1 always wrote version=1; a
      // refresh writes version=2, then 3, etc. Old notes that pinned
      // to version=N keep reading that version.
      //
      // `reserveNextVersion` takes a row lock on the article first, so
      // two concurrent refreshes serialise instead of both computing
      // version 2 and one hitting the unique index.
      const result = await prisma.$transaction(async (tx) => {
        const nextVersion = await reserveNextVersion(tx, article.id);
        await tx.articleVersion.updateMany({
          where: { articleId: article.id, isCurrent: true },
          data: { isCurrent: false },
        });
        const version = await tx.articleVersion.create({
          data: {
            articleId: article.id,
            version: nextVersion,
            textHash: parsed.document.textHash,
            source: parsed.document.source,
            extractorVersion: parsed.document.extractorVersion,
            isCurrent: true,
            // The refresh request *is* the new source, so the version it
            // produces keeps it. Without this the article would be
            // re-parsable exactly once — the next refresh would find no
            // source to start from, which is the state every pasted article
            // was stuck in before this column existed.
            sourceText: req.body.content,
          },
        });
        if (parsed.document.blocks.length > 0) {
          await tx.paragraph.createMany({
            data: parsed.document.blocks.map((b) => blockToParagraphRow(version.id, b)),
          });
        }
        const retained = await tx.note.count({
          where: { versionId: { in: (await tx.articleVersion.findMany({
            where: { articleId: article.id, isCurrent: false },
            select: { id: true },
          })).map((v) => v.id) } },
        });
        // Update article title / author from the new version so the
        // list endpoint reflects the latest content. The user can
        // override via `title` in the request body.
        await tx.article.update({
          where: { id: article.id },
          data: {
            title: parsed.document.title,
            author: parsed.document.author ?? null,
          },
        });
        return { version, retainedNoteCount: retained };
      });

      const paragraphs = await prisma.paragraph.findMany({
        where: { versionId: result.version.id },
      });
      return {
        article: {
          id: article.id,
          title: parsed.document.title,
          source: article.source,
          sourceUrl: article.sourceUrl,
          importedAt: article.importedAt.toISOString(),
        },
        version: toVersionDetail(result.version, paragraphs),
        retainedNoteCount: result.retainedNoteCount,
      };
    },
  );

  // ── List notes for one version of an article ─────────────────────────
  //
  // `?versionId=` selects the version the caller is actually rendering.
  // Without it a stale tab — one left open across a refresh — could only
  // ever be told about the *current* version's notes, so its own notes
  // were unreachable from any other context even though they were never
  // deleted. With it, "notes for the version I am showing" is a question
  // the server can answer, which is the whole basis of "旧笔记仍能读原版本".
  app.get<{ Params: { id: string }; Querystring: { versionId?: string } }>(
    ROUTES.articleNotes,
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { versionId: { type: "string", minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req): Promise<NoteListResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }

      const requested = req.query.versionId;
      let versionId: string;
      if (requested) {
        // Must belong to *this* article; a version id from another article
        // would otherwise expose another document's notes.
        const version = await prisma.articleVersion.findFirst({
          where: { id: requested, articleId: article.id },
          select: { id: true },
        });
        if (!version) {
          throw Object.assign(new Error("指定的文章版本不存在或不属于该文章。"), {
            statusCode: 422,
            code: "VALIDATION_FAILED",
          });
        }
        versionId = version.id;
      } else {
        const current = await prisma.articleVersion.findFirst({
          where: { articleId: article.id, isCurrent: true },
          select: { id: true },
        });
        if (!current) {
          throw Object.assign(new Error("文章版本数据缺失。"), { statusCode: 500 });
        }
        versionId = current.id;
      }
      const notes = await prisma.note.findMany({
        where: { versionId, ownerUserId: session.user.id },
        orderBy: { createdAt: "asc" },
      });
      // The conversation turns travel with the list.
      //
      // A note is not just its final answer: the original question and
      // every follow-up are separate messages, and a client that receives
      // only the flattened `answer` cannot reconstruct them -- a follow-up
      // would read as part of the first answer, and the next follow-up
      // would be sent without the earlier ones as context. One extra
      // query for the whole page keeps that structure without turning the
      // list into an N+1 per note.
      const messagesByNote: Record<string, NoteMessage[]> = {};
      if (notes.length > 0) {
        const messages = await prisma.message.findMany({
          where: { noteId: { in: notes.map((n) => n.id) } },
          orderBy: [{ noteId: "asc" }, { sequence: "asc" }],
        });
        for (const message of messages) {
          (messagesByNote[message.noteId] ??= []).push(toMessage(message));
        }
      }
      return { versionId, notes: notes.map(toNoteSummary), messagesByNote };
    },
  );

  // ── Create a note on the current version ──────────────────────────────
  app.post<{ Params: { id: string }; Body: NoteCreateRequest }>(
    ROUTES.articleNoteCreate,
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["paragraphIndex", "selectionText", "type", "question"],
          additionalProperties: false,
          properties: {
            paragraphIndex: { type: "integer", minimum: 1 },
            startParagraphIndex: { type: "integer", minimum: 1 },
            startOffset: { type: "integer", minimum: 0 },
            endParagraphIndex: { type: "integer", minimum: 1 },
            endOffset: { type: "integer", minimum: 0 },
            startBlockId: { type: "string", maxLength: 64 },
            endBlockId: { type: "string", maxLength: 64 },
            articleVersionId: { type: "string", minLength: 1, maxLength: 64 },
            clientKey: { type: "string", minLength: 1, maxLength: 128 },
            selectionText: { type: "string", minLength: 1, maxLength: 50_000 },
            type: { type: "string", enum: ["explain", "ask"] },
            question: { type: "string", minLength: 1, maxLength: MAX_NOTE_QUESTION },
            model: { type: "string", maxLength: 256 },
            // Optional. A create without one is accepted and leaves the note
            // on the default blue; an unknown value is refused rather than
            // stored, so the column never holds a colour the client cannot
            // draw.
            color: { type: "string", enum: ["yellow", "green", "blue", "red"] },
          },
        },
      },
    },
    async (req): Promise<NoteCreateResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }

      // Anchor to the version the *caller was reading*, when it names
      // one, rather than to whatever is current right now.
      //
      // The difference is not academic: a page left open across a
      // refresh shows version N while the article's current version is
      // N+1, and the reader's selection offsets were measured against
      // N. Anchoring them to N+1 would attach the note to text it never
      // matched — or, with a validation that happened to pass, to a
      // coincidence. Naming the version is therefore how a stale tab
      // stays honest, and an unnamed version keeps the previous
      // "anchor to current" behaviour for callers that do not track it.
      // Idempotency: a retry carrying a key this article has already
      // used returns the note the first attempt created, together with
      // its seeded question message, so the client can attach the id it
      // lost without creating a second card.
      if (req.body.clientKey) {
        const replay = await prisma.note.findFirst({
          where: { articleId: article.id, clientKey: req.body.clientKey },
        });
        if (replay) {
          const firstMessage = await prisma.message.findFirst({
            where: { noteId: replay.id },
            orderBy: { sequence: "asc" },
          });
          return {
            note: toNoteSummary(replay),
            message: toMessage(
              firstMessage ?? {
                id: "",
                noteId: replay.id,
                role: "user",
                content: replay.question,
                sequence: 1,
                createdAt: replay.createdAt,
              },
            ),
          };
        }
      }

      const requestedVersionId = req.body.articleVersionId;
      let versionId: string;
      if (requestedVersionId) {
        const version = await prisma.articleVersion.findFirst({
          where: { id: requestedVersionId, articleId: article.id },
          select: { id: true },
        });
        if (!version) {
          throw Object.assign(
            new Error("指定的文章版本不存在或不属于该文章。"),
            { statusCode: 422, code: "VALIDATION_FAILED" },
          );
        }
        versionId = version.id;
      } else {
        const current = await prisma.articleVersion.findFirst({
          where: { articleId: article.id, isCurrent: true },
          select: { id: true },
        });
        if (!current) {
          throw Object.assign(new Error("文章版本数据缺失。"), { statusCode: 500 });
        }
        versionId = current.id;
      }

      const startParagraphIndex = req.body.startParagraphIndex ?? req.body.paragraphIndex;
      const endParagraphIndex = req.body.endParagraphIndex ?? startParagraphIndex;
      const startOffset = req.body.startOffset ?? 0;
      const endOffset = req.body.endOffset ?? startOffset + req.body.selectionText.length;
      if (endParagraphIndex < startParagraphIndex || (endParagraphIndex === startParagraphIndex && endOffset <= startOffset)) {
        throw Object.assign(new Error("选区范围无效。"), { statusCode: 422 });
      }

      // Selection validation: the server is the only party that holds
      // the paragraph text, so it is the only place a client-supplied
      // selection can be checked. Everything the check needs is read
      // from the version the note is being anchored to — the client's
      // own copy of the text is never trusted.
      const paragraphs = await prisma.paragraph.findMany({ where: { versionId } });
      const stored = paragraphs.map((p) => ({
        blockIndex: p.blockIndex,
        blockId: p.blockId,
        text: p.text,
      }));

      // Two shapes, two rules (see `lib/selection.ts`):
      //   - the precise one, used whenever the client sends offsets —
      //     the selection must equal the server's reconstruction of
      //     that range, and a supplied block id must match the stored
      //     row so duplicate paragraphs stay distinguishable;
      //   - the legacy containment one, kept for callers that send only
      //     `paragraphIndex` + `selectionText`.
      const preciseRange =
        req.body.startOffset !== undefined ||
        req.body.endOffset !== undefined ||
        req.body.startParagraphIndex !== undefined ||
        req.body.endParagraphIndex !== undefined;

      let selectionText = req.body.selectionText;
      let startBlockId: string;
      let endBlockId: string;

      if (preciseRange) {
        const verdict = validateRangeSelection({
          paragraphs: stored,
          startParagraphIndex,
          startOffset,
          endParagraphIndex,
          endOffset,
          selectionText: req.body.selectionText,
          ...(req.body.startBlockId !== undefined ? { startBlockId: req.body.startBlockId } : {}),
          ...(req.body.endBlockId !== undefined ? { endBlockId: req.body.endBlockId } : {}),
        });
        if (!verdict.ok) {
          throw Object.assign(new Error(verdict.message), {
            statusCode: 422,
            code: "VALIDATION_FAILED",
          });
        }
        startBlockId = verdict.startBlockId;
        endBlockId = verdict.endBlockId;
        // Store the server's reconstruction rather than the client's
        // string. They are equal after normalisation, but persisting
        // the server's copy means a note can never hold text the
        // version does not contain, even if normalisation ever drifts.
        selectionText = verdict.reconstructed;
      } else {
        const paragraph = stored.find((p) => p.blockIndex === startParagraphIndex);
        if (!paragraph) {
          throw Object.assign(
            new Error(`当前版本没有第 ${req.body.paragraphIndex} 段。`),
            { statusCode: 422, code: "VALIDATION_FAILED" },
          );
        }
        const verdict = validateSelection(paragraph.text, req.body.selectionText);
        if (!verdict.ok) {
          // The plan: refuse with a 422 + a message the client can show.
          // The shared code is `VALIDATION_FAILED`; the message names the
          // paragraph so the user can re-select and retry.
          throw Object.assign(
            new Error(
              `选区文本与第 ${req.body.paragraphIndex} 段不匹配，请重新选择。`,
            ),
            { statusCode: 422, code: "VALIDATION_FAILED" },
          );
        }
        startBlockId = req.body.startBlockId ?? paragraph.blockId;
        endBlockId = req.body.endBlockId ?? startBlockId;
        selectionText = verdict.normalizedSelection;
      }

      // The first user message carries the question; the streamed
      // answer is appended later as the first assistant message via
      // `POST /api/notes/:id/messages`.
      const note = await prisma.$transaction(async (tx) => {
        const created = await tx.note.create({
          data: {
            ownerUserId: session.user.id,
            articleId: article.id,
            versionId,
            paragraphIndex: req.body.paragraphIndex,
            startParagraphIndex,
            startOffset,
            endParagraphIndex,
            endOffset,
            startBlockId,
            endBlockId,
            clientKey: req.body.clientKey ?? null,
            type: req.body.type,
            selectionText,
            selectionHash: hashSelection(selectionText),
            question: req.body.question,
            model: req.body.model?.trim() || "mock",
            color: req.body.color ?? null,
            status: "running",
          },
        });
        const message = await tx.message.create({
          data: {
            noteId: created.id,
            role: "user",
            content: req.body.question,
            sequence: 1,
          },
        });
        return { note: created, message };
      });

      return { note: toNoteSummary(note.note), message: toMessage(note.message) };
    },
  );

  // ── Fetch one note + its messages ────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    ROUTES.noteGet,
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>): Promise<NoteDetailResponse> => {
      const session = currentSession(req);
      const note = await loadOwnedNote(prisma, req.params.id, session.user.id);
      if (!note) {
        throw Object.assign(new Error("笔记不存在或不属于当前用户。"), { statusCode: 404 });
      }
      const messages = await prisma.message.findMany({
        where: { noteId: note.id },
        orderBy: { sequence: "asc" },
      });
      return { note: toNoteSummary(note), messages: messages.map(toMessage) };
    },
  );

  // ── Append a message to a note ───────────────────────────────────────
  app.post<{ Params: { id: string }; Body: NoteAppendMessageRequest }>(
    ROUTES.noteMessageCreate,
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["role", "content"],
          additionalProperties: false,
          properties: {
            role: { type: "string", enum: ["user", "assistant"] },
            content: { type: "string", minLength: 1, maxLength: MAX_NOTE_MESSAGE },
            clientKey: { type: "string", minLength: 1, maxLength: 128 },
            status: {
              type: "string",
              enum: ["running", "succeeded", "failed", "cancelled", "interrupted"],
            },
          },
        },
      },
    },
    async (req): Promise<NoteAppendMessageResponse> => {
      const session = currentSession(req);
      const note = await loadOwnedNote(prisma, req.params.id, session.user.id);
      if (!note) {
        throw Object.assign(new Error("笔记不存在或不属于当前用户。"), { statusCode: 404 });
      }

      // Idempotency: a retried append carrying a key this note has
      // already seen returns the message the first attempt wrote, rather
      // than adding a duplicate turn.
      if (req.body.clientKey) {
        const replay = await prisma.message.findFirst({
          where: { noteId: note.id, clientKey: req.body.clientKey },
        });
        if (replay) {
          return { message: toMessage(replay), note: toNoteSummary(note) };
        }
      }

      // The status transition rules are deliberately strict: only an
      // assistant message can mark a note as "succeeded" / "failed" /
      // "cancelled", and only the user can append "user" messages. A
      // user-typed "succeeded" override is a 400.
      if (req.body.status && req.body.status !== "running" && req.body.role !== "assistant") {
        throw Object.assign(
          new Error("只有 assistant 消息可以标记笔记为非 running 状态。"),
          { statusCode: 400 },
        );
      }
      if (
        req.body.status &&
        !["running", "succeeded", "failed", "cancelled", "interrupted"].includes(req.body.status)
      ) {
        throw Object.assign(new Error("无效的笔记状态。"), { statusCode: 400 });
      }

      const result = await prisma.$transaction(async (tx) => {
        const last = await tx.message.findFirst({
          where: { noteId: note.id },
          orderBy: { sequence: "desc" },
        });
        const nextSequence = (last?.sequence ?? 0) + 1;
        const message = await tx.message.create({
          data: {
            noteId: note.id,
            role: req.body.role,
            content: req.body.content,
            sequence: nextSequence,
            clientKey: req.body.clientKey ?? null,
          },
        });
        const isAssistant = req.body.role === "assistant";
        const update: Record<string, unknown> = {};
        if (isAssistant) {
          update["answer"] = req.body.content;
        }
        if (req.body.status) {
          update["status"] = req.body.status;
          if (req.body.status !== "running" && note.completedAt === null) {
            update["completedAt"] = new Date();
          }
          if (req.body.status === "running" && note.completedAt !== null) {
            // A retried run clears the prior completion marker so
            // "in progress" is reflected accurately.
            update["completedAt"] = null;
          }
        }
        const updated = await tx.note.update({
          where: { id: note.id },
          data: update,
        });
        return { message, updated };
      });

      return { message: toMessage(result.message), note: toNoteSummary(result.updated) };
    },
  );

  // ── Set a terminal lifecycle state without appending a message ────────
  //
  // A cancelled or failed run can have produced *no* text: cancel before
  // the first token, or a provider that errors immediately. The message
  // route cannot express that (its `content` is required and non-empty),
  // so without this endpoint the note would stay "running" on the server
  // forever and every other device would keep showing it as in progress.
  //
  // Only terminal states are accepted. "running" is what creating a note
  // already means, and allowing it here would let a client make a finished
  // note look busy again.
  app.post<{ Params: { id: string }; Body: NoteStatusUpdateRequest }>(
    ROUTES.noteStatusUpdate,
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["succeeded", "failed", "cancelled", "interrupted"],
            },
            clientKey: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (req): Promise<NoteDetailResponse> => {
      const session = currentSession(req);
      const note = await loadOwnedNote(prisma, req.params.id, session.user.id);
      if (!note) {
        throw Object.assign(new Error("笔记不存在或不属于当前用户。"), { statusCode: 404 });
      }
      // A note that already reached a terminal state is left alone: the
      // first outcome is the real one, and a late "failed" arriving after a
      // success must not rewrite history.
      if (note.status !== "running") {
        return { note: toNoteSummary(note), messages: [] };
      }
      const updated = await prisma.note.update({
        where: { id: note.id },
        data: { status: req.body.status, completedAt: new Date() },
      });
      return { note: toNoteSummary(updated), messages: [] };
    },
  );

  // ── Delete a note (cascades to messages via FK ON DELETE CASCADE) ─────
  app.delete<{ Params: { id: string } }>(
    ROUTES.noteDelete,
    {
      preHandler: requireSession,
      schema: {
        params: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req): Promise<NoteDeleteResponse> => {
      const session = currentSession(req);
      const note = await loadOwnedNote(prisma, req.params.id, session.user.id);
      if (!note) {
        throw Object.assign(new Error("笔记不存在或不属于当前用户。"), { statusCode: 404 });
      }
      await prisma.note.delete({ where: { id: note.id } });
      return { deletedId: note.id };
    },
  );
}
