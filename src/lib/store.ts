// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import type {
  Article,
  ArticleBody,
  ArticleDraft,
  Highlight,
  HighlightColor,
  HighlightStyle,
  Note,
  Paragraph,
} from "./types";
import { MAX_HIGHLIGHT_NOTE_LENGTH } from "./types";
import { ANONYMOUS_OWNER } from "./identity";
import { makeBody, purgeBodies, readBody, removeBodies, writeBody } from "./storage/bodies";
import { clearBodyDeletes, recordBodyDeletes } from "./storage/journal";
import { STORAGE_VERSION, WORKSPACE_KEY, stripStoredBodies } from "./storage/migrate";
import {
  applyParagraphEdit as applyEditToParagraphs,
  bodyStatsOf,
  blocksDigestOf,
  blockIdFor,
  type ParagraphEditInput,
} from "./editing/apply-edit";
import { reconcileHighlights, reconcileHighlightsAcrossDocument } from "./editing/anchors";
import type { DocumentBlock } from "./editing/document";
import { sha256Hex } from "./local-import-blocks";

/**
 * Why an article's text is not renderable.
 *
 * Only `never-stored` is reachable in this build, because nothing evicts a body
 * and nothing fetches one from anywhere. The rest are declared now, with their
 * meanings fixed, so that adding eviction or a remote fetch is a change of
 * *behaviour* rather than a change of *type* at every call site.
 *
 * The two that will be easiest to conflate and most important to keep apart:
 * `never-stored` ("this device never had it") and `evicted` ("it was here and
 * was removed to make room"). They call for different words and different
 * actions — the second should be re-fetched quietly, the first on a slow
 * connection should be asked about — and a single `absent` would erase the
 * distinction before anyone could act on it.
 */
export type BodyUnavailableReason =
  | "never-stored"
  | "evicted"
  | "offline"
  | "fetch-failed"
  | "gone"
  | "not-signed-in";

/** Result of one inline edit, for the UI's status line and test seams. */
export type ParagraphEditOutcome =
  | {
      ok: true;
      changed: boolean;
      hash: string;
      reanchored: number;
      detached: number;
    }
  | { ok: false; message: string };

/**
 * What the reader knows about one article's text.
 *
 * `loading` is a state rather than "no entry yet" so that a component can tell
 * "a load is in flight" from "nobody has asked", which is the difference
 * between showing a spinner and showing nothing.
 */
export type BodyEntry =
  | { state: "loading" }
  | { state: "present"; body: ArticleBody }
  | { state: "absent"; why: BodyUnavailableReason };

/** Bodies currently being read from storage, so two components share one read. */
const bodyLoadsInFlight = new Set<string>();

type AppState = {
  // Current article being read
  currentArticleId: string | null;

  /**
   * The user this local cache belongs to, or `"anonymous"` when no account
   * owns it. Every write goes through `set`, which writes the whole store to
   * `gloss-storage`; the `reconcileOwner` decision (see `lib/identity.ts`)
   * decides whether the next account to resolve should keep, adopt or clear
   * this data. Phase-1 persisted state has no owner stamp; `migrate` below
   * treats the absence as "anonymous, do not destroy".
   */
  ownerUserId: string;

  // Library
  /**
   * Article records. **Never their text** — that lives in `bodies`, and in
   * IndexedDB underneath. Keeping the text out of the record is what stops a
   * streamed note token from re-serialising the reader's whole library, and
   * what makes "the text is not on this device" a state the type can express.
   */
  articles: Record<string, Article>;
  notes: Record<string, Note>; // keyed by note.id
  highlights: Record<string, Highlight>; // keyed by highlight.id
  /**
   * Article text, in memory and **not persisted**.
   *
   * Deliberately in the store rather than in each component: the reader,
   * the notebook and the outline all need the same article's paragraphs, and
   * three independent loads would be three reads from IndexedDB and three
   * chances to disagree about whether it is here.
   */
  bodies: Record<string, BodyEntry>;

  /**
   * The colour and shape the next highlight will be drawn in, and the
   * ones the *live text selection* is already painted with — the
   * `::selection` rule keys off `highlightColor` (see `App.tsx`), so
   * dragging a selection previews exactly what a click will produce.
   *
   * Kept in this store rather than a new one so it inherits the
   * existing persistence, owner stamping and `clearUserCache`
   * behaviour instead of growing a fourth near-identical store.
   */
  highlightColor: HighlightColor;
  highlightStyle: HighlightStyle;
  setHighlightPrefs: (prefs: {
    color?: HighlightColor;
    style?: HighlightStyle;
  }) => void;

  /**
   * Whether the article outline is expanded. A reading-surface
   * preference, so it lives with the other one rather than in
   * component state: an outline that re-opens on every article would
   * be a setting the user has to re-apply, not a default.
   */
  outlineOpen: boolean;
  setOutlineOpen: (open: boolean) => void;

  // Actions
  setCurrentArticle: (id: string | null) => void;
  /**
   * Save an article and its text.
   *
   * The record and the in-memory body are installed **synchronously**, so the
   * reader can render the article it was just handed without waiting on a
   * disk. The returned promise settles when the body is durable — callers that
   * navigate away should await it, because the one thing this must not do is
   * report a save that a refresh will not find.
   *
   * `bodyStats` is computed here rather than accepted from the caller: the two
   * numbers describe the body being saved in this same call, and letting them
   * arrive separately is how a record ends up claiming a length its text does
   * not have.
   */
  saveArticle: (article: ArticleDraft, paragraphs: Paragraph[]) => Promise<void>;
  /**
   * Replace one paragraph's text/spans after an inline edit.
   *
   * The write is made durable before the promise settles, and the highlight
   * anchors in that paragraph are reconciled in the same tick: a kept range
   * stays, a uniquely matching quote moves, and anything unprovable is marked
   * `detached`. Notes are left alone — their renderer already validates the
   * quote and refuses to underline a range it cannot prove.
   */
  applyParagraphEdit: (
    articleId: string,
    paragraphIndex: number,
    edit: ParagraphEditInput,
  ) => Promise<ParagraphEditOutcome>;
  /**
   * Replace the whole article body after a document edit.
   *
   * The editor is a document, not a paragraph: blocks may be added, removed,
   * reordered or change type. Block ids of unchanged blocks are preserved (by
   * `type + hash`), which is what keeps their notes anchored; highlights are
   * reconciled across the document with the same never-guess rule.
   */
  replaceArticleBody: (
    articleId: string,
    blocks: readonly DocumentBlock[],
  ) => Promise<ParagraphEditOutcome>;
  /**
   * Ask for one article's text.
   *
   * Idempotent and cheap to call from a render path: a body already in memory,
   * already loading, or already known to be missing is left alone. This is the
   * only entry point that touches storage on the read side, so "who loads
   * bodies" has exactly one answer.
   */
  ensureBody: (articleId: string) => void;
  /**
   * Remove an article and everything anchored to it (its notes and
   * highlights) from the *local* cache.
   *
   * Added for the free channel, whose library is the local store: without
   * it, deleting a row would leave its notes and highlights behind as
   * orphans that no page can reach. It is deliberately local-only — a
   * synced account's server row is soft-deleted by `articles.deleteArticle`
   * instead, so this is never the cloud path.
   */
  deleteArticle: (id: string) => void;
  setBrief: (articleId: string, brief: Article["brief"]) => void;
  /**
   * Replace an article's AI tags. `undefined` clears them (used when a
   * forced run produces nothing usable).
   *
   * A dedicated action rather than a `saveArticle` call so a tag write
   * cannot overwrite paragraphs or a `remoteId` with a copy captured before
   * a long model call returned — the same late-write hazard `setBrief`
   * exists to avoid.
   */
  setArticleTags: (
    articleId: string,
    tags: string[] | undefined,
    meta?: { model?: string; at?: number },
  ) => void;

  addNote: (note: Omit<Note, "id" | "createdAt" | "isStreaming">) => string;
  updateNote: (id: string, patch: Partial<Note>) => void;
  deleteNote: (id: string) => void;
  appendToNote: (id: string, delta: string) => void;
  finishNote: (id: string) => void;
  /**
   * Attach the server's id (and the version it anchored to) to a note
   * that was created locally and has now been persisted. Idempotent, so
   * a retried push cannot produce a duplicate.
   */
  setNoteRemote: (id: string, remoteId: string, remoteVersionId: string) => void;
  /**
   * Attach the server's id (and version) to an article that started as
   * a local-only `local-<textHash>` row. The local id stays in place —
   * the URL hash does not change, so any note or highlight already
   * anchored to the article keeps working — and the cloud bridge reads
   * `remoteId` to discover which server id to push subsequent work
   * against. Base writes it from the verdict an adapter returns; with no
   * adapter installed it is never set, and the article stays local.
   *
   * Idempotent in the same sense as `setNoteRemote`: a second call
   * with the same `remoteId` is a no-op, so a retried upload cannot
   * re-point an already-anchored article at a different server row.
   * A call that *changes* `remoteId` is rejected — the contract is
   * "first server id wins", and a later one would orphan the notes
   * the first one already accepted.
   */
  setArticleRemote: (
    id: string,
    remoteId: string,
    remoteVersionId: string,
    source: "browser-jina" | "server-jina" | "server-readability" | "local",
  ) => void;
  /**
   * Update only the sync status without touching the server id.
   *
   * Used to record a failed upload attempt so the Reader can show
   * "本机已保存，云端同步失败" without the article appearing to have
   * been synced. The `remoteId` is left untouched — a future retry
   * with the same `clientKey` will populate it (or a different one if
   * the content has changed in the meantime).
   */
  setArticleSyncStatus: (
    id: string,
    status: "uploaded" | "duplicate" | "rejected" | "network-error" | "cancelled" | "stale-owner",
  ) => void;
  /**
   * Record where a locally edited article stands relative to the cloud.
   *
   * `pending` means the body changed while a server copy exists and no upload
   * has succeeded yet; `failed` carries the transport's message so the reader
   * can show it without inventing a cause. The local body is never reverted by
   * these transitions.
   */
  markArticleEditStatus: (
    id: string,
    status: "pending" | "syncing" | "failed",
    message?: string,
  ) => void;
  /**
   * Point the local record at the version an edit produced on the server.
   *
   * `versionId` is what the Reader compares a note's `remoteVersionId` against,
   * so updating it moves the "current version" line without touching the old
   * version's notes.
   */
  applyArticleEditVersion: (id: string, versionId: string) => void;
  /**
   * Insert or refresh a note that came *from* the server, keyed by its
   * remote id so re-syncing the list does not duplicate cards. Local
   * notes are never matched by position or by text — only by the id the
   * server itself assigned.
   */
  upsertRemoteNote: (note: Note) => string;
  /**
   * Append one conversation turn.
   *
   * Turns are kept for every note — anonymous ones included — because the
   * structure is what a follow-up needs as context and what a later sync
   * sends to the server. A note whose history lives only in the flattened
   * `answer` cannot be replayed or continued faithfully.
   */
  appendTurn: (
    id: string,
    turn: { role: "user" | "assistant"; content: string; status?: Note["localStatus"]; turnId?: string },
  ) => void;

  /** Create a highlight; returns its id so the caller can select it. */
  addHighlight: (
    highlight: Omit<Highlight, "id" | "createdAt">,
  ) => string;
  /** Recolour an existing highlight. */
  setHighlightColor: (id: string, color: Highlight["color"]) => void;
  /** Restyle an existing highlight (watercolour / line / curve). */
  setHighlightStyle: (id: string, style: HighlightStyle) => void;
  /**
   * Set, replace or remove the reader's personal remark on a highlight.
   *
   * `undefined` *deletes* the field rather than storing an empty string,
   * which is what keeps "has no remark" one state instead of two. It never
   * touches the highlight itself: removing what the reader wrote about a
   * passage must not remove the passage's mark. Deleting the highlight
   * (`deleteHighlight`) is the call that takes both, because the record
   * holding the remark is the record being deleted.
   */
  setHighlightNote: (id: string, note: string | undefined) => void;
  deleteHighlight: (id: string) => void;
  /** Bind a local mark to its server row after a successful create. */
  setHighlightRemote: (id: string, remoteId: string, remoteVersionId: string) => void;
  /**
   * Merge marks pulled from the account into the local store.
   *
   * Bound marks are updated in place and a bound mark the server no longer
   * has is removed (it was deleted on another device). Local marks with no
   * `remoteId` are left alone: they are this device's unsent work, and the
   * reconcile pass pushes them rather than dropping them.
   */
  applyRemoteHighlights: (articleId: string, incoming: Highlight[]) => void;

  /**
   * Drop articles, notes, highlights and the current-article pointer, and
   * reset the owner stamp to "anonymous". Used on sign-out and on a switch
   * to a different account.
   */
  clearUserCache: () => void;
  /** Attach the resolved user id as the new owner. */
  setOwner: (userId: string) => void;

  // Selectors (used by components)
  getNotesForArticle: (articleId: string) => Note[];
  getHighlightsForArticle: (articleId: string) => Highlight[];
  getArticle: (id: string) => Article | undefined;
};

/**
 * The part of the store that is written to `localStorage`.
 *
 * Everything except the article text, which is in IndexedDB behind `bodies`.
 * Stated as a type rather than implied by `partialize` so that adding a field
 * to `AppState` is a deliberate decision about whether it is persisted — the
 * accidental default would be "yes", which is how a large field ends up in the
 * blob nobody meant to put it in.
 */
type PersistedAppState = Pick<
  AppState,
  | "currentArticleId"
  | "ownerUserId"
  | "articles"
  | "notes"
  | "highlights"
  | "highlightColor"
  | "highlightStyle"
  | "outlineOpen"
>;

export const STORAGE_KEY = WORKSPACE_KEY;

/**
 * The persisted projection of a state object.
 *
 * One definition, used by `persist`'s `partialize` and by the restore path in
 * `local-backup.ts`, which has to write the same shape to `localStorage`
 * itself in order to publish disk-before-memory. Two copies of this list would
 * be a field that a backup restore silently drops.
 */
export function persistedState(state: AppState): PersistedAppState {
  return {
    currentArticleId: state.currentArticleId,
    ownerUserId: state.ownerUserId,
    articles: state.articles,
    notes: state.notes,
    highlights: state.highlights,
    highlightColor: state.highlightColor,
    highlightStyle: state.highlightStyle,
    outlineOpen: state.outlineOpen,
  };
}

export const useStore = create<AppState>()(
  persist<AppState, [], [], PersistedAppState>(
    (set, get) => ({
      currentArticleId: null,
      ownerUserId: ANONYMOUS_OWNER,
      articles: {},
      notes: {},
      highlights: {},
      bodies: {},
      highlightColor: "yellow",
      highlightStyle: "watercolor",
      outlineOpen: true,

      setHighlightPrefs: ({ color, style }) =>
        set((s) => ({
          highlightColor: color ?? s.highlightColor,
          highlightStyle: style ?? s.highlightStyle,
        })),
      setOutlineOpen: (open) => set({ outlineOpen: open }),

      setCurrentArticle: (id) => set({ currentArticleId: id }),

      saveArticle: async (article, paragraphs) => {
        const body = makeBody(article.id, paragraphs);
        const record: Article = {
          ...article,
          bodyStats: {
            paragraphs: paragraphs.length,
            chars: paragraphs.reduce((total, p) => total + p.text.length, 0),
          },
        };
        // Memory first, synchronously: the caller may navigate to the reader
        // in the same tick, and a body that is "still loading" for the article
        // the user just opened would render as a blank page for a frame.
        set((s) => ({
          articles: { ...s.articles, [article.id]: record },
          bodies: { ...s.bodies, [article.id]: { state: "present", body } },
          currentArticleId: article.id,
        }));
        // Then durability. A rejection is the caller's to handle — swallowing
        // it here is precisely the bug this whole change exists to remove:
        // an article that looks saved and is gone after a refresh.
        await writeBody(body);
      },

      applyParagraphEdit: async (articleId, paragraphIndex, edit) => {
        const state = get();
        const article = state.articles[articleId];
        const entry = state.bodies[articleId];
        if (!article || !entry || entry.state !== "present") {
          return { ok: false, message: "正文尚未加载，这次编辑没有保存。" };
        }

        const result = applyEditToParagraphs(entry.body.paragraphs, paragraphIndex, edit);
        if (!result.ok) return { ok: false, message: result.message };
        if (!result.changed) {
          return {
            ok: true,
            changed: false,
            hash: result.paragraph.hash,
            reanchored: 0,
            detached: 0,
          };
        }

        const inArticle = Object.values(state.highlights).filter(
          (highlight) => highlight.articleId === articleId,
        );
        const reconciled = reconcileHighlights(inArticle, paragraphIndex, edit.text);

        const body = makeBody(articleId, result.paragraphs);
        const nextArticle: Article = {
          ...article,
          bodyStats: result.stats,
          blocksDigest: result.blocksDigest,
          editedAt: Date.now(),
          // Only articles that already exist on the server need a sync pass;
          // a local-only article's first upload carries the edited body.
          ...(article.remoteId
            ? { editStatus: "pending" as const, editError: undefined }
            : {}),
        };

        set((s) => {
          const highlights = { ...s.highlights };
          for (const highlight of reconciled.next) highlights[highlight.id] = highlight;
          return {
            articles: { ...s.articles, [articleId]: nextArticle },
            bodies: { ...s.bodies, [articleId]: { state: "present", body } },
            highlights,
          };
        });
        await writeBody(body);

        return {
          ok: true,
          changed: true,
          hash: result.paragraph.hash,
          reanchored: reconciled.reanchored,
          detached: reconciled.detached,
        };
      },

      replaceArticleBody: async (articleId, blocks) => {
        const state = get();
        const article = state.articles[articleId];
        const entry = state.bodies[articleId];
        if (!article || !entry || entry.state !== "present") {
          return { ok: false, message: "正文尚未加载，这次编辑没有保存。" };
        }
        if (blocks.length === 0) {
          return { ok: false, message: "文章不能为空。" };
        }

        // Reuse an existing id for any block whose type+text is unchanged, so
        // notes keep their anchor when a paragraph only moved.
        const spareIds = new Map<string, string[]>();
        for (const paragraph of entry.body.paragraphs) {
          const key = `${paragraph.type ?? "paragraph"}:${paragraph.hash}`;
          const ids = spareIds.get(key) ?? [];
          if (paragraph.blockId) ids.push(paragraph.blockId);
          spareIds.set(key, ids);
        }

        const paragraphs: Paragraph[] = blocks.map((block, offset) => {
          const index = offset + 1;
          const hash = sha256Hex(block.text);
          const reused = spareIds.get(`${block.type}:${hash}`)?.shift();
          const paragraph: Paragraph = {
            index,
            text: block.text,
            hash,
            type: block.type,
            blockId: reused ?? blockIdFor(index, hash),
          };
          if (block.spans.length > 0) paragraph.spans = block.spans;
          if (block.type === "heading") paragraph.level = block.level ?? 1;
          if (block.type === "code") paragraph.lang = block.lang ?? null;
          if (block.type === "listItem") {
            paragraph.ordered = block.ordered ?? false;
            paragraph.depth = block.depth ?? 0;
            if (block.task) {
              paragraph.task = true;
              paragraph.checked = block.checked === true;
            }
          }
          if (block.type === "image") {
            if (block.src) paragraph.src = block.src;
            if (block.alt) paragraph.alt = block.alt;
            if (block.title) paragraph.title = block.title;
          }
          if (block.type === "table" && block.rows && block.rows.length > 0) {
            paragraph.rows = block.rows;
          }
          return paragraph;
        });

        const inArticle = Object.values(state.highlights).filter(
          (highlight) => highlight.articleId === articleId,
        );
        const reconciled = reconcileHighlightsAcrossDocument(inArticle, paragraphs);

        const body = makeBody(articleId, paragraphs);
        const digest = blocksDigestOf(paragraphs);
        const nextArticle: Article = {
          ...article,
          bodyStats: bodyStatsOf(paragraphs),
          blocksDigest: digest,
          editedAt: Date.now(),
          ...(article.remoteId
            ? { editStatus: "pending" as const, editError: undefined }
            : {}),
        };

        set((s) => {
          const highlights = { ...s.highlights };
          for (const highlight of reconciled.next) highlights[highlight.id] = highlight;
          return {
            articles: { ...s.articles, [articleId]: nextArticle },
            bodies: { ...s.bodies, [articleId]: { state: "present", body } },
            highlights,
          };
        });
        await writeBody(body);

        return {
          ok: true,
          changed: true,
          hash: digest,
          reanchored: reconciled.reanchored,
          detached: reconciled.detached,
        };
      },

      ensureBody: (articleId) => {        if (get().bodies[articleId]) return;
        if (bodyLoadsInFlight.has(articleId)) return;
        bodyLoadsInFlight.add(articleId);
        set((s) => ({ bodies: { ...s.bodies, [articleId]: { state: "loading" } } }));
        void readBody(articleId)
          .then((body) => {
            set((s) => {
              // The article may have been deleted while the read was in
              // flight. A body with no record is unreachable, so dropping the
              // entry is both correct and enough — no separate tombstone is
              // needed, because `deleteArticle` and `clearUserCache` remove the
              // record in the same synchronous tick they drop the body.
              if (!s.articles[articleId]) {
                const { [articleId]: _dropped, ...rest } = s.bodies;
                return { bodies: rest };
              }
              return {
                bodies: {
                  ...s.bodies,
                  [articleId]: body
                    ? { state: "present", body }
                    : { state: "absent", why: "never-stored" },
                },
              };
            });
          })
          .catch(() => {
            // Storage itself failed, as opposed to "nothing there". Reported as
            // its own reason so a later build can retry rather than conclude the
            // article was never stored.
            set((s) => ({
              bodies: { ...s.bodies, [articleId]: { state: "absent", why: "fetch-failed" } },
            }));
          })
          .finally(() => bodyLoadsInFlight.delete(articleId));
      },

      deleteArticle: (id) => {
        if (!get().articles[id]) return;
        // Recorded *before* the in-memory clear, and synchronously: the
        // deletion of the body cannot be synchronous (IndexedDB is not), so a
        // tab that closes in between has to find the intent on disk.
        recordBodyDeletes([id]);
        set((s) => {
          const { [id]: _removed, ...articles } = s.articles;
          const { [id]: _body, ...bodies } = s.bodies;
          const notes: Record<string, Note> = {};
          for (const [noteId, note] of Object.entries(s.notes)) {
            if (note.articleId !== id) notes[noteId] = note;
          }
          const highlights: Record<string, Highlight> = {};
          for (const [highlightId, highlight] of Object.entries(s.highlights)) {
            if (highlight.articleId !== id) highlights[highlightId] = highlight;
          }
          return {
            articles,
            notes,
            highlights,
            bodies,
            currentArticleId: s.currentArticleId === id ? null : s.currentArticleId,
          };
        });
        void removeBodies([id])
          .then(() => clearBodyDeletes([id]))
          .catch(() => undefined);
      },

      setBrief: (articleId, brief) =>
        set((s) => {
          const existing = s.articles[articleId];
          if (!existing) return s;
          return {
            articles: {
              ...s.articles,
              [articleId]: { ...existing, brief },
            },
          };
        }),

      setArticleTags: (articleId, tags, meta) =>
        set((s) => {
          const existing = s.articles[articleId];
          if (!existing) return s;
          // Drop empties/duplicates and keep the list short. The tagger
          // already sanitises, but this is the last gate before the value
          // becomes persisted state that the filter bar reads.
          const clean = tags
            ? Array.from(
                new Set(
                  tags
                    .map((t) => t.trim().replace(/^#/, "").replace(/[，,。.；;]+$/, ""))
                    .filter((t) => t.length > 0),
                ),
              ).slice(0, 4)
            : undefined;
          const applied = clean && clean.length > 0 ? clean : undefined;
          return {
            articles: {
              ...s.articles,
              [articleId]: {
                ...existing,
                tags: applied,
                tagsModel: applied ? meta?.model ?? existing.tagsModel : undefined,
                tagsAt: applied ? meta?.at ?? Date.now() : undefined,
              },
            },
          };
        }),

      addNote: (note) => {
        const id = nanoid(8);
        const now = Date.now();
        set((s) => ({
          notes: {
            ...s.notes,
            [id]: {
              ...note,
              id,
              isStreaming: true,
              createdAt: now,
              // The original question is turn 1 from the moment the note
              // exists. Seeding it here — rather than in the cloud bridge —
              // is what makes an anonymous note's history complete too.
              localStatus: "running",
              localQuestionCount: 1,
              turns: [
                {
                  id: `${id}-q1`,
                  noteId: id,
                  role: "user",
                  content: note.question,
                  sequence: 1,
                  createdAt: new Date(now).toISOString(),
                },
              ],
            },
          },
        }));
        return id;
      },

      updateNote: (id, patch) =>
        set((s) => {
          const existing = s.notes[id];
          if (!existing) return s;
          return {
            notes: { ...s.notes, [id]: { ...existing, ...patch } },
          };
        }),

      deleteNote: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.notes;
          return { notes: rest };
        }),

      appendToNote: (id, delta) =>
        set((s) => {
          const existing = s.notes[id];
          if (!existing) return s;
          return {
            notes: {
              ...s.notes,
              [id]: { ...existing, answer: existing.answer + delta },
            },
          };
        }),

      finishNote: (id) =>
        set((s) => {
          const existing = s.notes[id];
          if (!existing) return s;
          return {
            notes: {
              ...s.notes,
              [id]: { ...existing, isStreaming: false },
            },
          };
        }),

      setNoteRemote: (id, remoteId, remoteVersionId) =>
        set((s) => {
          const existing = s.notes[id];
          if (!existing) return s;
          // Already pointing at a remote row: leave it alone. A retried
          // push must not be able to re-point an established anchor at a
          // second server row.
          if (existing.remoteId) return s;
          return {
            notes: {
              ...s.notes,
              [id]: { ...existing, remoteId, remoteVersionId },
            },
          };
        }),

      setArticleRemote: (id, remoteId, remoteVersionId, source) =>
        set((s) => {
          const existing = s.articles[id];
          if (!existing) return s;
          // The first server id wins. A second upload returning a
          // different id is a server bug or a misrouted retry — the
          // safe move is to ignore it, because writing it would orphan
          // the notes the first id already accepted.
          if (existing.remoteId && existing.remoteId !== remoteId) return s;
          return {
            articles: {
              ...s.articles,
              // `versionId` is the field the Reader keys on to
              // decide which notes belong to the version on screen
              // (see `Reader.tsx`'s `displayedVersionId`). The
              // upload's `versionId` is the server's
              // `articleVersionId`; mirroring it locally is what
              // makes the "notes from other versions stay
              // reachable" filter work for a freshly synced
              // local article too.
              [id]: {
                ...existing,
                remoteId,
                remoteVersionId,
                versionId: existing.versionId ?? remoteVersionId,
                remoteSource: source,
                remoteSyncStatus: "uploaded",
              },
            },
          };
        }),

      setArticleSyncStatus: (id, status) =>
        set((s) => {
          const existing = s.articles[id];
          if (!existing) return s;
          return {
            articles: {
              ...s.articles,
              [id]: { ...existing, remoteSyncStatus: status },
            },
          };
        }),

      markArticleEditStatus: (id, status, message) =>
        set((s) => {
          const existing = s.articles[id];
          if (!existing) return s;
          return {
            articles: {
              ...s.articles,
              [id]: {
                ...existing,
                editStatus: status,
                editError: status === "failed" ? message : undefined,
              },
            },
          };
        }),

      applyArticleEditVersion: (id, versionId) =>
        set((s) => {
          const existing = s.articles[id];
          if (!existing) return s;
          return {
            articles: {
              ...s.articles,
              [id]: {
                ...existing,
                versionId,
                remoteVersionId: versionId,
                editStatus: undefined,
                editError: undefined,
              },
            },
          };
        }),

      appendTurn: (id, turn) =>
        set((s) => {
          const existing = s.notes[id];
          if (!existing) return s;
          const turns = existing.turns ?? [];
          const sequence = turns.length + 1;
          const next: Note["turns"] = [
            ...turns,
            {
              id: `${id}-t${sequence}`,
              noteId: id,
              role: turn.role,
              content: turn.content,
              sequence,
              createdAt: new Date().toISOString(),
              ...(turn.turnId ? { clientTurnId: turn.turnId } : {}),
              ...(turn.role === 'assistant' && turn.status && turn.status !== 'running' ? {status:turn.status}:{}),
            },
          ];
          const patch: Partial<Note> = { turns: next };
          if (turn.role === "assistant") {
            patch.localAnswerCount = (existing.localAnswerCount ?? 0) + 1;
            if (turn.status) patch.localStatus = turn.status;
          } else {
            patch.localQuestionCount = (existing.localQuestionCount ?? 0) + 1;
          }
          return { notes: { ...s.notes, [id]: { ...existing, ...patch } } };
        }),

      upsertRemoteNote: (note) => {
        if (!note.remoteId) throw new Error("upsertRemoteNote requires a remoteId");
        const existing = Object.values(get().notes).find(
          (n) => n.remoteId === note.remoteId,
        );
        if (existing) {
          // Keep the local identity (id, local createdAt) and overlay the
          // server's content. A streaming answer that is mid-flight
          // locally must not be clobbered by a stale list response.
          //
          // `articleId` is part of the local identity, not the server's: the
          // Reader filters notes by the id of the article *it* is showing
          // (`local-<hash>` for a pasted article), while the server row names
          // the server id. Overlaying the server's value orphaned the note from
          // the article it was written on — it stayed in the store and stopped
          // being rendered.
          if (!existing.isStreaming) {
            set((s) => ({
              notes: {
                ...s.notes,
                [existing.id]: {
                  ...existing,
                  ...note,
                  id: existing.id,
                  articleId: existing.articleId,
                },
              },
            }));
          }
          return existing.id;
        }
        const id = note.id && note.id.length > 0 ? note.id : `remote-${note.remoteId}`;
        set((s) => ({
          notes: { ...s.notes, [id]: { ...note, id, isStreaming: false } },
        }));
        return id;
      },

      addHighlight: (highlight) => {
        const id = nanoid(8);
        set((s) => ({
          highlights: {
            ...s.highlights,
            [id]: { ...highlight, id, createdAt: Date.now() },
          },
        }));
        return id;
      },

      setHighlightColor: (id, color) =>
        set((s) => {
          const existing = s.highlights[id];
          if (!existing) return s;
          return {
            highlights: { ...s.highlights, [id]: { ...existing, color } },
          };
        }),

      setHighlightStyle: (id, style) =>
        set((s) => {
          const existing = s.highlights[id];
          if (!existing) return s;
          return {
            highlights: { ...s.highlights, [id]: { ...existing, style } },
          };
        }),

      setHighlightNote: (id, note) =>
        set((s) => {
          const existing = s.highlights[id];
          if (!existing) return s;
          const next = { ...existing };
          // Delete rather than assign `undefined`: the two serialise the
          // same way through `JSON.stringify`, but the in-memory record is
          // read with `"note" in highlight` in places, and one absence is
          // easier to reason about than two.
          if (note === undefined) delete next.note;
          // Clamped here, not only in the editor: the backup schema refuses
          // a longer remark outright, so a caller that got past the UI would
          // be writing a record that makes the reader's *entire* backup
          // refuse to build. Truncating is the lesser failure, and the
          // editor's own `maxLength` means a person never reaches it.
          else next.note = note.slice(0, MAX_HIGHLIGHT_NOTE_LENGTH);
          return { highlights: { ...s.highlights, [id]: next } };
        }),

      deleteHighlight: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.highlights;
          return { highlights: rest };
        }),

      setHighlightRemote: (id, remoteId, remoteVersionId) =>
        set((s) => {
          const existing = s.highlights[id];
          if (!existing) return s;
          return {
            highlights: {
              ...s.highlights,
              [id]: { ...existing, remoteId, remoteVersionId },
            },
          };
        }),

      applyRemoteHighlights: (articleId, incoming) =>
        set((s) => {
          const next = { ...s.highlights };
          const idByRemote = new Map<string, string>();
          for (const [id, highlight] of Object.entries(next)) {
            if (highlight.articleId === articleId && highlight.remoteId) {
              idByRemote.set(highlight.remoteId, id);
            }
          }
          const seen = new Set<string>();
          for (const row of incoming) {
            if (!row.remoteId) continue;
            seen.add(row.remoteId);
            const existingId = idByRemote.get(row.remoteId);
            if (existingId) {
              const local = next[existingId];
              if (!local) continue;
              const merged: Highlight = {
                ...local,
                paragraphIndex: row.paragraphIndex,
                startOffset: row.startOffset,
                endOffset: row.endOffset,
                selectionText: row.selectionText,
                color: row.color,
                detached: row.detached ?? false,
                remoteVersionId: row.remoteVersionId,
              };
              if (row.style) merged.style = row.style;
              // One representation of "no remark": the field is absent, not
              // an empty string — the notebook reads its presence.
              if (row.note) merged.note = row.note;
              else delete merged.note;
              next[existingId] = merged;
              continue;
            }
            const id = `remote-hl-${row.remoteId}`;
            next[id] = { ...row, id };
          }
          // A bound mark missing from the server list was deleted elsewhere.
          for (const [id, highlight] of Object.entries(next)) {
            if (
              highlight.articleId === articleId &&
              highlight.remoteId &&
              !seen.has(highlight.remoteId)
            ) {
              delete next[id];
            }
          }
          return { highlights: next };
        }),

      clearUserCache: () => {
        const ids = Object.keys(get().articles);
        // Same contract as `deleteArticle`: the intent is synchronous, the
        // physical deletion is not. `applyOwnership` calls this and must not
        // start awaiting, so the journal is what makes it crash-safe instead.
        recordBodyDeletes(ids);
        set({
          currentArticleId: null,
          articles: {},
          notes: {},
          highlights: {},
          bodies: {},
          highlightColor: "yellow",
          highlightStyle: "watercolor",
          outlineOpen: true,
          ownerUserId: ANONYMOUS_OWNER,
        });
        // The physical deletion is queued rather than started here, so it
        // cannot overtake a later write — a restore that lands while a
        // sign-out's cleanup is still running would otherwise have its bodies
        // deleted by the wipe. See `purgeBodies`.
        void purgeBodies(ids).catch(() => undefined);
      },

      setOwner: (userId) => set({ ownerUserId: userId }),

      getNotesForArticle: (articleId) =>
        Object.values(get().notes)
          .filter((n) => n.articleId === articleId)
          .sort((a, b) => a.createdAt - b.createdAt),

      getHighlightsForArticle: (articleId) =>
        Object.values(get().highlights)
          .filter((h) => h.articleId === articleId)
          .sort((a, b) => a.createdAt - b.createdAt),

      getArticle: (id) => get().articles[id],
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      /**
       * Hydration is explicit, from `bootstrapStorage()` in `main.tsx`.
       *
       * Not a preference. Moving the bodies out of this blob is a two-sided
       * operation — write them to IndexedDB, then shrink the blob — and
       * `localStorage` is readable synchronously while IndexedDB is not. If
       * persist hydrated on module import, it would read the blob before the
       * migration could run and load articles that still carry `paragraphs`
       * into a shape that no longer has the field, with nowhere to put the
       * text. So the order is fixed at the entry point instead: migrate, then
       * delete anything a crashed wipe left behind, then hydrate.
       */
      skipHydration: true,
      partialize: (state): PersistedAppState => persistedState(state),
      /**
       * Turn whatever was on disk into a store state.
       *
       * `stripStoredBodies` is the defensive half of the body migration: it
       * removes `paragraphs` and `syncDocument` from every article it is
       * given and stages the text for a flush. In the normal path the blob has
       * already been through `migrateBodiesToIdb()` and this finds nothing to
       * do. It matters for the paths where that is not true — a blob written
       * by an older build that was never opened in between, a test that seeded
       * `localStorage` directly, a migration that was interrupted — because
       * the alternative to staging the text there is dropping it.
       */
      merge: (persisted, current) => {
        const state = (persisted ?? {}) as Partial<PersistedAppState> & {
          articles?: Record<string, unknown>;
        };
        return {
          ...current,
          ...state,
          articles: stripStoredBodies(state.articles),
          // Bodies are never read back from the blob, whatever a hand-edited
          // file claims. They are loaded by `ensureBody` and only by it.
          bodies: {},
        };
      },
      // Phase-1 stores have no `ownerUserId`. Treat that as "anonymous, do
      // not destroy" so a sign-up does not lose a freshly pasted article.
      //
      // The step from 2 to 3 is the body move, and it is *not* done here: it
      // cannot be, because it needs to await IndexedDB. `bootstrapStorage()`
      // performs it before this runs. What is left for this function is the
      // version bump, which is what makes persist write the new shape back.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<PersistedAppState>;
        if (version < 2) {
          return {
            ...state,
            ownerUserId: state.ownerUserId ?? ANONYMOUS_OWNER,
          } as PersistedAppState;
        }
        return state as PersistedAppState;
      },
    },
  ),
);
