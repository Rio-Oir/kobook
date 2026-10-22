// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Email verification landing.
 *
 * The mail link is `/api/auth/verify-email?token=…&callbackURL=/#/verify-email`.
 * The server verifies the token and 302s to `/#/verify-email` on success
 * (no error in `location.search`) or to `/?error=INVALID_TOKEN#/verify-email`
 * on failure.
 *
 * No API call here: the verification is server-side. The card is shared with
 * the other auth surfaces so a user who arrives from mail stays in the same
 * visual world.
 */
import { useMemo } from "react";
import { AuthCard } from "../components/auth/AuthUI";

export default function VerifyEmail() {
  const error = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("error");
  }, []);

  if (error) {
    return (
      <AuthCard
        title="链接无效或已过期"
        subtitle="验证链接只能使用一次，且 1 小时内有效。"
      >
        <div className="auth-success">
          <p>
            请在登录后从账号页重新发送验证邮件。如果你刚刚才点开链接，可能已经验证成功了。
          </p>
          <a className="auth-primary" href="#/login">
            去登录
          </a>
          <div className="auth-success-actions">
            <a href="#/">回到首页</a>
          </div>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="邮箱已验证"
      subtitle="你的账号现在可以登录并使用完整功能。"
    >
      <div className="auth-success">
        <p>验证完成。回到首页继续读，或者去账号页看看当前状态。</p>
        <a className="auth-primary" href="#/login">
          去登录
        </a>
        <div className="auth-success-actions">
          <a href="#/">回到首页</a>
        </div>
      </div>
    </AuthCard>
  );
}
