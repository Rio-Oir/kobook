// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The stale-response guard's own semantics.
 *
 * `cloud-library-browser.mjs` proves the *page* honours the guard end to end.
 * This file pins the guard itself, because every account-scoped operation in
 * this line now depends on three separate comparisons being right, and a future
 * edit that dropped one of them would still look reasonable in a diff:
 *
 *   - the **epoch**, which base advances on every ownership resolution — the
 *     only signal that catches "signed out and signed back in as the same
 *     person", where every cache on the device was isolated in between;
 *   - the **owner stamp** on the live local space;
 *   - the **resolved session user**.
 *
 * `cloudContextUserId` is the "is there an unambiguous account at all" question,
 * asked *before* a request rather than after it.
 */

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

const memory = new Map<string, string>();
const localStoragePolyfill = {
  getItem: (k: string): string | null => memory.get(k) ?? null,
  setItem: (k: string, v: string): void => {
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
});

beforeEach(() => {
  memory.clear();
});

/** Imported after the storage polyfill exists, like the other store tests. */
async function load() {
  const [{ captureCloudContext, isCloudContextCurrent, cloudContextUserId }, { useSession }, { useStore }, { bumpSessionEpoch }] =
    await Promise.all([
      import("../../src/lib/cloud/guard.js"),
      import("../../src/lib/session.js"),
      import("../../src/lib/store.js"),
      import("../../src/lib/session-epoch.js"),
    ]);
  const key = `user-${Math.random().toString(36).slice(2, 8)}`;
  useStore.getState().clearUserCache();
  useSession.setState({ status: "anon", user: null });
  useStore.getState().setOwner("anonymous");
  return { captureCloudContext, isCloudContextCurrent, cloudContextUserId, useSession, useStore, bumpSessionEpoch, key };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** Store the session and the owner stamp together, as base's ownership does. */
function signInAs(loaded: Loaded, id: string): void {
  loaded.useSession.setState({
    status: "authed",
    user: { id, email: `${id}@example.test`, emailVerified: true, role: "user" },
  });
  loaded.useStore.getState().setOwner(id);
}

test("a fresh context is current", async () => {
  const loaded = await load();
  const { captureCloudContext, isCloudContextCurrent, cloudContextUserId, key } = loaded;
  signInAs(loaded, key);
  const ctx = captureCloudContext();
  assert.equal(ctx.sessionUserId, key);
  assert.equal(ctx.ownerUserId, key);
  assert.equal(isCloudContextCurrent(ctx), true);
  assert.equal(cloudContextUserId(ctx), key);
});

test("an epoch bump invalidates the context even when nothing else moved", async () => {
  const loaded = await load();
  const { captureCloudContext, isCloudContextCurrent, bumpSessionEpoch, key } = loaded;
  signInAs(loaded, key);
  const ctx = captureCloudContext();
  // This is the "signed out and signed back in as the same person" case: the
  // owner id and the session user id are unchanged, but every cache on the
  // device was isolated in between.
  bumpSessionEpoch();
  assert.equal(isCloudContextCurrent(ctx), false);
});

test("a sign-out invalidates the context", async () => {
  const loaded = await load();
  const { captureCloudContext, isCloudContextCurrent, cloudContextUserId, useSession, useStore, key } = loaded;
  signInAs(loaded, key);
  const ctx = captureCloudContext();
  useSession.setState({ status: "anon", user: null });
  useStore.getState().setOwner("anonymous");
  assert.equal(isCloudContextCurrent(ctx), false);
  assert.equal(cloudContextUserId(captureCloudContext()), null, "no account to act for");
});

test("an account switch invalidates the context", async () => {
  const loaded = await load();
  const { captureCloudContext, isCloudContextCurrent, cloudContextUserId, key } = loaded;
  signInAs(loaded, key);
  const ctx = captureCloudContext();
  signInAs(loaded, "user-other");
  assert.equal(isCloudContextCurrent(ctx), false);
  assert.equal(cloudContextUserId(captureCloudContext()), "user-other");
});

test("a window where the session and the local space disagree has no account", async () => {
  const { captureCloudContext, cloudContextUserId, useSession, useStore } = await load();
  // The session already names someone, but the local space has not been handed
  // over yet — the window between the probe resolving and base stamping the
  // owner. Work started here has no unambiguous owner, so it must not be sent.
  useSession.setState({
    status: "authed",
    user: { id: "user-a", email: "a@example.test", emailVerified: true, role: "user" },
  });
  useStore.getState().setOwner("anonymous");
  assert.equal(cloudContextUserId(captureCloudContext()), null);

  // And the mirror image: the space still belongs to the account that is on its
  // way out.
  useSession.setState({ status: "anon", user: null });
  useStore.getState().setOwner("user-a");
  assert.equal(cloudContextUserId(captureCloudContext()), null);
});
