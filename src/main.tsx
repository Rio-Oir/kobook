// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerOfflineShell } from "./sw-register";
import { useStore } from "./lib/store";
import { bootstrapStorage } from "./lib/storage/migrate";
import { installCloudAdapter } from "./lib/cloud/install";

/**
 * Storage has to be settled before the first render.
 *
 * `useStore` sets `skipHydration`, so nothing has read `localStorage` yet. The
 * order below is fixed and is the reason this is one awaited call rather than
 * a few statements here:
 *
 *   1. move article bodies out of the `gloss-storage` blob and into
 *      IndexedDB, then shrink the blob (crash-safe and idempotent — see
 *      `storage/migrate.ts`);
 *   2. finish any body deletion a previous session started but a closed tab
 *      interrupted;
 *   3. hydrate the store from the now-current blob;
 *   4. flush anything the defensive merge path staged.
 *
 * Hydrating before step 1 would load articles that still carry their text into
 * a record shape that no longer has the field. Skipping step 2 would let a
 * half-finished wipe race a freshly loaded article.
 *
 * A failure here is reported and stepped over rather than fatal. The worst
 * outcome of continuing is an article whose text did not make it across, which
 * the reader shows as unavailable; refusing to start would take the whole app
 * down over one article.
 */
async function start(): Promise<void> {
  // The account/cloud implementation, registered before anything can ask about
  // a session. `src/lib/cloud/contract.ts` declares the seam and this is the
  // only place that fills it: `App`'s bootstrap effect resolves the session
  // through whichever adapter is registered, and settles on `anon` without
  // opening a socket when there is none. Registering it first — rather than
  // after the storage bootstrap below — is what makes "no probe can run before
  // the adapter exists" a property of the ordering rather than of timing.
  installCloudAdapter();

  try {
    const report = await bootstrapStorage(async () => {
      // `rehydrate` is typed `void | Promise<void>`; awaiting it is what makes
      // "hydration finished" a fact rather than a hope, and step 4 of the
      // bootstrap depends on it.
      await useStore.persist.rehydrate();
    });
    if (report.movedBodies > 0 || report.resumedDeletes > 0) {
      console.info(
        `[storage] moved ${report.movedBodies} article bodies to ${report.backend}` +
          (report.resumedDeletes > 0 ? `, finished ${report.resumedDeletes} pending deletes` : ""),
      );
    }
  } catch (err) {
    console.error("[storage] bootstrap failed; continuing with what loaded", err);
    // A bootstrap that threw still has to leave the store usable. `rehydrate`
    // is idempotent, and the merge path stages any body it finds, so a second
    // attempt is safe — and a store that never hydrated would render an empty
    // library over a full one.
    try {
      await useStore.persist.rehydrate();
    } catch {
      // Nothing further to try; the store now holds whatever the merge could
      // make of the blob.
    }
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // The offline shell belongs to the base product: reading saved articles with
  // no network is a base capability, not an account one. It used to be gated on
  // the free channel, which meant the only build that ever got it was the one
  // without accounts — an accident of how the channel flag was introduced
  // rather than a decision. `registerOfflineShell` is a no-op outside a secure
  // context or without service-worker support.
  registerOfflineShell();
}

void start();
