// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Password reset landing.
 *
 * The mail link is `/api/auth/reset-password/<token>?callbackURL=/#/reset-password`.
 * Better Auth validates the token and 302s to `/?token=…#/reset-password` on
 * success (the token is placed in `location.search` so the SPA can post it
 * to `/api/auth/reset-password`) or to `/?error=INVALID_TOKEN#/reset-password`
 * on failure.
 *
 * The reset itself is a single POST: `{ token, newPassword }`. On success
 * the page shows the signed-out confirmation; the next step is a sign-in.
 */
import { useState } from "react";
import { resetPassword } from "../lib/auth-client";
import { ApiRequestError } from "../lib/api-error";
import {
  AuthBanner,
  AuthCard,
  AuthField,
  AuthSubmit,
} from "../components/auth/AuthUI";

type Field = "password" | "confirm";
type Errors = Partial<Record<Field, string>>;

export default function ResetPassword() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token"));
  const [error] = useState(() => new URLSearchParams(window.location.search).get("error"));

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [done, setDone] = useState(false);

  if (error || !token) {
    return (
      <AuthCard
        title="链接无效或已过期"
        subtitle="重置链接只能使用一次，且 30 分钟内有效。"
      >
        <div className="auth-success">
          <p>请在登录页重新申请一条重置链接。</p>
          <a className="auth-primary" href="#/forgot">
            重新申请重置链接
          </a>
          <div className="auth-success-actions">
            <a href="#/login">去登录</a>
            <a href="#/">回到首页</a>
          </div>
        </div>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="密码已重置" subtitle="其他设备上的会话已全部失效。">
        <div className="auth-success">
          <p>请使用新密码登录。如果这不是你本人操作的，请立即重新申请重置。</p>
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

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const next: Errors = {};
    if (password.length < 8) next.password = "密码至少 8 位。";
    if (password !== confirm) next.confirm = "两次输入的密码不一致。";
    setErrors(next);
    setBanner(null);
    if (Object.keys(next).length > 0) {
      const first = next.password ? "password" : "confirm";
      document.getElementById(`auth-${first}`)?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await resetPassword({ token, newPassword: password });
      setDone(true);
    } catch (err) {
      setBanner(err instanceof ApiRequestError ? err.message : "操作失败，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      title="设置新密码"
      subtitle="至少 8 位；设置后其他设备上的登录会失效。"
      footer={
        <>
          <span>
            想起密码了？<a href="#/login">登录</a>
          </span>
          <a className="auth-quiet" href="#/forgot">
            重新申请
          </a>
        </>
      }
    >
      <AuthBanner message={banner} />
      <form onSubmit={onSubmit} noValidate>
        <div className="auth-fields">
          <AuthField
            label="新密码"
            name="newPassword"
            autoComplete="new-password"
            password
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setErrors((prev) => ({ ...prev, password: undefined }));
              setBanner(null);
            }}
            error={errors.password}
            hint="至少 8 位"
            required
            minLength={8}
          />
          <AuthField
            label="再次输入新密码"
            name="confirm"
            autoComplete="new-password"
            password
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setErrors((prev) => ({ ...prev, confirm: undefined }));
              setBanner(null);
            }}
            error={errors.confirm}
            required
            minLength={8}
          />
          <AuthSubmit loading={submitting} loadingText="正在提交…">
            设置新密码
          </AuthSubmit>
        </div>
      </form>
    </AuthCard>
  );
}
