// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Highlights — reader-made marks, synced per account.
 *
 * A mark is a range inside one paragraph of one immutable article version:
 * `[startOffset, endOffset)` over the server-stored paragraph text. The server
 * re-derives the marked text and refuses a request whose claimed
 * `selectionText` does not match, exactly the integrity rule the note route
 * applies; `blockId` distinguishes two paragraphs with identical text.
 *
 * Versioning follows notes: a mark stays bound to the version its offsets were
 * measured against. A refresh writes a new version, and `GET` still returns
 * the old marks with their own `versionId` — the client decides that marks
 * from another version are detached rather than re-pointing them at text they
 * were not measured over.
 *
 * All routes are owner-scoped in SQL (`where.ownerUserId`), so a guessed id
 * never leaks. `clientKey` makes a retried create return the row the first
 * attempt wrote instead of painting a second mark.
 */

import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ROUTES,
  type HighlightCreateRequest,
  type HighlightCreateResponse,
  type HighlightDeleteResponse,
  type HighlightListResponse,
  type HighlightRow,
  type HighlightUpdateRequest,
  type HighlightUpdateResponse,
} from "../../../shared/contracts/index.js";
import type { AppPrisma } from "../db.js";
import type { Auth } from "../auth.js";
import { createRequireSession, currentSession } from "../plugins/session.js";
import { normalizeProse } from "../lib/parse/blocks.js";

const MAX_HIGHLIGHT_NOTE = 20_000;
const COLORS = ["yellow", "green", "blue", "red"] as const;
const STYLES = ["watercolor", "line", "curve"] as const;

type HighlightDbRow = {
  id: string;
  articleId: string;
  versionId: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  blockId: string;
  selectionText: string;
  color: string;
  style: string;
  note: string;
  detached: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function selectionHash(text: string): string {
  return createHash("sha256").update(normalizeProse(text), "utf8").digest("hex");
}

function toHighlight(row: HighlightDbRow): HighlightRow {
  return {
    id: row.id,
    articleId: row.articleId,
    versionId: row.versionId,
    paragraphIndex: row.paragraphIndex,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    blockId: row.blockId,
    selectionText: row.selectionText,
    // The columns are free text in the database and unions on the wire; an
    // unknown value (hand-edited storage) falls back to the default look
    // rather than putting a value in a typed field the client cannot render.
    color: (COLORS.find((c) => c === row.color) ?? "yellow"),
    style: (STYLES.find((s) => s === row.style) ?? "watercolor"),
    note: row.note,
    detached: row.detached,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerHighlightRoutes(
  app: FastifyInstance,
  prisma: AppPrisma,
  auth: Auth,
): void {
  const requireSession = createRequireSession(auth);

  const idParams = {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "string", minLength: 1 } },
  } as const;

  // ── List ──────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    ROUTES.articleHighlights,
    { preHandler: requireSession, schema: { params: idParams } },
    async (req): Promise<HighlightListResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
        select: { id: true },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      const current = await prisma.articleVersion.findFirst({
        where: { articleId: article.id, isCurrent: true },
        select: { id: true },
      });
      const rows = await prisma.highlight.findMany({
        where: { articleId: article.id, ownerUserId: session.user.id, deletedAt: null },
        orderBy: [{ paragraphIndex: "asc" }, { startOffset: "asc" }],
      });
      return {
        versionId: current?.id ?? "",
        highlights: rows.map(toHighlight),
      };
    },
  );

  // ── Create ────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: HighlightCreateRequest }>(
    ROUTES.articleHighlightCreate,
    {
      preHandler: requireSession,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["paragraphIndex", "startOffset", "endOffset", "selectionText", "color"],
          additionalProperties: false,
          properties: {
            paragraphIndex: { type: "integer", minimum: 1 },
            startOffset: { type: "integer", minimum: 0 },
            endOffset: { type: "integer", minimum: 0 },
            blockId: { type: "string", maxLength: 128 },
            articleVersionId: { type: "string", maxLength: 64 },
            clientKey: { type: "string", minLength: 1, maxLength: 160 },
            selectionText: { type: "string", minLength: 1, maxLength: 4_000 },
            color: { type: "string", enum: [...COLORS] },
            style: { type: "string", enum: [...STYLES] },
            note: { type: "string", maxLength: MAX_HIGHLIGHT_NOTE },
          },
        },
      },
    },
    async (req): Promise<HighlightCreateResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
        select: { id: true },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }

      // Idempotency first: a retry must return the first row even if the
      // paragraph has since changed (an edit would otherwise turn the retry
      // into a validation failure the client cannot recover from).
      if (req.body.clientKey) {
        const existing = await prisma.highlight.findFirst({
          where: {
            articleId: article.id,
            ownerUserId: session.user.id,
            clientKey: req.body.clientKey,
          },
        });
        if (existing) return { highlight: toHighlight(existing) };
      }

      const version = req.body.articleVersionId
        ? await prisma.articleVersion.findFirst({
            where: { id: req.body.articleVersionId, articleId: article.id },
            select: { id: true },
          })
        : await prisma.articleVersion.findFirst({
            where: { articleId: article.id, isCurrent: true },
            select: { id: true },
          });
      if (!version) {
        throw Object.assign(new Error("文章版本不存在。"), { statusCode: 422 });
      }

      const paragraph = await prisma.paragraph.findFirst({
        where: { versionId: version.id, blockIndex: req.body.paragraphIndex },
        select: { text: true, blockId: true },
      });
      if (!paragraph) {
        throw Object.assign(new Error("该段落不在当前版本中。"), { statusCode: 422 });
      }
      if (req.body.blockId && paragraph.blockId && req.body.blockId !== paragraph.blockId) {
        throw Object.assign(new Error("选区锚点与当前版本不符。"), { statusCode: 422 });
      }
      const { startOffset, endOffset } = req.body;
      if (endOffset <= startOffset || endOffset > paragraph.text.length) {
        throw Object.assign(new Error("选区范围无效。"), { statusCode: 422 });
      }
      const reconstructed = normalizeProse(paragraph.text.slice(startOffset, endOffset));
      if (reconstructed.length === 0 || reconstructed !== normalizeProse(req.body.selectionText)) {
        throw Object.assign(new Error("选区文本与当前版本不符，请重新选择。"), {
          statusCode: 422,
        });
      }

      const created = await prisma.highlight.create({
        data: {
          ownerUserId: session.user.id,
          articleId: article.id,
          versionId: version.id,
          paragraphIndex: req.body.paragraphIndex,
          startOffset,
          endOffset,
          blockId: paragraph.blockId,
          selectionText: reconstructed,
          selectionHash: selectionHash(reconstructed),
          color: req.body.color,
          style: req.body.style ?? "watercolor",
          note: req.body.note ?? "",
          clientKey: req.body.clientKey ?? null,
        },
      });
      return { highlight: toHighlight(created) };
    },
  );

  // ── Update ────────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string }; Body: HighlightUpdateRequest }>(
    ROUTES.highlightUpdate,
    {
      preHandler: requireSession,
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            color: { type: "string", enum: [...COLORS] },
            style: { type: "string", enum: [...STYLES] },
            note: { type: "string", maxLength: MAX_HIGHLIGHT_NOTE },
            detached: { type: "boolean" },
          },
        },
      },
    },
    async (req): Promise<HighlightUpdateResponse> => {
      const session = currentSession(req);
      const existing = await prisma.highlight.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!existing) {
        throw Object.assign(new Error("划线不存在。"), { statusCode: 404 });
      }
      const data: {
        color?: string;
        style?: string;
        note?: string;
        detached?: boolean;
      } = {};
      if (req.body.color !== undefined) data.color = req.body.color;
      if (req.body.style !== undefined) data.style = req.body.style;
      if (req.body.note !== undefined) data.note = req.body.note;
      if (req.body.detached !== undefined) data.detached = req.body.detached;
      if (Object.keys(data).length === 0) {
        return { highlight: toHighlight(existing) };
      }
      const updated = await prisma.highlight.update({
        where: { id: existing.id },
        data,
      });
      return { highlight: toHighlight(updated) };
    },
  );

  // ── Delete ────────────────────────────────────────────────────────────
  //
  // Hard delete: a mark has no children and the client removes its local copy
  // in the same gesture, so a tombstone would only be a row nothing reads.
  // Pulls filter `deletedAt IS NULL` regardless, so a soft-deleted row from a
  // future cleanup would still be invisible.
  app.delete<{ Params: { id: string } }>(
    ROUTES.highlightDelete,
    { preHandler: requireSession, schema: { params: idParams } },
    async (req): Promise<HighlightDeleteResponse> => {
      const session = currentSession(req);
      const deleted = await prisma.highlight.deleteMany({
        where: { id: req.params.id, ownerUserId: session.user.id },
      });
      if (deleted.count === 0) {
        throw Object.assign(new Error("划线不存在。"), { statusCode: 404 });
      }
      return { deletedId: req.params.id };
    },
  );
}
