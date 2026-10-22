// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The sign-in veto, driven through the real adapter and the real sign-in
 * handler.
 *
 * ## What this file protects
 *
 * If the anonymous workspace on this device cannot be set aside, the device
 * must not be handed to an account. Base's ownership rule clears an account's
 * cache on sign-out, so an account that adopted an un-back-up-able workspace
 * would destroy it at the next sign-out — the content would be gone with no
 * snapshot to restore it from. The refusal therefore has to happen *before*
 * base stamps an owner, and base offers no decision-time veto, so it is
 * expressed at the two value-added call sites that run first:
 * `probeSession` (a session that already existed) and `admitAccount` (the
 * sign-in handler).
 *
 * Both are exercised here against a storage layer that refuses exactly one
 * write — the snapshot — so nothing else about the environment is unusual. The
 * assertion that matters is not the label but the *outcome*: after a blocked
 * attempt, the owner is still anonymous, the content is still there, and the
 * server-side session was revoked rather than left dangling.
 *
 * `ownership-apply.test.ts` covers the same guarantee at the ownership level;
 * this file is where "production actually calls the veto" is pinned.
 *
 * No network and no database: `fetch` is a stub that records the request shape
 * and answers from `routes`. That is the right level here — what is under test
 * is which requests a blocked sign-in does and does not make.
 */

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

const memory = new Map<string, string>();
let refuseWorkspaceSnapshot = false;

const localStoragePolyfill = {
  getItem: (k: string): string | null => memory.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    if (refuseWorkspaceSnapshot && k === "gloss-anon-space") {
      throw new Error("quota exceeded");
    }
    memory.set(k, v);
  },
  removeItem: (k: string): void => {
    memory.delete(k);
  },
  clear: (): void => {
    memory.clear();
  },
  key: (i: number): string | null => Array.from(memory.keys())[i] ?? null,
  get length(): number {
    return memory.size;
  },
};

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

let fetchCalls: FetchCall[] = [];
let routes: { test: (url: string, method: string) => boolean; reply: () => Response }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SESSION_USER = {
  id: "user-1",
  email: "u1@example.test",
  name: "U1",
  emailVerified: true,
  role: "user",
};

before(() => {
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
  Object.defineProperty(globalThis, "fetch", {
    value: async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      fetchCalls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      });
      for (const route of routes) {
        if (route.test(url, method)) return route.reply();
      }
      throw new Error(`unstubbed fetch: ${method} ${url}`);
    },
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  memory.clear();
  fetchCalls = [];
  refuseWorkspaceSnapshot = false;
  routes = [];
});

/** Fresh module scope, initialised *after* the storage polyfill exists. */
async function load() {
  const [
    { useStore },
    { useSettings },
    { useMigration },
    { clearPendingAdopt, hasArchive, prepareOwnershipTransition, ANON_SPACE_KEY },
    { createGlossCloudAdapter },
    { blockedSignIn, setBlockedSignIn },
    { registerCloudAdapter },
    auth,
  ] = await Promise.all([
    import("../../src/lib/store.js"),
    import("../../src/lib/settings.js"),
    import("../../src/lib/migration-store.js"),
    import("../../src/lib/migration-store.js"),
    import("../../src/lib/cloud/adapter.js"),
    import("../../src/lib/cloud/session-block.js"),
    import("../../src/lib/cloud/contract.js"),
    import("../../src/lib/auth-client.js"),
  ]);

  registerCloudAdapter(createGlossCloudAdapter());
  clearPendingAdopt();
  memory.clear();
  memory.delete(ANON_SPACE_KEY);
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();
  useMigration.getState().reset();
  setBlockedSignIn(null);
  // Give the anonymous space something worth protecting. `saveArticle` is
  // base's own action and persists through the store's middleware, so the
  // snapshot the veto takes is a real one.
  await useStore.getState().saveArticle(
    { id: "a-anon", title: "匿名时粘贴的文章", createdAt: 1 },
    [{ index: 1, text: "正文", hash: "h" }],
  );
  assert.equal(useStore.getState().ownerUserId, "anonymous");

  return {
    useStore,
    useSettings,
    useMigration,
    hasArchive,
    prepareOwnershipTransition,
    createGlossCloudAdapter,
    blockedSignIn,
    signIn: auth.signIn,
  };
}

function anonWorkspaceIsIntact(useStore: {
  getState: () => { ownerUserId: string; articles: Record<string, { title?: string }> };
}): void {
  assert.equal(useStore.getState().ownerUserId, "anonymous", "the device must stay anonymous");
  assert.equal(
    useStore.getState().articles["a-anon"]?.title,
    "匿名时粘贴的文章",
    "the anonymous workspace must still be here",
  );
}

test("a blocked snapshot makes the probe resolve anonymous, not the account", async () => {
  const { useStore, hasArchive, createGlossCloudAdapter, blockedSignIn } = await load();
  refuseWorkspaceSnapshot = true;
  routes = [
    { test: (url, m) => url.endsWith("/api/me") && m === "GET", reply: () => json({ user: SESSION_USER }) },
    {
      test: (url, m) => url.endsWith("/api/auth/sign-out") && m === "POST",
      reply: () => json({}, 204),
    },
  ];

  const resolved = await createGlossCloudAdapter().probeSession();

  assert.equal(resolved, null, "a probe that cannot protect the workspace must resolve anonymous");
  anonWorkspaceIsIntact(useStore);
  assert.equal(hasArchive(), false, "nothing was snapshotted, so nothing may be adopted");
  assert.ok(blockedSignIn(), "the reader has to be told why they are not signed in");
  assert.ok(
    fetchCalls.some((c) => c.url.endsWith("/api/auth/sign-out")),
    "the server-side session must be revoked rather than left dangling",
  );
});

test("a snapshot that succeeds lets the probe resolve the account and leaves a restorable archive", async () => {
  const { useStore, hasArchive, createGlossCloudAdapter, blockedSignIn, prepareOwnershipTransition } =
    await load();
  routes = [
    { test: (url, m) => url.endsWith("/api/me") && m === "GET", reply: () => json({ user: SESSION_USER }) },
  ];

  const resolved = await createGlossCloudAdapter().probeSession();

  assert.equal(resolved?.id, "user-1");
  assert.equal(blockedSignIn(), null, "there is nothing to warn about");
  assert.equal(hasArchive(), true, "the workspace must have been set aside for the offer");
  // Base decides ownership *after* the probe, so at this point the live space
  // is still the anonymous one — which is what makes the archive restorable if
  // the user later declines.
  assert.equal(useStore.getState().ownerUserId, "anonymous");
  assert.equal(await prepareOwnershipTransition("user-1"), "archived");
});

test("a blocked sign-in is rolled back: no owner is stamped, the workspace survives", async () => {
  const { useStore, useSettings, signIn, createGlossCloudAdapter, blockedSignIn } = await load();
  useSettings.getState().setApiKey("sk-anon-must-survive");
  refuseWorkspaceSnapshot = true;
  routes = [
    {
      test: (url, m) => url.endsWith("/api/auth/sign-in/email") && m === "POST",
      reply: () => json({ user: SESSION_USER }),
    },
    {
      test: (url, m) => url.endsWith("/api/auth/sign-out") && m === "POST",
      reply: () => json({}, 204),
    },
  ];
  // Touch the adapter so the value is used exactly like production does.
  createGlossCloudAdapter();

  await assert.rejects(
    () => signIn({ email: "u1@example.test", password: "pw" }),
    /本机存储不可用/,
    "the sign-in must fail loudly rather than half-succeed",
  );

  anonWorkspaceIsIntact(useStore);
  assert.equal(
    useSettings.getState().apiKey,
    "sk-anon-must-survive",
    "the anonymous BYOK key must not have been cleared either",
  );
  assert.ok(
    fetchCalls.some((c) => c.url.endsWith("/api/auth/sign-out")),
    "the cookie obtained by the failed sign-in must be revoked",
  );
  assert.ok(blockedSignIn(), "and the reader is told why");
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/api/me")).length, 0);
});

test("a sign-in that can snapshot adopts the account and raises the migration offer", async () => {
  const { useStore, hasArchive, useMigration, signIn } = await load();
  routes = [
    {
      test: (url, m) => url.endsWith("/api/auth/sign-in/email") && m === "POST",
      reply: () => json({ user: SESSION_USER }),
    },
  ];

  await signIn({ email: "u1@example.test", password: "pw" });

  assert.equal(useStore.getState().ownerUserId, "user-1", "the account owns the live space");
  assert.deepEqual(
    useStore.getState().articles,
    {},
    "the account gets a clean space so a cloud pull cannot mix with unconfirmed content",
  );
  assert.equal(hasArchive(), true, "the anonymous workspace is set aside, not lost");
  assert.equal(useMigration.getState().status, "offered", "and the user is asked before anything uploads");
  assert.equal(
    fetchCalls.filter((c) => c.url.endsWith("/api/articles")).length,
    0,
    "signing in must never upload on its own",
  );
});
