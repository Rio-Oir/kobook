// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Core data model for the Gloss clone

// Shared server contracts; legacy local-reader types below remain separate.
//
// The value re-exports of ROUTES / API_PREFIX are what let the frontend talk
// to the server without re-stating any path string.
//
// The list is deliberately short. It used to re-export the whole wire
// contract — session, admin, article-library, note DTOs — which meant the base
// build carried the shape of an application it cannot call. What remains is
// the content format base parses and renders, the anonymous-extraction DTOs,
// the error envelope, and the note lifecycle vocabulary the local data format
// uses. Account and sync schemas are the value-added line's and are not named
// here.
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
  /**
   * `sha256(text)`, the full 64-hex digest — *not* a prefix.
   *
   * It used to be truncated to 12 characters here, on the theory that the
   * shortened form was enough to anchor a note. It is not enough for the one
   * thing a paragraph now has to be able to do: rebuild a `ContentBlock` for
   * the sync upload, whose schema re-derives this field from `text` and refuses
   * the request when the two disagree. A truncated digest fails that check
   * every time, so a body that could only ever have been rebuilt from the
   * separate `Article.syncDocument` copy could not be uploaded at all once that
   * copy was removed. Storing the digest in full costs ~52 bytes per paragraph
   * — under 60 kB for a 1000-paragraph book — and makes a `Paragraph`
   * sufficient on its own.
   */
  hash: string;
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
  type?: "heading" | "paragraph" | "listItem" | "code" | "quote" | "image" | "table" | "hr";
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
  /** 0-based nesting depth. Only meaningful for `listItem`; absent means 0. */
  depth?: number;
  /** Task-list item. Only meaningful for `listItem`. */
  task?: boolean;
  /** Whether the task box is ticked. Only meaningful when `task` is true. */
  checked?: boolean;
  /** Image source / alt / title. Only meaningful for `type: "image"`. */
  src?: string;
  alt?: string;
  title?: string;
  /**
   * Table cells, row-major; the first row is the header. Only meaningful for
   * `type: "table"`. `text` still carries a flat join of the cells because
   * every block needs non-empty text for its hash.
   */
  rows?: string[][];
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
  id: string;             // server cuid, or `local-<textHash>` when anonymous
  url?: string;
  title: string;
  author?: string;
  publishedAt?: string;    // ISO date if jina.ai finds it
  /**
   * The article's own cover picture (a scraped page's `og:image`, or the first
   * content image), used instead of the bundled paintings. Absolute http(s) or
   * root-relative; absent means "no picture of its own" — the reader then uses
   * the default cover library.
   */
  coverImage?: string;
  brief?: Brief;
  createdAt: number;
  /**
   * How big the body is, in paragraphs and characters, **without the text**.
   *
   * The library lists every article the reader owns and shows "N 段" on each
   * row. Keeping the count on the record is what lets that page answer without
   * touching a single body — which is the difference between a list that costs
   * a few kilobytes and one that deserialises the whole library before it can
   * sort it (which is what it did when `paragraphs` lived here).
   *
   * It is also the one number about an article that stays meaningful when the
   * body is not on this device, which is the state the cloud work needs to
   * render.
   */
  bodyStats: { paragraphs: number; chars: number };
  /**
   * `sha256(JSON.stringify(blocks))` of the document this article was parsed
   * from, so "is this the same document?" is a string comparison.
   *
   * It replaces the old trick of holding the whole `ParsedDocument` on the
   * record (`syncDocument`) purely to have something to compare against —
   * which meant the body was stored twice, in the same `localStorage` key,
   * for every article that had been through the extractor.
   *
   * `textHash` cannot do this job. It covers the *normalised text* of every
   * block, so it is unchanged when only the formatting is: pasting `**粗体**`
   * and then `粗体` produces the same `textHash` and different blocks. The
   * reader needs to tell those apart, because the second paste must not
   * overwrite a row whose notes were measured against the first (see
   * `localArticleKeyFor`).
   *
   * Absent on articles written before it existed, and on any article whose
   * body arrived from somewhere that did not carry blocks. Absence means
   * "cannot prove equality", which takes the safe branch.
   */
  blocksDigest?: string;
  syncSource?: "local" | "browser-jina" | "server-jina" | "server-readability";
  /**
   * The `article_version` these paragraphs were parsed from, when the
   * article came from the server.
   *
   * Carried so a note can be anchored to the version the page is
   * *showing*: a tab left open across a refresh renders version N while
   * the article's current version is N+1, and the selection offsets were
   * measured against N. Without this the server would anchor the note to
   * N+1 and the text would not match.
   */
  versionId?: string;
  /**
   * Server id for the article, populated after the dual-channel
   * extractor uploads the locally-parsed document. Absent while the
   * article is purely local (an anonymous reader, or a logged-in reader
   * whose upload has not yet completed). The Reader's URL keeps using
   * `local-<textHash>` as the article key; this field is how the cloud
   * bridge learns which server id to attach the user's notes and
   * highlights to. It stays part of the local data format even in a build
   * with no cloud implementation, so an article uploaded by a signed-in
   * reader is still readable — and still rebindable — after the fact.
   */
  remoteId?: string;
  /** The `article_version` id paired with `remoteId`. */
  remoteVersionId?: string;
  /**
   * The channel the uploaded document came from. Mirrors
   * `ArticleSyncSource`; recorded on the local article so the
   * "我的文章" surface can show "本地 / 浏览器 Jina / 服务器备用"
   * without a second round trip.
   */
  remoteSource?: "browser-jina" | "server-jina" | "server-readability" | "local";
  /**
   * Terminal state of the most recent upload attempt. Drives the
   * informational note in the article header (e.g. "本机已保存，云端
   * 同步失败") and is the verdict the next sync would branch on.
   * Not persisted to the server.
   */
  remoteSyncStatus?: "uploaded" | "duplicate" | "rejected" | "network-error" | "cancelled" | "stale-owner";
  /**
   * Topical tags produced by the reader's AI tagger (2–4 short Chinese
   * labels such as 宗教 / 哲学 / 佛学).
   *
   * Tags live on the *record*, not on the body, on purpose: the library
   * lists hundreds of records without loading a single body, and the tag
   * filter bar has to group them from the record alone. The tagger reads
   * the body through `readBody` once, then writes only this small field.
   *
   * `undefined` means "not tagged on this device yet", not "no tags". The
   * Reader's on-open effect tags an article the first time it is read with
   * a usable BYOK key, and `ensureArticleTags` skips everything else.
   */
  tags?: string[];
  /** Model id that produced the tags, for "why did it label it that". */
  tagsModel?: string;
  /** Epoch ms of the most recent successful tagging run. */
  tagsAt?: number;
  /**
   * Local edit state relative to the cloud copy.
   *
   * `pending` is set when a paragraph edit changes an article that already has
   * a server id; a later sync pass uploads the whole body as a new version and
   * clears it. Articles that have never been uploaded do not need the flag —
   * their first upload already carries the edited body.
   */
  editStatus?: "pending" | "syncing" | "failed";
  /** When the body was last edited locally. Diagnostics and UI only. */
  editedAt?: number;
  /** Last sync failure message, kept for the header status line. */
  editError?: string;
};

/**
 * An article whose body has not been attached yet.
 *
 * `bodyStats` is deliberately not part of it: the store computes the two
 * numbers from the paragraphs it is handed, in one place, so a caller cannot
 * write a record whose stated size disagrees with the body beside it. A wrong
 * count here is not cosmetic — the library's "N 段" would lie, and the eviction
 * budget would be planned against a number that is not the truth.
 */
export type ArticleDraft = Omit<Article, "bodyStats">;

/**
 * The text of one article, stored apart from its record.
 *
 * ## Why it is a separate thing at all
 *
 * Three reasons, and each one is a bug that the joined version had:
 *
 *  - **Eviction becomes structural.** "Delete the text, keep the record" is a
 *    property of the storage layout — two stores, one key each — rather than a
 *    code path someone has to remember to write correctly.
 *  - **The library never loads text.** Listing articles reads records only, so
 *    the page that shows 200 titles does not deserialise 200 books to do it.
 *  - **The write patterns are opposites.** A body is large, written once and
 *    evictable; a record is small, written on every rename and never evictable.
 *    Sharing one record forced the large one's cost onto the small one's
 *    frequency: every streamed note token re-serialised every body the reader
 *    owned.
 *
 * ## Why the body carries no owner stamp
 *
 * Ownership lives on the record, and the two are keyed by the same article id,
 * so a body is reachable only through a record the current owner can see. A
 * second stamp would be a second thing to keep in step, and the failure mode
 * of them disagreeing is the one that matters — a body that outlives the
 * record it belonged to, readable by whoever holds the id next.
 */
export type ArticleBody = {
  articleId: string;
  paragraphs: Paragraph[];
  /**
   * Serialised size in bytes, recorded at write time.
   *
   * Kept so the eviction pass can decide what to drop without reading anything:
   * a budget check that had to load every body to measure it would defeat the
   * point of having a budget.
   */
  size: number;
  /** When this body was last written. Diagnostics, and the LRU tiebreak. */
  storedAt: number;
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

/**
 * The longest personal remark the data format accepts.
 *
 * Declared here, next to the field it bounds, because three places have to
 * agree on it and disagreeing is not a cosmetic bug: the backup schema
 * *rejects* a longer value, so a remark the editor happily accepted would
 * make the next `createLocalBackup()` throw and take the reader's whole
 * backup down with it. The store clamps to this number as a backstop for
 * programmatic callers, and both remark editors cap their textarea at it so
 * a person cannot type past it in the first place.
 *
 * 20 000 characters is far beyond a passage annotation and far below the
 * article cap, so it can only ever be reached by hand-editing.
 */
export const MAX_HIGHLIGHT_NOTE_LENGTH = 20_000;

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
   * Optional so highlights written before styles shipped still load:
   * the store stays at version 2 (bumping it would rewrite the frozen
   * phase-2 migration assertion), so there is no `migrate` pass to
   * backfill the field. The renderer resolves the absence through
   * `resolveHighlightStyle` rather than every call site guessing.
   */
  style?: HighlightStyle;
  /**
   * The reader's own remark on the marked passage — plain text they
   * typed, with no model involved.
   *
   * Kept on the highlight rather than in a record of its own because
   * the two share one lifecycle: a remark is *about* the marked words,
   * so deleting the mark deletes it, while deleting the remark leaves
   * the mark untouched. A separate collection would need a second
   * orphan sweep to keep that true.
   *
   * Optional, and absent rather than `""` when there is none: the
   * field's presence is what the notebook and the manage-popover read
   * to decide between "添加备注" and "编辑备注", and an empty string
   * would make those two states indistinguishable in a backup file.
   * Its absence on every highlight written before remarks shipped is
   * why no migration is needed and the store stays at version 2.
   */
  note?: string;
  /**
   * Set when an edit to the paragraph made this range unprovable.
   *
   * The record is kept rather than deleted: the remark, colour and creation
   * time are still the user's, and a later version-migration pass may be able
   * to re-anchor it. While the flag is set the renderer draws nothing, because
   * an underline on guessed characters would be worse than none.
   */
  detached?: boolean;
  createdAt: number;
  /**
   * Server row id, written when this mark has been synced to the account
   * (see `lib/cloud-highlights.ts`). Absent on a purely local mark, which is
   * exactly the condition the reconcile pass pushes on.
   */
  remoteId?: string;
  /** The `article_version` the server row is anchored to. */
  remoteVersionId?: string;
  /**
   * The parse-layer block id this mark was created against. Optional: marks
   * written before the field shipped send none, and the server then treats
   * the anchor as unchecked rather than as a mismatch.
   */
  blockId?: string;
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
   * This note's own colour, frozen from `highlightColor` at the moment the
   * reader asked. One colour then identifies the note everywhere it appears:
   * the underline on its passage, the connector to its card, the card's
   * active border, and the question blocks inside it.
   *
   * A note carries its colour rather than reading the live toolbar setting
   * because the toolbar setting is global and moving: it says what the
   * *next* highlight will be, not what this note is. Two notes over
   * adjacent text, asked under different colours, must not change colour
   * together — and a note asked about a red passage has to stay red after
   * the reader arms a different colour for something else.
   *
   * Absent means "no colour was chosen" (a row written before this field,
   * or a server that did not send one), which renders with the default note
   * blue. See `NOTE_COLOR_HEX`.
   */
  color?: HighlightColor;
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
