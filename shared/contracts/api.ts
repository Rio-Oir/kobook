// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The service's HTTP surface.
 *
 * This file is the single wire contract for everything this repository
 * serves, which is deliberately small: the route table is two entries, and
 * anything else a caller asks for is answered by the generic 404 handler. A
 * build that shipped the path table of an application it could not call would
 * be advertising endpoints with nothing behind them.
 *
 * What is here is exactly what is served, plus the DTOs for the one
 * unauthenticated route that makes the server do real work:
 *
 *   - `GET /api/health/live` — liveness, no dependencies;
 *   - `POST /api/anonymous/extract` — controlled text / HTML / URL
 *     extraction that writes nothing.
 *
 * Readiness (`/api/health/ready`) is deliberately **not** in this table. The
 * service has no dependency to check, and the acceptance run asserts the
 * route is absent rather than answered.
 *
 * One asymmetry is intentional: this file owns the *content* format
 * (`ContentBlock`, `ParsedDocument`, block ids and inline spans, in
 * `content.ts`) because the reader parses and renders documents. It owns no
 * account, sync, quota or billing schema; a deployment that has those defines
 * them on its own side of the optional adapter seam, and nothing here names
 * them.
 */

import type { ContentBlock, ParsedDocument } from "./content.js";

export const API_PREFIX = "/api";

export const ROUTES = {
  /**
   * Anonymous extraction. Same extractors the signed-in import uses, same
   * `ParsedDocument` shape, but nothing is written to a database and no user
   * row is created.
   */
  anonymousExtract: "/api/anonymous/extract",
  healthLive: "/api/health/live",
} as const;

/**
 * The two roles a session can carry.
 *
 * Declared here because the *session shape* is a shared contract: the optional
 * cloud adapter reports a role through `CloudSessionUser`, and this side must
 * be able to name it without importing an account module.
 */
export type UserRole = "user" | "admin";

/** How a document is being imported. */
export type ArticleImportKind = "text" | "html" | "url";

/**
 * Lifecycle of a note's answer, as this client records it.
 *
 * Base-owned, not server-owned: every note has a local status whether or not
 * anything is ever uploaded, and the value is part of the persisted local data
 * format. `running` is a live state; the other four are terminal and are what
 * a reload reports. `interrupted` in particular is written by the client's own
 * on-mount sweep when a stream did not finish — a process restart or a closed
 * tab is not the model failing, and the partial answer is still worth showing.
 */
export type NoteStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type NoteType = "explain" | "ask";

/**
 * A message turn on a note: the original question, the streamed answer, or a
 * follow-up. `sequence` is 1-based and unique per note.
 *
 * Part of the local note format — the reader keeps the conversation as
 * structured turns for every note, not only the ones that came from a server,
 * because a flattened `answer` loses the boundaries between turns and a
 * follow-up built from it alone would reach the model without the earlier
 * exchange as context.
 */
export interface NoteMessage {
  id: string;
  noteId: string;
  role: "user" | "assistant";
  content: string;
  sequence: number;
  createdAt: string;
}

/**
 * Anonymous extraction: parse text, HTML or a URL and return the document
 * without writing anything.
 *
 * Reading is identical whether or not anyone is signed in: this path runs the
 * *same* server extractors every other import path runs and returns the same
 * `ParsedDocument` shape. The two differences are deliberate and are the whole
 * point of the endpoint existing:
 *
 *   - it writes nothing. No article, no version, no paragraph, and no user row
 *     is created, so an anonymous reader never leaves a "ghost account"
 *     behind;
 *   - it is rate limited and size / timeout bounded, because it is the only
 *     unauthenticated route that makes the server do real work (and, for
 *     `kind: "url"`, the only unauthenticated egress).
 */
export interface AnonymousExtractRequest {
  kind: ArticleImportKind;
  content: string;
  /** Overrides the extractor's first-heading title when set. */
  title?: string;
}

export interface AnonymousExtractResponse {
  document: ParsedDocument;
  /**
   * Which extractor produced the document: `local` for the text / HTML paths,
   * `jina` or `html-readability` for URL imports.
   */
  extractor: "local" | "jina" | "html-readability";
  /** Present when a URL import fell back off Jina. */
  fallbackReason?: string;
}

/** Re-exported for convenience so callers import contracts from one place. */
export type { ContentBlock, ParsedDocument };
