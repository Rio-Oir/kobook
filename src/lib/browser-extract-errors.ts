// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The channel vocabulary: where a document came from, and how an attempt
 * failed.
 *
 * Failure classification is a product requirement, not a debugging aid. It
 * exists to drive two decisions that must be made in different places:
 *
 *   1. **what the user is told** — a rate limit and a dead network need
 *      different advice, and neither is `Failed to fetch`; and
 *   2. **whether the controlled fallback may run** — a cancelled request must
 *      not be retried against the backend (the user asked for it to stop), and
 *      an invalid URL must not be forwarded either.
 *
 * One honest limitation is encoded here rather than papered over: **a browser
 * cannot tell DNS failure from a CORS rejection.** Both surface as an opaque
 * `TypeError` from `fetch`, with no status, no headers and no way to read the
 * real reason — the opaque-ness *is* the CORS protection. So both collapse to
 * `network`, and the message names the possibilities instead of asserting one.
 * Claiming "DNS 解析失败" when the actual cause was a missing
 * `Access-Control-Allow-Origin` would send the user to fix the wrong thing.
 */

/** Where a parsed document came from. */
export type ExtractSource =
  /** Parsed in the browser from pasted text / Markdown. No network. */
  | "local"
  /** Fetched from `r.jina.ai` by the browser, parsed locally. */
  | "browser-jina"
  /** Fetched by the controlled backend via its configured Jina. */
  | "server-jina"
  /** Fetched and extracted by the controlled backend with Readability. */
  | "server-readability";

/** How an extraction attempt failed. */
export type ExtractFailureKind =
  /** The caller aborted. Never a fallback trigger. */
  | "cancelled"
  /** The bounded deadline elapsed before a complete response arrived. */
  | "timeout"
  /** HTTP 429 from the upstream. */
  | "rate-limited"
  /** Any other non-2xx from the upstream. */
  | "http"
  /** 2xx, but the body held no article text. */
  | "empty"
  /** 2xx, but the body was not the shape we can read. */
  | "format"
  /** The response exceeded the byte cap and was abandoned. */
  | "too-large"
  /** The URL is not an http(s) URL we will request. */
  | "invalid-url"
  /**
   * `fetch` rejected outright. DNS failure, TLS failure, refusal and CORS
   * rejection are indistinguishable from script (see the module note).
   */
  | "network"
  /** Text arrived, but no readable article could be parsed out of it. */
  | "parse";

export interface ExtractFailure {
  kind: ExtractFailureKind;
  /** Ready to render. Never `Failed to fetch`. */
  message: string;
  /** Present when a response was actually received. */
  status?: number;
  /**
   * Whether the orchestrator is allowed to try the controlled backend
   * fallback after this failure.
   *
   * `false` for `cancelled` (the user asked to stop; a silent second request
   * would contradict that) and for `invalid-url` (the server would refuse it
   * too, so the round trip buys nothing).
   */
  fallbackEligible: boolean;
  /**
   * Operator-facing detail — an upstream's own error text, an exception
   * message. Deliberately not shown to the user, and deliberately not part of
   * the message.
   */
  detail?: string;
}

export interface FailureContext {
  /** The bounded deadline, for the timeout message. */
  deadlineMs?: number;
  /** The byte cap, for the over-limit message. */
  maxBytes?: number;
}

function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function seconds(ms: number): number {
  const s = ms / 1000;
  return Number.isInteger(s) ? s : Math.round(s * 10) / 10;
}

/**
 * Kinds that may fall through to the controlled backend.
 *
 * Written as a set rather than a chain of `if`s at the call site so the
 * "cancelled must not fall back" rule has exactly one home, and a new kind is
 * forced to make a decision when it is added.
 */
const FALLBACK_ELIGIBLE: Record<ExtractFailureKind, boolean> = {
  cancelled: false,
  "invalid-url": false,
  timeout: true,
  "rate-limited": true,
  http: true,
  empty: true,
  format: true,
  "too-large": true,
  network: true,
  parse: true,
};

/** Build a failure with the standard message for its kind. */
export function extractFailure(
  kind: ExtractFailureKind,
  context: FailureContext & { status?: number; detail?: string } = {},
): ExtractFailure {
  const failure: ExtractFailure = {
    kind,
    message: failureMessage(kind, context),
    fallbackEligible: FALLBACK_ELIGIBLE[kind],
  };
  if (context.status !== undefined) failure.status = context.status;
  if (context.detail !== undefined) failure.detail = context.detail;
  return failure;
}

/** The user-facing sentence for a failure kind. */
export function failureMessage(kind: ExtractFailureKind, context: FailureContext = {}): string {
  const deadline = context.deadlineMs ?? 10_000;
  const cap = context.maxBytes ?? 0;
  switch (kind) {
    case "cancelled":
      return "已取消抓取。";
    case "invalid-url":
      return "请输入有效的 http(s) 文章链接。";
    case "network":
      // Names the possibilities rather than picking one: see the module note.
      return "无法直连抓取服务（可能是网络不可用、DNS 解析失败，或浏览器跨域限制）。正在尝试服务器备用抓取…";
    case "timeout":
      return `直连抓取超时（${seconds(deadline)} 秒）。正在尝试服务器备用抓取…`;
    case "rate-limited":
      return "抓取服务暂时限流（HTTP 429）。正在尝试服务器备用抓取…";
    case "http":
      return "抓取服务返回了错误。正在尝试服务器备用抓取…";
    case "empty":
      return "抓取服务返回了空正文。正在尝试服务器备用抓取…";
    case "format":
      return "抓取服务返回的内容无法识别。正在尝试服务器备用抓取…";
    case "too-large":
      return cap > 0
        ? `抓取结果超过 ${megabytes(cap)} MB 上限。正在尝试服务器备用抓取…`
        : "抓取结果过大。正在尝试服务器备用抓取…";
    case "parse":
      return "已取得正文，但未能解析出可阅读的段落。正在尝试服务器备用抓取…";
    default: {
      const exhaustive: never = kind;
      return `抓取失败（${String(exhaustive)}）。`;
    }
  }
}

/**
 * The message for "both channels failed".
 *
 * The end state has to offer a way forward rather than a dead end, so this
 * names what went wrong on each side *and* tells the user what to do, which
 * neither failure's own message does — each of those promises a fallback that
 * has now also failed.
 */
export function combinedFailureMessage(
  primary: ExtractFailure,
  fallback: ExtractFailure,
): string {
  if (fallback.kind === "cancelled") return "已取消抓取。";
  return `网页抓取失败：直连方式${shortReason(primary)}，服务器备用方式${shortReason(fallback)}。请手动粘贴文章正文后导入。`;
}

/** A clause describing one failure, for use inside a longer sentence. */
function shortReason(failure: ExtractFailure): string {
  switch (failure.kind) {
    case "cancelled":
      return "已取消";
    case "invalid-url":
      return "链接无效";
    case "network":
      return "无法连接";
    case "timeout":
      return "超时";
    case "rate-limited":
      return "被限流（429）";
    case "http":
      return failure.status === undefined ? "返回错误" : `返回 HTTP ${failure.status}`;
    case "empty":
      return "返回空正文";
    case "format":
      return "返回格式无法识别";
    case "too-large":
      return "返回内容过大";
    case "parse":
      return "返回的正文无法解析";
    default: {
      const exhaustive: never = failure.kind;
      return String(exhaustive);
    }
  }
}
