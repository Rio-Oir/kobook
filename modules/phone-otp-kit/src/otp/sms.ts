// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The SMS transport seam.
 *
 * ## The bug this interface is shaped to prevent
 *
 * The reference implementation's Aliyun adapter interpolated the SDK's raw
 * `err.message` (and, on the other branch, the response `body.message`) into the
 * exception it threw. Its own file header claimed the opposite — that only a
 * redacted summary reached the thrown error — so the comment and the code
 * disagreed, and only the code runs. Vendor messages routinely echo the
 * destination number, a request id, and sometimes the message body, i.e. the
 * code itself.
 *
 * Two structural fixes, neither of which depends on the vendor:
 *
 * 1. **A transport returns a code, not a message.** `SmsSendResult` has no field
 *    for text. There is nothing for an adapter to concatenate a vendor string
 *    into, so "the adapter should have sanitised it" is not a rule anyone has to
 *    remember.
 * 2. **A thrown error is never inspected.** {@link toSafeSmsFailure} maps any
 *    throwable to a failure code without reading `message`, `stack`, `name` or
 *    anything else off it. An adapter that throws the vendor's error object
 *    whole is still safe, because the kit does not look inside.
 *
 * The kit ships no real transport. There is no SDK import, no HTTP client and no
 * endpoint in this module: the production adapter is the integrator's, written
 * against their provider, and this interface is the contract it must satisfy.
 *
 * ## What an adapter must guarantee
 *
 * - Return `{ ok: false, failure }` for an outcome you can classify. Prefer this
 *   over throwing: it preserves classification without carrying text.
 * - Never log the `code`, and mask with `maskedTo` rather than masking yourself.
 * - Never retry internally. The kit's send budget was already charged; a silent
 *   retry spends real money outside the budget and outside the audit.
 * - Return `{ ok: true }` or `{ ok: false, failure }` — nothing else. The service
 *   checks the shape (see `interpretSmsSendResult`), so a malformed result is a
 *   failed send rather than an accidental success.
 */

export const SMS_FAILURE_CODES = [
  /** The provider could not be reached, or timed out. */
  "TRANSPORT_UNAVAILABLE",
  /** The provider refused for a quota/throttling reason. */
  "RATE_LIMITED",
  /** The provider accepted the request and rejected the message (template, signature, content review). */
  "REJECTED",
  /** The destination is not deliverable per the provider (ported, blacklisted, blocked). */
  "INVALID_DESTINATION",
  /** The adapter could not classify the outcome. */
  "UNKNOWN",
] as const;

export type SmsFailureCode = (typeof SMS_FAILURE_CODES)[number];

export interface SmsSendRequest {
  /** The destination, in E.164. An adapter needs it to deliver. */
  readonly toE164: string;
  /** Pre-masked destination, for any log line the adapter emits. */
  readonly maskedTo: string;
  /** The code to deliver. Never log it, never put it in an error. */
  readonly code: string;
  /** Which flow requested it. */
  readonly purpose: string;
  /** Lifetime to state in the message, in seconds. */
  readonly ttlSeconds: number;
  /** Provider template/signature id, when the deployment has one. */
  readonly templateId?: string;
}

/**
 * `{ ok: true }` carries nothing else on purpose.
 *
 * A vendor correlation id looks harmless and is not: it is unbounded
 * vendor-controlled text that frequently embeds the destination number, and once
 * it exists on the result it will eventually be logged. The kit has no use for
 * it, so it is not transported.
 */
export type SmsSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: SmsFailureCode };

export interface SmsTransport {
  /** Short, stable label for this adapter, e.g. `"fake"` or `"acme-sms-http"`. */
  readonly kind: string;
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

export function isSmsFailureCode(value: unknown): value is SmsFailureCode {
  return typeof value === "string" && (SMS_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Classify anything a transport threw, without reading it.
 *
 * The only thing inspected is an explicit `failure` property that is already one
 * of the known codes — the shape a disciplined adapter returns *without*
 * throwing. Everything else is `UNKNOWN`. Deliberately does not consult
 * `message`, `stack`, `name`, `code`, or any nested `cause`. Reading the property
 * can itself throw (a getter), so it happens inside a `try`: the classification
 * is a failure in that case, never an exception escaping into the service.
 */
export function toSafeSmsFailure(error: unknown): SmsFailureCode {
  if (typeof error !== "object" || error === null) return "UNKNOWN";
  try {
    const candidate = (error as { readonly failure?: unknown }).failure;
    return isSmsFailureCode(candidate) ? candidate : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/**
 * Interpret whatever a transport resolved to.
 *
 * A transport is external code, and the kit's security properties are stated in
 * terms of `SmsSendResult` — so the value is checked rather than trusted:
 *
 * - `ok` must be **exactly `true`**. `{ ok: 1 }`, `{ ok: "yes" }` and a truthy
 *   object are malformed results, not confirmations, and are treated as failures.
 *   "It was truthy" is how a broken adapter silently turns a failed send into a
 *   published, unusable code.
 * - `failure` must be one of `SMS_FAILURE_CODES`. Anything else — a vendor
 *   string, a number, a nested object — is `UNKNOWN`, so an adapter cannot get
 *   provider text into the observation by putting it where a code belongs.
 * - `null`, `undefined`, a string, a number and an array are all failures.
 * - A property read that throws (a getter) is a failure.
 *
 * The only value treated as success is an object whose `ok` is literally `true`.
 */
export function interpretSmsSendResult(value: unknown): SmsSendResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, failure: "UNKNOWN" };
  }

  let ok: unknown;
  let failure: unknown;
  try {
    ok = (value as { readonly ok?: unknown }).ok;
    if (ok !== true) failure = (value as { readonly failure?: unknown }).failure;
  } catch {
    return { ok: false, failure: "UNKNOWN" };
  }

  if (ok === true) return { ok: true };
  return { ok: false, failure: isSmsFailureCode(failure) ? failure : "UNKNOWN" };
}
