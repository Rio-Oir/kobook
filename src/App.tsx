// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Reader from "./pages/Reader";
import Auth from "./pages/Auth";
import VerifyEmail from "./pages/VerifyEmail";
import ResetPassword from "./pages/ResetPassword";
import Account from "./pages/Account";
import Settings from "./pages/Settings";
import { useSession } from "./lib/session";
import { useTheme, resolveTheme } from "./lib/theme";
import { useStore } from "./lib/store";
import { NAV_EVENT } from "./lib/navigate";
import { flushPendingDeletes, syncLocalLibrary } from "./lib/library-sync";

// Hash-based routing. Routes:
//   #/              -> Home
//   #/library       -> Library (one shelf: device rows ∪ account rows)
//   #/r/<id>        -> Reader for a given article
//   #/login         -> sign in
//   #/register      -> sign up
//   #/forgot        -> forgot password
//   #/verify-email  -> email verification landing
//   #/reset-password-> password reset landing
//   #/account       -> account page
//   #/settings      -> the AI + appearance settings page
//
// `#/cloud` is not a page any more: the account's articles are part of
// `#/library` now (the library merges both drawers), so the old URL is
// redirected there rather than rendering a second library.
//
// An unknown hash falls back to Home (existing behaviour; preserved so a
// typo'd link renders a useful page rather than a blank).
//
// There is deliberately no `#/billing`. Payment and entitlements are the
// value-added line's, which composes them around this same app; a route for
// them does not exist here, so a deep link to one is an unknown hash rather
// than a page that renders a "not available" message.
type Route =
  | { route: "home" }
  | { route: "library"; tag: string | null }
  | { route: "reader"; id: string }
  | { route: "auth"; mode: "login" | "register" | "forgot" }
  | { route: "verify-email" }
  | { route: "reset-password" }
  | { route: "account" }
  | { route: "settings" };

function parseHash(): Route {
  const h = window.location.hash || "";
  if (h.startsWith("#/r/")) {
    const id = h.slice(4);
    if (id.length > 0) return { route: "reader", id };
    return { route: "home" };
  }
  // `#/library?tag=<tag>` is the filtered view. The query is part of the
  // route (not component state) so a tag chip in the Reader can deep-link
  // into a filtered library and the back button restores the filter.
  if (h === "#/library" || h.startsWith("#/library?")) {
    const query = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
    const tag = new URLSearchParams(query).get("tag");
    return { route: "library", tag: tag && tag.trim().length > 0 ? tag.trim() : null };
  }
  if (h === "#/cloud") return { route: "library", tag: null };
  if (h === "#/login") return { route: "auth", mode: "login" };
  if (h === "#/register") return { route: "auth", mode: "register" };
  if (h === "#/forgot") return { route: "auth", mode: "forgot" };
  if (h === "#/verify-email") return { route: "verify-email" };
  if (h === "#/reset-password") return { route: "reset-password" };
  if (h === "#/account") return { route: "account" };
  if (h === "#/settings") return { route: "settings" };
  return { route: "home" };
}

export default function App() {
  const [route, setRoute] = useState(parseHash());
  const refreshSession = useSession((s) => s.refresh);
  const sessionStatus = useSession((s) => s.status);
  const sessionUserId = useSession((s) => s.user?.id);
  const theme = useTheme((s) => s.theme);
  const highlightColor = useStore((s) => s.highlightColor);
  const ownerUserId = useStore((s) => s.ownerUserId);

  // One shelf, synced as soon as the device belongs to the account.
  //
  // This deliberately does not wait for the reader to open the library: "登录
  // 后写进我的库" is the promise, and a reader who signs in and goes back to
  // reading should not have to visit a page for it to be true. Both calls are
  // idempotent (the upload path dedupes by client key and by content, the
  // delete queue drops what it finished) and `syncLocalLibrary` coalesces
  // concurrent callers, so the library page asking again is harmless.
  useEffect(() => {
    if (sessionStatus !== "authed" || !sessionUserId) return;
    if (ownerUserId !== sessionUserId) return;
    void flushPendingDeletes().then(() => syncLocalLibrary());
  }, [sessionStatus, sessionUserId, ownerUserId]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    // `navigate()` writes the URL with `pushState` (so the update can happen
    // inside a React transition for view transitions) and announces itself
    // with this event instead of a `hashchange`.
    const onNav = () => setRoute(parseHash());
    window.addEventListener(NAV_EVENT, onNav);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener(NAV_EVENT, onNav);
      window.removeEventListener("popstate", onHash);
    };
  }, []);

  useEffect(() => {
    // Normalise the retired URL: `#/cloud` renders the merged library, and the
    // address bar should say where the reader actually is. `replaceState`
    // (not `navigate`) so this is not a history entry of its own.
    if (window.location.hash === "#/cloud") {
      window.history.replaceState(null, "", "#/library");
    }
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
      document.documentElement.style.colorScheme = resolved === "night" ? "dark" : "light";
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

  const page = (() => {
    switch (route.route) {
      case "library":
        return <Library key={route.tag ?? "all"} initialTag={route.tag} />;
      case "reader":
        return <Reader key={route.id} articleId={route.id} />;
      case "auth":
        return <Auth key={route.mode} mode={route.mode} />;
      case "verify-email":
        return <VerifyEmail key={window.location.href} />;
      case "reset-password":
        return <ResetPassword key={window.location.href} />;
      case "account":
        return <Account key={route.route} />;
      case "settings":
        return <Settings />;
      case "home":
      default:
        return <Home />;
    }
  })();

  // One place decides how every motion component treats reduced motion:
  // transforms are dropped for users who ask their OS for less motion, while
  // opacity fades stay (they aid comprehension rather than decorate).
  return (
    <MotionConfig reducedMotion="user">
      {page}
    </MotionConfig>
  );
}
