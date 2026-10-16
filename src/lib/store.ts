// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";
import type { Article, Highlight, HighlightColor, HighlightStyle, Note } from "./types";
import { ANONYMOUS_OWNER } from "./identity";

type AppState = {
  // Current article being read
  currentArticleId: string | null;

  /**
   * The user this local cache belongs to, or `"anonymous"` when no account
   * owns it. Every write goes through `set`, which writes the whole store to
   * `gloss-storage`; the `reconcileOwner` decision (see `lib/identity.ts`)
   * decides whether the next account to resolve should keep, adopt or clear
   * this data. Persisted state from before the stamp existed has no
   * `ownerUserId`; `migrate` below treats the absence as "anonymous, do not
   * destroy".
   */
  ownerUserId: string;

  // Library
  articles: Record<string, Article>;
  notes: Record<string, Note>; // keyed by note.id
  highlights: Record<string, Highlight>; // keyed by highlight.id

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
  saveArticle: (article: Article) => void;
  /**
   * Remove an article and everything anchored to it (its notes and
   * highlights) from the *local* cache.
   *
   * The local library is this store, so without this a deleted row would
   * leave its notes and highlights behind as orphans that no page can reach.
   * It is deliberately local-only: an article that also exists in an account
   * is soft-deleted on the server by that implementation, never by this
   * action.
   */
  deleteArticle: (id: string) => void;
  setBrief: (articleId: string, brief: Article["brief"]) => void;

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
  deleteHighlight: (id: string) => void;

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

export const STORAGE_KEY = "gloss-storage";

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentArticleId: null,
      ownerUserId: ANONYMOUS_OWNER,
      articles: {},
      notes: {},
      highlights: {},
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

      saveArticle: (article) =>
        set((s) => ({
          articles: { ...s.articles, [article.id]: article },
          currentArticleId: article.id,
        })),

      deleteArticle: (id) =>
        set((s) => {
          if (!s.articles[id]) return s;
          const { [id]: _removed, ...articles } = s.articles;
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
            currentArticleId: s.currentArticleId === id ? null : s.currentArticleId,
          };
        }),

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
          if (!existing.isStreaming) {
            set((s) => ({
              notes: {
                ...s.notes,
                [existing.id]: { ...existing, ...note, id: existing.id },
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

      deleteHighlight: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.highlights;
          return { highlights: rest };
        }),

      clearUserCache: () =>
        set({
          currentArticleId: null,
          articles: {},
          notes: {},
          highlights: {},
          highlightColor: "yellow",
          highlightStyle: "watercolor",
          outlineOpen: true,
          ownerUserId: ANONYMOUS_OWNER,
        }),

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
      version: 2,
      // Stores written before the owner stamp existed have no `ownerUserId`.
      // Treat that as "anonymous, do not destroy" so a sign-in does not lose
      // a freshly pasted article.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<AppState>;
        if (version < 2) {
          return {
            ...state,
            ownerUserId: state.ownerUserId ?? ANONYMOUS_OWNER,
          };
        }
        return state as AppState;
      },
    },
  ),
);
