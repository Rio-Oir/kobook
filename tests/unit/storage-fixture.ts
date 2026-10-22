// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The storage environment a unit test runs in.
 *
 * Three things a test that touches article bodies has to arrange, and each one
 * is a real difference between Node and a browser rather than test plumbing:
 *
 *  1. **`indexedDB` does not exist in Node.** `fake-indexeddb` supplies one. It
 *     matters that the *IndexedDB* backend is the one under test rather than
 *     the `localStorage` fallback: IndexedDB is what runs in production, so
 *     testing the fallback alone would leave the shipped path unexercised and
 *     the safety net covered. (`tests/unit/storage-backend.test.ts` covers the
 *     fallback separately.)
 *  2. **`localStorage` does not exist either**, and the workspace blob, the
 *     deletion journal and the legacy key all live there.
 *  3. **The backend is probed once and cached.** Without resetting that cache
 *     between files — or between tests that install a different environment —
 *     the second test would silently use the first one's storage.
 */

import "fake-indexeddb/auto";
import { clearArchivedBodies, clearBodies } from "../../src/lib/storage/bodies.js";
import { setBackendForTesting } from "../../src/lib/storage/backend.js";

/** A `localStorage` that behaves like the real one, including `key`/`length`. */
export function installMemoryLocalStorage(): Map<string, string> {
  const memory = new Map<string, string>();
  const polyfill = {
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
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: polyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: polyfill,
    configurable: true,
    writable: true,
  });
  return memory;
}

/**
 * Wipe both body stores and drop the cached backend probe.
 *
 * Both, not just the live one: the anonymous archive is a second store now,
 * and a test that set one aside without clearing it would leak its contents
 * into the next test's restore — which is exactly the failure the archive
 * tests are about, so it must not be the fixture's own bug.
 *
 * Call from `beforeEach`. The IndexedDB database itself is left in place —
 * deleting and recreating it between tests would add a schema-upgrade race to
 * every one of them for no benefit, since the stores are the only thing with
 * content.
 */
export async function resetBodyStorage(): Promise<void> {
  setBackendForTesting(null);
  await clearBodies();
  await clearArchivedBodies();
}
