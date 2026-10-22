// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Result shapes shared by the server entry and the browser entry.
 *
 * Both sides need the same vocabulary for "the code was sent" and "the code was
 * wrong", so these types live in `shared/` rather than being mirrored. They
 * carry no user identity, no session, no token and no challenge id — see the
 * comment on `PhoneOtpVerifySuccess` for why the challenge id is absent.
 *
 * Failures are data, not exceptions: `{ ok: false, code }` where `code` is one
 * of the allowlisted response codes. A caller therefore cannot accidentally
 * render a provider message, because no field for one exists.
 */

import type { PhoneOtpResponseCode } from "./errors";

export interface PhoneOtpRequestSuccess {
  readonly ok: true;
  /** Display form, e.g. `138****8000`. Never the full number. */
  readonly maskedPhone: string;
  readonly purpose: string;
  /** Absolute epoch milliseconds at which the code stops working. */
  readonly expiresAt: number;
  readonly expiresInSeconds: number;
  /**
   * Advisory "you may ask again in N seconds" hint, derived from the configured
   * send rules. The limiter remains the authority; this is for the countdown.
   */
  readonly cooldownSeconds: number;
}

export interface PhoneOtpFailure {
  readonly ok: false;
  readonly code: PhoneOtpResponseCode;
  /** Present on `SEND_LIMITED` and `VERIFY_LIMITED`. */
  readonly retryAfterMs?: number;
  /** Present on `CODE_INVALID`: attempts left on the current challenge. */
  readonly attemptsRemaining?: number;
}

export type PhoneOtpRequestResult = PhoneOtpRequestSuccess | PhoneOtpFailure;

export interface PhoneOtpVerifySuccess {
  readonly ok: true;
  readonly maskedPhone: string;
  readonly purpose: string;
  /**
   * No challenge id, no user id, no session, no token.
   *
   * The reference implementation returned a challenge id from `request` and
   * accepted it on `verify`, which made "unknown id" and "wrong code" two
   * distinguishable answers — an oracle for challenge existence. Here `verify`
   * is keyed by purpose + phone, the id never leaves the store, and the two
   * cases collapse into the same `CODE_INVALID`.
   *
   * The kit also does not create a user or issue a session. A successful verify
   * means "someone who can read this number's SMS asked for purpose X"; turning
   * that into an account is the integrator's call, made in the integrator's own
   * transaction.
   */
}

export type PhoneOtpVerifyResult = PhoneOtpVerifySuccess | PhoneOtpFailure;

/** What the panel hands back to its parent about its own in-flight state. */
export interface PhoneOtpPanelPendingState {
  readonly requesting: boolean;
  readonly verifying: boolean;
}
