// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Core data model: the local reader's own types, plus a small re-export of the
// shared server contracts they align with.
//
// The value re-exports of ROUTES / API_PREFIX are what let the frontend talk
// to the server without re-stating any path string.
//
// The list is deliberately short. Re-exporting a whole product's wire contract
// — session, admin, hosted-library and note DTOs — would make this build carry
// the shape of an application it cannot call. What remains is the content
// format it parses and renders, the anonymous-extraction DTOs, the error
// envelope, and the note lifecycle vocabulary the local data format uses.
// Schemas that belong to an optional cloud implementation are not named here.
export {
  ROUTES,
  API_PREFIX,
  INLINE_MARK_ORDER,
  type ContentBlock,
  type ParsedDocument,
  type InlineSpan,
  type InlineMarkKind,
  type StreamEvent,
  type ApiErrorBody,
  type LiveHealth,
  type NoteStatus,
  type NoteMessage,
  type UserRole,
  type AnonymousExtractRequest,
  type AnonymousExtractResponse,
} from "../../shared/contracts/index";

// Re-exporting a type does not bring it into this module's scope, and
// `Note` below refers to both of these by name — as does `Paragraph` to
// `InlineSpan`.
import type {
  InlineSpan,
  NoteMessage as SharedNoteMessage,
  NoteStatus as SharedNoteStatus,
} from "../../shared/contracts/index";

export type Paragraph = {
  index: number;          // 1-based, displayed in the margin
  text: string;
  hash: string;           // sha256(text).slice(0, 16), used for note anchoring
  /**
   * The parse layer's block id (`b<index>-<hash8>`). Absent for
   * paragraphs written by the legacy localStorage path before the
   * server existed; the Reader then falls back to index-only anchoring,
   * which is still server-validated, just without the duplicate-
   * paragraph tiebreak.
   */
  blockId?: string;
  /**
   * Block kind, when the paragraph came from the server parse layer.
   * Absent on paragraphs written before the parse layer stamped it, and
   * on every fixture in the test suite — the renderer therefore treats
   * a missing value as `"paragraph"` (see `lib/blocks.ts`) instead of
   * requiring a migration.
   */
  type?: "heading" | "paragraph" | "listItem" | "code" | "quote";
  /**
   * Heading depth, 1..6, straight from the parser (`node.depth` for
   * Markdown, the `h1`–`h6` tag name for HTML). Carried through so the
   * reader can size headings and build the outline; without it a
   * document's hierarchy is unrecoverable on the client even though the
   * server stores it.
   */
  level?: number;
  /** Fenced-code language, when the source declared one. */
  lang?: string | null;
  /** Ordered vs bullet list. Only meaningful for `listItem`. */
  ordered?: boolean;
  /**
   * Inline emphasis inside `text` — bold, italic, inline code,
   * strikethrough, links — as half-open offsets onto `text` itself.
   *
   * Offsets rather than markup so that `text` stays the one statement of
   * what the characters are. That is what keeps emphasis from disturbing
   * anything already measured against it: a highlight, a note's
   * selection, or the `hash` a note re-anchors by across versions.
   *
   * Absent for every paragraph parsed before the extractors recorded it,
   * and for every localStorage blob written then — which is why the
   * renderer treats a missing value as "no emphasis" rather than as an
   * error or as a reason to re-fetch the article.
   */
  spans?: InlineSpan[];
};

export type Brief = {
  gist: string;
  claims: { text: string; paragraphRef: string }[]; // paragraphRef like "¶3" or "¶13-26"
  generatedAt: number;
};

export type Article = {
  id: string;             // `local-<textHash>` for a locally created article
  url?: string;
  title: string;
  author?: string;
  publishedAt?: string;    // ISO date if the reader service reports one
  paragraphs: Paragraph[];
  brief?: Brief;
  createdAt: number;
  /** Exact validated upload payload retained for refresh-safe retries. */
  syncDocument?: import("../../shared/contracts/index").ParsedDocument;
  syncSource?: "local" | "browser-jina" | "server-jina" | "server-readability";
  /**
   * The document version these paragraphs were parsed from, when the
   * article came from a server.
   *
   * Carried so a note can be anchored to the version the page is
   * *showing*: a tab left open across a refresh renders version N while
   * the article's current version is N+1, and the selection offsets were
   * measured against N. Without this the server would anchor the note to
   * N+1 and the text would not match.
   */
  versionId?: string;
  /**
   * Server id for the article, populated after an upload of the
   * locally-parsed document succeeds. Absent while the article is purely
   * local (an anonymous reader, or a signed-in reader whose upload has not
   * yet completed). The Reader's URL keeps using `local-<textHash>` as the
   * article key; this field is how an upload implementation learns which
   * server id to attach the user's notes and highlights to. It stays part of
   * the local data format whether or not any such implementation exists, so
   * an uploaded article remains readable — and still rebindable — after the
   * fact.
   */
  remoteId?: string;
  /** The document version id paired with `remoteId`. */
  remoteVersionId?: string;
  /**
   * Where the uploaded document came from. Recorded on the local article so
   * a list surface can show the provenance without a second round trip.
   */
  remoteSource?: "browser-jina" | "server-jina" | "server-readability" | "local";
  /**
   * Terminal state of the most recent upload attempt. Drives the
   * informational note in the article header ("saved locally, sync failed")
   * and is the verdict the next attempt would branch on.
   * Not persisted to the server.
   */
  remoteSyncStatus?: "uploaded" | "duplicate" | "rejected" | "network-error" | "cancelled" | "stale-owner";
};

export type NoteType = "explain" | "ask";

/**
 * A highlight is an *anchor*, not content: it records which characters
 * of which paragraph the user marked, plus a colour. It carries no AI
 * answer, which is why it is a separate type from `Note` — marking a
 * passage should not be coupled to spending tokens on it.
 *
 * Offsets are 0-based, half-open (`[startOffset, endOffset)`) indices
 * into the paragraph's normalised text. See `lib/text-offset.ts` for
 * why plain integer offsets are sufficient in this reader.
 */
export type HighlightColor = "yellow" | "green" | "blue" | "red";

/**
 * How a highlight is drawn. Kept separate from the colour so the two
 * can be combined freely (4 × 3 = 12 looks) and so a later style is a
 * CSS rule plus one entry in `lib/highlight.ts` rather than a new
 * field.
 *
 *   - `watercolor` — an uneven translucent wash, the default
 *   - `line`       — a straight rule along the baseline
 *   - `curve`      — a hand-drawn-looking wavy rule
 */
export type HighlightStyle = "watercolor" | "line" | "curve";

export type Highlight = {
  id: string;
  articleId: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  /** The marked text, captured at creation time for display. */
  selectionText: string;
  color: HighlightColor;
  /**
   * Optional so highlights written before styles shipped still load.
   * The store stays at its current version (bumping it would rewrite the
   * frozen migration assertion in `tests/unit/storage-migration.test.ts`),
   * so there is no `migrate` pass to backfill the field. The renderer
   * resolves the absence through `resolveHighlightStyle` rather than
   * every call site guessing.
   */
  style?: HighlightStyle;
  createdAt: number;
};

export type NoteUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
};

/**
 * One conversation turn.
 *
 * Local turns carry one field the server's `NoteMessage` does not: the
 * *terminal status this client observed for that turn*. Without it the
 * only place a run's outcome survives is the note-level `localStatus`,
 * which describes the **latest** run — so a note whose first answer was
 * cancelled and whose follow-up succeeded could only ever replay its
 * history as "everything succeeded". The catch-up path
 * (`syncPendingNotes`) reads this to push each turn's real fate.
 *
 * It is `Exclude<..., "running">` because `running` is not a terminal
 * state: a turn that is still running has no recorded status at all, and
 * the live stream is what reports its outcome later.
 *
 * Server-returned turns simply never set it; readers must treat its
 * absence as "succeeded", which is what the server's own history means.
 */
export type NoteTurn = SharedNoteMessage & {
  clientTurnId?: string;
  status?: Exclude<SharedNoteStatus, "running">;
};

export type Note = {
  id: string;
  articleId: string;
  paragraphIndex: number;
  type: NoteType;
  selectionText: string;
  question: string;       // the prompt sent to the LLM
  answer: string;         // streamed, accumulated
  model: string;          // which model produced the answer
  isStreaming: boolean;
  usage?: NoteUsage;      // last call's token usage (shows cache hits)
  createdAt: number;
  /**
   * Half-open range of the selection. `null` when the browser could not
   * map the range to the paragraph (see `lib/text-offset.ts`); such a
   * note is still readable locally but is *not* pushed to the server,
   * because the server cannot validate an anchor it cannot reconstruct.
   */
  startParagraphIndex?: number;
  startOffset?: number;
  endParagraphIndex?: number;
  endOffset?: number;
  /** Parse-layer block ids at each end of the range, when known. */
  startBlockId?: string;
  endBlockId?: string;
  /**
   * Set once the note exists on the server. Absent for a purely local
   * note — an anonymous reader's note, or a note whose range could not
   * be validated. Its presence is what decides whether an answer or a
   * delete has to be mirrored to the server.
   */
  remoteId?: string;
  /** The server's `article_version` id the remote note is anchored to. */
  remoteVersionId?: string;
  /** The server's lifecycle state, when this note came from there. */
  remoteStatus?: SharedNoteStatus;
  /**
   * This client's lifecycle state for the note. Distinct from
   * `remoteStatus` on purpose: a note whose server row is still `running`
   * has not been interrupted *here*, and a boolean `isStreaming` cannot
   * express that difference.
   */
  localStatus?: SharedNoteStatus;
  /** How many answers this client has appended to the note. */
  localAnswerCount?: number;
  /** Same idea for follow-up questions the user typed. */
  localQuestionCount?: number;
  /**
   * The turn currently being generated, and how much of it has arrived.
   *
   * Frozen when the stream starts so an interruption can be recorded
   * against *that* turn. The note's `answer` accumulates every turn, so
   * replaying it as "the interrupted run" would append a duplicate of the
   * whole conversation; and a turn id that is re-derived would append the
   * same run twice if a sweep ran twice.
   */
  activeTurnId?: string;
  activeTurnText?: string;
  /**
   * The conversation as structured turns: the original question, the
   * first answer, then each follow-up question and its answer.
   *
   * Maintained for **every** note, not only the ones that came from the
   * server: `answer` is a rendered flattening that loses the boundaries
   * between turns, so a follow-up built from it alone reaches the model
   * without the earlier exchange as context — and a note created while
   * signed out would have no history to migrate later.
   */
  turns?: NoteTurn[];
};

export type ArticleStatus = "idle" | "fetching" | "ready" | "error";

export type ArticleState = {
  article: Article | null;
  status: ArticleStatus;
  error: string | null;
};
