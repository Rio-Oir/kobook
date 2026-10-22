// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The account page, reached from the header menu's 我的 entry.
 *
 * Deliberately small: it answers "who am I signed in as" and nothing else.
 * Signing out, clearing local data and the article library all live
 * elsewhere (the header menu and the library page), so this page has no
 * destructive actions of its own.
 *
 * What it still owns:
 *   - the profile fields the session shape does not carry (display name and
 *     the verified phone number), fetched from the account API;
 *   - the "resend verification email" action for an unverified address,
 *     which is account hygiene rather than a feature gate — reading and BYOK
 *     work the same verified or not;
 *   - bouncing an anonymous visitor back home.
 */

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { sendVerificationEmail } from "../lib/auth-client";
import { ApiRequestError } from "../lib/api-error";
import { useSession } from "../lib/session";
import { useAccountProfile } from "../lib/profile-store";
import { avatarFor } from "../lib/profile";
import { Button } from "@/components/ui/button";
import TopBarMenu from "@/components/TopBarMenu";
import { navigate } from "@/lib/navigate";

export default function Account() {
  const session = useSession();
  const user = session.user;
  const [resendStatus, setResendStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  // Display name and bound phone come from the account API, shared with the
  // header menu through `profile-store` so both surfaces show the same name.
  const profile = useAccountProfile(session.status === "authed" ? user?.id : null);

  // If the session has not resolved yet, bounce to home. This must be done in
  // an effect, not in render, so it runs after the first commit.
  useEffect(() => {
    if (session.status === "anon") {
      window.location.hash = "#/";
    }
  }, [session.status]);

  if (session.status !== "authed" || !user) {
    return null;
  }

  function goBack() {
    if (window.history.length > 1) window.history.back();
    else navigate("#/");
  }

  const onResend = async () => {
    setError(null);
    setResendStatus("sending");
    try {
      await sendVerificationEmail(user.email, "/#/verify-email");
      setResendStatus("sent");
    } catch (err) {
      setResendStatus("error");
      setError(err instanceof ApiRequestError ? err.message : "发送失败，请稍后再试。");
    }
  };

  const localPart = user.email.split("@")[0] || user.email;
  // A phone account has no mailbox the user knows about: the stored address is
  // an unroutable placeholder, so showing it would be noise at best. The
  // number is the identity to display.
  const boundPhone = profile?.phoneNumber ?? null;
  const name = profile?.name ?? localPart;
  const identity = boundPhone ?? user.email;
  const verified = user.emailVerified;

  return (
    <div className="min-h-screen bg-gloss-bg text-gloss-text">
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              aria-label="返回"
              className="grid size-8 place-items-center rounded-lg text-gloss-textDim transition-colors hover:bg-gloss-text/[0.06] hover:text-gloss-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </button>
            <h1 className="font-serif text-2xl leading-tight">我的</h1>
          </div>
          {/* The account menu is the only place to sign out, so it has to be
              reachable here too — otherwise this page would be a dead end. */}
          <TopBarMenu showLibrary={false} />
        </header>

        <section className="flex items-center gap-4 rounded-2xl border border-gloss-border bg-gloss-surface px-6 py-5">
          <img
            src={avatarFor({ id: user.id, email: user.email })}
            alt=""
            className="size-14 rounded-full bg-gloss-surface2"
          />
          <div className="min-w-0">
            <div className="truncate text-lg font-medium">{name}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gloss-textDim">
              <span className="truncate">{identity}</span>
              <span aria-hidden="true">·</span>
              <span className={verified ? "text-emerald-500" : "text-gloss-accent"}>
                {verified ? "已验证" : "未验证"}
              </span>
            </div>
          </div>
        </section>

        <section className="mt-4 overflow-hidden rounded-2xl border border-gloss-border bg-gloss-surface">
          <InfoRow label="昵称" value={name} />
          <InfoRow label={boundPhone ? "手机号" : "邮箱"} value={identity} />
          <div className="flex items-center justify-between gap-4 border-t border-gloss-border/60 px-6 py-3.5">
            <span className="text-xs text-gloss-textDim">{boundPhone ? "手机验证" : "邮箱验证"}</span>
            <span className="flex items-center gap-3 text-right">
              <span className={verified ? "text-sm text-emerald-500" : "text-sm text-gloss-accent"}>
                {verified ? "已验证" : "未验证"}
              </span>
              {!verified && !boundPhone ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={resendStatus === "sending"}
                  onClick={onResend}
                >
                  {resendStatus === "sending"
                    ? "发送中…"
                    : resendStatus === "sent"
                      ? "已发送"
                      : "重新发送验证邮件"}
                </Button>
              ) : null}
            </span>
          </div>
        </section>

        {error ? (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-3.5">
      <span className="text-xs text-gloss-textDim">{label}</span>
      <span className="min-w-0 truncate text-sm">{value}</span>
    </div>
  );
}
