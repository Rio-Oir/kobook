// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The HTTP surface shared by the server, the acceptance tests and the
 * frontend.
 *
 * This file is the single wire contract: every account, admin,
 * article-library, note and sample route lives here as one `ROUTES` object,
 * so the frontend and the server cannot drift about a path or a DTO shape.
 *
 * The one section deliberately absent is billing. Payment, entitlements and
 * the merchant configuration belong to the value-added line, which composes
 * them around this same server. The boundary is drawn *here*, in the wire
 * contract, rather than as a flag inside a handler: a deployment that sells
 * something extends the surface from its own module, and the open-source
 * build cannot take money because no route for it exists to call.
 *
 * Note the asymmetry that is intentional: base owns the *content* format
 * (`ContentBlock`, `ParsedDocument`, block ids and inline spans, in
 * `content.ts`) because it parses and renders documents, and it owns the
 * account, sync and note schema because those are what make the reader work
 * on more than one device.
 */

import type { ContentBlock, ParsedDocument } from "./content.js";

export const API_PREFIX = "/api";

export const ROUTES = {
  anonymousExtract: "/api/anonymous/extract",
  healthLive: "/api/health/live",
  healthReady: "/api/health/ready",
  /** Mount point for the Better Auth handler (basePath). */
  authMount: "/api/auth/*",
  authBasePath: "/api/auth",
  me: "/api/me",
  sampleEcho: "/api/sample/echo",
  sampleParse: "/api/sample/parse",
  sampleStream: "/api/sample/stream",

  // ── phase 2 ──────────────────────────────────────────────────────────────
  /**
   * Provisional AI entry: it does nothing but enforce the verified-session
   * gate, and exists so that "验证邮箱后才能使用 AI 入口" is observable on the
   * server before real generation arrives. Phase 4 replaces it with
   * `/api/generations` carrying the same `requireVerifiedSession` pre-handler;
   * this constant must be deleted then, not left behind as a no-op endpoint.
   */
  aiEntry: "/api/ai/entry",
  adminUsers: "/api/admin/users",
  adminUserRole: "/api/admin/users/:userId/role",
  adminUserDisable: "/api/admin/users/:userId/disable",
  adminUserEnable: "/api/admin/users/:userId/enable",
  adminAudit: "/api/admin/audit",
  /**
   * Development mail inbox. Mounted only when NODE_ENV is not "production",
   * and the mount is what the acceptance run asserts is absent in production.
   */
  devMail: "/api/dev/mail",
  devMailLatest: "/api/dev/mail/latest",
  /**
   * Development SMS inbox. Same rule as the mail inbox: mounted only when the
   * in-process outbox is the active transport and NODE_ENV is not production.
   */
  devSms: "/api/dev/sms",
  devSmsLatest: "/api/dev/sms/latest",

  // ── phase 3 (slice 1) ────────────────────────────────────────────────────
  /**
   * User-owned article library. All five endpoints sit behind the session
   * gate; cross-user reads are blocked by the SQL filter on `ownerUserId`,
   * not by the URL shape, so a guessed id never leaks.
   *
   * Slice 1: import accepts only `kind: "text" | "html"`. The `url` kind is
   * a slice 2 deliverable (Jina + DNS / redirect SSRF defense). The route
   * itself is mounted, so the URL is real and the rejection comes from the
   * body schema — a 400, not a 404.
   */
  articleImport: "/api/articles/import",
  articleList: "/api/articles",
  articleDetail: "/api/articles/:id",
  articleDelete: "/api/articles/:id",
  articleExport: "/api/articles/:id/export",
  /**
   * Wire A: upload an article the browser has already parsed.
   *
   * Distinct from `/api/articles/import`, which fetches the URL itself or
   * re-parses pasted content. This route is what the dual-channel
   * extractor uses when channel 1 (browser-direct Jina) has succeeded:
   * the client already has the `ContentBlock[]` and the `textHash`; the
   * server only re-validates and writes. The body schema is the
   * whitelist — no `blocks` spread, no `source` chosen by the caller
   * beyond the closed `ArticleSyncSource` set, and no proxy / Jina base
   * URL.
   *
   * The `(ownerUserId, clientKey)` unique constraint on `Article.clientKey`
   * is the idempotency gate, so a retried upload with the same key
   * returns the article the first attempt created rather than adding a
   * second one. Caller-supplied `clientKey` is the only field that
   * reaches the database, so a request without one is rejected at the
   * schema — a missing key would mean every retry creates a new row.
   */
  articleSync: "/api/articles/sync",
  /**
   * Upload an edited body as the next immutable version of an existing
   * article.
   *
   * Versions are never rewritten: notes keep the version id they were created
   * against, and a reader with an old tab open must keep validating against
   * the text it is showing. An edit therefore appends version N+1 and demotes
   * N, which is the same rule `refresh` follows.
   */
  articleVersions: "/api/articles/:id/versions",

  // ── phase 3 (slice 3) ────────────────────────────────────────────────────
  /** Re-import the article's text into a new version, keeping old notes
   *  bound to the version they were created against. */
  articleRefresh: "/api/articles/:id/refresh",
  /** List every note anchored on the article's current version. */
  articleNotes: "/api/articles/:id/notes",
  /** Create a note on the article. Server validates the selection. */
  articleNoteCreate: "/api/articles/:id/notes",
  /** Delete a note by id (cascades to its messages). */
  noteDelete: "/api/notes/:id",
  /** Append a message to a note (the streamed answer, or a follow-up). */
  noteMessageCreate: "/api/notes/:id/messages",
  /** Fetch one note (used to re-attach the answer on refresh). */
  noteGet: "/api/notes/:id",
  /**
   * Set a note's lifecycle state without appending a message.
   *
   * A run can reach a terminal state with *no* text at all — a cancelled
   * request that had not produced a first token, a provider that failed
   * before the first chunk. Without this the client would either leave the
   * note looking like it is still generating, or invent an empty message
   * to carry the status. Neither is true, so the status travels on its own.
   */
  noteStatusUpdate: "/api/notes/:id/status",

  // ── account metadata + highlights ────────────────────────────────────────
  /** Replace an article's AI tags (account data; any device may write). */
  articleTags: "/api/articles/:id/tags",
  /** Replace an article's generated summary. */
  articleBrief: "/api/articles/:id/brief",
  /** Backfill cover / published date on an article imported before those
   *  columns were uploaded with the document. */
  articleMeta: "/api/articles/:id/meta",
  /** List the reader's marks on an article's current version. */
  articleHighlights: "/api/articles/:id/highlights",
  /** Create one mark; idempotent on `clientKey`. */
  articleHighlightCreate: "/api/articles/:id/highlights",
  /** Update colour / style / remark / detached on one mark. */
  highlightUpdate: "/api/highlights/:id",
  /** Delete one mark. */
  highlightDelete: "/api/highlights/:id",
} as const;

/** The two roles phase 2 supports. Enforced by a database CHECK constraint. */
export type UserRole = "user" | "admin";

/** Shape of the authenticated principal, as the server reports it. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  /**
   * E.164 number when the account was created with a phone number. Null for
   * email accounts. Included so the account screen can show which number is
   * bound without a second endpoint; it is never accepted from a request.
   */
  phoneNumber?: string | null;
  /**
   * Server-read role, never taken from a request. Exposed because the client
   * needs it to decide whether to offer the admin surface; the server still
   * re-checks it on every admin request.
   */
  role: UserRole;
}

export interface MeResponse {
  user: SessionUser;
  session: {
    id: string;
    expiresAt: string;
  };
}

/**
 * Echo endpoint: the server must return the exact JSON body it received
 * *after* the session check has run. This is the observable proof that
 * Fastify body parsing and the Better Auth bridge do not fight over the
 * request stream.
 */
export interface EchoRequest {
  /** Arbitrary payload, echoed back verbatim. */
  payload: unknown;
  /** Client-supplied marker, echoed back so tests can match a round trip. */
  marker: string;
}

export interface EchoResponse {
  marker: string;
  payload: unknown;
  /** Raw byte length of the request body as parsed by Fastify. */
  receivedBytes: number;
  /** Session user id that authorised the call — never taken from the body. */
  actorUserId: string;
}

export type ParseSourceKind = "html" | "markdown";

/**
 * Fixture-only parse request. There is intentionally no URL field: phase 1
 * has no arbitrary-URL fetch endpoint.
 */
export interface ParseRequest {
  kind: ParseSourceKind;
  content: string;
  /** Optional override; otherwise derived from the document. */
  title?: string;
}

export interface ParseResponse {
  document: ParsedDocument;
}

/** Re-exported for convenience so callers import contracts from one place. */
export type { ContentBlock, ParsedDocument };

// ── Phase 2: AI entry gate ─────────────────────────────────────────────────

/**
 * Response of the provisional AI entry. Reaching this body at all means the
 * caller had a session, was not disabled, and had a verified address.
 */
export interface AiEntryResponse {
  allowed: true;
  /** Session user id — never taken from the request body. */
  actorUserId: string;
  phase: 2;
}

// ── Phase 2: administration ────────────────────────────────────────────────

/**
 * A user as an administrator sees them.
 *
 * Deliberately narrow: phase 2 has no article, note or conversation data to
 * leak, and this shape is what keeps it that way when those tables arrive —
 * private content is never joined into the admin surface by default.
 */
export interface AdminUserSummary {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: UserRole;
  banned: boolean;
  banReason: string | null;
  createdAt: string;
}

export interface AdminUserListResponse {
  users: AdminUserSummary[];
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: string | null;
}

export interface AdminSetRoleRequest {
  role: UserRole;
}

export interface AdminDisableRequest {
  reason?: string;
}

export interface AdminUserResponse {
  user: AdminUserSummary;
  /** Audit row id, so an operator can point at the record of the action. */
  auditId: string;
}

export type AdminActionKind =
  | "grant_role"
  | "revoke_role"
  | "disable_account"
  | "enable_account";

export type AdminActionResult = "applied" | "rejected";

export interface AdminAuditEntry {
  id: string;
  /** "system" for the ADMIN_EMAILS bootstrap, "cli" for the admin CLI. */
  actorUserId: string;
  actorEmail: string;
  targetUserId: string;
  action: AdminActionKind;
  result: AdminActionResult;
  detail: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface AdminAuditResponse {
  entries: AdminAuditEntry[];
}

// ── Phase 2: development mail inbox ────────────────────────────────────────

/**
 * A message captured by the development outbox.
 *
 * `url` is a credential: it carries the single-use verification or reset token.
 * The endpoint that returns it is mounted only outside production, and the
 * acceptance run asserts it is absent under NODE_ENV=production.
 */
export interface DevMailMessage {
  id: string;
  purpose: "verify-email" | "reset-password" | "sign-in-otp";
  to: string;
  subject: string;
  /** Empty for `sign-in-otp`, which carries a code instead of a link. */
  url: string;
  /** Extracted from `url` so tests do not have to re-parse the link shape. */
  token: string;
  /** Six-digit login code; empty for the two link flows. */
  code: string;
  queuedAt: string;
}

export interface DevMailLatestResponse {
  message: DevMailMessage | null;
}

export interface DevMailListResponse {
  messages: DevMailMessage[];
}

// ── Phase 2: development SMS inbox ─────────────────────────────────────────

/**
 * One message captured by the development SMS outbox.
 *
 * `code` is a live credential. The endpoint that returns it is mounted only
 * outside production, and the acceptance run asserts the mount is absent under
 * NODE_ENV=production. `to` is the full E.164 number for the same reason: the
 * harness has to match a code to the number that requested it.
 */
export interface DevSmsMessage {
  id: string;
  to: string;
  /** Display form, e.g. `138****8000`. */
  maskedTo: string;
  purpose: string;
  /** Six-digit verification code. */
  code: string;
  queuedAt: string;
}

export interface DevSmsLatestResponse {
  message: DevSmsMessage | null;
}

export interface DevSmsListResponse {
  messages: DevSmsMessage[];
}

// ── Phase 3 (slice 1): article library ────────────────────────────────────

/**
 * Input kinds the import endpoint accepts.
 *   - `text` — pasted Markdown; remark parses it into the unified
 *     `ContentBlock[]` shape.
 *   - `html` — pasted raw HTML; Readability + the DOM walker parse it.
 *   - `url`  — a public URL; the SSRF guard, the Jina primary, and
 *     the Readability fallback live on the server. The route is
 *     mounted, but a missing / broken Jina key simply falls back to
 *     direct fetching + Readability.
 */
export type ArticleImportKind = "text" | "html" | "url";

/**
 * Request body for `POST /api/articles/import`.
 *
 * - `kind: "text"` — `content` is treated as Markdown; remark parses it
 *   into the unified `ContentBlock[]` shape.
 * - `kind: "html"` — `content` is treated as raw HTML; Readability + the
 *   DOM walker parse it.
 *
 * Both paths go through the same `parseContent` layer, so the response
 * shape is identical regardless of which kind the request used. The
 * `title` field overrides the extractor's first-heading title when set.
 */
export interface ArticleImportRequest {
  kind: ArticleImportKind;
  content: string;
  title?: string;
  /**
   * Only meaningful for `kind: "url"`.
   *
   * Absent / `false` (the default) — if this user already has a
   * non-deleted article with the same `sourceUrl`, return that article
   * and its current version instead of creating a duplicate. The plan's
   * rule is "同一 URL 再导入默认返回自己的已有文章".
   *
   * `true` — the explicit "重新抓取" opt-in: write a new version onto
   * the existing article. Notes created against the previous version
   * stay bound to it, exactly like `POST /api/articles/:id/refresh`.
   */
  reimport?: boolean;
  /**
   * Optional client-supplied idempotency key, unique per account.
   *
   * A retried import carrying a key this account has already used
   * returns the article the first attempt created rather than a second
   * copy. This is what makes the anonymous→account migration safe to
   * retry when the response to the first attempt was lost — a case that
   * local bookkeeping alone cannot close, because the value that went
   * missing is exactly the article id the client needed to record.
   *
   * Callers that send nothing keep the existing behaviour exactly;
   * `NULL` keys do not collide with each other.
   */
  clientKey?: string;
}

/**
 * One article's metadata as it appears in list and detail responses.
 * `source` mirrors the DB column: "text" for slice 1, "url" for slice 2.
 */
export interface ArticleSummary {
  id: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  importedAt: string;
  /**
   * Account metadata that used to be device-only. Optional so a reader of an
   * older server payload (or a cached response) does not have to synthesise
   * them; the server always sends them.
   *
   * `coverImage` — the page's own picture, or null when it had none.
   * `publishedAt` — ISO date from the extractor, or null.
   * `tags` — AI topic labels; empty when the article is not tagged yet.
   */
  coverImage?: string | null;
  publishedAt?: string | null;
  tags?: string[];
}

/**
 * One version of one article: the immutable snapshot produced by one
 * parse run. The same `ContentBlock` shape the parser emits becomes the
 * `paragraphs` array verbatim (id / index / type / text / hash / level /
 * lang / ordered / spans), so the frontend never has to translate between
 * server-side and parser-internal representations.
 */
export interface ArticleVersionDetail {
  id: string;
  articleId: string;
  version: number;
  source: string;
  importedAt: string;
  paragraphs: ContentBlock[];
}

export interface ArticleImportResponse {
  article: ArticleSummary;
  version: ArticleVersionDetail;
}

// ── Wire A: already-parsed article upload ─────────────────────────────────

/**
 * The set of "where the document came from" labels the upload endpoint
 * accepts. Mirrors the `ExtractSource` union in the browser's
 * `browser-extract-errors.ts` so the two halves of the wire use the
 * same vocabulary.
 *
 * `local` covers the paste path (the browser parsed the user's pasted
 * Markdown / text). The other three describe URL imports with the
 * channel the document actually arrived through — "browser-jina" for
 * a direct Jina fetch from the browser, the other two for the
 * server-side fallback that ran because the browser channel failed.
 */
export type ArticleSyncSource =
  | "browser-jina"
  | "server-jina"
  | "server-readability"
  | "local";

/**
 * Body of `POST /api/articles/sync`.
 *
 * Field by field rather than spread so a stray property on the input
 * object cannot reach the database. The browser-side
 * `local-import-sync.ts` builds the same shape from a typed argument
 * list, and `assertNoSecrets` runs before the request goes out, so the
 * only path through this is the one the wire declares.
 */
export interface ArticleSyncRequest {
  title: string;
  sourceUrl: string | null;
  source: ArticleSyncSource;
  author: string | null;
  textHash: string;
  blocks: ContentBlock[];
  /**
   * The page's own cover picture, when the client has one. Optional:
   * older clients send nothing and the default cover library applies.
   */
  coverImage?: string | null;
  /** Published date the extractor found, when the client has one. */
  publishedAt?: string | null;
  /**
   * Caller-supplied idempotency key, unique per account. A retry
   * carrying a key this account has already used returns the article
   * the first attempt created rather than a second copy. The
   * `local-import-sync.ts` module's `deriveIdempotencyKey` produces
   * 32 hex characters; the schema accepts that length and rejects
   * anything longer to keep the database column from growing without
   * bound.
   */
  clientKey: string;
}

export interface ArticleSyncResponse {
  articleId: string;
  versionId: string;
  /**
   * The `Article.source` column value, derived server-side from
   * `sourceUrl`: a non-null source URL is a `"url"` import, a null one
   * is `"text"`. The browser does not set this — the server picks.
   */
  source: "text" | "url";
}

/**
 * Body of `POST /api/articles/:id/versions`.
 *
 * The blocks are the client's own parse of the edited body — the server
 * re-derives every `hash`, checks `textHash` and refuses a version whose base
 * is no longer current. `baseVersionId` is what makes concurrent edits safe:
 * a second device that edited the same article from an older version gets a
 * 409 instead of silently replacing the other device's text.
 */
export interface ArticleVersionCreateRequest {
  blocks: ContentBlock[];
  textHash: string;
  /** The version this edit started from. Omitted = append to whatever is current. */
  baseVersionId?: string;
}

export interface ArticleVersionCreateResponse {
  articleId: string;
  version: ArticleVersionDetail;
}

export interface ArticleListResponse {
  articles: ArticleSummary[];
  /** Opaque cursor for the next page, or null when the list is exhausted. */
  nextCursor: string | null;
}

export interface ArticleDetailResponse {
  article: ArticleSummary;
  version: ArticleVersionDetail;
  /**
   * The generated summary, when one exists. Kept out of the list response on
   * purpose: it is a few kilobytes per article and the library never renders
   * it, so only the detail route pays for it.
   */
  brief?: ArticleBriefPayload | null;
}

/** The generated article summary, as the client stores it. */
export interface ArticleBriefPayload {
  gist: string;
  claims: { text: string; paragraphRef: string }[];
  generatedAt: number;
}

export interface ArticleExportResponse {
  article: ArticleSummary;
  version: ArticleVersionDetail;
  /** The generated summary, when one exists — an export is a full copy. */
  brief?: ArticleBriefPayload | null;
  /** ISO timestamp of the export, for tooling that snapshots the output. */
  exportedAt: string;
}

export interface ArticleDeleteResponse {
  deletedId: string;
}

// ── Phase 3 (slice 3): notes + messages ────────────────────────────────────

/**
 * Lifecycle of a note's AI run. "running" until the client tells the
 * server the stream finished, then one of the terminal states.
 *
 * `interrupted` is distinct from `failed` on purpose: a browser reload
 * or a process restart is not the model failing, and the partial answer
 * is still worth showing. The consumer that detects the restart writes
 * it (see the Reader's on-mount sweep), which is what makes "刷新后显示
 * interrupted" observable rather than aspirational.
 */
export type NoteStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type NoteType = "explain" | "ask";

/**
 * The four highlight colours. Spelled out here rather than imported from the
 * client so the wire contract does not depend on the reader's own palette
 * module — a rename on that side must not change what the server accepts.
 */
export type HighlightColor = "yellow" | "green" | "blue" | "red";

/** How a mark is drawn. Same three values the reader's toolbar offers. */
export type HighlightStyle = "watercolor" | "line" | "curve";

/** A message turn on a note: the original question, the streamed
 *  answer, or a follow-up. `sequence` is 1-based and unique per note. */
export interface NoteMessage {
  id: string;
  noteId: string;
  role: "user" | "assistant";
  content: string;
  sequence: number;
  createdAt: string;
}

/** Note as it appears in list responses: everything the Reader needs
 *  to render a card without a follow-up fetch. */
export interface NoteSummary {
  id: string;
  articleId: string;
  versionId: string;
  paragraphIndex: number;
  startParagraphIndex: number;
  startOffset: number;
  endParagraphIndex: number;
  endOffset: number;
  /**
   * Parse-layer block ids at each end of the range (`b<index>-<hash8>`).
   * These are what distinguish two paragraphs that carry identical
   * text, so a note re-anchored onto the wrong occurrence is detectable.
   */
  startBlockId: string;
  endBlockId: string;
  type: NoteType;
  selectionText: string;
  selectionHash: string;
  question: string;
  answer: string;
  model: string;
  status: NoteStatus;
  /**
   * This note's own colour, or `null` for a row written before the column
   * existed and for a client that sent none. The reader falls back to the
   * default note blue, so absence is a renderable state rather than a gap.
   */
  color: HighlightColor | null;
  createdAt: string;
  completedAt: string | null;
}

export interface NoteDetailResponse {
  note: NoteSummary;
  messages: NoteMessage[];
}

export interface NoteListResponse {
  /**
   * The `article_version` this list is *about* — the article's current
   * version at the time of the request.
   *
   * A client rendering an older version (a tab left open across a
   * refresh) must not treat the absence of its notes here as "they were
   * deleted": the list answers a question about a different version.
   * Naming the version is what makes that distinction checkable instead
   * of guessed.
   */
  versionId: string;
  notes: NoteSummary[];
  /**
   * The conversation turns per note, keyed by note id.
   *
   * Sent with the list rather than requiring one `GET /api/notes/:id` per
   * card: a note's structure (original question, first answer, each
   * follow-up) is not recoverable from the flattened `answer` string, and
   * a client that loses it cannot send a follow-up with the earlier turns
   * as context. One extra query on the server replaces an N+1 on the
   * client, which matters on an article with dozens of notes.
   *
   * A note with no messages is absent from the map rather than mapped to
   * an empty array, so the common case costs nothing on the wire.
   */
  messagesByNote: Record<string, NoteMessage[]>;
}

/**
 * Body of `POST /api/articles/:id/notes`. The server validates every
 * field:
 *   - `startParagraphIndex` / `endParagraphIndex` must exist in the
 *     current version's paragraphs
 *   - `startOffset` / `endOffset` must lie inside those paragraphs and
 *     describe a non-empty half-open range
 *   - `selectionText` must equal the server's reconstruction of that
 *     range (normalised the same way the parser normalises), so a
 *     client cannot supply text the article never contained
 *   - `startBlockId` / `endBlockId`, when present, must match the stored
 *     paragraph ids, which is what makes duplicate paragraphs
 *     distinguishable
 *   - `question` length is bounded
 *   - `type` is one of the two allowed values
 *
 * Offsets are *optional* for backwards compatibility: a request that
 * sends only `paragraphIndex` + `selectionText` is accepted under the
 * weaker containment rule. The Reader always sends the full range.
 */
export interface NoteCreateRequest {
  paragraphIndex: number;
  startParagraphIndex?: number;
  startOffset?: number;
  endParagraphIndex?: number;
  endOffset?: number;
  /** Optional block-id anchors; see `NoteSummary`. */
  startBlockId?: string;
  endBlockId?: string;
  /**
   * The `article_version` the caller was reading, when it knows.
   *
   * A page left open across a refresh renders version N while the
   * article's current version is N+1, and the offsets in this body were
   * measured against N. Naming N is what stops the note from being
   * anchored to text the reader never saw; omitting it keeps the
   * "anchor to whatever is current" behaviour for callers that do not
   * track versions.
   *
   * Must belong to the article in the path — a version id from another
   * article is refused with 422 rather than silently ignored.
   */
  articleVersionId?: string;
  /**
   * Optional client-supplied idempotency key, unique per article. Same
   * purpose as `ArticleImportRequest.clientKey`: a retried create
   * returns the note the first attempt made instead of a duplicate.
   */
  clientKey?: string;
  selectionText: string;
  type: NoteType;
  question: string;
  /**
   * The highlight colour the reader had armed when they asked — this note's
   * own colour, frozen at creation. Optional so a client that predates the
   * field still creates a note; the server treats its absence as "no
   * colour", which renders with the default note blue.
   */
  color?: HighlightColor;
  /** Optional model id. Defaults to "mock" when the client has no key. */
  model?: string;
}

export interface NoteCreateResponse {
  note: NoteSummary;
  /** The seeded "user" message, so the client does not have to re-fetch. */
  message: NoteMessage;
}

export interface NoteAppendMessageRequest {
  role: "user" | "assistant";
  content: string;
  /**
   * Optional client-supplied idempotency key, unique per note.
   *
   * An answer is appended by a client that may retry after its response
   * was lost. Without a key the retry adds a *second* assistant turn —
   * duplicated content the user cannot remove, and double the context on
   * the next follow-up. With one, the replay returns the message the
   * first attempt wrote.
   */
  clientKey?: string;
  /**
   * When the assistant message is the *first* answer on the note, the
   * client can set this to mark the note as "succeeded" in the same
   * call. The server is the only one that gets to decide; passing
   * "succeeded" with `role: "user"` is a 400.
   */
  status?: NoteStatus;
}

export interface NoteAppendMessageResponse {
  message: NoteMessage;
  note: NoteSummary;
}

// ── Account metadata: tags and summaries ───────────────────────────────────

/**
 * Body of `PUT /api/articles/:id/tags`.
 *
 * Whole-list replacement rather than per-tag add/remove: the client always
 * knows the complete set (the tagger produces it in one call, "重新生成"
 * produces another), so a partial merge would only create a second source of
 * truth to reconcile. `at` is the client's write time, echoed back so the
 * caller can tell its own write apart from another device's.
 */
export interface ArticleTagsRequest {
  tags: string[];
  /** Model id that produced the list; omitted for a manual edit. */
  model?: string;
  at?: number;
}

export interface ArticleTagsResponse {
  article: ArticleSummary;
}

/** Body of `PUT /api/articles/:id/brief`. */
export interface ArticleBriefRequest {
  /** The generated summary. Shape mirrors the client's `Brief`. */
  brief: {
    gist: string;
    claims: { text: string; paragraphRef: string }[];
    generatedAt: number;
  };
  at?: number;
}

export interface ArticleBriefResponse {
  article: ArticleSummary;
}

/** Body of `PUT /api/articles/:id/meta`. Both fields are optional; a field
 *  that is absent is left untouched, so a client that only knows the cover
 *  does not clear the date. */
export interface ArticleMetaRequest {
  coverImage?: string | null;
  publishedAt?: string | null;
}

export interface ArticleMetaResponse {
  article: ArticleSummary;
}

// ── Highlights ─────────────────────────────────────────────────────────────

/**
 * One reader-made mark, as the server stores it.
 *
 * `startOffset` / `endOffset` are a half-open range inside paragraph
 * `paragraphIndex` of `versionId`. `blockId` is the parse layer's id for that
 * paragraph, so a document containing the same sentence twice still anchors
 * to the occurrence the reader dragged over. `note` is the reader's own
 * remark on the marked words — plain text, no model.
 */
export interface HighlightRow {
  id: string;
  articleId: string;
  versionId: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  blockId: string;
  selectionText: string;
  color: HighlightColor;
  style: HighlightStyle;
  note: string;
  detached: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Body of `POST /api/articles/:id/highlights`.
 *
 * The server re-derives the marked text from the version's paragraphs and
 * refuses a request whose `selectionText` does not match, the same integrity
 * rule the note route applies; `clientKey` makes a retried create return the
 * row the first attempt wrote.
 */
export interface HighlightCreateRequest {
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  /** Parse-layer block id; omitted by older clients, then unchecked. */
  blockId?: string;
  /** Version the offsets were measured against; defaults to current. */
  articleVersionId?: string;
  clientKey?: string;
  selectionText: string;
  color: HighlightColor;
  style?: HighlightStyle;
  note?: string;
}

export interface HighlightCreateResponse {
  highlight: HighlightRow;
}

export interface HighlightUpdateRequest {
  color?: HighlightColor;
  style?: HighlightStyle;
  note?: string;
  detached?: boolean;
}

export interface HighlightUpdateResponse {
  highlight: HighlightRow;
}

export interface HighlightListResponse {
  /** The version this list is about (the article's current version). */
  versionId: string;
  highlights: HighlightRow[];
}

export interface HighlightDeleteResponse {
  deletedId: string;
}

/** Body of `POST /api/articles/:id/refresh`. For slice 3, only `text`
 *  refresh is supported; URL refresh lands in slice 4. */
export interface ArticleRefreshRequest {
  kind: "text" | "html";
  content: string;
  title?: string;
}

export interface ArticleRefreshResponse {
  article: ArticleSummary;
  version: ArticleVersionDetail;
  /** Number of old notes that still bind to the previous version. */
  retainedNoteCount: number;
}

/**
 * Body of `POST /api/notes/:id/status`.
 *
 * Only a terminal state is accepted here: "running" is what creating a
 * note means, and a client that could set it after the fact could make a
 * finished note look busy again. The role restriction the message route
 * applies ("only an assistant turn may finish a note") is preserved by the
 * same reasoning — this endpoint has no way to attribute the change to a
 * user turn, and it is only ever called by the client that ran the model.
 */
export interface NoteStatusUpdateRequest {
  status: Exclude<NoteStatus, "running">;
  /**
   * Optional client-supplied idempotency key. The operation is already
   * idempotent by nature (it sets a value), but a key lets a retry be
   * recognised in a log rather than looking like a second, later change.
   */
  clientKey?: string;
}

export interface NoteDeleteResponse {
  deletedId: string;
}

// ── Phase 3 (cross-segment follow-up): anonymous extraction ────────────────

/**
 * Body of `POST /api/anonymous/extract`.
 *
 * The product rule is that reading is identical signed in or out: the
 * anonymous path parses text / HTML / a URL through the *same* server
 * extractors the signed-in import uses, and returns the same
 * `ParsedDocument` shape. The two differences are deliberate and are the
 * whole point of the endpoint existing:
 *
 *   - it writes nothing. No `article`, no `article_version`, no
 *     `paragraph`, and no user row is created, so an anonymous reader
 *     never leaves a "ghost account" behind;
 *   - it is rate limited and size / timeout bounded, because it is the
 *     only unauthenticated route that makes the server do real work
 *     (and, for `kind: "url"`, the only unauthenticated egress).
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
   * Which extractor produced the document: `local` for the text / HTML
   * paths, `jina` or `html-readability` for URL imports.
   */
  extractor: "local" | "jina" | "html-readability";
  /** Present when a URL import fell back off Jina. */
  fallbackReason?: string;
}

