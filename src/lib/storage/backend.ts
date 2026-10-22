// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The key/value seam under everything that stores article text.
 *
 * ## Why a seam at all
 *
 * Two backends have to exist, and neither is optional:
 *
 *  - **IndexedDB** is the real one. `localStorage` has a hard 10 MiB ceiling in
 *    every browser (it is not a quota — it is a fixed size, and it does not
 *    grow with the disk), which is roughly ten 200k-character books. An article
 *    body also has to leave `localStorage` for a second reason that has nothing
 *    to do with capacity: the whole store is one key, so writing a single
 *    streamed note token re-serialises every article the reader owns. Moving
 *    the bodies out is what makes a keystroke cost a keystroke.
 *  - **`localStorage`** is the fallback, and it is not hypothetical. An
 *    enterprise policy, an embedded webview, a browser with storage disabled,
 *    a corrupt database, and the Node unit-test environment all lack a usable
 *    `indexedDB`. Without a fallback the app would have to either refuse to
 *    work or grow a second, divergent implementation of everything above this
 *    file — so the fallback is a *backend*, and the code above is written once.
 *
 * ## Why the interface exposes keys, not cursors
 *
 * Every method here is a whole-value operation on a known key, plus `keys()`.
 * There is deliberately no cursor, no range query and no index. That is what
 * makes the two backends provably equivalent: a cursor API would let them
 * diverge in ordering and boundary behaviour, and the divergence would surface
 * as "the unit tests pass and the browser shows the wrong order". Ordering and
 * filtering belong to the layer above, which has exactly one implementation.
 *
 * ## Why nothing here is typed to a domain object
 *
 * `get`/`put` move `unknown`. The store above is the only thing that knows what
 * a body is; keeping that knowledge out of the backend is what lets the same
 * code run over IndexedDB's structured clone and `localStorage`'s JSON string
 * without a branch.
 */

/**
 * The object stores (IndexedDB) / key namespaces (`localStorage`).
 *
 * Two entries, and the second one is why this is a parameter rather than a
 * hard-coded name.
 *
 *  - `bodies` is the live text: whatever the reader currently owns, readable
 *    and evictable.
 *  - `bodies-archive` holds the anonymous workspace while an account owns the
 *    live space. It has to be a separate namespace rather than a flag on a
 *    body, for two reasons that are both about *not* reading the wrong text:
 *    the wipe path sweeps `bodies` by enumeration and must not touch the
 *    archive, and a local article id is `local-<textHash16>` — a pure text
 *    hash with no device or account in it — so the anonymous space and an
 *    account that imported the same passage mint the *same* key. In one
 *    namespace the second would silently overwrite the first, and restoring
 *    the anonymous space would hand back the account's copy.
 */
export type StoreName = "bodies" | "bodies-archive";

export const STORE_NAMES: readonly StoreName[] = ["bodies", "bodies-archive"];

export interface KvBackend {
  /** Which implementation this is. Recorded so a diagnostic can say so. */
  readonly kind: "indexeddb" | "local-storage";
  get(store: StoreName, key: string): Promise<unknown>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  /** Every key in the store. Used by the wipe path and by the budget pass. */
  keys(store: StoreName): Promise<string[]>;
  /** Drop every record in one store. */
  clear(store: StoreName): Promise<void>;
}

const DB_NAME = "kobook";
/**
 * Bumped from 1 when `bodies-archive` was added.
 *
 * The upgrade handler below creates any store in `STORE_NAMES` that is
 * missing, so an existing database gains the archive on its next open. The
 * bump is what makes that next open happen: IndexedDB only runs
 * `onupgradeneeded` when the requested version is higher than the stored one,
 * and a new store would otherwise never be created — the first archive write
 * would fail with `NotFoundError` in every browser that had already opened the
 * database, which is every returning reader.
 */
const DB_VERSION = 2;

/**
 * Open the database, creating the object stores on first use.
 *
 * Resolves `null` rather than throwing for every failure. The caller's only
 * sensible reaction is the same in all of them — use the fallback — and a
 * rejected promise here would mean every call site needs its own try/catch for
 * a condition that is not exceptional (a private window, a locked-down profile,
 * a database another tab is upgrading).
 */
function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Some browsers throw synchronously when storage is blocked outright.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Safari (and every Chromium) fires this when another tab wants to
      // upgrade the schema. Without the close the other tab blocks forever, and
      // this tab would keep using a connection whose version is now stale.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Wrap one IDB request as a promise. */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Run one operation in its own transaction.
 *
 * One operation per transaction, deliberately. A transaction auto-commits as
 * soon as control returns to the event loop with no pending request, so
 * `await`ing anything that is *not* an IDB request inside one is the classic
 * way to get `TransactionInactiveError` on the next call — and the failure is
 * load-bearing: it looks like the data was written and the transaction was
 * silently rolled back. Keeping the scope to a single awaited request makes
 * that impossible by construction rather than by remembering the rule.
 */
async function withStore<T>(
  db: IDBDatabase,
  store: StoreName,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const tx = db.transaction(store, mode);
  const done = request(run(tx.objectStore(store)));
  const result = await done;
  if (mode === "readwrite") {
    // Wait for the commit, not just the request. A request can succeed and the
    // transaction still fail to commit (quota, an aborted upgrade), and a
    // caller that reported success on the request alone would be lying about
    // durability — which matters most for the one write whose whole job is to
    // survive a crash.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }
  return result;
}

/** IndexedDB, or `null` when this environment cannot provide a usable one. */
export async function createIndexedDbBackend(): Promise<KvBackend | null> {
  const db = await openDatabase();
  if (!db) return null;

  // A connection that opens is not a connection that works: a profile with
  // IndexedDB disabled for the origin opens and then fails every transaction.
  // Prove one round-trip before committing to it, so the fallback is chosen
  // once here rather than discovered mid-write later.
  try {
    await withStore(db, "bodies", "readonly", (s) => s.count());
  } catch {
    db.close();
    return null;
  }

  return {
    kind: "indexeddb",
    async get(store, key) {
      return withStore<unknown>(db, store, "readonly", (s) => s.get(key) as IDBRequest<unknown>);
    },
    async put(store, key, value) {
      await withStore(db, store, "readwrite", (s) => s.put(value, key));
    },
    async delete(store, key) {
      await withStore(db, store, "readwrite", (s) => s.delete(key));
    },
    async keys(store) {
      const all = await withStore<IDBValidKey[]>(db, store, "readonly", (s) => s.getAllKeys());
      return all.map(String);
    },
    async clear(store) {
      await withStore(db, store, "readwrite", (s) => s.clear());
    },
  };
}

const KEY_PREFIX = "gloss-kv:";

function prefixFor(store: StoreName): string {
  return `${KEY_PREFIX}${store}:`;
}

/**
 * `localStorage` as a per-record key/value store.
 *
 * Per record rather than as one blob: the point of this layer is that deleting
 * one body does not rewrite every other one, and a single blob would reintroduce
 * exactly the write amplification that moving off `localStorage` was for. It is
 * still subject to the 10 MiB ceiling — that ceiling is the reason this is the
 * fallback and not the design.
 *
 * Writes can throw (`QuotaExceededError`, or a `SecurityError` in a profile
 * that blocks storage). They are allowed to propagate: the caller is saving an
 * article and has to hear about it. What must *not* happen is a silent
 * success — an article that appears saved and is gone after a reload is the
 * bug this whole layer exists to fix.
 */
export function createLocalStorageBackend(): KvBackend {
  const storage = (): Storage => localStorage;

  return {
    kind: "local-storage",
    async get(store, key) {
      const raw = storage().getItem(prefixFor(store) + key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        // A half-written record is worse than none: it would be handed to the
        // reader as a body with missing fields. Treat it as absent, and let the
        // next write replace it.
        return undefined;
      }
    },
    async put(store, key, value) {
      storage().setItem(prefixFor(store) + key, JSON.stringify(value));
    },
    async delete(store, key) {
      storage().removeItem(prefixFor(store) + key);
    },
    async keys(store) {
      const prefix = prefixFor(store);
      const out: string[] = [];
      const all = storage();
      for (let i = 0; i < all.length; i += 1) {
        const name = all.key(i);
        if (name && name.startsWith(prefix)) out.push(name.slice(prefix.length));
      }
      return out;
    },
    async clear(store) {
      // Collect first: removing while walking the live `localStorage` by index
      // skips entries, because every removal shifts the remaining ones down.
      for (const key of await this.keys(store)) await this.delete(store, key);
    },
  };
}

/**
 * The backend to use, decided once.
 *
 * Resolved lazily and cached, so the probe (open, round-trip, possibly fall
 * back) happens once per session rather than per body. The cached *promise* is
 * what makes concurrent first calls share one probe instead of racing two.
 */
let backendPromise: Promise<KvBackend> | null = null;

export function kvBackend(): Promise<KvBackend> {
  backendPromise ??= (async () => {
    try {
      return (await createIndexedDbBackend()) ?? createLocalStorageBackend();
    } catch {
      return createLocalStorageBackend();
    }
  })();
  return backendPromise;
}

/**
 * Force a specific backend. Tests only.
 *
 * The Node test environment has neither a real `indexedDB` nor a real
 * `localStorage`, so a test that exercises the storage layer has to install
 * both. Rather than leaving the probe to pick whichever polyfill happens to be
 * present, a test states which one it means.
 */
export function setBackendForTesting(backend: KvBackend | null): void {
  backendPromise = backend ? Promise.resolve(backend) : null;
}
