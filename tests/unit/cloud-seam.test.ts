// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The base/cloud seam, as a behaviour contract.
 *
 * These are the properties the dependency split exists to guarantee, written
 * so that a future change cannot quietly undo one of them:
 *
 *   1. **No adapter is installed by default, and that is not an error.** The
 *      session settles on `anon` without opening a socket, and every cloud
 *      entry point keeps its promise contract.
 *   2. **A cloud failure never blocks or corrupts a local operation.** An
 *      adapter that throws on every call leaves the article, the note and the
 *      delete intact and reachable.
 *   3. **Base applies the verdict; the adapter only reports it.** There is
 *      one implementation of what an article or a note is, and it is not in
 *      the transport.
 *   4. **Owner and epoch semantics survive the split.** An anonymous cache is
 *      kept across an anonymous probe, adopted on first sign-in, and cleared
 *      for a different account — and the epoch advances on every resolution so
 *      in-flight work from a previous session is dropped.
 *   5. **A note's anchor and its frozen turn id cross the seam unchanged.**
 *      Block ids, offsets and the turn id are what make a note re-anchorable
 *      and a replay idempotent; a transport that rewrote any of them would
 *      break anchoring on the other side of the wire.
 *
 * The tests drive the seam with recording fakes rather than a server. A fake
 * that never touches the network is the point: what is under test is base's
 * behaviour *when there is no cloud*, which is the state a base release ships
 * in and the state no integration suite can produce by accident.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { installLocalStorage } from "./byok-fake-provider.js";

// The stores persist through `localStorage`, which node does not have.
installLocalStorage();

let cloud: typeof import("../../src/lib/cloud/contract.js");
let bridge: typeof import("../../src/lib/cloud/bridge.js");
let session: typeof import("../../src/lib/session.js");
let lifecycle: typeof import("../../src/lib/note-lifecycle.js");
let ownership: typeof import("../../src/lib/ownership.js");
let epoch: typeof import("../../src/lib/session-epoch.js");
let useStore: typeof import("../../src/lib/store.js").useStore;
let useSettings: typeof import("../../src/lib/settings.js").useSettings;

before(async () => {
  cloud = await import("../../src/lib/cloud/contract.js");
  bridge = await import("../../src/lib/cloud/bridge.js");
  session = await import("../../src/lib/session.js");
  lifecycle = await import("../../src/lib/note-lifecycle.js");
  ownership = await import("../../src/lib/ownership.js");
  epoch = await import("../../src/lib/session-epoch.js");
  useStore = (await import("../../src/lib/store.js")).useStore;
  useSettings = (await import("../../src/lib/settings.js")).useSettings;
});

beforeEach(() => {
  // Every test starts from the shipped default: no adapter.
  cloud.registerCloudAdapter(null);
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();
  useSettings.getState().setOwner("anonymous");
  useSessionSettle();
});

/** Force the session store back to a known state without probing. */
function useSessionSettle(): void {
  session.useSession.setState({ status: "anon", user: null, _bootstrap: undefined });
}

const ARTICLE = {
  id: "local-abc1234567890",
  title: "示例文章",
  createdAt: 1_700_000_000_000,
};

const PARAGRAPHS = [{ index: 1, text: "第一段正文。", hash: "deadbeef0123" }];

/**
 * Save an article through the store and hand back its id.
 *
 * Awaited, because the text is a body now and the write is asynchronous. The
 * record and the in-memory body are installed synchronously inside
 * `saveArticle`, so every synchronous assertion that follows still sees them —
 * what the await adds is that a storage refusal surfaces here instead of as an
 * unhandled rejection after the test has finished.
 */
async function seedArticle(): Promise<string> {
  await useStore.getState().saveArticle({ ...ARTICLE }, PARAGRAPHS.map((p) => ({ ...p })));
  return ARTICLE.id;
}

function seedNote(articleId: string): string {
  return useStore.getState().addNote({
    articleId,
    paragraphIndex: 1,
    type: "explain",
    selectionText: "第一段",
    question: "这是什么意思？",
    answer: "",
    model: "test-model",
    startParagraphIndex: 1,
    startOffset: 0,
    endParagraphIndex: 1,
    endOffset: 3,
  });
}

/** An adapter that records its calls and answers with a fixed verdict. */
function recordingAdapter(overrides: Partial<import("../../src/lib/cloud/contract.js").CloudAdapter> = {}) {
  const calls: string[] = [];
  const anchors: import("../../src/lib/cloud/contract.js").CloudNoteAnchor[] = [];
  const turnIds: (string | undefined)[] = [];
  const adapter: import("../../src/lib/cloud/contract.js").CloudAdapter = {
    id: "test-recording",
    async probeSession() {
      calls.push("probeSession");
      return null;
    },
    async signOut() {
      calls.push("signOut");
    },
    async uploadArticle() {
      calls.push("uploadArticle");
      return { status: "rejected", message: "refused" };
    },
    async persistNote(_noteId, _articleId, anchor) {
      calls.push("persistNote");
      anchors.push(anchor);
      return { remoteId: "remote-note-1", remoteVersionId: "remote-ver-1" };
    },
    async persistAnswer(_noteId, _answer, _status, turnId) {
      calls.push("persistAnswer");
      turnIds.push(turnId);
    },
    async persistFollowUpQuestion(_noteId, _question, turnId) {
      calls.push("persistFollowUpQuestion");
      turnIds.push(turnId);
    },
    async deleteNote() {
      calls.push("deleteNote");
    },
    async syncNotesFromServer() {
      calls.push("syncNotesFromServer");
      return 0;
    },
    ...overrides,
  };
  return { adapter, calls, anchors, turnIds };
}

/** An adapter that throws from every method, including the optional one. */
function hostileAdapter(): import("../../src/lib/cloud/contract.js").CloudAdapter {
  const boom = (): never => {
    throw new Error("cloud is down");
  };
  return {
    id: "test-hostile",
    onOwnerResolved: boom,
    probeSession: async () => boom(),
    signOut: async () => boom(),
    uploadArticle: async () => boom(),
    persistNote: async () => boom(),
    persistAnswer: async () => boom(),
    persistFollowUpQuestion: async () => boom(),
    deleteNote: async () => boom(),
    syncNotesFromServer: async () => boom(),
  };
}

/**
 * An adapter whose every method throws **synchronously**, before returning a
 * promise.
 *
 * This is the case `.catch()` cannot see, and the one TypeScript cannot
 * exclude: a function whose body only throws has return type `never`, which is
 * assignable to `Promise<T>`. The previous implementation called
 * `adapter.method(...).catch(...)`, so the exception was raised at the call
 * site and propagated straight out of base's own functions — out of
 * `saveAndOpen`, out of the session bootstrap, out of the note sweep.
 *
 * The factory exists so every entry point can be exercised against it; the
 * tests below are the regression fence for "a broken adapter cannot break the
 * local path".
 */
function syncThrowingAdapter(overrides: Partial<import("../../src/lib/cloud/contract.js").CloudAdapter> = {}) {
  const boom = (): never => {
    throw new Error("adapter threw synchronously");
  };
  const base: import("../../src/lib/cloud/contract.js").CloudAdapter = {
    id: "test-sync-throw",
    onOwnerResolved: boom,
    probeSession: boom,
    signOut: boom,
    uploadArticle: boom,
    persistNote: boom,
    persistAnswer: boom,
    persistFollowUpQuestion: boom,
    deleteNote: boom,
    syncNotesFromServer: boom,
  };
  return { ...base, ...overrides } as import("../../src/lib/cloud/contract.js").CloudAdapter;
}

/** An adapter whose methods never settle. */
function neverSettlingAdapter(): import("../../src/lib/cloud/contract.js").CloudAdapter {
  const hang = (): Promise<never> => new Promise<never>(() => {});
  return {
    id: "test-never",
    probeSession: hang,
    signOut: hang,
    uploadArticle: hang,
    persistNote: hang,
    persistAnswer: hang,
    persistFollowUpQuestion: hang,
    deleteNote: hang,
    syncNotesFromServer: hang,
  };
}

// ── 1. The default: no adapter ────────────────────────────────────────────

test("seam: base ships with no cloud adapter installed", async () => {
  assert.equal(cloud.cloudAdapter(), null);
  assert.equal(cloud.hasCloudAdapter(), false);
  assert.equal(bridge.isCloudEnabled(), false);
  assert.equal(bridge.actingUserId(), null);
});

test("seam: with no adapter the session settles on anon and opens no socket", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("the base build must not open a socket to resolve a session");
  }) as typeof globalThis.fetch;
  try {
    useSessionSettle();
    session.useSession.setState({ status: "loading" });
    await session.useSession.getState().refresh();
    assert.equal(session.useSession.getState().status, "anon");
    assert.equal(session.useSession.getState().user, null);
    assert.equal(calls, 0, "refresh must not probe when nothing implements the contract");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("seam: every cloud entry point is a no-op that keeps its promise contract", async () => {
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);

  assert.equal(await bridge.persistNote(noteId, articleId, { paragraphIndex: 1, type: "explain", selectionText: "x", question: "q", model: "m" }), null);
  await bridge.persistAnswer(noteId, "answer", "succeeded", "turn-1");
  await bridge.persistFollowUpQuestion(noteId, "why?", "turn-2");
  assert.equal(await bridge.syncNotesFromServer(articleId), 0);
  await bridge.removeNote(noteId);

  assert.equal(useStore.getState().notes[noteId], undefined, "the local delete still happened");
  assert.ok(useStore.getState().articles[articleId], "the article is untouched");
});

test("seam: an article import with no adapter stays purely local", async () => {
  const articleId = await seedArticle();
  const article = useStore.getState().articles[articleId]!;
  bridge.enqueueArticleSync(article, { title: "t", blocks: [], textHash: "h" } as never, "local");
  assert.equal(useStore.getState().articles[articleId]?.remoteId, undefined);
  assert.equal(useStore.getState().articles[articleId]?.remoteSyncStatus, undefined);
});

// ── 2. A failing adapter never blocks the local path ──────────────────────

test("seam: an adapter that throws cannot block or corrupt a local write", async () => {
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  cloud.registerCloudAdapter(hostileAdapter());

  // The local writes already happened before any of these ran; none of the
  // cloud calls may throw into the caller or undo them.
  assert.equal(await bridge.persistNote(noteId, articleId, { paragraphIndex: 1, type: "explain", selectionText: "x", question: "q", model: "m" }), null);
  await bridge.persistAnswer(noteId, "partial", "failed", "turn-x");
  await bridge.persistFollowUpQuestion(noteId, "again?", "turn-y");
  assert.equal(await bridge.syncNotesFromServer(articleId), 0);

  assert.ok(useStore.getState().articles[articleId], "the article survives a cloud failure");
  assert.ok(useStore.getState().notes[noteId], "the note survives a cloud failure");
  assert.equal(useStore.getState().notes[noteId]?.remoteId, undefined, "a failed create leaves the note local");

  // The delete is local-first: it must complete even though the remote half
  // throws.
  await bridge.removeNote(noteId);
  assert.equal(useStore.getState().notes[noteId], undefined);
});

test("seam: a throwing upload records a visible local failure without dropping the article", async () => {
  const articleId = await seedArticle();
  cloud.registerCloudAdapter(hostileAdapter());
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  const article = useStore.getState().articles[articleId]!;
  bridge.enqueueArticleSync(article, { title: "t", blocks: [], textHash: "h" } as never, "local", {
    ownerUserId: "user-A",
    epoch: epoch.currentSessionEpoch(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const after = useStore.getState().articles[articleId]!;
  assert.ok(after, "a throwing upload must not remove the article");
  assert.equal(after.remoteId, undefined);
  assert.equal(after.remoteSyncStatus, "network-error", "the failure is visible, not silent");
});

test("seam: an upload is never attempted under an identity base cannot verify", async () => {
  const { adapter, calls } = recordingAdapter();
  cloud.registerCloudAdapter(adapter);
  const articleId = await seedArticle();
  const article = useStore.getState().articles[articleId]!;

  // No session is installed, so the frozen submit identity names an account
  // this client is not signed in as. Base must refuse to upload rather than
  // bind an article to an identity it cannot confirm.
  bridge.enqueueArticleSync(article, { title: "t", blocks: [], textHash: "h" } as never, "local", {
    ownerUserId: "user-A",
    epoch: epoch.currentSessionEpoch(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [], "nothing may reach the transport without a matching session");
  assert.equal(useStore.getState().articles[articleId]?.remoteId, undefined);
});

test("seam: a rejected upload is recorded on the article and keeps it", async () => {
  const { adapter } = recordingAdapter();
  cloud.registerCloudAdapter(adapter);
  const articleId = await seedArticle();
  // Make the local space and the session name the same account, so the
  // identity gate lets the upload through.
  useStore.getState().setOwner("user-A");
  useSessionSettle();
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  const article = useStore.getState().articles[articleId]!;
  bridge.enqueueArticleSync(article, { title: "t", blocks: [], textHash: "h" } as never, "local", {
    ownerUserId: "user-A",
    epoch: epoch.currentSessionEpoch(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const after = useStore.getState().articles[articleId]!;
  assert.equal(after.remoteId, undefined, "a refusal must not bind a server id");
  assert.equal(after.remoteSyncStatus, "rejected");
});

test("seam: an accepted upload binds the server id onto the local article", async () => {
  const { adapter } = recordingAdapter({
    uploadArticle: async () => ({ status: "uploaded", articleId: "server-1", versionId: "ver-1" }),
  });
  cloud.registerCloudAdapter(adapter);
  const articleId = await seedArticle();
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  const article = useStore.getState().articles[articleId]!;
  bridge.enqueueArticleSync(article, { title: "t", blocks: [], textHash: "h" } as never, "browser-jina", {
    ownerUserId: "user-A",
    epoch: epoch.currentSessionEpoch(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const after = useStore.getState().articles[articleId]!;
  assert.equal(after.remoteId, "server-1", "base — not the adapter — writes the server id");
  assert.equal(after.remoteVersionId, "ver-1");
  assert.equal(after.remoteSource, "browser-jina");
});

// ── 3. Owner and epoch compatibility ──────────────────────────────────────

test("seam: an anonymous probe keeps the anonymous cache", async () => {
  const articleId = await seedArticle();
  useSettings.setState({ apiKey: "sk-user-key" });

  const decision = ownership.applyOwnership(null);
  assert.equal(decision, "keep");
  assert.ok(useStore.getState().articles[articleId], "a reload must not erase a pasted article");
  assert.equal(useSettings.getState().apiKey, "sk-user-key", "a reload must not erase a BYOK key");
});

test("seam: the first sign-in adopts the cache, a different account clears it", async () => {
  const articleId = await seedArticle();
  useSettings.setState({ apiKey: "sk-anon-key" });

  assert.equal(ownership.applyOwnership("user-A"), "adopt");
  assert.equal(useStore.getState().ownerUserId, "user-A");
  assert.ok(useStore.getState().articles[articleId], "adoption keeps the anonymous article readable");
  assert.equal(useSettings.getState().ownerUserId, "user-A");

  // Same account again is a no-op.
  assert.equal(ownership.applyOwnership("user-A"), "keep");

  // A different account must not see the previous one's cache.
  assert.equal(ownership.applyOwnership("user-B"), "clear");
  assert.equal(useStore.getState().ownerUserId, "user-B");
  assert.equal(useStore.getState().articles[articleId], undefined, "a foreign cache is cleared");
  assert.equal(useSettings.getState().apiKey, "", "a credential never travels between identities");

  // Signing out returns the stamp to anonymous.
  assert.equal(ownership.applyOwnership(null), "clear");
  assert.equal(useStore.getState().ownerUserId, "anonymous");
});

test("seam: every ownership resolution advances the epoch", async () => {
  const before = epoch.currentSessionEpoch();
  ownership.applyOwnership(null);
  const afterKeep = epoch.currentSessionEpoch();
  assert.ok(afterKeep > before, "even a no-op resolution advances the epoch");

  ownership.applyOwnership("user-A");
  assert.ok(epoch.currentSessionEpoch() > afterKeep);
});

test("seam: the adapter is told about the resolved owner, after the local stamps", async () => {
  const seen: (string | null)[] = [];
  const { adapter } = recordingAdapter({
    onOwnerResolved: (owner) => {
      // The local stamps must already be consistent when the adapter runs;
      // otherwise an implementation cannot tell which space it is being told
      // about.
      seen.push(`${owner}:${useStore.getState().ownerUserId}`);
    },
  });
  cloud.registerCloudAdapter(adapter);

  ownership.applyOwnership("user-A");
  ownership.applyOwnership(null);
  assert.deepEqual(seen, ["user-A:user-A", "null:anonymous"]);
});

// ── 4. Note anchors and frozen turn ids ───────────────────────────────────

test("seam: a note anchor crosses the seam unchanged", async () => {
  const { adapter, anchors } = recordingAdapter();
  cloud.registerCloudAdapter(adapter);
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  const anchor = {
    paragraphIndex: 1,
    type: "explain" as const,
    selectionText: "第一段",
    question: "这是什么意思？",
    model: "test-model",
    startParagraphIndex: 1,
    startOffset: 0,
    endParagraphIndex: 1,
    endOffset: 3,
    startBlockId: "b1-deadbeef",
    endBlockId: "b1-deadbeef",
  };
  await bridge.persistNote(noteId, articleId, anchor);

  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0], anchor, "block ids and offsets must reach the transport verbatim");
});

test("seam: base binds the note's server id onto the local note", async () => {
  const { adapter } = recordingAdapter();
  cloud.registerCloudAdapter(adapter);
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  const remoteId = await bridge.persistNote(noteId, articleId, {
    paragraphIndex: 1,
    type: "explain",
    selectionText: "第一段",
    question: "q",
    model: "m",
  });

  assert.equal(remoteId, "remote-note-1");
  const note = useStore.getState().notes[noteId]!;
  assert.equal(note.remoteId, "remote-note-1", "base — not the adapter — writes the binding");
  assert.equal(note.remoteVersionId, "remote-ver-1");

  // A second call is a no-op: the note already has a row, so a retry cannot
  // re-point it at a different one.
  assert.equal(await bridge.persistNote(noteId, articleId, {
    paragraphIndex: 1,
    type: "explain",
    selectionText: "第一段",
    question: "q",
    model: "m",
  }), "remote-note-1");
});

test("seam: a note create that lands after the epoch moved is not bound", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { adapter } = recordingAdapter({
    persistNote: async () => {
      await gate;
      return { remoteId: "remote-late", remoteVersionId: "ver-late" };
    },
  });
  cloud.registerCloudAdapter(adapter);
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  const pending = bridge.persistNote(noteId, articleId, {
    paragraphIndex: 1,
    type: "explain",
    selectionText: "第一段",
    question: "q",
    model: "m",
  });
  // The session ends while the create is in flight.
  ownership.applyOwnership(null);
  release!();

  assert.equal(await pending, null);
  assert.equal(
    useStore.getState().notes[noteId]?.remoteId,
    undefined,
    "a binding from a previous session must never be written",
  );
});

test("seam: the interruption sweep records the frozen turn's own partial text", async () => {
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  const turnId = lifecycle.mintTurnId();

  // A run that produced some text and then the tab was closed.
  lifecycle.startActiveTurn(noteId, turnId);
  useStore.getState().updateNote(noteId, { activeTurnText: "已经流出的半句", answer: "已经流出的半句" });

  const swept = lifecycle.markStaleStreamsInterrupted(articleId);
  assert.deepEqual(swept, [noteId]);

  const note = useStore.getState().notes[noteId]!;
  assert.equal(note.isStreaming, false);
  assert.equal(note.localStatus, "interrupted");
  assert.equal(note.activeTurnId, undefined);

  const assistantTurn = note.turns?.find((t) => t.role === "assistant");
  assert.equal(assistantTurn?.content, "已经流出的半句");
  assert.equal(assistantTurn?.clientTurnId, turnId, "the turn id is the one frozen at stream start");
});

test("seam: the sweep offers the same frozen turn id to the adapter", async () => {
  const { adapter, turnIds } = recordingAdapter();
  cloud.registerCloudAdapter(adapter);
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  const turnId = lifecycle.mintTurnId();
  lifecycle.startActiveTurn(noteId, turnId);
  useStore.getState().updateNote(noteId, { activeTurnText: "半句" });
  lifecycle.markStaleStreamsInterrupted(articleId);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(turnIds, [turnId], "a replay must land on the same message, not append a second one");
});

// ── 5. Installing and uninstalling ────────────────────────────────────────

test("seam: registering null restores the shipped default", async () => {
  const { adapter, calls } = recordingAdapter();
  cloud.registerCloudAdapter(adapter);
  assert.equal(cloud.hasCloudAdapter(), true);
  await session.useSession.getState().refresh();
  assert.deepEqual(calls, ["probeSession"]);

  cloud.registerCloudAdapter(null);
  assert.equal(cloud.hasCloudAdapter(), false);
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  assert.equal(await bridge.persistNote(noteId, articleId, { paragraphIndex: 1, type: "explain", selectionText: "x", question: "q", model: "m" }), null);
  assert.deepEqual(calls, ["probeSession"], "no call reaches an uninstalled adapter");
});

// ── 6. A *synchronously* throwing adapter cannot break the local path ─────
//
// `.catch()` is attached to the result of the call, so it only ever sees a
// rejected promise. A method that throws before returning — which TypeScript
// permits, because `() => never` is assignable to `() => Promise<T>` — used to
// escape into base's own stack. These are the regression fence for that: each
// one fails, rather than passing, against the previous implementation.

test("seam: a synchronously throwing adapter cannot escape a local note write", async () => {
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  cloud.registerCloudAdapter(syncThrowingAdapter());
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  // None of these may throw out of the caller.
  assert.equal(await bridge.persistNote(noteId, articleId, { paragraphIndex: 1, type: "explain", selectionText: "x", question: "q", model: "m" }), null);
  await bridge.persistAnswer(noteId, "answer", "succeeded", "turn-1");
  await bridge.persistFollowUpQuestion(noteId, "why?", "turn-2");
  assert.equal(await bridge.syncNotesFromServer(articleId), 0);

  assert.ok(useStore.getState().articles[articleId], "the article survives");
  assert.ok(useStore.getState().notes[noteId], "the note survives");
  assert.equal(useStore.getState().notes[noteId]?.remoteId, undefined);
});

test("seam: a synchronously throwing adapter cannot escape a local delete", async () => {
  const articleId = await seedArticle();
  const noteId = seedNote(articleId);
  // Give the note a server binding so the remote half is actually attempted.
  useStore.getState().setNoteRemote(noteId, "remote-1", "ver-1");
  cloud.registerCloudAdapter(syncThrowingAdapter());

  await bridge.removeNote(noteId);
  assert.equal(useStore.getState().notes[noteId], undefined, "the local delete still happened");
});

test("seam: a synchronously throwing upload does not escape the import path", async () => {
  const articleId = await seedArticle();
  cloud.registerCloudAdapter(syncThrowingAdapter());
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });
  const article = useStore.getState().articles[articleId]!;

  // `enqueueArticleSync` is called synchronously from the import handler, after
  // the article has been saved and the reader has navigated. A throw here used
  // to surface as a failed import on an import that had already succeeded.
  bridge.enqueueArticleSync(article, { title: "t", blocks: [], textHash: "h" } as never, "local", {
    ownerUserId: "user-A",
    epoch: epoch.currentSessionEpoch(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const after = useStore.getState().articles[articleId]!;
  assert.equal(after.remoteId, undefined);
  assert.equal(after.remoteSyncStatus, "network-error", "the failure is still visible");
});

test("seam: a synchronously throwing persistAnswer cannot abort the interruption sweep", async () => {
  const articleId = await seedArticle();
  const first = seedNote(articleId);
  const second = seedNote(articleId);
  cloud.registerCloudAdapter(syncThrowingAdapter());

  for (const noteId of [first, second]) {
    const turnId = lifecycle.mintTurnId();
    lifecycle.startActiveTurn(noteId, turnId);
    useStore.getState().updateNote(noteId, { activeTurnText: "半句" });
  }

  // The sweep must reach both notes: a throw from the first note's mirror must
  // not leave the second looking like it is still streaming.
  const swept = lifecycle.markStaleStreamsInterrupted(articleId);
  assert.deepEqual([...swept].sort(), [first, second].sort());
  for (const noteId of [first, second]) {
    assert.equal(useStore.getState().notes[noteId]?.isStreaming, false);
    assert.equal(useStore.getState().notes[noteId]?.localStatus, "interrupted");
  }
});

test("seam: a synchronously throwing owner hook cannot interrupt ownership", async () => {
  cloud.registerCloudAdapter(syncThrowingAdapter());
  const articleId = await seedArticle();
  useSettings.setState({ apiKey: "sk-anon-key" });

  // The hook is called in every branch; the local reconciliation must complete
  // and the decision must still be reported.
  const adopted = ownership.applyOwnership("user-A");
  assert.equal(adopted, "adopt");
  assert.equal(useStore.getState().ownerUserId, "user-A");
  assert.ok(useStore.getState().articles[articleId], "adoption still kept the article");

  const kept = ownership.applyOwnership("user-A");
  assert.equal(kept, "keep");

  const cleared = ownership.applyOwnership("user-B");
  assert.equal(cleared, "clear");
  assert.equal(useStore.getState().ownerUserId, "user-B");
  assert.equal(useStore.getState().articles[articleId], undefined);

  const signedOut = ownership.applyOwnership(null);
  assert.equal(signedOut, "clear");
  assert.equal(useStore.getState().ownerUserId, "anonymous");
});

test("seam: a synchronously throwing owner hook cannot strand the session on loading", async () => {
  // A probe that *succeeds* but whose ownership hook throws is the precise
  // shape of the reported defect: `applyOwnership` ran before the status was
  // published, so the throw left the app on `loading` with a resolved session.
  cloud.registerCloudAdapter(
    syncThrowingAdapter({
      probeSession: async () => ({ id: "user-A", email: "a@b.c", emailVerified: true }),
    }),
  );
  useSessionSettle();
  session.useSession.setState({ status: "loading" });

  await session.useSession.getState().refresh();

  assert.equal(session.useSession.getState().status, "authed");
  assert.equal(session.useSession.getState().user?.id, "user-A");
  assert.equal(useStore.getState().ownerUserId, "user-A", "the owner was still stamped");
});

test("seam: a synchronously throwing probeSession still settles the session on anon", async () => {
  cloud.registerCloudAdapter(syncThrowingAdapter());
  useSessionSettle();
  session.useSession.setState({ status: "loading" });

  await session.useSession.getState().refresh();
  assert.equal(session.useSession.getState().status, "anon");
});

// ── 7. Sign-out clears local state whatever the adapter does ──────────────

test("seam: signOut clears the local session even when the adapter throws synchronously", async () => {
  cloud.registerCloudAdapter(syncThrowingAdapter());
  useStore.getState().setOwner("user-A");
  await useStore.getState().saveArticle({ ...ARTICLE }, PARAGRAPHS.map((p) => ({ ...p })));
  useSettings.setState({ apiKey: "sk-user-key" });
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  await session.useSession.getState().signOut();

  assert.equal(session.useSession.getState().status, "anon");
  assert.equal(session.useSession.getState().user, null);
  assert.equal(useStore.getState().ownerUserId, "anonymous", "the account's cache was isolated");
  assert.equal(useSettings.getState().apiKey, "", "the credential was dropped");
});

test("seam: signOut clears the local session even when the adapter rejects", async () => {
  cloud.registerCloudAdapter(hostileAdapter());
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  await session.useSession.getState().signOut();
  assert.equal(session.useSession.getState().status, "anon");
  assert.equal(useStore.getState().ownerUserId, "anonymous");
});

test("seam: signOut clears the local session even when the adapter never answers", async () => {
  cloud.registerCloudAdapter(neverSettlingAdapter());
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  // A hung endpoint must not hold the sign-out open. Raced against a budget so
  // a regression fails cleanly instead of hanging the suite.
  const outcome = await Promise.race([
    session.useSession.getState().signOut().then(() => "settled" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_000)),
  ]);

  assert.equal(outcome, "settled", "sign-out must not wait on the service");
  assert.equal(session.useSession.getState().status, "anon");
  assert.equal(useStore.getState().ownerUserId, "anonymous");
});

test("seam: signOut still asks the adapter to end the remote session", async () => {
  const { adapter, calls } = recordingAdapter();
  cloud.registerCloudAdapter(adapter);
  useStore.getState().setOwner("user-A");
  session.useSession.setState({ status: "authed", user: { id: "user-A", email: "a@b.c", emailVerified: true } });

  await session.useSession.getState().signOut();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(calls.includes("signOut"), "the best-effort remote revoke is still attempted");
  assert.equal(session.useSession.getState().status, "anon");
});
