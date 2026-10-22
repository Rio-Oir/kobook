// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Error contract.
 *
 * Application sample failures use this shape. Better Auth retains its native
 * error responses, and readiness uses the health contract. The `message` is
 * user-displayable; it must never contain SQL, stack traces, provider keys,
 * cookies or database credentials.
 */

export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "EMPTY_CONTENT"
  | "UNSUPPORTED_INPUT"
  | "UPSTREAM_FAILED"
  | "CONFLICT"
  | "INTERNAL"
  /**
   * The session is valid but the address is not verified yet. Distinct from
   * FORBIDDEN so the client can offer "resend verification" instead of an
   * unexplained refusal.
   */
  | "EMAIL_NOT_VERIFIED"
  /**
   * The account was disabled by an administrator. Distinct so the client can
   * say so, rather than reporting a generic permission error for what is an
   * account-state problem.
   */
  | "ACCOUNT_DISABLED"
  /**
   * The import request body parsed fine, but the resulting document had no
   * retainable text (audit P1#3). 422 keeps it distinct from a malformed
   * body (400) so the client can render the "粘贴正文" fallback.
   */
  | "EMPTY_ARTICLE"
  /**
   * The route exists but the implementation is intentionally not wired yet
   * (URL import in phase 3 slice 1; the Jina / SSRF work lands in slice 2).
   * 501 is what clients should see, never 500.
   */
  | "NOT_IMPLEMENTED";

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Correlates a user-visible failure with a server log line. */
    requestId: string;
  };
}

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  EMPTY_CONTENT: 422,
  UNSUPPORTED_INPUT: 415,
  UPSTREAM_FAILED: 502,
  CONFLICT: 409,
  INTERNAL: 500,
  EMAIL_NOT_VERIFIED: 403,
  ACCOUNT_DISABLED: 403,
  EMPTY_ARTICLE: 422,
  NOT_IMPLEMENTED: 501,
};

export function httpStatusForCode(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function buildApiError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
): ApiErrorBody {
  return { error: { code, message, requestId } };
}

/**
 * Cookie/credential-ish substrings that must never reach a log sink or an
 * API response. Kept deliberately narrow so it does not mangle normal text.
 */
export const REDACTED = "[redacted]";
