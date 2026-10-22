// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Message composition for the two account emails.
 *
 * The link is used exactly as Better Auth built it — we do not re-parse or
 * re-assemble it. The SPA supplies the landing route through `callbackURL`
 * (verification) and `redirectTo` (reset), the library appends the token and
 * URL-encodes the callback, so there is one code path that knows how those
 * URLs are shaped instead of two that can disagree.
 *
 * What the flow looks like end to end (verified against the installed
 * better-auth 1.7.7 behaviour):
 *
 *   1. sign-up / resend  → mail link
 *        {BETTER_AUTH_URL}/api/auth/verify-email?token=…&callbackURL=%2F%23%2Fverify-email
 *   2. the recipient opens it → the API verifies, then 302s into the SPA at
 *      `/#/verify-email`; a bad or reused token 302s to `/?error=INVALID_TOKEN#/verify-email`
 *   3. password reset → `{BETTER_AUTH_URL}/api/auth/reset-password/<token>?callbackURL=…`
 *      → 302 to `/?token=<token>#/reset-password`, i.e. the SPA reads that
 *      token from `location.search`, not from the hash.
 */

import type { MailTransport, OutboundMail } from "./transport.js";

export interface MailRecipient {
  email: string;
  name?: string | null;
}

export interface MailerConfig {
  transport: MailTransport;
  /** Verification token lifetime in seconds; echoed in the message text. */
  verificationExpiresInSeconds: number;
  /** Reset token lifetime in seconds; echoed in the message text. */
  resetExpiresInSeconds: number;
  /** Login-code lifetime in seconds; echoed in the message text. */
  signInOtpExpiresInSeconds: number;
}

export interface Mailer {
  sendVerificationEmail(data: { user: MailRecipient; url: string }): Promise<void>;
  sendResetPassword(data: { user: MailRecipient; url: string }): Promise<void>;
  /**
   * Sends a passwordless sign-in code. The code is a credential, so it is
   * never echoed into a log or an error message; `mailer.ts` owns the only
   * copy that reaches a transport.
   */
  sendSignInOtp(data: { user: MailRecipient; otp: string }): Promise<void>;
}

/** "30 分钟" / "1 小时" / "2 小时 30 分钟" — no invented precision. */
export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
}

/** The part of an email address before the @, for a friendlier greeting. */
function displayName(user: MailRecipient): string {
  const name = user.name?.trim();
  return name && name.length > 0 ? name : user.email;
}

export function createMailer(config: MailerConfig): Mailer {
  async function send(mail: OutboundMail): Promise<void> {
    await config.transport.send(mail);
  }

  return {
    async sendVerificationEmail(data) {
      const valid = formatDuration(config.verificationExpiresInSeconds);
      await send({
        to: data.user.email,
        subject: "验证你的邮箱 · KoBook",
        purpose: "verify-email",
        url: data.url,
        text:
          `${displayName(data.user)}，你好：\n\n` +
          "请打开下面的链接完成邮箱验证，验证后即可使用解释、提问和摘要功能：\n\n" +
          `${data.url}\n\n` +
          `链接 ${valid}内有效，且只能使用一次。\n` +
          "如果这不是你的操作，忽略这封邮件即可，你的账号不会发生任何变化。",
      });
    },

    async sendResetPassword(data) {
      const valid = formatDuration(config.resetExpiresInSeconds);
      await send({
        to: data.user.email,
        subject: "重置密码 · KoBook",
        purpose: "reset-password",
        url: data.url,
        text:
          `${displayName(data.user)}，你好：\n\n` +
          "请打开下面的链接设置新密码：\n\n" +
          `${data.url}\n\n` +
          `链接 ${valid}内有效，且只能使用一次。设置新密码后，其他设备上的登录状态会全部失效。\n` +
          "如果这不是你的操作，请忽略这封邮件，你的密码不会改变。",
      });
    },

    async sendSignInOtp(data) {
      const valid = formatDuration(config.signInOtpExpiresInSeconds);
      await send({
        to: data.user.email,
        subject: "登录验证码 · KoBook",
        purpose: "sign-in-otp",
        code: data.otp,
        text:
          `${displayName(data.user)}，你好：\n\n` +
          "你的登录验证码是：\n\n" +
          `${data.otp}\n\n` +
          `验证码 ${valid}内有效，最多可尝试 5 次，验证成功后立即失效。\n` +
          "请勿把验证码告诉任何人。如果这不是你的操作，忽略这封邮件即可，你的账号不会发生任何变化。",
      });
    },
  };
}

