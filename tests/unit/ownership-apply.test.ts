// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `applyOwnership` is the wiring proof for the cache-isolation gate. The pure
 * decision lives in `reconcileOwner` and is covered by
 * `auth-config.test.ts`; what this file pins is the side effects on the
 * persisted stores, in the exact order the production code calls them.
 *
 * ## What changed in phase 3, and why the older assertions moved
 *
 * The phase-2 version of this file asserted that a sign-in **relabelled** an
 * anonymous workspace with the new account's id. That is no longer correct:
 *
 *   - "登录时不静默上传匿名内容：显示迁移/同步确认，拒绝后保留独立匿名本地
 *     空间" — uploading is the user's decision, and the decision has to
 *     have something to fall back on;
 *   - a relabel makes the two workspaces the same object. Once they are, a
 *     cloud article pulled for the account lands in the same store as
 *     unconfirmed anonymous content, and "which of these did the user agree to
 *     upload" stops being answerable.
 *
 * So the rule is: the anonymous workspace is snapshotted aside verbatim — still
 * stamped `anonymous`, so it can be restored — and the account gets a clean
 * space plus an *offer*.
 *
 * ## What changed in the dependency-isolation split, and how it is tested now
 *
 * Ownership moved to base (`src/lib/ownership.ts`) and the migration rule moved
 * to this line's adapter (`src/lib/cloud/adapter.ts`). Base has no
 * pre-decision veto for an optional implementation, so the snapshot can no
 * longer be taken from inside `applyOwnership` — it is taken from
 * `prepareOwnershipTransition` while the live space is still anonymous, which
 * is exactly what `probeSession` and the sign-in handler do in production.
 *
 * `loadFresh` below therefore registers the real adapter and drives
 * `transitionOwnership`, which is production's sequence verbatim: snapshot →
 * base decides → the adapter reacts. Testing the composition rather than one
 * function is deliberate; the split is the thing that could break, and a test
 * that called the halves directly would not notice if production stopped
 * calling them in this order.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";

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

/** `keep | adopt | clear | offer` — the old single-function vocabulary. */
type OwnershipDecision = "keep" | "adopt" | "clear" | "offer";

async function loadFresh() {
  // Re-importing the modules gives a fresh module cache for the stores,
  // which is the only way to avoid state leaking across tests when the
  // persisted blob has been wiped.
  const [
    { useStore },
    { useSettings },
    { applyOwnership },
    migrationStore,
    { prepareOwnershipTransition, clearPendingAdopt },
    { onOwnerResolved },
    { registerCloudAdapter },
    { createGlossCloudAdapter },
  ] = await Promise.all([
    import("../../src/lib/store.js"),
    import("../../src/lib/settings.js"),
    import("../../src/lib/ownership.js"),
    import("../../src/lib/migration-store.js"),
    import("../../src/lib/migration-store.js"),
    import("../../src/lib/cloud/adapter.js"),
    import("../../src/lib/cloud/contract.js"),
    import("../../src/lib/cloud/adapter.js"),
  ]);

  // `onOwnerResolved` reaches the adapter through base's `callAdapterHook`, so
  // the composition under test is only complete with one registered.
  registerCloudAdapter(createGlossCloudAdapter());

  // Reset to the initial state explicitly so the in-memory state matches
  // the empty localStorage.
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();
  migrationStore.useMigration.getState().reset();
  memory.delete(migrationStore.ANON_SPACE_KEY);

  /**
   * The production ownership transition, in production's order.
   *
   * Reports `offer` — the old single-function vocabulary this file's
   * assertions are written in — when the adapter actually raised a migration
   * offer, and base's own decision otherwise.
   *
   * **`keep` is also what a blocked snapshot reports**, because that is what
   * production does: `prepareOwnershipTransition` returning `blocked` makes the
   * probe resolve `null` and makes the sign-in roll back, so base's
   * `applyOwnership` is never called on that path and the device stays
   * anonymous. The test below asserts the outcome that matters — the content
   * survives a later sign-out — rather than only the label.
   */
  const transitionOwnership = async (resolvedUserId: string | null): Promise<OwnershipDecision> => {
    if (resolvedUserId) {
      if ((await prepareOwnershipTransition(resolvedUserId)) === "blocked") return "keep";
    } else {
      clearPendingAdopt();
    }
    const decision = await applyOwnership(resolvedUserId);
    onOwnerResolved(resolvedUserId);
    if (decision === "adopt" && migrationStore.useMigration.getState().status === "offered") {
      return "offer";
    }
    return decision;
  };

  return {
    useStore,
    useSettings,
    migrationStore,
    prepareOwnershipTransition,
    applyOwnership: transitionOwnership,
  };
}

async function seedAnonymousArticle(useStore: {
  getState: () => {
    saveArticle: (
      a: { id: string; title: string; createdAt: number },
      paragraphs: { index: number; text: string; hash: string }[],
    ) => Promise<void>;
  };
}): Promise<void> {
  // Two arguments, not one: the storage format keeps the record and the text
  // apart, and `saveArticle` is the only thing that assembles both. Awaited
  // because the text is written asynchronously — a test that snapshots the
  // workspace before this resolves archives a record with no body.
  await useStore.getState().saveArticle(
    { id: "a-anon", title: "匿名时粘贴的文章", createdAt: 1 },
    [{ index: 1, text: "正文", hash: "h" }],
  );
}

test("signing in with an anonymous workspace offers migration instead of adopting it", async () => {
  const { useStore, useSettings, applyOwnership, migrationStore } = await loadFresh();
  await seedAnonymousArticle(useStore);
  useSettings.getState().setApiKey("sk-anon-but-keep");
  assert.equal(useStore.getState().ownerUserId, "anonymous");

  const decision = await applyOwnership("user-1");
  assert.equal(decision, "offer", "a workspace with content is never silently adopted");

  // The account owns the *live* space, and the anonymous content is not
  // in it — that is what keeps a cloud pull from mixing with it.
  assert.equal(useStore.getState().ownerUserId, "user-1");
  assert.deepEqual(useStore.getState().articles, {}, "the live space is clean for the account");

  // The workspace itself is intact, still stamped anonymous, and
  // restorable.
  assert.equal(migrationStore.hasArchive(), true, "the workspace must be snapshotted");
  const archived = JSON.parse(memory.get(migrationStore.ANON_SPACE_KEY)!) as {
    state: { ownerUserId: string; articles: Record<string, { title: string }> };
  };
  assert.equal(
    archived.state.ownerUserId,
    "anonymous",
    "the snapshot must keep its anonymous stamp, or restore would refuse it",
  );
  assert.equal(archived.state.articles["a-anon"]?.title, "匿名时粘贴的文章");

  assert.equal(
    migrationStore.pendingMigrationAccount(),
    "user-1",
    "the account must be offered the migration",
  );
  // The credential does **not** follow the content across identities.
  //
  // This assertion used to read "adopt must not wipe the API key", from
  // the phase-2 rule that a sign-up should not lose a key someone had
  // typed while signed out. The product rule changed: "匿名密钥是否在用户
  // 明确登录操作中继续本机使用**可显式选择**". A plain sign-in is not that
  // choice, so the safe default is to drop it — silently carrying a
  // credential into an account is the failure mode the rule names.
  //
  // The explicit option exists (`setOwner(userId, { keepAnonymousKey:
  // true })`), and wiring it to a real user-facing control is recorded as
  // an open item in `docs/阶段3到阶段4跨界需求.md`; until then the default
  // is the conservative one.
  assert.equal(
    useSettings.getState().apiKey,
    "",
    "a credential must not move to the account without an explicit choice",
  );
});

test("signing in with an empty cache adopts outright, with no offer to make", async () => {
  const { useStore, applyOwnership, migrationStore } = await loadFresh();
  const decision = await applyOwnership("user-1");
  assert.equal(decision, "adopt");
  assert.equal(useStore.getState().ownerUserId, "user-1");
  assert.equal(migrationStore.pendingMigrationAccount(), null, "nothing to offer");
  assert.equal(migrationStore.hasArchive(), false);
});

test("switching to a different user clears articles, notes, currentArticle and the API key", async () => {
  const { useStore, useSettings, applyOwnership } = await loadFresh();
  await useStore.getState().saveArticle(
    { id: "a-a", title: "账号A的文章", createdAt: 1 },
    [{ index: 1, text: "A的正文", hash: "h" }],
  );
  useStore.getState().setOwner("user-A");
  useSettings.getState().setApiKey("sk-A-only");
  useSettings.getState().setOwner("user-A");

  const decision = await applyOwnership("user-B");
  assert.equal(decision, "clear");
  const store = useStore.getState();
  assert.equal(store.ownerUserId, "user-B");
  assert.deepEqual(store.articles, {}, "previous account's articles must be cleared");
  assert.deepEqual(store.notes, {}, "previous account's notes must be cleared");
  assert.equal(store.currentArticleId, null, "currentArticleId must drop the pointer");
  const settings = useSettings.getState();
  assert.equal(settings.ownerUserId, "user-B");
  assert.equal(settings.apiKey, "", "previous account's API key must be cleared");
  assert.equal(settings.provider, "deepseek", "provider is a UI preference, not a credential");
});

test("re-issuing the same user takes the keep path and writes nothing", async () => {
  const { useStore, useSettings, applyOwnership } = await loadFresh();
  await applyOwnership("user-B");
  await useStore.getState().saveArticle(
    { id: "a-b", title: "账号B的文章", createdAt: 1 },
    [{ index: 1, text: "B的正文", hash: "h" }],
  );

  const decision = await applyOwnership("user-B");
  assert.equal(decision, "keep");
  assert.equal(
    useStore.getState().articles["a-b"]?.title,
    "账号B的文章",
    "keep must not clear anything",
  );
  useSettings.getState().setApiKey("sk-B");
  await applyOwnership("user-B");
  assert.equal(useSettings.getState().apiKey, "sk-B");
});

test("an anonymous probe does not wipe the settings a signed-out reader configured", async () => {
  // The defect this replaces: `applyOwnership(null)` cleared the store
  // and the API key unconditionally, and it runs on every session probe
  // — including the one on page load. A signed-out reader who had set a
  // BYOK key lost it by refreshing.
  const { useStore, useSettings, applyOwnership } = await loadFresh();
  useSettings.getState().setApiKey("sk-local-anonymous");
  await seedAnonymousArticle(useStore);

  const decision = await applyOwnership(null);
  assert.equal(decision, "keep");
  assert.equal(useSettings.getState().apiKey, "sk-local-anonymous", "the key must survive");
  assert.equal(
    useStore.getState().articles["a-anon"]?.title,
    "匿名时粘贴的文章",
    "the article must survive",
  );
});

test("sign-out from an account clears it and hands the anonymous workspace back", async () => {
  const { useStore, useSettings, applyOwnership, migrationStore } = await loadFresh();
  // An anonymous workspace exists, then the user signs in and the
  // workspace is set aside.
  await seedAnonymousArticle(useStore);
  await applyOwnership("user-C");
  assert.equal(useStore.getState().ownerUserId, "user-C");

  useSettings.getState().setApiKey("sk-C-only");
  useSettings.getState().setOwner("user-C");

  const signout = await applyOwnership(null);
  assert.equal(signout, "clear");
  const store = useStore.getState();
  assert.equal(store.ownerUserId, "anonymous");
  // The account's own content is gone...
  assert.deepEqual(store.notes, {});
  // ...and the anonymous workspace is back, because the snapshot is
  // restored rather than the account's rows being relabelled.
  assert.equal(
  store.articles["a-anon"]?.title,
    "匿名时粘贴的文章",
    "the anonymous workspace must come back on sign-out",
  );
  // The restored pointer is the anonymous workspace's own, not a
  // leftover from the account.
  assert.equal(store.currentArticleId, "a-anon");
  assert.equal(migrationStore.hasArchive(), false, "the snapshot is consumed by the restore");

  const settings = useSettings.getState();
  assert.equal(settings.ownerUserId, "anonymous");
  assert.equal(settings.apiKey, "", "the account's credential must not survive sign-out");
});

test("a failed snapshot keeps the device anonymous, and the workspace survives a later sign-out", async () => {
  const { useStore, useSettings, applyOwnership, migrationStore, prepareOwnershipTransition } =
    await loadFresh();
  await seedAnonymousArticle(useStore);
  useSettings.getState().setApiKey("sk-anon-must-survive");
  assert.equal(useStore.getState().ownerUserId, "anonymous");

  // Make the snapshot write fail (quota, disabled storage, anything).
  const original = localStoragePolyfill.setItem;
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      ...localStoragePolyfill,
      setItem: (k: string, v: string) => {
        if (k === "gloss-anon-space") throw new Error("quota exceeded");
        original(k, v);
      },
    },
    configurable: true,
    writable: true,
  });
  try {
    // The veto itself. This is the call `probeSession` and `admitAccount` make
    // *before* base is allowed to stamp anything; the adapter- and
    // sign-in-level tests that prove both paths honour it live in
    // `tests/unit/cloud-adapter.test.ts`.
    assert.equal(await prepareOwnershipTransition("user-D"), "blocked");

    // Because production stops at the veto, base's `applyOwnership` is never
    // reached on this path, so nothing is stamped and nothing is adopted:
    // the workspace is still the live one and still anonymous-owned.
    assert.equal(useStore.getState().ownerUserId, "anonymous");
    assert.equal(
      useStore.getState().articles["a-anon"]?.title,
      "匿名时粘贴的文章",
      "the workspace must still be there",
    );
    assert.equal(migrationStore.hasArchive(), false, "no snapshot was written");
    assert.equal(migrationStore.pendingMigrationAccount(), null, "nothing was set aside to migrate");

    // The property that actually matters, asserted at the moment it could be
    // broken: signing out clears an *account's* cache, so if the device had
    // become this account's, the content would be gone here. It is not.
    assert.equal(await applyOwnership(null), "keep");
    assert.equal(
      useStore.getState().articles["a-anon"]?.title,
      "匿名时粘贴的文章",
      "a later sign-out must not destroy the anonymous workspace",
    );
    assert.equal(
      useSettings.getState().apiKey,
      "sk-anon-must-survive",
      "and the anonymous BYOK key must survive too",
    );
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStoragePolyfill,
      configurable: true,
      writable: true,
    });
  }
});

test("stale articles pointing at a currentArticleId of a deleted article do not survive a clear", async () => {
  const { useStore, applyOwnership } = await loadFresh();
  await useStore.getState().saveArticle(
    { id: "orphan", title: "临时文章", createdAt: 1 },
    [],
  );
  useStore.getState().setOwner("user-X");
  assert.equal(useStore.getState().currentArticleId, "orphan");

  await applyOwnership("user-Y");
  const state = useStore.getState();
  assert.equal(state.currentArticleId, null, "currentArticleId must not point at a deleted article");
});
