// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Account-side article client.
 *
 * The `/api/articles` surface, as this client calls it: import, list, detail,
 * export, sync upload, delete. Base owns the *anonymous* extractor and the pure
 * "parsed document → local article" mapping (`src/lib/articles.ts`), and this
 * module is the account-side counterpart — the same shape, reached over a
 * session instead of produced locally.
 *
 * Callers: `article-sync.ts` (the upload transport), `migration.ts` (the
 * anonymous-content upload) and `library-sync.ts` / `pages/Library.tsx` (the
 * account half of the single library).
 */

import {
  ROUTES,
  type ArticleBriefRequest,
  type ArticleBriefResponse,
  type ArticleDeleteResponse,
  type ArticleDetailResponse,
  type ArticleExportResponse,
  type ArticleImportRequest,
  type ArticleImportResponse,
  type ArticleListResponse,
  type ArticleMetaRequest,
  type ArticleMetaResponse,
  type ArticleSyncRequest,
  type ArticleSyncResponse,
  type ArticleTagsRequest,
  type ArticleTagsResponse,
  type ArticleVersionCreateRequest,
  type ArticleVersionCreateResponse,
  type HighlightCreateRequest,
  type HighlightCreateResponse,
  type HighlightDeleteResponse,
  type HighlightListResponse,
  type HighlightUpdateRequest,
  type HighlightUpdateResponse,
} from "./cloud/contracts";
import { ApiRequestError, apiRequest } from "./api-error";
import { blocksDigest, coverImageFromParagraphs, toLocalParagraph } from "./articles";
import type { ArticleDraft, Paragraph } from "./types";

/**
 * Localise an error from the import path.
 *
 * The URL wording no longer promises "下一阶段上线" — URL import works for
 * anonymous readers too, so telling them it is not available would be false.
 * What remains true is that some sources cannot be reached, and the server's
 * own Chinese message already says which.
 */
function localizeImportError(err: ApiRequestError): ApiRequestError {
  if (err.code === "EMPTY_ARTICLE") {
    return new ApiRequestError(
      "未能从内容中提取正文，请尝试粘贴更完整的文章。",
      err.status,
      err.code,
      err.requestId,
    );
  }
  return err;
}

/**
 * Import a Markdown / HTML string as a new article in the account's library.
 *
 * The `kind: "text"` path produces the same block shape the local parser does,
 * so a migrated anonymous article keeps the paragraph ids / hashes it carried
 * locally.
 */
export async function importArticle(input: ArticleImportRequest): Promise<ArticleImportResponse> {
  try {
    return await apiRequest<ArticleImportResponse>(ROUTES.articleImport, {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    if (err instanceof ApiRequestError) throw localizeImportError(err);
    throw err;
  }
}

/** One page of the account's article library. */
export async function listArticles(cursor?: string): Promise<ArticleListResponse> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiRequest<ArticleListResponse>(`${ROUTES.articleList}${qs}`);
}

export async function getArticle(id: string): Promise<ArticleDetailResponse> {
  return apiRequest<ArticleDetailResponse>(ROUTES.articleDetail.replace(":id", id));
}

/** Soft-delete one article from the account's library. */
export async function deleteArticle(id: string): Promise<ArticleDeleteResponse> {
  return apiRequest<ArticleDeleteResponse>(ROUTES.articleDelete.replace(":id", id), {
    method: "DELETE",
  });
}

/** The article plus its version, for taking a copy out of the account. */
export async function exportArticle(id: string): Promise<ArticleExportResponse> {
  return apiRequest<ArticleExportResponse>(ROUTES.articleExport.replace(":id", id));
}

// ── Account metadata: tags, summary, cover ────────────────────────────────

/**
 * Replace an article's tags in the account.
 *
 * Whole-list replacement, because the tagger always knows the complete set.
 * Fire-and-forget at the call site: a failed push must not interrupt reading,
 * and the next open reconciles by pushing whatever the local record has.
 */
export async function putArticleTags(
  id: string,
  body: ArticleTagsRequest,
): Promise<ArticleTagsResponse> {
  return apiRequest<ArticleTagsResponse>(ROUTES.articleTags.replace(":id", id), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/** Store the generated summary on the account, so every device has it. */
export async function putArticleBrief(
  id: string,
  body: ArticleBriefRequest,
): Promise<ArticleBriefResponse> {
  return apiRequest<ArticleBriefResponse>(ROUTES.articleBrief.replace(":id", id), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/**
 * Backfill cover / published date on an article uploaded before those columns
 * existed. A field that is absent is left untouched on the server.
 */
export async function putArticleMeta(
  id: string,
  body: ArticleMetaRequest,
): Promise<ArticleMetaResponse> {
  return apiRequest<ArticleMetaResponse>(ROUTES.articleMeta.replace(":id", id), {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ── Highlights ────────────────────────────────────────────────────────────

export async function listHighlights(id: string): Promise<HighlightListResponse> {
  return apiRequest<HighlightListResponse>(ROUTES.articleHighlights.replace(":id", id));
}

export async function createHighlight(
  id: string,
  body: HighlightCreateRequest,
): Promise<HighlightCreateResponse> {
  return apiRequest<HighlightCreateResponse>(ROUTES.articleHighlightCreate.replace(":id", id), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function patchHighlight(
  id: string,
  body: HighlightUpdateRequest,
): Promise<HighlightUpdateResponse> {
  return apiRequest<HighlightUpdateResponse>(ROUTES.highlightUpdate.replace(":id", id), {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function deleteHighlightRemote(id: string): Promise<HighlightDeleteResponse> {
  return apiRequest<HighlightDeleteResponse>(ROUTES.highlightDelete.replace(":id", id), {
    method: "DELETE",
  });
}

/**
 * Upload an article the browser has already parsed.
 *
 * Used by the dual-channel extractor when channel 1 (browser-direct Jina)
 * succeeds — the client already has the `ContentBlock[]` and the `textHash`,
 * so sending them keeps the wire honest ("browser 直连成功后端 0 请求" only
 * holds if the server accepts the result instead of fetching the URL again).
 * The body is built field-by-field by `local-import-sync.buildSyncPayload`, so
 * a stray key on the input cannot reach the request.
 */
export async function syncArticle(
  input: ArticleSyncRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ArticleSyncResponse> {
  // `apiRequestWithSignal` exists because spreading a per-call `init` over the
  // base options would drop a caller-supplied `signal` rather than merge it.
  if (options.signal) {
    return apiRequest<ArticleSyncResponse>(ROUTES.articleSync, {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
  }
  return apiRequest<ArticleSyncResponse>(ROUTES.articleSync, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Upload an edited body as the next version of an article that already exists
 * on the server.
 *
 * Distinct from `syncArticle`: that one creates article + version 1 under a
 * client key, this appends to a known article id. The server validates the
 * blocks and `textHash` identically, and `baseVersionId` makes the write
 * conditional on the version the edit was made from.
 */
export async function createArticleVersion(
  articleId: string,
  input: ArticleVersionCreateRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ArticleVersionCreateResponse> {
  const path = ROUTES.articleVersions.replace(":id", articleId);
  if (options.signal) {
    return apiRequest<ArticleVersionCreateResponse>(path, {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
  }
  return apiRequest<ArticleVersionCreateResponse>(path, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ── Server row → local article ────────────────────────────────────────────
//
// `toLocalParagraph` is *not* defined here. It used to be, as an eight-line
// copy of base's private mapper with a truncated hash — and the note beside it
// said that if base ever exported its own, this should become a call to it.
// Base does export one now, so this does. The copy is gone rather than kept in
// step: two mappers that have to agree is exactly how a pulled-down body ends
// up carrying a `hash` the sync upload re-derives differently and refuses.

/**
 * Convert a server `ArticleDetailResponse` into the pair the store writes.
 *
 * Two values, not one — the same shape `anonymousDocumentToLocalArticle`
 * returns, and for the same reason: the record and the text are stored
 * separately now (storage format v3), and a function that returned them fused
 * would have to be undone by every caller.
 *
 * Two properties matter and both are load-bearing:
 *
 *  - **The local id *is* the server id.** The row is fetched from the account,
 *    so it already exists under that id; keeping `local-<textHash>` here would
 *    make `cloud-notes.getSyncedArticleId` look for a `remoteId` that this
 *    article does not need, and the notes written on it would be parked
 *    forever.
 *  - **`versionId` is carried through deliberately**, so a note anchors to the
 *    version being displayed rather than to whatever is current when the
 *    create request lands.
 *
 * `blocksDigest` is derived here, where the blocks are still in hand: once
 * they are a body the record has no way back to them, and this is what lets a
 * later pull of the same document be recognised as the same one rather than
 * overwriting a row whose notes were measured against different formatting.
 */
export function serverToLocalArticle(detail: ArticleDetailResponse): {
  article: ArticleDraft;
  paragraphs: Paragraph[];
} {
  const paragraphs = detail.version.paragraphs;
  // The server stores the body, not a separate cover column, so a pulled
  // article's own picture is derived from the text it came with. Without this
  // a page that had a hero image would show the default painting on every
  // device except the one that imported it.
  const coverImage = detail.article.coverImage ?? coverImageFromParagraphs(paragraphs);
  return {
    article: {
      id: detail.article.id,
      title: detail.article.title,
      createdAt: Date.parse(detail.article.importedAt),
      versionId: detail.version.id,
      // A pulled row *is* the account's article, so it carries the account
      // binding explicitly even though its id already equals the server id.
      // Everything downstream keys off `remoteId` ("does this row have a
      // server copy?"): edit uploads, delete-both-ends, the sync badge. Leaving
      // it unset made a pulled article look local-only — edits stayed on the
      // device and "delete" left the account copy behind.
      remoteId: detail.article.id,
      remoteVersionId: detail.version.id,
      ...(detail.article.sourceUrl ? { url: detail.article.sourceUrl } : {}),
      ...(detail.article.publishedAt ? { publishedAt: detail.article.publishedAt } : {}),
      ...(detail.article.tags && detail.article.tags.length > 0
        ? { tags: detail.article.tags }
        : {}),
      ...(detail.brief ? { brief: detail.brief } : {}),
      ...(coverImage ? { coverImage } : {}),
      blocksDigest: blocksDigest(paragraphs),
    },
    paragraphs: paragraphs.map(toLocalParagraph),
  };
}
