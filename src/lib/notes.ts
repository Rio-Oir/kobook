// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontend client for the notes surface.
 *
 * Wires the Reader's "ask" / "explain" actions to the account service, so
 * notes persist with the user rather than only in localStorage. This client
 * lives in the value-added line: base has no `/api/notes` route and no note
 * schema, and reaches this module only through the cloud adapter.
 *
 * Error shape: base's `normalizeApiError` turns either server envelope into an
 * `ApiRequestError`, and the note routes answer with the shared error contract
 * whose `message` is already user-readable Chinese — so the caller can render
 * `err.message` directly.
 */

import {
  ROUTES,
  type NoteAppendMessageRequest,
  type NoteAppendMessageResponse,
  type NoteCreateRequest,
  type NoteCreateResponse,
  type NoteDeleteResponse,
  type NoteDetailResponse,
  type NoteStatusUpdateRequest,
  type NoteListResponse,
  type ArticleRefreshRequest,
  type ArticleRefreshResponse,
} from "./cloud/contracts";
import { apiRequest } from "./api-error";

function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiRequest<T>(path, init);
}

function withParam(template: string, key: string, value: string): string {
  return template.replace(`:${key}`, encodeURIComponent(value));
}

/**
 * List the notes on one version of an article.
 *
 * `versionId` selects the version the caller is rendering. Omit it for
 * "whatever is current". Passing it is what lets a tab left open across a
 * refresh load *its* notes instead of being told about a document it is
 * not showing.
 */
export async function listNotes(
  articleId: string,
  versionId?: string,
): Promise<NoteListResponse> {
  const path = withParam(ROUTES.articleNotes, "id", articleId);
  const qs = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
  return request<NoteListResponse>(`${path}${qs}`);
}

export async function createNote(
  articleId: string,
  body: NoteCreateRequest,
): Promise<NoteCreateResponse> {
  return request<NoteCreateResponse>(withParam(ROUTES.articleNoteCreate, "id", articleId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getNote(noteId: string): Promise<NoteDetailResponse> {
  return request<NoteDetailResponse>(withParam(ROUTES.noteGet, "id", noteId));
}

export async function appendMessage(
  noteId: string,
  body: NoteAppendMessageRequest,
): Promise<NoteAppendMessageResponse> {
  return request<NoteAppendMessageResponse>(
    withParam(ROUTES.noteMessageCreate, "id", noteId),
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

/**
 * Set a note's terminal lifecycle state without appending a message.
 *
 * A run can end with no text at all — cancelled before the first token, or
 * a provider that failed immediately. The message route cannot carry that
 * (`content` is required and non-empty), so the status travels on its own
 * rather than being smuggled in on an invented empty turn.
 */
export async function updateNoteStatus(
  noteId: string,
  body: NoteStatusUpdateRequest,
): Promise<NoteDetailResponse> {
  return request<NoteDetailResponse>(withParam(ROUTES.noteStatusUpdate, "id", noteId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function deleteNote(noteId: string): Promise<NoteDeleteResponse> {
  return request<NoteDeleteResponse>(withParam(ROUTES.noteDelete, "id", noteId), {
    method: "DELETE",
  });
}

export async function refreshArticle(
  articleId: string,
  body: ArticleRefreshRequest,
): Promise<ArticleRefreshResponse> {
  return request<ArticleRefreshResponse>(withParam(ROUTES.articleRefresh, "id", articleId), {
    method: "POST",
    body: JSON.stringify(body),
  });
}
