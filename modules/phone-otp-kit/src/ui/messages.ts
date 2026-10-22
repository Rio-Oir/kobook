// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chinese (mainland) copy for the panel, and the code → sentence table.
 *
 * Two rules:
 *
 * - **The panel renders sentences from this table, keyed by an allowlisted code.
 *   It never renders text that arrived with a response.** A response carrying a
 *   `message` field renders nothing extra, because the panel has no code path
 *   that reads one. The default copy is Chinese because the only number family
 *   this kit claims is mainland mobile; `labels` lets an integrator override
 *   every string without forking the component.
 * - **A label that interpolates a phone number is handed an already-masked
 *   value.** `sentTo` receives `138****8000`, and the panel is what produces
 *   that string — the integration never gets the chance to pass a full number
 *   into user-visible text by accident.
 */

import { isPhoneOtpResponseCode, type PhoneOtpResponseCode } from "../shared/errors";

/** One sentence per response code. Total by construction: `Record` over the union. */
export const PHONE_OTP_ERROR_MESSAGES_ZH: Readonly<Record<PhoneOtpResponseCode, string>> =
  Object.freeze({
    INVALID_PHONE: "请输入正确的手机号",
    UNSUPPORTED_PHONE: "暂不支持该手机号，请使用中国大陆手机号",
    INVALID_PURPOSE: "当前场景暂不支持手机号验证",
    UNTRUSTED_CLIENT: "无法确认当前设备，请稍后重试",
    SEND_LIMITED: "发送过于频繁，请稍后再试",
    SMS_SEND_FAILED: "验证码发送失败，请稍后重试",
    VERIFY_LIMITED: "尝试次数过多，请稍后再试",
    CODE_EXPIRED: "验证码已过期，请重新获取",
    CODE_INVALID: "验证码不正确",
    TOO_MANY_ATTEMPTS: "错误次数过多，请重新获取验证码",
    INTERNAL: "服务暂时不可用，请稍后重试",
  });

/** Used for anything not on the allowlist — including a code the parent invented. */
export const GENERIC_ERROR_MESSAGE_ZH = "操作失败，请稍后重试";

/**
 * The sentence for a code, or the generic one.
 *
 * Takes `unknown` on purpose: the caller may be holding a value from a response
 * it did not type, and the function has to be safe for that rather than trusting
 * the cast.
 */
export function messageForErrorCode(code: unknown): string {
  if (!isPhoneOtpResponseCode(code)) return GENERIC_ERROR_MESSAGE_ZH;
  return PHONE_OTP_ERROR_MESSAGES_ZH[code] ?? GENERIC_ERROR_MESSAGE_ZH;
}

export interface PhoneOtpPanelLabels {
  readonly title: string;
  readonly phoneLabel: string;
  readonly phonePlaceholder: string;
  readonly sendCode: string;
  readonly sending: string;
  readonly resendIn: (seconds: number) => string;
  readonly codeLabel: string;
  readonly codePlaceholder: string;
  readonly verify: string;
  readonly verifying: string;
  /** Receives an already-masked number. */
  readonly sentTo: (maskedPhone: string) => string;
  readonly verified: string;
  readonly phoneChanged: string;
  readonly attemptsRemaining: (remaining: number) => string;
}

export const DEFAULT_LABELS: PhoneOtpPanelLabels = Object.freeze({
  title: "手机号验证码",
  phoneLabel: "手机号",
  phonePlaceholder: "请输入 11 位手机号",
  sendCode: "获取验证码",
  sending: "发送中…",
  resendIn: (seconds: number) => `重新获取（${seconds} 秒）`,
  codeLabel: "验证码",
  codePlaceholder: "请输入验证码",
  verify: "验证",
  verifying: "验证中…",
  sentTo: (maskedPhone: string) => `验证码已发送至 ${maskedPhone}`,
  verified: "验证成功",
  phoneChanged: "手机号已修改，请重新获取验证码",
  attemptsRemaining: (remaining: number) => `（还可尝试 ${remaining} 次）`,
});

/** Fill in whatever the caller did not override. */
export function resolveLabels(partial?: Partial<PhoneOtpPanelLabels>): PhoneOtpPanelLabels {
  if (partial === undefined) return DEFAULT_LABELS;
  return { ...DEFAULT_LABELS, ...partial };
}
