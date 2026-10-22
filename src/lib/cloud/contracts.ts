// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The account / cloud wire contract, named in one place for the client.
 *
 * Base owns the *content* format (`src/lib/types.ts`) and the anonymous
 * extraction DTOs. The account, library, sync and note DTOs are the server's
 * wire shapes, and `shared/contracts/api.ts` is where they are declared.
 *
 * This file is the single place the client names them. It exists so that the
 * account modules import from one reviewable list instead of reaching into
 * the shared barrel at a dozen call sites, and so that the list is greppable
 * when the question is "what does this client actually depend on?".
 *
 * Nothing here is new: it is a straight re-export, read from the shared
 * barrel so the server and this client cannot drift.
 *
 * Billing is deliberately absent. Payment and entitlements are the
 * value-added line's, and a name for them must not appear in this client's
 * contract — see `shared/contracts/api.ts` for the same boundary on the wire
 * side.
 */

export {
  ROUTES,
  API_PREFIX,
  type SessionUser,
  type MeResponse,
  type AiEntryResponse,
  type AdminUserSummary,
  type AdminUserListResponse,
  type AdminUserResponse,
  type AdminAuditEntry,
  type AdminAuditResponse,
  type DevMailMessage,
  type ArticleImportRequest,
  type ArticleImportResponse,
  type ArticleSyncRequest,
  type ArticleSyncResponse,
  type ArticleSyncSource,
  type ArticleVersionCreateRequest,
  type ArticleVersionCreateResponse,
  type ArticleSummary,
  type ArticleVersionDetail,
  type ArticleListResponse,
  type ArticleDetailResponse,
  type ArticleExportResponse,
  type ArticleDeleteResponse,
  type ArticleRefreshRequest,
  type ArticleRefreshResponse,
  type ArticleTagsRequest,
  type ArticleTagsResponse,
  type ArticleBriefRequest,
  type ArticleBriefResponse,
  type ArticleBriefPayload,
  type ArticleMetaRequest,
  type ArticleMetaResponse,
  type HighlightRow,
  type HighlightCreateRequest,
  type HighlightCreateResponse,
  type HighlightUpdateRequest,
  type HighlightUpdateResponse,
  type HighlightListResponse,
  type HighlightDeleteResponse,
  type HighlightColor,
  type HighlightStyle,
  type NoteSummary,
  type NoteDetailResponse,
  type NoteListResponse,
  type NoteCreateRequest,
  type NoteCreateResponse,
  type NoteAppendMessageRequest,
  type NoteAppendMessageResponse,
  type NoteDeleteResponse,
  type NoteStatusUpdateRequest,
} from "../../../shared/contracts/index";
