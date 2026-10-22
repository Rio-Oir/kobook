// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Header account entry.
 *
 * Three states:
 *   - loading: render nothing (avoids a flash of "login" before the first
 *     session probe lands);
 *   - anon:    the "登录" link;
 *   - authed:  the cloud library, and a link to `#/account` showing the local
 *              part of the email; in the unverified case that link is styled
 *              in the accent color to nudge the user to verify.
 *
 * Used by `Home.tsx` and `Reader.tsx` headers. The visual style is small and
 * muted to match the existing top bar.
 *
 * There is no `#/billing` entry, and the absence is the point. Payment lives in
 * the value-added line; a link to a route this build does not serve lands on an
 * unknown hash and renders Home, which is worse than no entry at all — it reads
 * as a feature that is broken rather than one that is not here.
 *
 * It used to consult a release-channel flag and hide itself in the free build.
 * That is gone for the reason it never worked: hiding an entry point is not
 * what makes a build free of a capability. The capability is absent from this
 * tree at the route table and the server, not in a component.
 */
import { useSession } from "../lib/session";
import { blockedSignIn } from "../lib/cloud/session-block";

export default function AccountLink() {
  const status = useSession((s) => s.status);
  const user = useSession((s) => s.user);
  // Read after the session settles, which is when a blocked probe has already
  // recorded its reason — so this does not need to be reactive state.
  const blocked = blockedSignIn();

  if (status === "loading") return null;

  if (status === "anon") {
    return (
      <div className="flex items-center gap-3 text-xs">
        {blocked ? (
          // A reader left in the anonymous state has to be told why, or the
          // header just looks like they were signed out for no reason.
          <span className="text-amber-600" title={blocked} aria-label={blocked}>
            ⚠ 本机存储不可用
          </span>
        ) : null}
        <a href="#/login" className="text-gloss-textDim hover:text-gloss-text">
          登录
        </a>
      </div>
    );
  }

  if (status === "authed" && user) {
    const local = user.email.split("@")[0] || user.email;
    return (
      <div className="flex items-center gap-3 text-xs">
        <a
          href="#/account"
          className={
            "text-xs " +
            (user.emailVerified ? "text-gloss-textDim hover:text-gloss-text" : "text-gloss-accent")
          }
        >
          {user.emailVerified ? local : "邮箱未验证"}
        </a>
      </div>
    );
  }

  return null;
}
