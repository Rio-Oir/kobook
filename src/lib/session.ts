// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The session store.
 *
 * The *question* — is anyone signed in, and whose cache is on screen — is a
 * property of the local data model (see `ownership.ts`). The *answer* is not:
 * resolving a session is an HTTP call to an account service, so it is
 * delegated to the optional cloud adapter.
 *
 * With no adapter installed — the default — `refresh()` settles on `anon`
 * without opening a socket. That is deliberate and load-bearing: it is what
 * makes "this build makes no cloud request on load" a property of the module
 * graph rather than of a runtime flag. The status still moves out of
 * `loading`, so nothing downstream is left waiting on a probe that will never
 * come.
 *
 * `AbortController` bookkeeping is standard: `refresh` aborts any in-flight
 * probe before starting a new one, so React StrictMode's double effect in
 * development collapses to one call.
 */

import { create } from "zustand";
import { applyOwnership } from "./ownership";
import { callAdapter, cloudAdapter, type CloudSessionUser } from "./cloud/contract";

interface SessionState {
  status: "loading" | "anon" | "authed";
  user: CloudSessionUser | null;
  /**
   * `AbortController` for the in-flight bootstrap fetch, so StrictMode
   * double-mount does not start two concurrent probes.
   */
  _bootstrap?: AbortController | undefined;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  user: null,

  async refresh() {
    const adapter = cloudAdapter();
    if (!adapter) {
      // No cloud implementation: there is no session to resolve and no
      // endpoint to resolve it against. Settle locally.
      set({ status: "anon", user: null, _bootstrap: undefined });
      return;
    }

    const existing = get()._bootstrap;
    if (existing) existing.abort();
    const controller = new AbortController();
    set({ _bootstrap: controller });

    let resolved: CloudSessionUser | null = null;
    try {
      // The call is inside the `try`, so this covers a *synchronous* throw as
      // well as a rejection: `probeSession` is typed as returning a promise,
      // but a function that only throws has return type `never`, which is
      // assignable to one, and a JavaScript implementation is under no
      // obligation at all.
      resolved = await adapter.probeSession(controller.signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // A failed probe is "anonymous", never a stuck spinner: the reader must
      // be usable with the account service down.
      resolved = null;
    }

    // A probe that was superseded must not write its result. `abort()` above
    // only cancels the fetch; an adapter that ignored the signal can still
    // return, so the controller identity is re-checked here.
    if (get()._bootstrap !== controller) return;

    // Reconcile the local caches against whoever this is *before* publishing
    // the status, so no component can render one account's data under
    // another's session.
    applyOwnership(resolved?.id ?? null);
    set({
      status: resolved ? "authed" : "anon",
      user: resolved,
      _bootstrap: undefined,
    });
  },

  async signOut() {
    // ── Local state first, unconditionally ────────────────────────────────
    //
    // Signing out is a *local* promise: this device stops showing this
    // account. It must not be hostage to an optional remote call that may
    // fail, reject, throw synchronously, or never answer at all. Clearing
    // first also means the epoch has already advanced by the time the remote
    // attempt runs, so a response that arrives late cannot be attributed to
    // the session being ended.
    get()._bootstrap?.abort();
    applyOwnership(null);
    set({ status: "anon", user: null, _bootstrap: undefined });

    // ── Then the remote revoke, best effort and not awaited ───────────────
    //
    // There is nothing useful to do with the outcome here. Clearing a session
    // cookie is the server's job, and whether it succeeded is settled by the
    // next probe, not by this call. Awaiting it would reintroduce exactly the
    // coupling the seam exists to remove, and would make the returned promise
    // — which a caller may well be awaiting behind a button — pending on a
    // network the local reader does not depend on.
    //
    // `callAdapter` contains a synchronous throw as well as a rejection, so
    // neither can surface as an unhandled rejection after the local state is
    // already consistent.
    void callAdapter((adapter) => adapter.signOut(), undefined);
  },
}));

/** Whether a cloud implementation is installed. For tests and diagnostics. */
export function isCloudConfigured(): boolean {
  return cloudAdapter() !== null;
}
