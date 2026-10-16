// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useEffect, useState } from "react";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Reader from "./pages/Reader";
import { useSession } from "./lib/session";
import { useTheme, resolveTheme } from "./lib/theme";
import { useStore } from "./lib/store";

// Hash-based routing. Routes:
//   #/              -> Home
//   #/library       -> Library (the local article list)
//   #/r/<id>        -> Reader for a given article
//
// An unknown hash falls back to Home (existing behaviour; preserved so a
// typo'd link renders a useful page rather than a blank).
//
// Account routes (`#/login`, `#/register`, `#/forgot`, `#/verify-email`,
// `#/reset-password`, `#/account`) are not "hidden" here — they do not exist.
// The pages, the client and the endpoints behind them are absent from this
// tree, so a deep link to one is simply an unknown hash and lands on Home.
// That is the difference between a build that hides a login form and one that
// has none.
type Route =
  | { route: "home" }
  | { route: "library" }
  | { route: "reader"; id: string };

function parseHash(): Route {
  const h = window.location.hash || "";
  if (h.startsWith("#/r/")) {
    const id = h.slice(4);
    if (id.length > 0) return { route: "reader", id };
    return { route: "home" };
  }
  if (h === "#/library") return { route: "library" };
  return { route: "home" };
}

export default function App() {
  const [route, setRoute] = useState(parseHash());
  const refreshSession = useSession((s) => s.refresh);
  const theme = useTheme((s) => s.theme);
  const highlightColor = useStore((s) => s.highlightColor);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Bootstrap the session once. `refresh` is StrictMode-safe: it aborts any
  // in-flight probe before starting a new one, so the double effect in
  // development collapses to a single call.
  //
  // With no cloud adapter installed — the default — this settles on `anon`
  // without opening a socket, and reconciles the local owner stamps against
  // "nobody", which is a no-op for a cache that is already anonymous. The call
  // is still made so the status leaves `loading`; the guarantee that no
  // request is issued lives in `session.ts`, not in this effect.
  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);
  // Apply the theme to <html>. The inline bootstrap script in `index.html` has
  // already set the right value before the first paint; this effect covers
  // subsequent changes (user toggles, system preference flips). It also
  // listens to `prefers-color-scheme` changes when the user is in "system"
  // mode so the page follows the OS at runtime.
  useEffect(() => {
    const apply = (t: typeof theme) => {
      const resolved = resolveTheme(t);
      document.documentElement.setAttribute("data-theme", resolved);
      document.documentElement.style.colorScheme = resolved;
    };
    apply(theme);
    if (theme !== "system") return;
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme]);

  // Paint the live text selection in the colour the next highlight will use,
  // so a drag previews the result (`index.css` keys the `::selection` rules off
  // this attribute). Set on <html> rather than a wrapper div because
  // `::selection` has to reach every element on the page, including the reader
  // body and the note cards.
  useEffect(() => {
    document.documentElement.setAttribute("data-sel-color", highlightColor);
  }, [highlightColor]);

  switch (route.route) {
    case "library":
      return <Library />;
    case "reader":
      return <Reader key={route.id} articleId={route.id} />;
    case "home":
    default:
      return <Home />;
  }
}
