// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The anonymous→account migration against a controlled server double.
 *
 * The properties under test only appear when something goes wrong, which
 * is exactly when a migration must not lose data:
 *
 *   - **A lost response must not duplicate.** The dangerous window is "the
 *     server created the row and the reply never arrived" — the client has
 *     nothing to record, so only the *server's* idempotency key can stop
 *     the retry from creating a second row. The double implements replay
 *     for articles, notes and messages, and the tests assert the server
 *     saw one row per item.
 *   - **A partial run must not claim success.** When a turn fails, the
 *     account is not marked migrated, the workspace is not discarded, and
 *     a retry resumes rather than restarts.
 *   - **The conversation travels.** A note that migrates without its
 *     follow-ups is a question with no answer, so every turn is replayed,
 *     including the follow-up questions the user typed.
 *   - **An account switch aborts everything.** The remaining requests
 *     would otherwise go out on the new account's cookie carrying the old
 *     account's content.
 *   - **Block ids are remapped.** Block ids are version-scoped, so a
 *     re-import can produce different ones; sending the originals would
 *     make every ranged note fail validation.
 *   - **The credential never travels.**
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const memory = new Map<string, string>();
const localStoragePolyfill = {
  getItem: (k: string): string | null => memory.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    memory.set(k, v);
  },
  removeItem: (k: string): void => {
    memory.delete(k);
  },
  clear: (): void => memory.clear(),
  key: (i: number): string | null => Array.from(memory.keys())[i] ?? null,
  get length(): number {
    return memory.size;
  },
};

interface FakeArticle {
  id: string;
  clientKey: string | null;
  title: string;
  paragraphs: { index: number; id: string; text: string }[];
}
interface FakeNote {
  id: string;
  articleId: string;
  clientKey: string | null;
  question: string;
  selectionText: string;
  versionId: string;
}
interface FakeMessage {
  noteId: string;
  role: string;
  content: string;
  sequence: number;
  clientKey: string | null;
}

interface FakeServer {
  server: Server;
  base: string;
  articles: FakeArticle[];
  notes: FakeNote[];
  messages: FakeMessage[];
  requests: { path: string; body: Record<string, unknown> }[];
  failNoteOnce: { key: string; status: number } | null;
  failMessageOnce: { key: string; status: number } | null;
  dropMessageOnce: { key: string } | null;
  dropArticleOnce: { key: string } | null;
  delayArticleImportMs: number;
  close(): Promise<void>;
}

let fake: FakeServer;
let realFetch: typeof fetch;

/** Split pasted Markdown the way the real importer would, deterministically. */
function parseBlocks(content: string): { index: number; id: string; text: string }[] {
  const parts = content
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#+\s*/, "").trim())
    .filter((p) => p.length > 0);
  return parts.map((text, i) => ({
    index: i + 1,
    // Deliberately *different* from the local ids a client would hold:
    // block ids are version-scoped, and the migration has to remap them.
    id: `b${i + 1}-imported${i}`,
    text,
  }));
}

async function startFake(): Promise<FakeServer> {
  const state: FakeServer = {
    server: createServer(),
    base: "",
    articles: [],
    notes: [],
    messages: [],
    requests: [],
    failNoteOnce: null,
    failMessageOnce: null,
    dropMessageOnce: null,
    dropArticleOnce: null,
    delayArticleImportMs: 0,
    close: () =>
      new Promise<void>((resolve) => {
        state.server.closeAllConnections?.();
        state.server.close(() => resolve());
      }),
  };

  state.server.on("request", (req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = (raw.length > 0 ? JSON.parse(raw) : {}) as Record<string, unknown>;
      state.requests.push({ path: url, body });

      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const apiError = (status: number): void =>
        send(status, { error: { code: "INTERNAL", message: "boom", requestId: "r" } });

      if (url === "/api/articles/import" && req.method === "POST") {
        const clientKey = (body["clientKey"] as string | undefined) ?? null;
        if (state.delayArticleImportMs > 0) {
          await new Promise((r) => setTimeout(r, state.delayArticleImportMs));
        }
        if (state.dropArticleOnce && state.dropArticleOnce.key === clientKey) {
          state.dropArticleOnce = null;
          const existing = state.articles.find((a) => a.clientKey === clientKey);
          if (!existing) {
            state.articles.push({
              id: `art-${state.articles.length + 1}`,
              clientKey,
              title: String(body["title"] ?? ""),
              paragraphs: parseBlocks(String(body["content"] ?? "")),
            });
          }
          req.socket.destroy();
          return;
        }
        const replay = clientKey
          ? state.articles.find((a) => a.clientKey === clientKey)
          : undefined;
        const article =
          replay ??
          (() => {
            const created: FakeArticle = {
              id: `art-${state.articles.length + 1}`,
              clientKey,
              title: String(body["title"] ?? ""),
              paragraphs: parseBlocks(String(body["content"] ?? "")),
            };
            state.articles.push(created);
            return created;
          })();
        return send(200, {
          article: {
            id: article.id,
            title: article.title,
            source: "text",
            sourceUrl: null,
            importedAt: new Date().toISOString(),
          },
          version: {
            id: `ver-${article.id}`,
            articleId: article.id,
            version: 1,
            source: "markdown-remark",
            importedAt: new Date().toISOString(),
            paragraphs: article.paragraphs.map((p) => ({
              id: p.id,
              index: p.index,
              type: "paragraph",
              text: p.text,
              hash: `h${p.index}`,
            })),
          },
        });
      }

      const noteCreate = /^\/api\/articles\/([^/]+)\/notes$/.exec(url);
      if (noteCreate && req.method === "POST") {
        const articleId = noteCreate[1]!;
        const clientKey = (body["clientKey"] as string | undefined) ?? null;
        if (state.failNoteOnce && state.failNoteOnce.key === clientKey) {
          const status = state.failNoteOnce.status;
          state.failNoteOnce = null;
          return apiError(status);
        }
        const replay = clientKey
          ? state.notes.find((n) => n.articleId === articleId && n.clientKey === clientKey)
          : undefined;
        const note =
          replay ??
          (() => {
            const created: FakeNote = {
              id: `note-${state.notes.length + 1}`,
              articleId,
              clientKey,
              question: String(body["question"] ?? ""),
              selectionText: String(body["selectionText"] ?? ""),
              versionId: String(body["articleVersionId"] ?? `ver-${articleId}`),
            };
            state.notes.push(created);
            state.messages.push({
              noteId: created.id,
              role: "user",
              content: created.question,
              sequence: 1,
              clientKey: null,
            });
            return created;
          })();
        return send(200, {
          note: {
            id: note.id,
            articleId,
            versionId: note.versionId,
            paragraphIndex: Number(body["paragraphIndex"] ?? 1),
            startParagraphIndex: Number(body["startParagraphIndex"] ?? 1),
            startOffset: Number(body["startOffset"] ?? 0),
            endParagraphIndex: Number(body["endParagraphIndex"] ?? 1),
            endOffset: Number(body["endOffset"] ?? 0),
            startBlockId: String(body["startBlockId"] ?? ""),
            endBlockId: String(body["endBlockId"] ?? ""),
            type: String(body["type"] ?? "explain"),
            selectionText: note.selectionText,
            selectionHash: "h",
            question: note.question,
            answer: "",
            model: "mock",
            status: "running",
            createdAt: new Date().toISOString(),
            completedAt: null,
          },
          message: {
            id: "m1",
            noteId: note.id,
            role: "user",
            content: note.question,
            sequence: 1,
            createdAt: new Date().toISOString(),
          },
        });
      }

      const messageCreate = /^\/api\/notes\/([^/]+)\/messages$/.exec(url);
      if (messageCreate && req.method === "POST") {
        const noteId = messageCreate[1]!;
        const clientKey = (body["clientKey"] as string | undefined) ?? null;
        if (state.dropMessageOnce && state.dropMessageOnce.key === clientKey) {
          state.dropMessageOnce = null;
          // The row is written, then the reply is lost.
          if (!state.messages.some((m) => m.noteId === noteId && m.clientKey === clientKey)) {
            state.messages.push({
              noteId,
              role: String(body["role"] ?? "assistant"),
              content: String(body["content"] ?? ""),
              sequence: state.messages.filter((m) => m.noteId === noteId).length + 1,
              clientKey,
            });
          }
          req.socket.destroy();
          return;
        }
        if (state.failMessageOnce && state.failMessageOnce.key === clientKey) {
          const status = state.failMessageOnce.status;
          state.failMessageOnce = null;
          return apiError(status);
        }
        const replay = clientKey
          ? state.messages.find((m) => m.noteId === noteId && m.clientKey === clientKey)
          : undefined;
        const message =
          replay ??
          (() => {
            const created: FakeMessage = {
              noteId,
              role: String(body["role"] ?? "assistant"),
              content: String(body["content"] ?? ""),
              sequence: state.messages.filter((m) => m.noteId === noteId).length + 1,
              clientKey,
            };
            state.messages.push(created);
            return created;
          })();
        return send(200, {
          message: {
            id: `m${message.sequence}`,
            noteId,
            role: message.role,
            content: message.content,
            sequence: message.sequence,
            createdAt: new Date().toISOString(),
          },
          note: {
            id: noteId,
            articleId: "art-1",
            versionId: "ver-art-1",
            paragraphIndex: 1,
            startParagraphIndex: 1,
            startOffset: 0,
            endParagraphIndex: 1,
            endOffset: 1,
            startBlockId: "b1-imported0",
            endBlockId: "b1-imported0",
            type: "explain",
            selectionText: "s",
            selectionHash: "h",
            question: "q",
            answer: message.content,
            model: "mock",
            status: "succeeded",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        });
      }

      if (url.startsWith("/api/articles") && req.method === "GET") {
        return send(200, { articles: state.articles, nextCursor: null });
      }

      return send(404, { error: { code: "NOT_FOUND", message: "no such endpoint", requestId: "r" } });
    })();
  });

  await new Promise<void>((resolve) => state.server.listen(0, "127.0.0.1", resolve));
  const port = (state.server.address() as AddressInfo).port;
  state.base = `http://127.0.0.1:${port}`;
  return state;
}

before(async () => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStoragePolyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStoragePolyfill,
    configurable: true,
    writable: true,
  });
  realFetch = globalThis.fetch;
  fake = await startFake();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? new URL(input, fake.base) : input;
    return realFetch(target as RequestInfo, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await fake.close();
});

beforeEach(() => {
  memory.clear();
  fake.articles = [];
  fake.notes = [];
  fake.messages = [];
  fake.requests = [];
  fake.failNoteOnce = null;
  fake.failMessageOnce = null;
  fake.dropMessageOnce = null;
  fake.dropArticleOnce = null;
  fake.delayArticleImportMs = 0;
});

interface Loaded {
  useStore: typeof import("../../src/lib/store.js").useStore;
  useSession: typeof import("../../src/lib/session.js").useSession;
  useMigration: typeof import("../../src/lib/migration-store.js").useMigration;
  confirmMigration: typeof import("../../src/lib/migration.js").confirmMigration;
  migrationStore: typeof import("../../src/lib/migration-store.js");
}

async function loadFresh(): Promise<Loaded> {
  const [storeMod, sessionMod, migrationStore, migration] = await Promise.all([
    import("../../src/lib/store.js"),
    import("../../src/lib/session.js"),
    import("../../src/lib/migration-store.js"),
    import("../../src/lib/migration.js"),
  ]);
  storeMod.useStore.getState().clearUserCache();
  migrationStore.useMigration.getState().reset();
  memory.delete(migrationStore.ANON_SPACE_KEY);
  sessionMod.useSession.setState({
    status: "authed",
    user: {
      id: "user-1",
      email: "u@example.test",
      emailVerified: true,
      role: "user",
    },
  });
  return {
    useStore: storeMod.useStore,
    useSession: sessionMod.useSession,
    useMigration: migrationStore.useMigration,
    confirmMigration: migration.confirmMigration,
    migrationStore,
  };
}

/** Put an anonymous workspace (article + one note with a full conversation) in the archive. */
async function seedArchivedWorkspace(
  loaded: Loaded,
  options: {
    noteId?: string;
    noteOverrides?: Record<string, unknown>;
    /** Conversation turns, set *before* the snapshot is taken. */
    turns?: { role: "user" | "assistant"; content: string }[];
  } = {},
): Promise<string> {
  const { useStore } = loaded;
  await useStore.getState().saveArticle(
    { id: "local-abc123", title: "匿名文章", createdAt: 1 },
    [
      { index: 1, text: "第一段正文", hash: "h1", blockId: "b1-localaaa" },
      { index: 2, text: "第二段正文", hash: "h2", blockId: "b2-localbbb" },
    ],
  );
  const noteId = useStore.getState().addNote({
    articleId: "local-abc123",
    paragraphIndex: 1,
    type: "explain",
    selectionText: "第一段正文",
    question: "这段说了什么？",
    answer: "第一个回答。",
    model: "mock",
    ...(options.noteOverrides ?? {}),
  });
  useStore.getState().updateNote(noteId, {
    isStreaming: false,
    ...(options.turns
      ? {
          turns: options.turns.map((t, i) => ({
            id: `t${i + 1}`,
            noteId,
            role: t.role,
            content: t.content,
            sequence: i + 1,
            createdAt: "",
          })),
        }
      : {}),
  });
  if (options.noteId) {
    // Re-key the note so a test can name it deterministically in a key.
    const note = useStore.getState().notes[noteId]!;
    const notes = { ...useStore.getState().notes };
    delete notes[noteId];
    notes[options.noteId] = { ...note, id: options.noteId };
    useStore.setState({ notes });
  }

  // Set the workspace aside through the real path, not by copying the blob.
  // The text lives in its own store now, so a hand-rolled snapshot that copies
  // only `gloss-storage` is precisely the bug `archiveAnonymousSpace` was fixed
  // for: the archive would hold the records and none of the paragraphs, and the
  // migration would report every article as "record without a body".
  assert.equal(
    await loaded.migrationStore.archiveAnonymousSpace(),
    true,
    "the workspace must be settable aside for these tests to mean anything",
  );
  loaded.useStore.getState().clearUserCache();
  loaded.useStore.getState().setOwner("user-1");
  loaded.useMigration.getState().markRunning("user-1");
  return options.noteId ?? noteId;
}

test("a complete migration uploads the article, its note and every turn", async () => {
  const loaded = await loadFresh();
  await seedArchivedWorkspace(loaded, {
    noteId: "note-fixed",
    turns: [
      { role: "user", content: "这段说了什么？" },
      { role: "assistant", content: "第一个回答。" },
      { role: "user", content: "那成本呢？" },
      { role: "assistant", content: "第二个回答。" },
    ],
  });

  const result = await loaded.confirmMigration("user-1");
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.uploadedArticles, 1);
  assert.equal(result.uploadedNotes, 1);
  assert.equal(result.uploadedMessages, 3, "the seed is not re-sent; the other three turns are");
  assert.equal(fake.articles.length, 1);
  assert.equal(fake.notes.length, 1);
  // Seed question + two answers + one follow-up question.
  assert.equal(fake.messages.length, 4);
  assert.deepEqual(
    fake.messages.map((m) => `${m.role}:${m.content}`),
    [
      "user:这段说了什么？",
      "assistant:第一个回答。",
      "user:那成本呢？",
      "assistant:第二个回答。",
    ],
    "the conversation must arrive in order with both questions preserved",
  );
  assert.equal(loaded.useMigration.getState().status, "done");
});

test("a lost article-import response does not duplicate the article on retry", async () => {
  const loaded = await loadFresh();
  await seedArchivedWorkspace(loaded);
  fake.dropArticleOnce = { key: "anon:user-1:local-abc123" };

  const first = await loaded.confirmMigration("user-1");
  assert.equal(first.completed, false);
  assert.equal(first.failedArticles, 1);
  assert.equal(fake.articles.length, 1, "the server did create the row");

  const second = await loaded.confirmMigration("user-1");
  assert.equal(second.completed, true, JSON.stringify(second));
  assert.equal(fake.articles.length, 1, "the retry must replay onto the same row");
  assert.equal(fake.notes.length, 1);
});

test("a lost message response does not duplicate the turn on retry", async () => {
  const loaded = await loadFresh();
  await seedArchivedWorkspace(loaded, {
    noteId: "note-fixed",
    turns: [
      { role: "user", content: "这段说了什么？" },
      { role: "assistant", content: "第一个回答。" },
    ],
  });
  // The answer is written, then the reply is lost.
  fake.dropMessageOnce = { key: "anon:user-1:local-abc123:note-fixed:m2" };

  const first = await loaded.confirmMigration("user-1");
  assert.equal(first.completed, false, "a lost reply is not a success");
  assert.equal(first.failedNotes, 1);
  assert.equal(
    fake.messages.filter((m) => m.role === "assistant").length,
    1,
    "the server did write the answer",
  );

  const second = await loaded.confirmMigration("user-1");
  assert.equal(second.completed, true, JSON.stringify(second));
  assert.equal(
    fake.messages.filter((m) => m.role === "assistant").length,
    1,
    "the retry must replay onto the same message, not append a second answer",
  );
  assert.equal(fake.messages.length, 2, "seed question + one answer");
});

test("an answer that fails leaves the note incomplete and the retry sends only the missing turn", async () => {
  const loaded = await loadFresh();
  await seedArchivedWorkspace(loaded, {
    noteId: "note-fixed",
    turns: [
      { role: "user", content: "这段说了什么？" },
      { role: "assistant", content: "第一个回答。" },
      { role: "user", content: "那成本呢？" },
      { role: "assistant", content: "第二个回答。" },
    ],
  });
  fake.failMessageOnce = { key: "anon:user-1:local-abc123:note-fixed:m4", status: 500 };

  const first = await loaded.confirmMigration("user-1");
  assert.equal(first.completed, false, "a missing answer must not be reported as migrated");
  assert.equal(first.failedNotes, 1);
  assert.equal(first.failedMessages, 1);
  assert.equal(first.uploadedMessages, 2, "the turns that did land are still counted");
  assert.equal(
    loaded.useMigration.getState().progressFor("user-1").completedNoteKeys.includes(
      "anon:user-1:local-abc123:note-fixed",
    ),
    false,
    "the note must not be recorded as complete",
  );
  assert.equal(loaded.migrationStore.hasArchive(), true, "the workspace must survive for the retry");

  const beforeRetry = fake.requests.filter((r) => r.path.endsWith("/messages")).length;
  const second = await loaded.confirmMigration("user-1");
  assert.equal(second.completed, true, JSON.stringify(second));
  // Only the missing turn is re-sent; the three that succeeded are skipped.
  const afterRetry = fake.requests.filter((r) => r.path.endsWith("/messages")).length;
  assert.equal(afterRetry - beforeRetry, 1, "the retry must send exactly the missing turn");
  assert.equal(fake.messages.filter((m) => m.role === "assistant").length, 2);
});

test("an account switch mid-run stops the upload and leaves local state alone", async () => {
  const loaded = await loadFresh();
  await seedArchivedWorkspace(loaded);
  fake.delayArticleImportMs = 300;

  const running = loaded.confirmMigration("user-1");
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Somebody signs in as a different account while the import is in flight.
  loaded.useSession.setState({
    status: "authed",
    user: {
      id: "user-2",
      email: "b@example.test",
      emailVerified: true,
      role: "user",
    },
  });
  const result = await running;

  assert.equal(result.completed, false, "a switched run must never report success");
  assert.ok(result.error, "and must explain why");
  assert.equal(
    fake.requests.filter((r) => r.path === "/api/articles/import").length,
    1,
    "the run must stop at the switch, not keep importing",
  );
  assert.equal(
    fake.requests.filter((r) => r.path.endsWith("/messages")).length,
    0,
    "no note or message may be sent after the switch",
  );
  assert.equal(
    fake.notes.length,
    0,
    "and no note may be created under the new account's credentials",
  );
  assert.equal(
    loaded.useMigration.getState().status,
    "failed",
    "the account must not be stamped as migrated",
  );
});

test("a cross-segment note migrates with the imported version's block ids", async () => {
  const loaded = await loadFresh();
  const { useStore } = loaded;
  // A two-paragraph article with a range spanning both, anchored to the
  // *local* block ids.
  await useStore.getState().saveArticle(
    { id: "local-cross1", title: "跨段匿名文章", createdAt: 1 },
    [
      { index: 1, text: "第一段正文", hash: "h1", blockId: "b1-localaaa" },
      { index: 2, text: "第二段正文", hash: "h2", blockId: "b2-localbbb" },
    ],
  );
  const noteId = useStore.getState().addNote({
    articleId: "local-cross1",
    paragraphIndex: 1,
    type: "ask",
    selectionText: "正文\n第二段",
    question: "整体在说什么？",
    answer: "回答。",
    model: "mock",
    startParagraphIndex: 1,
    startOffset: 2,
    endParagraphIndex: 2,
    endOffset: 3,
    startBlockId: "b1-localaaa",
    endBlockId: "b2-localbbb",
  });
  useStore.getState().updateNote(noteId, { isStreaming: false });
  // Set the workspace aside through the real path, not by copying the blob.
  // The text lives in its own store now, so a hand-rolled snapshot that copies
  // only `gloss-storage` is precisely the bug `archiveAnonymousSpace` was fixed
  // for: the archive would hold the records and none of the paragraphs, and the
  // migration would report every article as "record without a body".
  assert.equal(
    await loaded.migrationStore.archiveAnonymousSpace(),
    true,
    "the workspace must be settable aside for these tests to mean anything",
  );
  loaded.useStore.getState().clearUserCache();
  loaded.useStore.getState().setOwner("user-1");
  loaded.useMigration.getState().markRunning("user-1");

  const result = await loaded.confirmMigration("user-1");
  assert.equal(result.completed, true, JSON.stringify(result));
  const created = fake.notes[0]!;
  const request = fake.requests.find((r) => r.path.endsWith("/notes"))!.body;
  assert.equal(
    request["startBlockId"],
    "b1-imported0",
    "the note must be re-anchored to the imported version's block id",
  );
  assert.equal(request["endBlockId"], "b2-imported1");
  assert.equal(request["startOffset"], 2);
  assert.equal(request["endOffset"], 3);
  assert.equal(
    created.versionId,
    fake.articles[0]!.id === created.articleId ? `ver-${created.articleId}` : created.versionId,
  );
  assert.equal(
    request["articleVersionId"],
    `ver-${created.articleId}`,
    "and must name the imported version explicitly",
  );
});

test("a note whose paragraph no longer holds its text is reported, not mis-anchored", async () => {
  const loaded = await loadFresh();
  const { useStore } = loaded;
  await useStore.getState().saveArticle(
    { id: "local-gone1", title: "匿名文章", createdAt: 1 },
    [{ index: 1, text: "原始段落文字", hash: "h1", blockId: "b1-localaaa" }],
  );
  const noteId = useStore.getState().addNote({
    articleId: "local-gone1",
    paragraphIndex: 1,
    type: "explain",
    // Text that the imported version will not contain.
    selectionText: "原始段落文字",
    question: "这段说了什么？",
    answer: "回答。",
    model: "mock",
  });
  useStore.getState().updateNote(noteId, { isStreaming: false });
  useStore.getState().updateNote("local-gone1", {});
  // Rewrite the stored text so the re-import produces something else entirely.
  // It has to go through `saveArticle`: the text is a body in its own store
  // now, so writing a `paragraphs` key onto the *record* would leave the body
  // untouched — the note would still find its text and this test would pass
  // while proving nothing.
  await useStore.getState().saveArticle(
    { id: "local-gone1", title: "匿名文章", createdAt: 1 },
    [{ index: 1, text: "完全不同的内容", hash: "h1", blockId: "b1-localaaa" }],
  );
  // Set the workspace aside through the real path, not by copying the blob.
  // The text lives in its own store now, so a hand-rolled snapshot that copies
  // only `gloss-storage` is precisely the bug `archiveAnonymousSpace` was fixed
  // for: the archive would hold the records and none of the paragraphs, and the
  // migration would report every article as "record without a body".
  assert.equal(
    await loaded.migrationStore.archiveAnonymousSpace(),
    true,
    "the workspace must be settable aside for these tests to mean anything",
  );
  loaded.useStore.getState().clearUserCache();
  loaded.useStore.getState().setOwner("user-1");
  loaded.useMigration.getState().markRunning("user-1");

  const result = await loaded.confirmMigration("user-1");
  assert.equal(result.completed, false, "an unmigratable note must not be reported as migrated");
  assert.equal(result.failedNotes, 1);
  assert.equal(fake.notes.length, 0, "no note may be anchored to text that is not there");
  assert.ok(result.error);
});

test("no request carries a credential", async () => {
  const loaded = await loadFresh();
  await seedArchivedWorkspace(loaded);
  const [{ useSettings }] = await Promise.all([import("../../src/lib/settings.js")]);
  useSettings.getState().setApiKey("sk-must-not-travel");

  await loaded.confirmMigration("user-1");
  assert.ok(fake.requests.length > 0);
  for (const request of fake.requests) {
    const body = JSON.stringify(request.body);
    assert.ok(!body.includes("sk-must-not-travel"), `a request carried the key: ${body}`);
  }
  assert.equal(useSettings.getState().apiKey, "sk-must-not-travel");
});

test("migrating an empty workspace completes without pretending work happened", async () => {
  const loaded = await loadFresh();
  loaded.useMigration.getState().markRunning("user-1");
  const result = await loaded.confirmMigration("user-1");
  assert.equal(result.completed, true);
  assert.equal(result.uploadedArticles, 0);
  assert.equal(fake.articles.length, 0);
});

test("a migration invoked for an account that is not signed in does nothing", async () => {
  const loaded = await loadFresh();
  await seedArchivedWorkspace(loaded);
  const result = await loaded.confirmMigration("someone-else");
  assert.equal(result.completed, false);
  assert.equal(fake.requests.length, 0, "no request may be sent for a foreign account");
});
