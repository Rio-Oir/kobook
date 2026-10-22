// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The API error shape and the one HTTP helper every client shares.
 *
 * This used to live in `auth-client.ts`, which made the account client the
 * de-facto owner of the error contract for the whole frontend — `articles.ts`
 * and `notes.ts` both imported `ApiRequestError` from it, so removing the
 * account client would have taken the error type with it. It is its own
 * module now: base owns the error contract, and the optional cloud adapter
 * (see `cloud/contract.ts`) consumes it rather than owning it.
 *
 * Two error shapes must both be handled. `/api/*` uses the shared error
 * contract (`{ error: { code, message, requestId } }`); an external auth
 * service returns its native shape (`{ message, code? }`). `normalizeApiError`
 * handles both, so callers only ever see a single `ApiRequestError` whose
 * `code` is either a shared `ApiErrorCode`, a vendor `BASE_ERROR_CODES`
 * string, or a numeric status fallback.
 *
 * User-displayable copy is in Simplified Chinese like the rest of the UI.
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

interface ApiErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string };
  message?: string;
  code?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultMessageFor(status: number): string {
  if (status === 401) return "未登录或会话已失效。";
  if (status === 403) return "没有权限执行该操作。";
  if (status === 404) return "资源不存在。";
  if (status === 409) return "该邮箱已注册或资源冲突。";
  if (status === 429) return "操作过于频繁，请稍后再试。";
  if (status >= 500) return "服务器错误，请稍后再试。";
  return "操作失败，请稍后再试。";
}

/**
 * 一个没有任何说明的 404/405，不是"这个接口里没有这条记录"。
 *
 * 本服务的 404 永远带信封（`{ error: { code, message, requestId } }`），所以
 * 没有 message 的 404 一定是别的东西在回答这个地址——只渲染页面的开发端口、
 * 纯静态预览、没有上游的反向代理。这时说"资源不存在。"会把读者引向"记录不见
 * 了"，而真正不见的是后端；把真正的问题说出来。
 */
const NO_API_UPSTREAM =
  "接口服务未连通：这个地址没有转发 /api 请求，请改用带后端的入口（开发环境是 http://127.0.0.1:8080）打开。";

export async function normalizeApiError(response: Response): Promise<ApiRequestError> {
  let body: ApiErrorEnvelope = {};
  try {
    const text = await response.text();
    if (text.length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (isObject(parsed)) body = parsed as ApiErrorEnvelope;
    }
  } catch {
    // Non-JSON body or empty: fall through to the status-only error.
  }
  const sharedError = body.error;
  const sharedCode = sharedError?.code;
  const sharedMessage = sharedError?.message;
  const nativeMessage = body.message;
  const nativeCode = body.code;
  // 只有真的有一句话时才算"接口答复了"；空体、HTML、裸 404 都算没答。
  const explained =
    (typeof sharedMessage === "string" && sharedMessage.length > 0) ||
    (typeof nativeMessage === "string" && nativeMessage.length > 0);
  const status = response.status;
  const message = explained
    ? ((sharedMessage ?? nativeMessage) as string)
    : status === 404 || status === 405
      ? NO_API_UPSTREAM
      : defaultMessageFor(status);
  return new ApiRequestError(
    message,
    status,
    sharedCode ?? nativeCode,
    sharedError?.requestId,
  );
}

/**
 * One JSON request against this origin.
 *
 * `credentials: "same-origin"` is enough to carry a session cookie when the
 * deployment serves the app and the API from one origin; there is no CORS
 * dance and no token plumbing. Callers that need cancellation use
 * `apiRequestWithSignal`, because spreading a per-call `init` over the base
 * options would drop a caller-supplied `signal` rather than merge it.
 */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw await normalizeApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function apiRequestWithSignal<T>(
  path: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<T> {
  return apiRequest<T>(path, { ...init, signal: init.signal });
}
