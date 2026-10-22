// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cloud-note synchronisation: account scoping, version-aware
 * reconciliation, durable retries and turn identity.
 *
 * Each test targets a specific way this area loses data, because those are
 * the failures a happy-path test cannot see:
 *
 *   - a queued write by account A being sent on account B's cookie;
 *   - a refresh's note list deleting cached *old-version* notes;
 *   - two clients deriving the same turn key and colliding;
 *   - a create that lost its response leaving the note local forever, or
 *     duplicating on the next attempt;
 *   - a delete that failed being silently forgotten instead of retried;
 *   - cloud work running while the local space and the session disagree
 *     about which account they describe.
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

interface RemoteNote {
  id: string;
  articleId: string;
  versionId: string;
  paragraphIndex: number;
  startParagraphIndex: number;
  startOffset: number;
  endParagraphIndex: number;
  endOffset: number;
  startBlockId: string;
  endBlockId: string;
  type: string;
  selectionText: string;
  question: string;
  answer: string;
  model: string;
  status: string;
  createdAt: string;
  clientKey: string | null;
}

interface Fake {
  server: Server;
  base: string;
  /** The version `GET /api/articles/:id/notes` answers about. */
  listVersionId: string;
  createClientKey: (body: Record<string, unknown>) => string | null;
  notes: RemoteNote[];
  messages: { noteId: string; role: string; content: string; sequence: number; clientKey: string | null }[];
  requests: { method: string; path: string; body: Record<string, unknown> }[];
  createDelayMs: number;
  dropCreateOnce: { key: string } | null;
  failCreateOnce: { key: string; status: number } | null;
  failAppendOnce: { key: string } | null;
  failDeleteOnce: { id: string } | null;
  close(): Promise<void>;
}

let fake: Fake;
let realFetch: typeof fetch;

function makeRemoteNote(overrides: Partial<RemoteNote> = {}): RemoteNote {
  return {
    id: `note-${Math.random().toString(36).slice(2, 8)}`,
    articleId: "art-1",
    versionId: "ver-art-1",
    paragraphIndex: 1,
    startParagraphIndex: 1,
    startOffset: 0,
    endParagraphIndex: 1,
    endOffset: 4,
    startBlockId: "b1-aaaaaaaa",
    endBlockId: "b1-aaaaaaaa",
    type: "explain",
    selectionText: "第一段正文",
    question: "云端问题",
    answer: "云端回答",
    model: "mock",
    status: "succeeded",
    createdAt: new Date().toISOString(),
    clientKey: null,
    ...overrides,
  };
}

async function startFake(): Promise<Fake> {
  const state: Fake = {
    server: createServer(),
    base: "",
    listVersionId: "ver-art-1",
    createClientKey: (body) => (body["clientKey"] as string | undefined) ?? null,
    notes: [],
    messages: [],
    requests: [],
    createDelayMs: 0,
    dropCreateOnce: null,
    failCreateOnce: null,
    failAppendOnce: null,
    failDeleteOnce: null,
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
      state.requests.push({ method: req.method ?? "GET", path: url, body });
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      const noteCreate = /^\/api\/articles\/([^/]+)\/notes$/.exec(url);
      if (noteCreate && req.method === "POST") {
        const clientKey = state.createClientKey(body);
        if (state.createDelayMs > 0) await new Promise((r) => setTimeout(r, state.createDelayMs));
        if (state.dropCreateOnce && state.dropCreateOnce.key === clientKey) {
          state.dropCreateOnce = null;
          if (!state.notes.some((n) => n.clientKey === clientKey)) {
            state.notes.push(
              makeRemoteNote({
                id: `note-${state.notes.length + 1}`,
                articleId: noteCreate[1]!,
                question: String(body["question"] ?? ""),
                selectionText: String(body["selectionText"] ?? ""),
                answer: "",
                status: "running",
                clientKey,
              }),
            );
          }
          req.socket.destroy();
          return;
        }
        if (state.failCreateOnce && state.failCreateOnce.key === clientKey) {
          const status = state.failCreateOnce.status;
          state.failCreateOnce = null;
          return send(status, { error: { code: "INTERNAL", message: "boom", requestId: "r" } });
        }
        const replay = clientKey
          ? state.notes.find((n) => n.clientKey === clientKey && n.articleId === noteCreate[1])
          : undefined;
        const note =
          replay ??
          (() => {
            const created = makeRemoteNote({
              id: `note-${state.notes.length + 1}`,
              articleId: noteCreate[1]!,
              versionId: String(body["articleVersionId"] ?? state.listVersionId),
              question: String(body["question"] ?? ""),
              selectionText: String(body["selectionText"] ?? ""),
              answer: "",
              status: "running",
              clientKey,
            });
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
          note,
          message: {
            id: "m1",
            noteId: note.id,
            role: "user",
            content: note.question,
            sequence: 1,
            createdAt: note.createdAt,
          },
        });
      }

      // The list is queried with `?versionId=`, so match the path alone and
      // read the requested version from the query — the route answers
      // about whichever version the caller names.
      const parsedUrl = new URL(url, "http://fake.test");
      const noteList = /^\/api\/articles\/([^/]+)\/notes$/.exec(parsedUrl.pathname);
      if (noteList && req.method === "GET") {
        const requestedVersion =
          parsedUrl.searchParams.get("versionId") ?? state.listVersionId;
        const notes = state.notes.filter(
          (n) => n.articleId === noteList[1] && n.versionId === requestedVersion,
        );
        const messagesByNote: Record<string, unknown[]> = {};
        for (const note of notes) {
          const msgs = state.messages.filter((m) => m.noteId === note.id);
          if (msgs.length > 0) {
            messagesByNote[note.id] = msgs.map((m, i) => ({
              id: `m${i + 1}`,
              noteId: note.id,
              role: m.role,
              content: m.content,
              sequence: m.sequence,
              createdAt: note.createdAt,
            }));
          }
        }
        return send(200, { versionId: requestedVersion, notes, messagesByNote });
      }

      const messageCreate = /^\/api\/notes\/([^/]+)\/messages$/.exec(url);
      if (messageCreate && req.method === "POST") {
        const noteId = messageCreate[1]!;
        const clientKey = (body["clientKey"] as string | undefined) ?? null;
        if (state.failAppendOnce?.key === clientKey) {
          state.failAppendOnce = null;
          return send(500, { error: { code: "INTERNAL", message: "boom", requestId: "r" } });
        }
        const replay = clientKey
          ? state.messages.find((m) => m.noteId === noteId && m.clientKey === clientKey)
          : undefined;
        const message =
          replay ??
          (() => {
            const created = {
              noteId,
              role: String(body["role"] ?? "assistant"),
              content: String(body["content"] ?? ""),
              sequence: state.messages.filter((m) => m.noteId === noteId).length + 1,
              clientKey,
            };
            state.messages.push(created);
            return created;
          })();
        const note = state.notes.find((n) => n.id === noteId);
        if (note && message.role === "assistant") note.answer = message.content;
        return send(200, {
          message: {
            id: `m${message.sequence}`,
            noteId,
            role: message.role,
            content: message.content,
            sequence: message.sequence,
            createdAt: new Date().toISOString(),
          },
          note: note ?? makeRemoteNote({ id: noteId }),
        });
      }

      const statusUpdate=/^\/api\/notes\/([^/]+)\/status$/.exec(url);
      if(statusUpdate && req.method==='POST') {
        const note=state.notes.find(n=>n.id===statusUpdate[1]);
        if(note)note.status=String(body['status']);
        return send(200,{note});
      }
      const noteDelete = /^\/api\/notes\/([^/]+)$/.exec(url);
      if (noteDelete && req.method === "DELETE") {
        if (state.failDeleteOnce?.id === noteDelete[1]) {
          state.failDeleteOnce = null;
          return send(500, { error: { code: "INTERNAL", message: "boom", requestId: "r" } });
        }
        const removed = state.notes.find((n) => n.id === noteDelete[1]);
        state.notes = state.notes.filter((n) => n.id !== noteDelete[1]);
        return send(200, { deletedId: removed?.id ?? noteDelete[1] });
      }

      return send(404, { error: { code: "NOT_FOUND", message: `no such endpoint: ${req.method} ${url}`, requestId: "r" } });
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
  fake.listVersionId = "ver-art-1";
  fake.notes = [];
  fake.messages = [];
  fake.requests = [];
  fake.createDelayMs = 0;
  fake.dropCreateOnce = null;
  fake.failCreateOnce = null;
  fake.failAppendOnce = null;
  fake.failDeleteOnce = null;
});

interface Loaded {
  useStore: typeof import("../../src/lib/store.js").useStore;
  useSession: typeof import("../../src/lib/session.js").useSession;
  cloud: typeof import("../../src/lib/cloud-notes.js");
}

function signInAs(loaded: Loaded, id: string): void {
  loaded.useSession.setState({
    status: "authed",
    user: { id, email: `${id}@example.test`, emailVerified: true, role: "user" },
  });
  loaded.useStore.getState().setOwner(id);
}

async function loadFresh(): Promise<Loaded> {
  const [storeMod, sessionMod, cloud, { registerCloudAdapter }, { createGlossCloudAdapter }] =
    await Promise.all([
      import("../../src/lib/store.js"),
      import("../../src/lib/session.js"),
      import("../../src/lib/cloud-notes.js"),
      import("../../src/lib/cloud/contract.js"),
      import("../../src/lib/cloud/adapter.js"),
    ]);
  // Production always has an adapter registered (`main.tsx` calls
  // `installCloudAdapter`), and this module's "is there a cloud at all" gate
  // reads the seam rather than a release flag now — so without this every
  // path under test would correctly decide there is nothing to sync to.
  registerCloudAdapter(createGlossCloudAdapter());
  storeMod.useStore.getState().clearUserCache();
  cloud.useCloudQueue.getState().reset();
  await storeMod.useStore.getState().saveArticle(
    { id: "art-1", title: "云端文章", createdAt: 1, versionId: "ver-art-1" },
    [{ index: 1, text: "第一段正文", hash: "h1", blockId: "b1-aaaaaaaa" }],
  );
  signInAs({ useStore: storeMod.useStore, useSession: sessionMod.useSession, cloud }, "user-A");
  return { useStore: storeMod.useStore, useSession: sessionMod.useSession, cloud };
}

function addLocalNote(loaded: Loaded, overrides: Record<string, unknown> = {}): string {
  const id = loaded.useStore.getState().addNote({
    articleId: "art-1",
    paragraphIndex: 1,
    type: "explain",
    selectionText: "第一段正文",
    question: "本地问题",
    answer: "本地回答",
    model: "mock",
    ...overrides,
  });
  loaded.useStore.getState().finishNote(id);
  return id;
}

const anchor = {
  paragraphIndex: 1,
  type: "explain" as const,
  selectionText: "第一段正文",
  question: "本地问题",
  model: "mock",
  startParagraphIndex: 1,
  startOffset: 0,
  endParagraphIndex: 1,
  endOffset: 4,
  startBlockId: "b1-aaaaaaaa",
  endBlockId: "b1-aaaaaaaa",
};

async function pendingArticleNote() {
 const loaded=await loadFresh();
 await loaded.useStore.getState().saveArticle({id:'local-pending',title:'待上传',createdAt:1},[{index:1,text:'第一段正文',hash:'h1',blockId:'b1-aaaaaaaa'}]);
 const noteId=addLocalNote(loaded,{...anchor,articleId:'local-pending',answer:''});
 await loaded.cloud.persistNote(noteId,'local-pending',anchor);
 return {...loaded,noteId};
}
test('pending local note waits for its owner and stale upload epoch cannot start catch-up',async()=>{
 const loaded=await pendingArticleNote();const {syncPendingNotes}=await import('../../src/lib/article-sync.js');
 const {currentSessionEpoch,bumpSessionEpoch}=await import('../../src/lib/session-epoch.js');
 const epoch=currentSessionEpoch();
 loaded.useStore.getState().setArticleRemote('local-pending','art-1','ver-art-1','local');
 signInAs(loaded,'user-B');await loaded.cloud.flushQueue('user-A');
 await syncPendingNotes('local-pending','user-A',epoch);assert.equal(fake.requests.length,0);
 signInAs(loaded,'user-A');bumpSessionEpoch();
 await syncPendingNotes('local-pending','user-A',epoch);assert.equal(fake.requests.length,0);
 await loaded.cloud.flushQueue();assert.equal(fake.notes.length,1);
});
test('upload lands during generation: note is created and completion uses one frozen turn',async()=>{
 const loaded=await pendingArticleNote();const {syncPendingNotes}=await import('../../src/lib/article-sync.js');
 const {currentSessionEpoch}=await import('../../src/lib/session-epoch.js');
 loaded.cloud.startActiveTurn(loaded.noteId,'answer-live');
 loaded.useStore.getState().setArticleRemote('local-pending','art-1','ver-art-1','local');
 await syncPendingNotes('local-pending','user-A',currentSessionEpoch());
 assert.equal(fake.notes.length,1);assert.equal(fake.messages.filter(m=>m.role==='assistant').length,0);
 loaded.useStore.getState().appendTurn(loaded.noteId,{role:'assistant',content:'完成回答',status:'succeeded',turnId:'answer-live'});
 loaded.cloud.markLocalStatus(loaded.noteId,'succeeded');
 await loaded.cloud.persistAnswer(loaded.noteId,'完成回答','succeeded','answer-live');
 await syncPendingNotes('local-pending','user-A',currentSessionEpoch());await loaded.cloud.flushQueue();
 assert.equal(fake.notes.length,1);assert.equal(fake.messages.filter(m=>m.role==='assistant').length,1);assert.equal(fake.messages.find(m=>m.role==='assistant')?.content,'完成回答');
});
for(const outcome of ['succeeded','failed','cancelled','interrupted'] as const) {
 test(`generation finishes before upload: ${outcome} survives queue rehydrate and replay`,async()=>{
  const loaded=await pendingArticleNote();const {syncPendingNotes}=await import('../../src/lib/article-sync.js');
  const {currentSessionEpoch}=await import('../../src/lib/session-epoch.js');
  loaded.useStore.getState().appendTurn(loaded.noteId,{role:'assistant',content:'保留的部分文本',status:outcome,turnId:'answer-before'});
  loaded.cloud.markLocalStatus(loaded.noteId,outcome);
  await loaded.cloud.persistAnswer(loaded.noteId,'保留的部分文本',outcome,'answer-before');
  assert.equal(fake.requests.length,0);assert.equal(loaded.cloud.useCloudQueue.getState().pendingCreates.length,1);
  await loaded.cloud.useCloudQueue.persist.rehydrate();
  loaded.useStore.getState().setArticleRemote('local-pending','art-1','ver-art-1','local');
  await syncPendingNotes('local-pending','user-A',currentSessionEpoch());await loaded.cloud.flushQueue();
  assert.equal(fake.notes.length,1);assert.equal(fake.messages.filter(m=>m.role==='assistant').length,1);
  const appends=fake.requests.filter(r=>r.path.endsWith('/messages'));
  assert.ok(appends.length>=1);assert.ok(appends.every(r=>r.body['status']===outcome));
  assert.equal(loaded.useStore.getState().notes[loaded.noteId]?.turns?.[1]?.status,outcome);
 });
 test(`empty ${outcome} before upload sends terminal status without invented message`,async()=>{
  const loaded=await pendingArticleNote();loaded.cloud.markLocalStatus(loaded.noteId,outcome);
  await loaded.cloud.persistAnswer(loaded.noteId,'',outcome,'empty-turn');
  loaded.useStore.getState().setArticleRemote('local-pending','art-1','ver-art-1','local');
  await loaded.cloud.flushQueue();assert.equal(fake.notes.length,1);assert.equal(fake.messages.filter(m=>m.role==='assistant').length,0);
  assert.equal(fake.notes[0]?.status,outcome);assert.equal(loaded.cloud.useCloudQueue.getState().pendingStatuses.length,0);
 });
}

// ── 1. Version-aware listing and reconciliation ─────────────────────────

test("a stale tab keeps its old-version notes when a refresh moved the article on", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded, { answer: "旧版本上的回答" });
  loaded.useStore.getState().setNoteRemote(noteId, "note-old", "ver-art-1");
  // A refresh happened in another context: the article is now on ver-art-2
  // and has a second note there. The tab in front of us is still showing
  // ver-art-1, and its note is still on the server against ver-art-1.
  fake.listVersionId = "ver-art-2";
  fake.notes = [
    makeRemoteNote({ id: "note-old", versionId: "ver-art-1", answer: "旧版本上的回答" }),
    makeRemoteNote({ id: "note-new", versionId: "ver-art-2", answer: "新版本上的回答" }),
  ];

  const merged = await loaded.cloud.syncNotesFromServer("art-1");
  assert.equal(merged, 1, "the list must be about the version being rendered");
  assert.ok(
    loaded.useStore.getState().notes[noteId],
    "the old-version note must survive: a refresh elsewhere does not delete it",
  );
  assert.equal(
    Object.values(loaded.useStore.getState().notes).some((n) => n.remoteId === "note-new"),
    false,
    "and the newer version's notes must not be rendered as if they were this version's",
  );
  const listRequests = fake.requests.filter(
    (r) => r.method === "GET" && r.path.includes("/notes"),
  );
  assert.ok(
    listRequests.some((r) => r.path.includes("versionId=ver-art-1")),
    `the request must name the rendered version, saw ${JSON.stringify(listRequests.map((r) => r.path))}`,
  );
});

test("a note bound to a different version survives a sync of the current version", async () => {
  const loaded = await loadFresh();
  const oldNoteId = addLocalNote(loaded, { answer: "历史回答" });
  loaded.useStore.getState().setNoteRemote(oldNoteId, "note-historic", "ver-art-0");
  // The list is about the version on screen, but this note belongs to an
  // earlier one and is simply not part of the question being answered.
  fake.notes = [];

  await loaded.cloud.syncNotesFromServer("art-1");
  assert.ok(
    loaded.useStore.getState().notes[oldNoteId],
    "a note from another version must not be swept up by this version's list",
  );
});

test("a note of the listed version that the server no longer has is removed", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  loaded.useStore.getState().setNoteRemote(noteId, "note-gone", "ver-art-1");
  fake.notes = [];
  await loaded.cloud.syncNotesFromServer("art-1");
  assert.equal(loaded.useStore.getState().notes[noteId], undefined);
});

// ── 2. Turn identity ────────────────────────────────────────────────────

test("two clients following up on one note do not collide on a turn key", async () => {
  const loaded = await loadFresh();
  const remoteId = "note-shared";
  fake.notes = [makeRemoteNote({ id: remoteId })];

  // Client 1: a note it has already seen with one exchange behind it.
  const a = addLocalNote(loaded, { answer: "客户端1的回答" });
  loaded.useStore.getState().setNoteRemote(a, remoteId, "ver-art-1");
  loaded.useStore.getState().updateNote(a, {
    turns: [
      { id: "x1", noteId: a, role: "user", content: "原来的问题", sequence: 1, createdAt: "" },
      { id: "x2", noteId: a, role: "assistant", content: "原来的回答", sequence: 2, createdAt: "" },
    ],
    localAnswerCount: 1,
    localQuestionCount: 1,
  });
  await loaded.cloud.persistFollowUpQuestion(a, "客户端1的追问", "turn-a-1");

  // Client 2: a *second browser* with the same note but a different local
  // turn id for its own follow-up. A counter-derived key would be
  // `q:<remote>:1` in both clients and the server would replay client 1's
  // question instead of storing client 2's.
  await loaded.cloud.persistFollowUpQuestion(a, "客户端2的追问", "turn-b-1");

  const questions = fake.messages.filter((m) => m.role === "user" && m.clientKey !== null);
  assert.deepEqual(
    questions.map((m) => m.content).sort(),
    ["客户端1的追问", "客户端2的追问"],
    "both follow-ups must be stored, not one replayed over the other",
  );
});

test("a retried turn replays onto the same message", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  const remoteId = "note-retry";
  fake.notes = [makeRemoteNote({ id: remoteId })];
  loaded.useStore.getState().setNoteRemote(noteId, remoteId, "ver-art-1");

  fake.failAppendOnce = { key: loaded.cloud.turnClientKey(remoteId, "turn-1") };
  await loaded.cloud.persistAnswer(noteId, "唯一的回答", "succeeded", "turn-1");
  assert.equal(loaded.cloud.useCloudQueue.getState().pendingMessages.length, 1);

  await loaded.cloud.flushQueue();
  assert.equal(
    fake.messages.filter((m) => m.role === "assistant").length,
    1,
    "the retry must not append a second answer",
  );
  assert.equal(loaded.cloud.useCloudQueue.getState().pendingMessages.length, 0);
});

// ── 3. Durable, idempotent creation ─────────────────────────────────────

test("a create that lost its response is retried to the same row, not duplicated", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  const key = loaded.cloud.noteCreateClientKey("user-A", "art-1", noteId);
  fake.dropCreateOnce = { key };

  await loaded.cloud.persistNote(noteId, "art-1", anchor);
  assert.equal(fake.notes.length, 1, "the server created the row");
  assert.equal(
    loaded.cloud.useCloudQueue.getState().pendingCreates.length,
    1,
    "and the create must be queued rather than lost",
  );
  assert.equal(
    loaded.useStore.getState().notes[noteId]?.remoteId,
    undefined,
    "the client has no id yet",
  );

  await loaded.cloud.flushQueue();
  assert.equal(fake.notes.length, 1, "the retry must replay onto the same row");
  assert.equal(
    loaded.useStore.getState().notes[noteId]?.remoteId,
    fake.notes[0]!.id,
    "and the note must finally learn its remote id",
  );
  assert.equal(loaded.cloud.useCloudQueue.getState().pendingCreates.length, 0);
});

test("an answer waits behind a queued create and is sent once it succeeds", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  const key = loaded.cloud.noteCreateClientKey("user-A", "art-1", noteId);
  fake.failCreateOnce = { key, status: 500 };

  await loaded.cloud.persistNote(noteId, "art-1", anchor);
  assert.equal(loaded.cloud.useCloudQueue.getState().pendingCreates.length, 1);
  await loaded.cloud.persistAnswer(noteId, "回答已到达", "succeeded", "turn-1");
  assert.equal(
    fake.messages.filter((m) => m.role === "assistant").length,
    0,
    "the answer cannot be sent before the note exists",
  );
  assert.equal(
    loaded.cloud.useCloudQueue.getState().pendingMessages.length,
    1,
    "but it must be kept, not dropped",
  );

  await loaded.cloud.flushQueue();
  assert.equal(fake.notes.length, 1);
  assert.equal(
    fake.messages.filter((m) => m.role === "assistant").length,
    1,
    "and sent once the create succeeded",
  );
});

test("a create the server refuses is not queued forever", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  const key = loaded.cloud.noteCreateClientKey("user-A", "art-1", noteId);
  fake.failCreateOnce = { key, status: 422 };

  await loaded.cloud.persistNote(noteId, "art-1", anchor);
  assert.equal(
    loaded.cloud.useCloudQueue.getState().pendingCreates.length,
    0,
    "a refusal will not become true on a retry, so it must not be queued",
  );
  assert.ok(loaded.useStore.getState().notes[noteId], "and the note stays usable locally");
});

// ── 4. Owner ≡ session ──────────────────────────────────────────────────

test("cloud work does not run while the local space and the session disagree", async () => {
  const loaded = await loadFresh();
  // The session says A; the local space still says anonymous — the window
  // between a sign-in resolving and the space being handed over.
  loaded.useStore.getState().setOwner("anonymous");
  assert.equal(loaded.cloud.actingUserId(), null, "there is no unambiguous owner");

  const noteId = addLocalNote(loaded);
  await loaded.cloud.persistNote(noteId, "art-1", anchor);
  await loaded.cloud.persistAnswer(noteId, "不该发出的回答", "succeeded", "turn-1");
  await loaded.cloud.flushQueue();
  assert.equal(fake.requests.length, 0, "no request may be sent while they disagree");
});

// ── 5. Tombstones ───────────────────────────────────────────────────────

test("a failed delete is retried under the owner that owned the row", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  const remoteId = "note-tomb";
  fake.notes = [makeRemoteNote({ id: remoteId })];
  loaded.useStore.getState().setNoteRemote(noteId, remoteId, "ver-art-1");

  fake.failDeleteOnce = { id: remoteId };
  // Base owns the local half of a delete now (`cloud/bridge.removeNote`): the
  // note is removed from the store first and *then* the remote delete is
  // offered to the adapter. These two lines are that sequence, so the queue
  // behaviour below is still exercised against the code production runs.
  loaded.useStore.getState().deleteNote(noteId);
  await loaded.cloud.deleteRemoteNote(noteId, remoteId);
  const tombstones = loaded.cloud.useCloudQueue.getState().pendingDeletes;
  assert.equal(tombstones.length, 1, "the failed delete must be remembered");
  assert.equal(tombstones[0]!.ownerUserId, "user-A", "and remembered for its owner");

  // Another account signs in. Its flush must not touch A's tombstone.
  signInAs(loaded, "user-B");
  await loaded.cloud.flushQueue();
  assert.equal(
    fake.notes.length,
    1,
    "another account must not delete a row it does not own",
  );
  assert.equal(loaded.cloud.useCloudQueue.getState().pendingDeletes.length, 1);

  // A signs in again and finishes the job.
  signInAs(loaded, "user-A");
  await loaded.cloud.flushQueue();
  assert.equal(fake.notes.length, 0, "the owner's retry completes the delete");
  assert.equal(loaded.cloud.useCloudQueue.getState().pendingDeletes.length, 0);
});

test("a failed orphan cleanup becomes a tombstone instead of being dropped", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  // The create takes a moment; the user deletes the card in that window,
  // and the cleanup DELETE the client then attempts fails too.
  fake.createDelayMs = 120;
  fake.failDeleteOnce = { id: "note-1" };
  const creating = loaded.cloud.persistNote(noteId, "art-1", anchor);
  await new Promise((resolve) => setTimeout(resolve, 30));
  loaded.useStore.getState().deleteNote(noteId);
  await creating.catch(() => null);

  assert.equal(fake.notes.length, 1, "the server created the row");
  assert.equal(
    loaded.useStore.getState().notes[noteId],
    undefined,
    "the card is gone locally",
  );
  assert.ok(
    loaded.cloud.useCloudQueue
      .getState()
      .pendingDeletes.some((d) => d.remoteId === "note-1"),
    "and the row it left behind must be queued for deletion, not silently forgotten",
  );
});

test("a pending deletion is not resurrected by the next sync", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  const remoteId = "note-resurrect";
  fake.notes = [makeRemoteNote({ id: remoteId })];
  loaded.useStore.getState().setNoteRemote(noteId, remoteId, "ver-art-1");

  fake.failDeleteOnce = { id: remoteId };
  loaded.useStore.getState().deleteNote(noteId);
  await loaded.cloud.deleteRemoteNote(noteId, remoteId);
  assert.equal(loaded.useStore.getState().notes[noteId], undefined);

  await loaded.cloud.syncNotesFromServer("art-1");
  assert.equal(
    Object.values(loaded.useStore.getState().notes).some((n) => n.remoteId === remoteId),
    false,
    "the sync must not bring back a row queued for deletion",
  );
});

// ── 7. The request shape, and write-ahead intent ────────────────────────

test("the create request carries its idempotency key in the body", async () => {
  // A key held only in the queue never reaches the server, so the retry
  // creates a second row exactly when the first response was lost. The
  // assertion is on the request the server actually received.
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  await loaded.cloud.persistNote(noteId, "art-1", anchor);

  const create = fake.requests.find((r) => r.method === "POST" && r.path.endsWith("/notes"));
  assert.ok(create, "a create must have been sent");
  assert.equal(
    create!.body["clientKey"],
    loaded.cloud.noteCreateClientKey("user-A", "art-1", noteId),
    "the key must travel in the body, not just live in the queue",
  );
});

test("a turn request carries its own key in the body", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  const remoteId = "note-wire";
  fake.notes = [makeRemoteNote({ id: remoteId })];
  loaded.useStore.getState().setNoteRemote(noteId, remoteId, "ver-art-1");

  await loaded.cloud.persistAnswer(noteId, "回答", "succeeded", "turn-wire");
  const append = fake.requests.find((r) => r.path.endsWith("/messages"));
  assert.ok(append, "an append must have been sent");
  assert.equal(append!.body["clientKey"], loaded.cloud.turnClientKey(remoteId, "turn-wire"));
  assert.equal(append!.body["role"], "assistant");
  assert.equal(append!.body["content"], "回答");
  assert.equal(append!.body["status"], "succeeded");
});

test("the create intent is persisted before the request goes out", async () => {
  // The case a "queue on failure" design loses entirely: a process that
  // dies mid-flight never runs its failure branch, so the intent has to be
  // on disk first.
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  fake.createDelayMs = 200;
  const creating = loaded.cloud.persistNote(noteId, "art-1", anchor);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    loaded.cloud.useCloudQueue.getState().pendingCreates.length,
    1,
    "the intent must be recorded while the request is still in flight",
  );
  await creating;
  assert.equal(
    loaded.cloud.useCloudQueue.getState().pendingCreates.length,
    0,
    "and removed once the server confirms it",
  );
});

test("a stale create result stays queued for its own owner", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  fake.createDelayMs = 200;
  const creating = loaded.cloud.persistNote(noteId, "art-1", anchor);
  await new Promise((resolve) => setTimeout(resolve, 40));
  signInAs(loaded, "user-B");
  await creating.catch(() => null);

  const queued = loaded.cloud.useCloudQueue.getState().pendingCreates;
  assert.equal(queued.length, 1, "the row belongs to A, so A still owes it");
  assert.equal(queued[0]!.ownerUserId, "user-A", "and the queue must say whose it is");
  assert.equal(
    fake.notes.length,
    1,
    "the server did create it; the replay is what makes that harmless",
  );
});

// ── 8. Queue upgrade must not discard owed work ────────────────────────

test("a v2 queue payload is carried over instead of discarded", async () => {
  const loaded = await loadFresh();
  memory.set(
    "gloss-cloud-queue",
    JSON.stringify({
      version: 2,
      state: {
        pendingAnswers: [
          {
            ownerUserId: "user-A",
            noteId: "note-local",
            remoteId: "note-old",
            content: "尚未送达的回答",
            status: "succeeded",
            clientKey: "ans:note-old:1",
          },
        ],
        pendingDeletes: [{ ownerUserId: "user-A", remoteId: "note-deleted" }],
      },
    }),
  );
  await loaded.cloud.useCloudQueue.persist.rehydrate();

  const state = loaded.cloud.useCloudQueue.getState();
  assert.equal(state.pendingMessages.length, 1, "queued answers must survive the upgrade");
  assert.equal(state.pendingMessages[0]!.content, "尚未送达的回答");
  assert.equal(state.pendingMessages[0]!.role, "assistant");
  assert.equal(state.pendingDeletes.length, 1, "and so must queued deletes");
  assert.equal(state.pendingDeletes[0]!.ownerUserId, "user-A");
});

// ── 9. Interruption records the turn, not the whole answer ─────────────

test("an interrupted run records only the turn that was in flight", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded, { answer: "第一轮回答。\n\n---\n\n第二轮只写了一半" });
  const remoteId = "note-interrupt";
  fake.notes = [makeRemoteNote({ id: remoteId, answer: "第一轮回答。" })];
  loaded.useStore.getState().setNoteRemote(noteId, remoteId, "ver-art-1");
  // The Reader marks the in-flight turn when the stream starts and records
  // the partial as it arrives.
  loaded.cloud.startActiveTurn(noteId, "turn-interrupted");
  loaded.useStore.getState().updateNote(noteId, { activeTurnText: "第二轮只写了一半" });

  const swept = loaded.cloud.markStaleStreamsInterrupted("art-1");
  assert.deepEqual(swept, [noteId]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const written = fake.messages.filter((m) => m.role === "assistant");
  assert.equal(written.length, 1);
  assert.equal(
    written[0]!.content,
    "第二轮只写了一半",
    "the interrupted turn is the partial, not the whole accumulated answer",
  );
  const note = loaded.useStore.getState().notes[noteId]!;
  assert.equal(note.isStreaming, false);
  assert.equal(note.localStatus, "interrupted");
  assert.equal(note.activeTurnId, undefined, "the in-flight marker must be cleared");
});

test("sweeping an interrupted run twice does not append it again", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded, { answer: "部分回答" });
  const remoteId = "note-interrupt-2";
  fake.notes = [makeRemoteNote({ id: remoteId, answer: "" })];
  loaded.useStore.getState().setNoteRemote(noteId, remoteId, "ver-art-1");
  loaded.cloud.startActiveTurn(noteId, "turn-once");
  loaded.useStore.getState().updateNote(noteId, { activeTurnText: "部分回答" });

  loaded.cloud.markStaleStreamsInterrupted("art-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A second sweep (a re-render, a strict-mode double effect) must find
  // nothing to do.
  const second = loaded.cloud.markStaleStreamsInterrupted("art-1");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(second, [], "a finished run is not stale");
  assert.equal(
    fake.messages.filter((m) => m.role === "assistant").length,
    1,
    "and the turn must not be appended twice",
  );
});

test("a queued turn keeps its key when the note it waits behind is created", async () => {
  const loaded = await loadFresh();
  const noteId = addLocalNote(loaded);
  fake.failCreateOnce = {
    key: loaded.cloud.noteCreateClientKey("user-A", "art-1", noteId),
    status: 500,
  };
  await loaded.cloud.persistNote(noteId, "art-1", anchor);
  assert.equal(loaded.cloud.useCloudQueue.getState().pendingCreates.length, 1);

  await loaded.cloud.persistAnswer(noteId, "排在创建后面的回答", "succeeded", "turn-behind");
  const parked = loaded.cloud.useCloudQueue.getState().pendingMessages;
  assert.equal(parked.length, 1, "the turn waits rather than being dropped");

  await loaded.cloud.flushQueue("user-A");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const written = fake.messages.filter((m) => m.role === "assistant");
  assert.equal(written.length, 1, "and is sent once the note exists");
  assert.equal(written[0]!.content, "排在创建后面的回答");
  assert.match(
    written[0]!.clientKey!,
    /^t:note-\d+:turn-behind$/,
    "its key must be rewritten against the real remote id",
  );
});
