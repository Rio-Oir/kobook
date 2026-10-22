// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * User-owned article library — phase 3 slices 1 + 2.
 *
 * Five endpoints, all behind `createRequireSession`. The SQL `WHERE
 * ownerUserId = $1` filter is the cross-user gate, not the URL shape: a
 * guessed article id can never leak across accounts because the route
 * looks the row up by `(id, ownerUserId)` and a miss is indistinguishable
 * from "does not exist" (404 `NOT_FOUND`).
 *
 * The import endpoint accepts three kinds:
 *   - `text` — pasted Markdown, parsed by remark.
 *   - `html` — pasted raw HTML, parsed by Readability + the DOM walker.
 *   - `url`  — a public URL; the SSRF guard, the Jina primary, and
 *     the Readability fallback live in `lib/url-import.ts` /
 *     `lib/ssrf-guard.ts`. The URL body is the *only* place the
 *     server fetches attacker-influenced input.
 *
 * Soft delete means an attacker who learns a deleted id still gets 404,
 * because list / detail / export all filter `deletedAt IS NULL`. The
 * physical cleanup is the account-deletion path (phase 6).
 */

import type { FastifyInstance } from "fastify";
import {
  ROUTES,
  buildApiError,
  type ArticleDeleteResponse,
  type ArticleDetailResponse,
  type ArticleExportResponse,
  type ArticleImportKind,
  type ArticleImportRequest,
  type ArticleImportResponse,
  type ArticleListResponse,
  type ArticleSummary,
  type ArticleBriefRequest,
  type ArticleBriefResponse,
  type ArticleMetaRequest,
  type ArticleMetaResponse,
  type ArticleTagsRequest,
  type ArticleTagsResponse,
  type ArticleSyncRequest,
  type ArticleSyncResponse,
  type ArticleSyncSource,
  type ArticleVersionCreateRequest,
  type ArticleVersionCreateResponse,
  type ArticleVersionDetail,
  type ContentBlock,
  type ContentBlockType,
  type InlineMarkKind,
  type InlineSpan,
  type ParsedDocument,
} from "../../../shared/contracts/index.js";
import type { AppPrisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import type { Auth } from "../auth.js";
import { createRequireSession, currentSession } from "../plugins/session.js";
import { parseContent, type ParseKind } from "../lib/parse/index.js";
import { documentTextHash, EXTRACTOR_VERSION, sha256Hex } from "../lib/parse/blocks.js";
import { spansAreSound } from "../lib/parse/inline.js";
import {
  ContentUnavailableError,
  UpstreamChallengeError,
  importFromUrl,
} from "../lib/url-import.js";
import { SsrfBlockedError, SsrfTimeoutError } from "../lib/ssrf-guard.js";
import { reserveNextVersion } from "../lib/versioning.js";

const PAGE_SIZE = 50;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * Request-body ceiling for `POST /api/articles/sync`.
 *
 * Stated on the route rather than inherited from the global `bodyLimit`, which
 * is sized for the paste box (`MAX_PARSE_INPUT_BYTES` + 1 MiB). A synced
 * document is not the same thing: it arrives as `ContentBlock[]` JSON — the
 * text plus per-block overhead and any inline spans — and it comes from the
 * browser's own extractor, which is allowed to hold a larger document than a
 * textarea accepts. Inheriting the parse route's number would have made the
 * sync route's capacity an accident of an unrelated constant, and the failure
 * would be a 413 the user cannot act on.
 */
const MAX_SYNC_BYTES = 16 * 1024 * 1024;

/** Block ceiling for one synced document. 40k blocks is far past any book. */
const MAX_SYNC_BLOCKS = 40_000;

/** The closed set `ArticleSyncSource` names, for the JSON schema. */
const SYNC_SOURCES: readonly ArticleSyncSource[] = [
  "browser-jina",
  "server-jina",
  "server-readability",
  "local",
];

/** The closed set `ContentBlockType` names, for the JSON schema. */
const BLOCK_TYPES: readonly ContentBlockType[] = [
  "heading",
  "paragraph",
  "listItem",
  "code",
  "quote",
  "image",
  "table",
  "hr",
];

/** The closed set `InlineMarkKind` names, for the JSON schema. */
const INLINE_MARK_KINDS: readonly InlineMarkKind[] = ["strong", "em", "code", "del", "link"];

/**
 * The body schema of `POST /api/articles/sync`.
 *
 * Exported, and defined away from the route, for one reason: it is the only
 * part of the sync path that can be exercised without a database, and it is
 * worth exercising. `additionalProperties: false` is a claim about what a
 * client *cannot* send, and `tests/unit/route-body-strictness.test.ts` records
 * that such a claim is only true when the application's AJV configuration says
 * so — Fastify's default strips an unknown key instead of rejecting it. A test
 * that imported a *copy* of this object would prove nothing about the route;
 * a test that imports this one drives the real thing.
 */
export const ARTICLE_SYNC_BODY_SCHEMA = {
  type: "object",
  required: ["title", "sourceUrl", "source", "author", "textHash", "blocks", "clientKey"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 512 },
    // Null for a paste; http(s) for anything fetched. The pattern is the same
    // invariant `ssrf-guard` enforces on the server-side fetch path, applied
    // here so the column cannot hold an arbitrary scheme from a client that
    // fetched the page itself.
    sourceUrl: {
      type: ["string", "null"],
      maxLength: 2048,
      pattern: "^https?://",
    },
    source: { type: "string", enum: [...SYNC_SOURCES] },
    author: { type: ["string", "null"], maxLength: 512 },
    // `sha256Hex` is 64 lowercase hex characters on both sides; the bound is
    // loose enough to survive a future digest change and tight enough that the
    // column cannot be filled with a document.
    textHash: { type: "string", minLength: 8, maxLength: 128, pattern: "^[0-9a-f]+$" },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: MAX_SYNC_BLOCKS,
      items: {
        type: "object",
        required: ["id", "index", "type", "text", "hash"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          index: { type: "integer", minimum: 1 },
          type: { type: "string", enum: [...BLOCK_TYPES] },
          text: { type: "string", minLength: 1 },
          hash: { type: "string", minLength: 8, maxLength: 128, pattern: "^[0-9a-f]+$" },
          level: { type: "integer", minimum: 1, maximum: 6 },
          lang: { type: ["string", "null"], maxLength: 64 },
          ordered: { type: "boolean" },
          // List-only fields: 0-based nesting depth and task state.
          depth: { type: "integer", minimum: 0, maximum: 100 },
          task: { type: "boolean" },
          checked: { type: "boolean" },
          // Image-only fields. `src` is the only one the renderer needs; the
          // route refuses a non-http(s) value so a stored `javascript:` URL can
          // never become an executable image source.
          src: { type: "string", minLength: 1, maxLength: 4096 },
          alt: { type: "string", maxLength: 4096 },
          title: { type: "string", maxLength: 4096 },
          // Table-only field: row-major plain cell text, first row is the
          // header. `text` remains the flat join the hash is computed over.
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 512,
            items: {
              type: "array",
              maxItems: 64,
              items: { type: "string", maxLength: 4096 },
            },
          },
          spans: {
            type: "array",
            maxItems: 4096,
            items: {
              type: "object",
              required: ["start", "end", "kinds"],
              additionalProperties: false,
              properties: {
                start: { type: "integer", minimum: 0 },
                end: { type: "integer", minimum: 0 },
                kinds: {
                  type: "array",
                  minItems: 1,
                  maxItems: INLINE_MARK_KINDS.length,
                  items: { type: "string", enum: [...INLINE_MARK_KINDS] },
                },
                href: { type: "string", maxLength: 2048 },
              },
            },
          },
        },
      },
    },
    // `deriveIdempotencyKey` produces 32 hex characters. The length is capped
    // rather than merely bounded because the column's uniqueness is per owner
    // and an unbounded key would let one account grow it without limit.
    clientKey: { type: "string", minLength: 1, maxLength: 32 },
    // Account metadata the client already has. Both optional: a client that
    // predates them sends nothing, and the row keeps nulls (the default cover
    // library applies, and the published date is simply unknown).
    coverImage: { type: ["string", "null"], maxLength: 2048, pattern: "^(https?://|/)" },
    publishedAt: { type: ["string", "null"], maxLength: 64 },
  },
} as const;

/**
 * The body schema of `POST /api/articles/:id/versions`.
 *
 * Reuses the sync route's block schema by reference rather than copying it:
 * a field added to the sync wire must not be silently accepted by this route
 * in one build and rejected in the next. `baseVersionId` is optional because a
 * local-only article may be edited before its first upload; when present it is
 * the optimistic-concurrency token.
 */
export const ARTICLE_VERSION_BODY_SCHEMA = {
  type: "object",
  required: ["blocks", "textHash"],
  additionalProperties: false,
  properties: {
    blocks: ARTICLE_SYNC_BODY_SCHEMA.properties.blocks,
    textHash: ARTICLE_SYNC_BODY_SCHEMA.properties.textHash,
    baseVersionId: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

/** Opaque cursor: base64url of the last id. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
export function decodeCursor(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function toSummary(row: {
  id: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  importedAt: Date;
  /** Account metadata; optional so hand-built fixtures do not have to carry it. */
  coverImage?: string | null;
  publishedAt?: string | null;
  tags?: string[];
}): ArticleSummary {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    sourceUrl: row.sourceUrl,
    importedAt: row.importedAt.toISOString(),
    coverImage: row.coverImage ?? null,
    publishedAt: row.publishedAt ?? null,
    tags: row.tags ?? [],
  };
}

function paragraphToBlock(row: {
  blockIndex: number;
  blockId: string;
  type: string;
  text: string;
  hash: string;
  level: number | null;
  lang: string | null;
  ordered: boolean | null;
  depth?: number | null;
  task?: boolean | null;
  checked?: boolean | null;
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  rows?: unknown;
  spans: unknown;
}): ContentBlock {
  const block: ContentBlock = {
    // The stored id is authoritative. It is recomputed only for rows
    // written before the column was populated (empty string), which
    // keeps a pre-migration row readable without inventing a new
    // scheme for it.
    id: row.blockId || `b${row.blockIndex}-${row.hash.slice(0, 8)}`,
    index: row.blockIndex,
    type: row.type as ContentBlock["type"],
    text: row.text,
    hash: row.hash,
  };
  if (row.type === "heading") block.level = row.level ?? 1;
  if (row.type === "code") block.lang = row.lang ?? null;
  if (row.type === "listItem") {
    block.ordered = row.ordered ?? false;
    block.depth = row.depth ?? 0;
    if (row.task) {
      block.task = true;
      block.checked = row.checked ?? false;
    }
  }
  if (row.type === "image" && row.src) {
    block.src = row.src;
    if (row.alt) block.alt = row.alt;
    if (row.title) block.title = row.title;
  }
  // `rows` is a JSON column, so it is re-shaped on the way out for the same
  // reason `spans` is: a hand-run UPDATE or an older build may have put
  // anything there, and the renderer indexes it directly.
  if (row.type === "table" && Array.isArray(row.rows)) {
    const rows = row.rows
      .filter((cells): cells is unknown[] => Array.isArray(cells))
      .map((cells) => cells.map((cell) => (typeof cell === "string" ? cell : "")));
    if (rows.length > 0) block.rows = rows;
  }
  // Re-checked on the way out rather than trusted on the way in. The column
  // is `Json`, so the database will happily return whatever a future build —
  // or a hand-run UPDATE — put there, and the offsets are what the client
  // slices paragraph text with. Emphasis that does not line up with the
  // stored text is dropped here so the wire never carries a span that would
  // land every highlight in the block on the wrong characters.
  if (Array.isArray(row.spans) && row.spans.length > 0) {
    const spans = row.spans as InlineSpan[];
    if (spansAreSound(spans, row.text.length)) block.spans = spans;
  }
  return block;
}

/**
 * The single place a `ContentBlock` is turned into a `paragraph` row.
 * The three import paths (text, URL, refresh) all go through here so
 * `blockId` cannot be forgotten on one of them — which is exactly the
 * drift that made the cross-segment anchor unreliable.
 */
/**
 * The `paragraph.spans` column value for a block.
 *
 * `undefined` rather than `null` for a block with no emphasis: for a nullable
 * column Prisma reads `undefined` as "not provided" and stores SQL NULL, which
 * is the same absence an unemphasised block should have.
 *
 * The cast is needed because Prisma's JSON input type is an index-signature
 * shape and `InlineSpan` is an interface — identical on the wire, but
 * TypeScript will not accept the latter where the former is required. Confining
 * it to one function keeps the boundary crossing in a single explained place
 * instead of sprinkled across every write path.
 */
function spansColumn(spans: ContentBlock["spans"]): Prisma.InputJsonValue | undefined {
  return spans && spans.length > 0 ? (spans as unknown as Prisma.InputJsonValue) : undefined;
}

/** The `paragraph.rows` column value for a table block. */
function rowsColumn(rows: ContentBlock["rows"]): Prisma.InputJsonValue | undefined {
  return rows && rows.length > 0 ? (rows as unknown as Prisma.InputJsonValue) : undefined;
}

function blockToParagraphRow(versionId: string, b: ContentBlock) {
  return {
    versionId,
    blockIndex: b.index,
    blockId: b.id,
    type: b.type,
    text: b.text,
    hash: b.hash,
    level: b.type === "heading" ? b.level ?? 1 : null,
    lang: b.type === "code" ? b.lang ?? null : null,
    ordered: b.type === "listItem" ? b.ordered ?? false : null,
    depth: b.type === "listItem" ? b.depth ?? 0 : null,
    task: b.type === "listItem" && b.task ? true : null,
    checked: b.type === "listItem" && b.task ? b.checked ?? false : null,
    src: b.type === "image" ? b.src ?? null : null,
    alt: b.type === "image" ? b.alt ?? null : null,
    title: b.type === "image" ? b.title ?? null : null,
    rows: b.type === "table" ? rowsColumn(b.rows) : undefined,
    spans: spansColumn(b.spans),
  };
}

/** Exported so `routes/notes.ts` writes paragraphs the same way. */
export { blockToParagraphRow };

/**
 * Validate the blocks a client says it parsed, and normalise what is stored.
 *
 * This is the only place untrusted `ContentBlock[]` enters the database. The
 * import routes never needed it because their blocks come from this server's
 * own parse layer; the sync route's come from the browser, so every field that
 * is load-bearing downstream is re-derived or re-checked here.
 *
 *  - **`hash` is re-derived from `text`, not trusted.** `hash` is what
 *    `documentTextHash` is computed over and what the client uses to decide
 *    whether two versions of an article are the same, so a stored hash that
 *    does not describe its own text would poison both. The client's
 *    `local-import-blocks.ts` hashes the same normalised string with the same
 *    SHA-256, so an honest payload is unaffected.
 *  - **`index` must be strictly ascending from 1.** `paragraph` carries a
 *    `(versionId, blockIndex)` unique index, so a duplicate is a Prisma
 *    constraint violation surfacing as a 500 rather than as something the
 *    client can act on. Ascending order is also required for the digest to
 *    mean anything: `documentTextHash` joins the hashes in array order, so
 *    accepting a shuffled array would let a caller produce the client's digest
 *    from a differently-ordered document.
 *  - **Unsound `spans` are dropped, not rejected.** Same rule the read path
 *    (`paragraphToBlock`) and the collector already apply, and for the same
 *    reason: losing some bold text is cosmetic, whereas an offset past the end
 *    of the paragraph would land every highlight in that block on the wrong
 *    characters.
 *
 * `id` is carried through **verbatim** rather than recomputed from
 * `b${index}-${hash.slice(0, 8)}`. The client already used this id to anchor
 * the notes it made before the upload, and the notes route matches a note's
 * `blockId` against the stored row — so rewriting it here would re-point every
 * anchor the user already has. Storing the client's id is what keeps the
 * anchor stable across the upload.
 */
function sanitizeSyncedBlocks(raw: readonly ContentBlock[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const block of raw) {
    const expectedIndex = blocks.length + 1;
    if (block.index !== expectedIndex) {
      throw Object.assign(
        new Error(`段落序号必须从 1 连续递增：第 ${expectedIndex} 段收到的是 ${block.index}。`),
        { statusCode: 422 },
      );
    }
    if (sha256Hex(block.text) !== block.hash) {
      throw Object.assign(new Error(`第 ${block.index} 段的 hash 与正文不符。`), {
        statusCode: 422,
      });
    }
    const clean: ContentBlock = {
      id: block.id,
      index: block.index,
      type: block.type,
      text: block.text,
      hash: block.hash,
    };
    // Re-shaped exactly as `BlockCollector.add` does, so a block written by the
    // sync path and one written by the import path are indistinguishable in the
    // database. A field left off by the client becomes the same null/absent
    // value the collector would have produced.
    if (block.type === "heading") clean.level = block.level ?? 1;
    if (block.type === "code") clean.lang = block.lang ?? null;
    if (block.type === "listItem") {
      clean.ordered = block.ordered ?? false;
      clean.depth = block.depth ?? 0;
      if (block.task) {
        clean.task = true;
        clean.checked = block.checked ?? false;
      }
    }
    if (block.type === "image") {
      const src = block.src ?? "";
      if (!/^(https?:\/\/|\/)/i.test(src)) {
        throw Object.assign(new Error(`第 ${block.index} 段的图片地址不受支持。`), {
          statusCode: 422,
        });
      }
      clean.src = src;
      if (block.alt) clean.alt = block.alt;
      if (block.title) clean.title = block.title;
    }
    if (block.type === "table") {
      const rows = Array.isArray(block.rows)
        ? block.rows
            .filter((cells): cells is string[] => Array.isArray(cells))
            .map((cells) => cells.map((cell) => (typeof cell === "string" ? cell : String(cell ?? ""))))
        : [];
      if (rows.length === 0) {
        throw Object.assign(new Error(`第 ${block.index} 段的表格没有内容。`), {
          statusCode: 422,
        });
      }
      clean.rows = rows;
    }
    if (Array.isArray(block.spans) && block.spans.length > 0) {
      const spans = block.spans as InlineSpan[];
      if (spansAreSound(spans, block.text.length)) clean.spans = spans;
    }
    blocks.push(clean);
  }
  return blocks;
}

/** The columns the sync route's idempotency check compares. */
interface ClientKeyArticle {
  id: string;
  title: string;
  author: string | null;
  sourceUrl: string | null;
  deletedAt: Date | null;
}

/**
 * The article a `clientKey` already produced for this owner, if any.
 *
 * Scoped to `ownerUserId` so a guessed key cannot reach another account's row —
 * the same cross-user gate every other route in this file uses. Deliberately
 * *not* scoped to `deletedAt: null`; see the call site for why.
 */
function findArticleByClientKey(
  prisma: AppPrisma,
  ownerUserId: string,
  clientKey: string,
): Promise<ClientKeyArticle | null> {
  return prisma.article.findFirst({
    where: { ownerUserId, clientKey },
    select: { id: true, title: true, author: true, sourceUrl: true, deletedAt: true },
  });
}

/**
 * Prisma's unique-constraint violation.
 *
 * Checked structurally rather than with `instanceof Prisma.PrismaClientKnownRequestError`
 * because the generated client is a build artifact that can be regenerated at a
 * different version than the one this file was written against, and a failed
 * `instanceof` would silently turn a handled race back into a 500. The same
 * structural check is what tells a unique-index race apart from a real failure
 * anywhere else it comes up.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * The sync route's 409: this `clientKey` already names a different document.
 *
 * A client bug rather than a successful retry — `deriveIdempotencyKey` hashes
 * the payload into the key, so the same key with different content cannot come
 * from a correct caller. Reported instead of absorbed because answering with
 * the first article would discard the second document without telling anyone.
 */
function clientKeyConflict(): Error {
  return Object.assign(new Error("这个 clientKey 已经用于上传另一篇文章。"), {
    statusCode: 409,
    code: "CONFLICT",
  });
}

export function toVersionDetail(
  version: {
    id: string;
    articleId: string;
    version: number;
    source: string;
    importedAt: Date;
  },
  paragraphs: Parameters<typeof paragraphToBlock>[0][],
): ArticleVersionDetail {
  return {
    id: version.id,
    articleId: version.articleId,
    version: version.version,
    source: version.source,
    importedAt: version.importedAt.toISOString(),
    paragraphs: paragraphs
      .slice()
      .sort((a, b) => a.blockIndex - b.blockIndex)
      .map(paragraphToBlock),
  };
}

/**
 * The document fields `persistDocument` reads.
 *
 * Structural rather than `ParsedDocument` because one of the four write paths
 * stores a document this server never parsed: `POST /api/articles/sync` takes
 * blocks the *browser's* extractor produced, and the channel they arrived
 * through (`"browser-jina"`, `"local"`, …) is what belongs in
 * `ArticleVersion.source`. That set is deliberately not `ExtractorId` — it
 * says how the text reached us, not which of our parsers made it. Every
 * `ParsedDocument` satisfies this shape, so the three import paths are
 * untouched and there is still exactly one place that turns a document into
 * rows.
 */
interface PersistableDocument {
  title: string;
  author?: string | null;
  blocks: ContentBlock[];
  source: string;
  extractorVersion: string;
  textHash: string;
}

export function registerArticleRoutes(
  app: FastifyInstance,
  prisma: AppPrisma,
  auth: Auth,
): void {
  const requireSession = createRequireSession(auth);

  /**
   * Persist a parsed document as a fresh article + initial version +
   * paragraphs. Used by all three import kinds; the only thing that
   * differs between them is how the `document` was produced.
   *
   * The `source` column records which extractor produced the
   * document, so future migrations can re-parse a row whose
   * `extractorVersion` no longer matches the running parser.
   */
  async function persistDocument(
    session: { user: { id: string } },
    document: PersistableDocument,
    source: "text" | "url",
    sourceUrl: string | null,
    clientKey?: string,
    sourceText?: string,
    /** Account metadata that arrived with the document, when it did. */
    metadata?: { coverImage?: string | null; publishedAt?: string | null },
  ): Promise<{ article: ReturnType<typeof toSummary>; version: ArticleVersionDetail }> {
    const result = await prisma.$transaction(async (tx) => {
      const article = await tx.article.create({
        data: {
          ownerUserId: session.user.id,
          source,
          sourceUrl,
          title: document.title,
          author: document.author ?? null,
          clientKey: clientKey ?? null,
          coverImage: metadata?.coverImage ?? null,
          publishedAt: metadata?.publishedAt ?? null,
        },
      });
      const version = await tx.articleVersion.create({
        data: {
          articleId: article.id,
          version: 1,
          textHash: document.textHash,
          source: document.source,
          extractorVersion: document.extractorVersion,
          isCurrent: true,
          // Kept only for pasted input, where it is the one copy that exists.
          // See `ArticleVersion.sourceText`.
          sourceText: sourceText ?? null,
        },
      });
      if (document.blocks.length > 0) {
        await tx.paragraph.createMany({
          data: document.blocks.map((b) => blockToParagraphRow(version.id, b)),
        });
      }
      return { article, version };
    });

    // Re-read paragraphs so the response carries the same shape the
    // detail / export routes return. The in-memory `document.blocks`
    // would also work, but routing through the DB makes the round-trip
    // identical regardless of which import kind ran.
    const paragraphs = await prisma.paragraph.findMany({
      where: { versionId: result.version.id },
    });
    return {
      article: toSummary(result.article),
      version: toVersionDetail(result.version, paragraphs),
    };
  }

  // ── Import ────────────────────────────────────────────────────────────
  app.post<{ Body: ArticleImportRequest }>(
    ROUTES.articleImport,
    {
      preHandler: requireSession,
      schema: {
        body: {
          type: "object",
          required: ["kind", "content"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["text", "html", "url"] },
            content: { type: "string", minLength: 1, maxLength: MAX_IMPORT_BYTES },
            title: { type: "string", maxLength: 512 },
            // Explicit "重新抓取" opt-in for URL imports. Absent /
            // false means "return my existing article for this URL".
            reimport: { type: "boolean" },
            clientKey: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (req): Promise<ArticleImportResponse> => {
      const session = currentSession(req);

      // Idempotency: a retry carrying a key this account has already
      // used gets the article the first attempt created. Checked before
      // any fetch or parse so a retry is cheap as well as correct, and
      // scoped to the caller's own rows so a guessed key cannot reach
      // another account.
      if (req.body.clientKey) {
        const replay = await prisma.article.findFirst({
          where: {
            ownerUserId: session.user.id,
            clientKey: req.body.clientKey,
            deletedAt: null,
          },
        });
        if (replay) {
          const version = await prisma.articleVersion.findFirst({
            where: { articleId: replay.id, isCurrent: true },
          });
          if (version) {
            const paragraphs = await prisma.paragraph.findMany({
              where: { versionId: version.id },
            });
            return {
              article: toSummary(replay),
              version: toVersionDetail(version, paragraphs),
            };
          }
        }
      }

      if (req.body.kind === "url") {
        return await importUrlKind(session, req.body.content, {
          reimport: req.body.reimport === true,
          ...(req.body.clientKey ? { clientKey: req.body.clientKey } : {}),
        });
      }
      return await importTextKind(
        session,
        req.body.kind,
        req.body.content,
        req.body.title,
        req.body.clientKey,
      );
    },
  );

  // ── Sync (Wire A) ─────────────────────────────────────────────────────
  //
  // Upload an article the browser has already parsed. This is what the
  // dual-channel extractor calls when channel 1 (browser-direct Jina)
  // succeeded: the client holds the `ContentBlock[]` and the `textHash`, so
  // accepting them keeps the wire honest — "browser 直连成功后端 0 请求" only
  // holds if the server does not fetch the URL again.
  //
  // The route is not an alternative spelling of `/api/articles/import`. That
  // one re-parses text or HTML server-side, which means the blocks it stores
  // are whatever *this* build's parser produces — different ids, different
  // `spans`, a different `textHash` from the ones the client is already
  // rendering and anchoring notes against. Uploading the client's own blocks
  // is the whole point: the two sides must not disagree about the document.
  //
  // Everything a client supplies is re-validated here rather than trusted;
  // `sanitizeSyncedBlocks` says which field each check protects.
  app.post<{ Body: ArticleSyncRequest }>(
    ROUTES.articleSync,
    {
      preHandler: requireSession,
      bodyLimit: MAX_SYNC_BYTES,
      schema: { body: ARTICLE_SYNC_BODY_SCHEMA },
    },
    async (req): Promise<ArticleSyncResponse> => {
      const session = currentSession(req);
      const body = req.body;
      // Derived server-side, never taken from the body: the contract has no
      // field for it, and a client that could name its own `source` could
      // label a fetched page as a paste.
      const articleSource: "text" | "url" = body.sourceUrl === null ? "text" : "url";

      // ── Idempotency ─────────────────────────────────────────────────
      // `(ownerUserId, clientKey)` is unique, so a retry that reaches here
      // twice returns the article the first attempt created. The comparison
      // is against the whole request, not just the key: the key is derived
      // from the payload, so the same key with different content is a client
      // bug — answering it with the first article would silently discard the
      // second document, and the client would never learn it had.
      //
      // The lookup deliberately does *not* filter `deletedAt`. The unique
      // index ignores that column, so a soft-deleted row still owns the key —
      // filtering it out here would make "delete the article, then import the
      // same text again" a request that can never succeed, because the key is
      // derived from the text and is therefore identical every time. Such a
      // row is revived instead: the client is uploading a document it
      // currently holds, so the honest reading is that the document exists for
      // this account, and reviving also keeps the notes the user wrote on it
      // before deleting. (The alternative — a permanent 409 — was rejected
      // because it makes a document permanently unsyncable with no way for the
      // user to clear it.)
      const replay = await findArticleByClientKey(prisma, session.user.id, body.clientKey);
      if (replay) {
        const sameBody =
          replay.title === body.title &&
          replay.sourceUrl === body.sourceUrl &&
          (replay.author ?? null) === body.author;
        if (!sameBody) throw clientKeyConflict();
        const version = await prisma.articleVersion.findFirst({
          where: { articleId: replay.id, isCurrent: true },
        });
        if (!version) {
          // The version row is written in the same transaction as the article,
          // so a missing current row is a server-side inconsistency rather than
          // something the client did. Same shape the detail route reports.
          throw Object.assign(new Error("文章版本数据缺失。"), { statusCode: 500 });
        }
        if (version.textHash !== body.textHash) throw clientKeyConflict();
        if (replay.deletedAt !== null) {
          await prisma.article.update({ where: { id: replay.id }, data: { deletedAt: null } });
        }
        return {
          articleId: replay.id,
          versionId: version.id,
          source: replay.sourceUrl === null ? "text" : "url",
        };
      }

      const blocks = sanitizeSyncedBlocks(body.blocks);

      // The check the contract names. Without it `textHash` would be a
      // client-supplied claim, and every future "is this the same document?"
      // comparison — cache invalidation, note re-anchoring, the version list —
      // would be reading an unverified value. Recomputing it from the blocks
      // that are about to be stored is what makes the column a fact.
      if (documentTextHash(blocks) !== body.textHash) {
        throw Object.assign(new Error("textHash 与正文不符。"), { statusCode: 422 });
      }

      // ── 内容相同即同一篇 ───────────────────────────────────────────────
      //
      // `clientKey` only dedupes retries of the *same local record*: two
      // devices that imported the same document derive different keys and
      // would end up with two server articles for one text. The product rule
      // is "same content = same article", so the identity that is actually
      // shared is the document hash — plus `sourceUrl`, because the same
      // words fetched from two different pages are legitimately two entries
      // (the URL is part of what the reader saved).
      //
      // Only the *current* version counts: an article whose body was edited
      // has a different hash now, and the old version's hash must not
      // resurrect it. Matching rows are returned instead of created, so the
      // client binds its local record to the article that already exists and
      // its notes stay attached.
      const sameDocument = await prisma.articleVersion.findFirst({
        where: {
          textHash: body.textHash,
          isCurrent: true,
          article: {
            ownerUserId: session.user.id,
            sourceUrl: body.sourceUrl,
            deletedAt: null,
          },
        },
        orderBy: { importedAt: "asc" },
        select: {
          id: true,
          articleId: true,
          article: { select: { coverImage: true, publishedAt: true } },
        },
      });
      if (sameDocument) {
        // A second device uploading the same text may be the first one to
        // know the page's picture or date. Fill a null rather than leaving
        // the account copy without metadata merely because the first upload
        // came from a client that had none.
        const patch: { coverImage?: string; publishedAt?: string } = {};
        if (body.coverImage && !sameDocument.article.coverImage) {
          patch.coverImage = body.coverImage;
        }
        if (body.publishedAt && !sameDocument.article.publishedAt) {
          patch.publishedAt = body.publishedAt;
        }
        if (Object.keys(patch).length > 0) {
          await prisma.article.update({ where: { id: sameDocument.articleId }, data: patch });
        }
        return {
          articleId: sameDocument.articleId,
          versionId: sameDocument.id,
          source: articleSource,
        };
      }

      const document: PersistableDocument = {
        title: body.title,
        author: body.author,
        blocks,
        // The browser's extractor produced these blocks, so the honest value
        // is the channel they arrived through, not one of this server's own
        // extractor ids. `extractorVersion` is the one field the wire does not
        // carry; the client's pipeline constant is the same string today
        // (`phase1.3` on both sides), and a divergence would need the field
        // added to `ArticleSyncRequest` rather than guessed at here.
        source: body.source,
        extractorVersion: EXTRACTOR_VERSION,
        textHash: body.textHash,
      };

      try {
        const saved = await persistDocument(
          session,
          document,
          articleSource,
          body.sourceUrl,
          body.clientKey,
          undefined,
          {
            coverImage: body.coverImage ?? null,
            publishedAt: body.publishedAt ?? null,
          },
        );
        return {
          articleId: saved.article.id,
          versionId: saved.version.id,
          source: articleSource,
        };
      } catch (err) {
        // Two uploads of the same key can pass the lookup above together —
        // a retry racing the original, or two tabs. The unique index is what
        // actually serialises them, so the loser re-reads the winner's row
        // instead of reporting a 500 the client would treat as a server fault.
        if (!isUniqueViolation(err)) throw err;
        const winner = await findArticleByClientKey(prisma, session.user.id, body.clientKey);
        if (!winner) throw err;
        const version = await prisma.articleVersion.findFirst({
          where: { articleId: winner.id, isCurrent: true },
        });
        if (!version) throw err;
        return {
          articleId: winner.id,
          versionId: version.id,
          source: winner.sourceUrl === null ? "text" : "url",
        };
      }
    },
  );

  // ── Edited version ────────────────────────────────────────────────────
  //
  // Append one immutable version to an existing article. The read path and the
  // notes stay untouched: version N keeps its rows and its notes, and the
  // display switches to N+1. `refresh` and `sync` are the other two writers of
  // a first version; this is the only route that appends to a synced article.
  app.post<{ Params: { id: string }; Body: ArticleVersionCreateRequest }>(
    ROUTES.articleVersions,
    {
      preHandler: requireSession,
      bodyLimit: MAX_SYNC_BYTES,
      schema: { body: ARTICLE_VERSION_BODY_SCHEMA },
    },
    async (req): Promise<ArticleVersionCreateResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在。"), { statusCode: 404 });
      }

      const blocks = sanitizeSyncedBlocks(req.body.blocks);
      if (documentTextHash(blocks) !== req.body.textHash) {
        throw Object.assign(new Error("textHash 与正文不符。"), { statusCode: 422 });
      }

      const version = await prisma.$transaction(async (tx) => {
        // Lock before reading the number: two tabs editing the same article
        // must queue, so the second sees the first's version and can be
        // rejected by its `baseVersionId` instead of silently replacing it.
        const next = await reserveNextVersion(tx, article.id);
        if (req.body.baseVersionId) {
          const current = await tx.articleVersion.findFirst({
            where: { articleId: article.id, isCurrent: true },
            select: { id: true },
          });
          if (!current || current.id !== req.body.baseVersionId) {
            throw Object.assign(
              new Error("云端已有一个更新的版本，请重新打开文章后再编辑。"),
              { statusCode: 409 },
            );
          }
        }
        await tx.articleVersion.updateMany({
          where: { articleId: article.id, isCurrent: true },
          data: { isCurrent: false },
        });
        const created = await tx.articleVersion.create({
          data: {
            articleId: article.id,
            version: next,
            textHash: req.body.textHash,
            // Not one of the extractor ids: no extractor produced this text.
            source: "client-edit",
            extractorVersion: EXTRACTOR_VERSION,
            isCurrent: true,
          },
        });
        if (blocks.length > 0) {
          await tx.paragraph.createMany({
            data: blocks.map((block) => blockToParagraphRow(created.id, block)),
          });
        }
        return created;
      });

      const paragraphs = await prisma.paragraph.findMany({
        where: { versionId: version.id },
      });
      return {
        articleId: article.id,
        version: toVersionDetail(version, paragraphs),
      };
    },
  );

  async function importTextKind(
    session: { user: { id: string } },
    kind: ArticleImportKind,
    content: string,
    title: string | undefined,
    clientKey?: string,
  ): Promise<ArticleImportResponse> {
    // The public API speaks `text` (Markdown) and `html`; the parse
    // layer speaks `markdown` and `html`. Translate at the boundary so
    // the user-facing `text` name stays stable.
    const parseKind: ParseKind =
      kind === "text" ? "markdown" : kind === "html" ? "html" : "markdown";
    const parsed = parseContent(parseKind, content, { title });
    if (!parsed.ok) {
      const code = parsed.code === "EMPTY_CONTENT" ? "EMPTY_ARTICLE" : "VALIDATION_FAILED";
      throw Object.assign(new Error(parsed.message), { statusCode: code === "EMPTY_ARTICLE" ? 422 : 400 });
    }
    // A heading by itself is just a title; an article must carry at
    // least one body block (paragraph / listItem / code / quote) so
    // the Reader has something to display below the heading.
    const hasBody = parsed.document.blocks.some((b) => b.type !== "heading");
    if (parsed.document.blocks.length === 0 || !hasBody) {
      throw Object.assign(new Error("未能提取任何正文段落。"), {
        statusCode: 422,
        code: "EMPTY_ARTICLE",
      });
    }
    return persistDocument(session, parsed.document, "text", null, clientKey, content, {
      coverImage: parsed.document.coverImage ?? null,
    });
  }

  async function importUrlKind(
    session: { user: { id: string } },
    url: string,
    options: { reimport?: boolean; clientKey?: string } = {},
  ): Promise<ArticleImportResponse> {
    // "每个用户拥有独立文章条目；同一 URL 再导入默认返回自己的已有文章。"
    // The default is *return what you already have*, so importing the
    // same link twice does not silently fill the library with
    // duplicates. `reimport: true` is the explicit "重新抓取" opt-in and
    // goes down the normal create-a-new-article path.
    //
    // The lookup is scoped to the caller's own articles, so user A
    // importing a URL that user B already owns still creates A's own
    // row — the dedupe is per-library, not global.
    if (!options.reimport) {
      const existing = await prisma.article.findFirst({
        where: {
          ownerUserId: session.user.id,
          source: "url",
          sourceUrl: url,
          deletedAt: null,
        },
        orderBy: { importedAt: "asc" },
      });
      if (existing) {
        const existingVersion = await prisma.articleVersion.findFirst({
          where: { articleId: existing.id, isCurrent: true },
        });
        if (existingVersion) {
          const paragraphs = await prisma.paragraph.findMany({
            where: { versionId: existingVersion.id },
          });
          return {
            article: toSummary(existing),
            version: toVersionDetail(existingVersion, paragraphs),
          };
        }
        // A row with no current version is a server-side
        // inconsistency; fall through to a fresh import rather than
        // returning a half-shaped response.
      }
    }

    const jinaApiKey = process.env["JINA_API_KEY"]?.trim() || undefined;
    const jinaBaseUrl = process.env["JINA_BASE_URL"]?.trim() || undefined;
    let result;
    try {
      result = await importFromUrl(url, { jinaApiKey, jinaBaseUrl });
    } catch (err: unknown) {
      if (err instanceof ContentUnavailableError) {
        // The page is gone, not the network: 422 keeps it apart from the
        // retryable 502 below, and the message already reads as a full
        // sentence for the user.
        throw Object.assign(new Error(err.message), { statusCode: 422 });
      }
      if (err instanceof UpstreamChallengeError) {
        // Login wall / JS shell / verification endpoint: retryable, and the
        // sentence is the reader's only clue about what to do next.
        throw Object.assign(new Error(err.message), { statusCode: 502 });
      }
      if (err instanceof SsrfBlockedError) {
        // The plan calls for a 422 "we refused this URL" with a
        // Chinese message; the message is the user-readable one from
        // the guard.
        throw Object.assign(new Error(err.message), { statusCode: 422 });
      }
      if (err instanceof SsrfTimeoutError) {
        throw Object.assign(new Error(err.message), { statusCode: 504 });
      }
      // Surface the upstream failure as a 502 so the client can
      // distinguish "we could not reach the source" from "we refused
      // to reach the source".
      throw Object.assign(
        new Error(`URL 抓取失败：${err instanceof Error ? err.message : String(err)}`),
        { statusCode: 502 },
      );
    }
    if (result.document.blocks.length === 0) {
      throw Object.assign(new Error("URL 抓取未提取到任何正文。"), { statusCode: 422 });
    }
    if (options.reimport) {
      return refreshUrlKind(session, url, result.document);
    }
    return persistDocument(session, result.document, "url", url, options.clientKey, undefined, {
      coverImage: result.document.coverImage ?? null,
    });
  }

  /**
   * "重新抓取" against an existing URL article: write a new version on
   * the article that already owns that URL, demoting the current one.
   * Old notes keep the version they were created against, which is the
   * same rule `POST /api/articles/:id/refresh` applies to a text
   * refresh.
   */
  async function refreshUrlKind(
    session: { user: { id: string } },
    url: string,
    document: ParsedDocument,
  ): Promise<ArticleImportResponse> {
    const article = await prisma.article.findFirst({
      where: {
        ownerUserId: session.user.id,
        source: "url",
        sourceUrl: url,
        deletedAt: null,
      },
      orderBy: { importedAt: "asc" },
    });
    if (!article) {
      // No existing row to refresh — treat the opt-in as a first
      // import rather than failing.
      return persistDocument(session, document, "url", url, undefined, undefined, {
        coverImage: document.coverImage ?? null,
      });
    }
    const version = await prisma.$transaction(async (tx) => {
      const nextVersion = await reserveNextVersion(tx, article.id);
      await tx.articleVersion.updateMany({
        where: { articleId: article.id, isCurrent: true },
        data: { isCurrent: false },
      });
      const created = await tx.articleVersion.create({
        data: {
          articleId: article.id,
          version: nextVersion,
          textHash: document.textHash,
          source: document.source,
          extractorVersion: document.extractorVersion,
          isCurrent: true,
        },
      });
      if (document.blocks.length > 0) {
        await tx.paragraph.createMany({
          data: document.blocks.map((b) => blockToParagraphRow(created.id, b)),
        });
      }
      await tx.article.update({
        where: { id: article.id },
        data: {
          title: document.title,
          author: document.author ?? null,
          // A re-fetch that found a picture replaces the old one; a page
          // that declares none keeps whatever the article already had.
          ...(document.coverImage ? { coverImage: document.coverImage } : {}),
        },
      });
      return created;
    });
    const paragraphs = await prisma.paragraph.findMany({
      where: { versionId: version.id },
    });
    return {
      article: toSummary({
        ...article,
        title: document.title,
      }),
      version: toVersionDetail(version, paragraphs),
    };
  }

  // ── List ──────────────────────────────────────────────────────────────
  app.get(
    ROUTES.articleList,
    { preHandler: requireSession },
    async (req): Promise<ArticleListResponse> => {
      const session = currentSession(req);
      const cursor = decodeCursor((req.query as { cursor?: string }).cursor);
      const rows = await prisma.article.findMany({
        where: {
          ownerUserId: session.user.id,
          deletedAt: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: PAGE_SIZE + 1,
      });
      const hasMore = rows.length > PAGE_SIZE;
      const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
      const next = hasMore ? encodeCursor(page[page.length - 1]!.id) : null;
      return { articles: page.map(toSummary), nextCursor: next };
    },
  );

  // ── Detail ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    ROUTES.articleDetail,
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
    async (req): Promise<ArticleDetailResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        // Same shape for "never existed" and "deleted" so a guessed id
        // never confirms the row's existence.
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      const version = await prisma.articleVersion.findFirst({
        where: { articleId: article.id, isCurrent: true },
      });
      if (!version) {
        // The version row is created in the same transaction as the
        // article, so a missing current row is a server-side inconsistency.
        throw Object.assign(new Error("文章版本数据缺失。"), { statusCode: 500 });
      }
      const paragraphs = await prisma.paragraph.findMany({
        where: { versionId: version.id },
      });
      return {
        article: toSummary(article),
        version: toVersionDetail(version, paragraphs),
        // The summary travels only on the detail route: the library lists
        // hundreds of articles and never renders it, so paying a few
        // kilobytes per row there would be pure waste.
        brief: (article.brief as ArticleDetailResponse["brief"]) ?? null,
      };
    },
  );

  // ── Account metadata: tags ────────────────────────────────────────────
  //
  // Whole-list replacement. The tagger produces the complete set in one call
  // and "重新生成" produces another, so a per-tag merge would only invent a
  // second source of truth to reconcile. Bounded and de-duplicated here
  // because the client's 4-tag limit is a product choice, not a wire rule.
  app.put<{ Params: { id: string }; Body: ArticleTagsRequest }>(
    ROUTES.articleTags,
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
          required: ["tags"],
          additionalProperties: false,
          properties: {
            tags: {
              type: "array",
              maxItems: 12,
              items: { type: "string", minLength: 1, maxLength: 32 },
            },
            model: { type: "string", maxLength: 128 },
            at: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req): Promise<ArticleTagsResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      const seen = new Set<string>();
      const tags: string[] = [];
      for (const raw of req.body.tags) {
        const tag = raw.trim();
        if (tag.length === 0 || seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
        if (tags.length >= 8) break;
      }
      const updated = await prisma.article.update({
        where: { id: article.id },
        data: {
          tags,
          tagsModel: req.body.model ?? null,
          tagsAt: new Date(req.body.at ?? Date.now()),
        },
      });
      return { article: toSummary(updated) };
    },
  );

  // ── Account metadata: generated summary ───────────────────────────────
  //
  // The summary is expensive (one model call) and identical for every
  // device, so it belongs to the account rather than to whichever device
  // happened to open the article first. Stored whole as JSON: it is read as
  // one value and never queried by field.
  app.put<{ Params: { id: string }; Body: ArticleBriefRequest }>(
    ROUTES.articleBrief,
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
          required: ["brief"],
          additionalProperties: false,
          properties: {
            brief: {
              type: "object",
              required: ["gist", "claims", "generatedAt"],
              additionalProperties: false,
              properties: {
                gist: { type: "string", maxLength: 8_000 },
                claims: {
                  type: "array",
                  maxItems: 200,
                  items: {
                    type: "object",
                    required: ["text", "paragraphRef"],
                    additionalProperties: false,
                    properties: {
                      text: { type: "string", maxLength: 4_000 },
                      paragraphRef: { type: "string", maxLength: 64 },
                    },
                  },
                },
                generatedAt: { type: "integer", minimum: 0 },
              },
            },
            at: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req): Promise<ArticleBriefResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      const updated = await prisma.article.update({
        where: { id: article.id },
        data: {
          brief: req.body.brief,
          briefAt: new Date(req.body.at ?? Date.now()),
        },
      });
      return { article: toSummary(updated) };
    },
  );

  // ── Account metadata: cover / published date backfill ─────────────────
  //
  // Articles uploaded before these columns existed have nulls on the server
  // even though the device that imported them knows the values. This route is
  // how that device fills them in the next time it opens the article, so a
  // second device sees the real cover instead of the painted default.
  app.put<{ Params: { id: string }; Body: ArticleMetaRequest }>(
    ROUTES.articleMeta,
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
          additionalProperties: false,
          properties: {
            coverImage: { type: ["string", "null"], maxLength: 2048, pattern: "^(https?://|/)" },
            publishedAt: { type: ["string", "null"], maxLength: 64 },
          },
        },
      },
    },
    async (req): Promise<ArticleMetaResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      const data: { coverImage?: string | null; publishedAt?: string | null } = {};
      if ("coverImage" in req.body) data.coverImage = req.body.coverImage ?? null;
      if ("publishedAt" in req.body) data.publishedAt = req.body.publishedAt ?? null;
      if (Object.keys(data).length === 0) {
        return { article: toSummary(article) };
      }
      const updated = await prisma.article.update({ where: { id: article.id }, data });
      return { article: toSummary(updated) };
    },
  );

  // ── Delete (soft) ─────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    ROUTES.articleDelete,
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
    async (req): Promise<ArticleDeleteResponse> => {
      const session = currentSession(req);
      // findFirst is required so a non-owned id never becomes a 200 with
      // `count: 0`; we want the same 404 a missing row produces.
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      const now = new Date();
      await prisma.article.update({
        where: { id: article.id },
        data: { deletedAt: now },
      });
      return { deletedId: article.id };
    },
  );

  // ── Export ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    ROUTES.articleExport,
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
    async (req): Promise<ArticleExportResponse> => {
      const session = currentSession(req);
      const article = await prisma.article.findFirst({
        where: { id: req.params.id, ownerUserId: session.user.id, deletedAt: null },
      });
      if (!article) {
        throw Object.assign(new Error("文章不存在或已删除。"), { statusCode: 404 });
      }
      const version = await prisma.articleVersion.findFirst({
        where: { articleId: article.id, isCurrent: true },
      });
      if (!version) {
        throw Object.assign(new Error("文章版本数据缺失。"), { statusCode: 500 });
      }
      const paragraphs = await prisma.paragraph.findMany({
        where: { versionId: version.id },
      });
      return {
        article: toSummary(article),
        version: toVersionDetail(version, paragraphs),
        brief: (article.brief as ArticleExportResponse["brief"]) ?? null,
        exportedAt: new Date().toISOString(),
      };
    },
  );
}

// Re-export so tests can assert the version extractor label without
// reaching into the parse layer.
export { EXTRACTOR_VERSION };
