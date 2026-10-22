// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The two storage backends, and the claim that they are interchangeable.
 *
 * The seam exists so that everything above it is written once. That is only
 * true if the backends really do behave the same, and "really do" is not
 * something the interface can enforce — it is a property of the two
 * implementations, so it needs a test that runs the same operations against
 * both and compares.
 *
 * The cases are chosen for where a key/value store over two very different
 * APIs could plausibly diverge:
 *
 *   - a missing key (`undefined`, not `null`, not a throw — IndexedDB resolves
 *     `undefined` and the `localStorage` side has to match);
 *   - `keys` returning *only* this store's keys (IndexedDB has stores and
 *     `localStorage` has one flat space, so this is where a prefix bug would
 *     show up as the wipe path deleting something it did not mean to);
 *   - `clear` emptying one store and leaving the other alone;
 *   - a record that cannot be decoded, which `get` must report as absent
 *     rather than throw — a single unreadable entry must not take the reader's
 *     whole library down.
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import "fake-indexeddb/auto";
import {
  createIndexedDbBackend,
  createLocalStorageBackend,
  kvBackend,
  setBackendForTesting,
  type KvBackend,
} from "../../src/lib/storage/backend.js";
import { installMemoryLocalStorage } from "./storage-fixture.js";

const memory = installMemoryLocalStorage();

/** Operations every backend must answer identically. */
async function exercise(backend: KvBackend): Promise<void> {
  assert.equal(await backend.get("bodies", "missing"), undefined, "a missing key is undefined");

  await backend.put("bodies", "a", { n: 1, nested: { list: [1, 2, 3] } });
  await backend.put("bodies", "b", "plain string");
  assert.deepEqual(await backend.get("bodies", "a"), { n: 1, nested: { list: [1, 2, 3] } });
  assert.equal(await backend.get("bodies", "b"), "plain string");

  await backend.put("bodies", "a", { n: 2 });
  assert.deepEqual(await backend.get("bodies", "a"), { n: 2 }, "a second put replaces the value");

  assert.deepEqual((await backend.keys("bodies")).sort(), ["a", "b"]);

  await backend.delete("bodies", "a");
  assert.equal(await backend.get("bodies", "a"), undefined);
  // Deleting twice is success, not an error: the wipe paths retry.
  await backend.delete("bodies", "a");
  assert.deepEqual(await backend.keys("bodies"), ["b"]);

  await backend.clear("bodies");
  assert.deepEqual(await backend.keys("bodies"), []);
  assert.equal(await backend.get("bodies", "b"), undefined);
}

beforeEach(async () => {
  memory.clear();
  setBackendForTesting(null);
  for (const backend of [createLocalStorageBackend(), await createIndexedDbBackend()]) {
    if (backend) await backend.clear("bodies");
  }
});

afterEach(() => {
  setBackendForTesting(null);
});

test("the IndexedDB backend answers every operation", async () => {
  const backend = await createIndexedDbBackend();
  assert.ok(backend, "fake-indexeddb must provide one");
  // The claim under test is that this is the *production* backend, so it
  // failing to open would otherwise silently downgrade the suite to testing
  // the fallback.
  assert.equal(backend.kind, "indexeddb");
  await exercise(backend);
});

test("the localStorage backend answers every operation identically", async () => {
  const backend = createLocalStorageBackend();
  assert.equal(backend.kind, "local-storage");
  await exercise(backend);
});

test("the localStorage backend only sees its own store's keys", async () => {
  // Both backends are addressed by `(store, key)`, but `localStorage` is one
  // flat space. If the prefix were wrong, `clear` would be a `localStorage`
  // wipe — taking the workspace blob, the settings and the legacy key with it.
  memory.set("gloss-storage", "the workspace blob");
  memory.set("gloss-settings", "an api key");
  const backend = createLocalStorageBackend();
  await backend.put("bodies", "a", { paragraphs: [] });
  assert.deepEqual(await backend.keys("bodies"), ["a"]);
  await backend.clear("bodies");
  assert.equal(memory.get("gloss-storage"), "the workspace blob");
  assert.equal(memory.get("gloss-settings"), "an api key");
});

test("a record that cannot be decoded reads as absent rather than throwing", async () => {
  const backend = createLocalStorageBackend();
  await backend.put("bodies", "a", { ok: true });
  // The shape a half-written `setItem` leaves behind.
  memory.set("gloss-kv:bodies:a", "{not json");
  assert.equal(await backend.get("bodies", "a"), undefined);
});

test("with no IndexedDB the probe falls back to localStorage and stays there", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  // A profile where storage is blocked outright, and the Node environment
  // without a polyfill both look like this.
  Reflect.deleteProperty(globalThis, "indexedDB");
  setBackendForTesting(null);
  try {
    const backend = await kvBackend();
    assert.equal(backend.kind, "local-storage");
    // Cached: a second call does not re-probe, so a page that opens many
    // articles pays for the decision once.
    assert.equal(await kvBackend(), backend);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
    setBackendForTesting(null);
  }
});
