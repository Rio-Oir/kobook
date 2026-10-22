// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Programmatic hash routing with React view-transition support.
 *
 * The app routes on `window.location.hash` (see `App.tsx`). Plain
 * `<a href="#/...">` links still work through the `hashchange` event, but a
 * route change that has to be *animated* must be committed inside a React
 * transition: `<ViewTransition>` only runs when the old and new trees are
 * part of one transition update.
 *
 * `window.location.hash = …` fires `hashchange` asynchronously, which lands
 * outside any transition scope. `navigate()` therefore:
 *
 *   1. writes the URL with `history.pushState` — the address bar and the back
 *      button keep working, but no `hashchange` is dispatched;
 *   2. dispatches `NAV_EVENT` synchronously, so `App` can update its route
 *      state inside the same `startTransition` that carries
 *      `addTransitionType`.
 *
 * The transition types `post-open` / `post-close` are what let the library
 * and the reader pick different shared-element timings for the two
 * directions (the closing animation is deliberately quicker — see
 * `index.css`).
 */

import { addTransitionType, startTransition } from "react";

/** Fired on `window` after the URL has been written. `App` listens. */
export const NAV_EVENT = "gloss:navigate";

export type NavTransitionType = "post-open" | "post-close";

export interface NavDetail {
  hash: string;
}

/**
 * Change route. With a `type`, the update is a React transition so
 * `<ViewTransition>` shared elements animate; without one it is a plain
 * synchronous update (same visual result as clicking an anchor).
 */
export function navigate(hash: string, type?: NavTransitionType): void {
  const apply = () => {
    if (window.location.hash !== hash) {
      // pushState (not `location.hash =`) so no `hashchange` fires and the
      // update stays inside the enclosing transition.
      window.history.pushState(null, "", hash);
    }
    window.dispatchEvent(new CustomEvent<NavDetail>(NAV_EVENT, { detail: { hash } }));
  };

  if (!type) {
    apply();
    return;
  }
  startTransition(() => {
    addTransitionType(type);
    apply();
  });
}

/**
 * The article whose card should carry the shared-element names on the next
 * library mount.
 *
 * Opening a card is handled locally by the library (it knows which card was
 * clicked), but coming *back* from the reader is a fresh mount of the
 * library, which otherwise has no way to know which row is the matching
 * counterpart. The reader records its article id here immediately before
 * navigating back, and the library consumes it once on mount.
 *
 * Deliberately a module variable rather than persisted state: it describes
 * one in-flight navigation, not a durable preference, and a stale value is
 * harmless because it is consumed and cleared on the next library mount.
 */
let pendingFocusArticleId: string | null = null;

export function setPostTransitionFocus(articleId: string | null): void {
  pendingFocusArticleId = articleId;
}

/** Read and clear the pending focus id. */
export function takePostTransitionFocus(): string | null {
  const id = pendingFocusArticleId;
  pendingFocusArticleId = null;
  return id;
}
