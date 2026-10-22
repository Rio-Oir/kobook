// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Numeric and pattern constants shared by the server and browser entries.
 *
 * Nothing here reads the environment. The kit takes every value from its
 * configuration object so that a deployment mistake is a construction-time
 * failure rather than a silently different runtime behaviour.
 */

/** A one-time code is this many digits. */
export const OTP_CODE_LENGTH = 6;

/** The code lengths this kit supports, end to end (config and panel). */
export const MIN_CODE_LENGTH = 6;
export const MAX_CODE_LENGTH = 8;

/** Default lifetime of a challenge, and therefore of the code in the SMS. */
export const DEFAULT_CODE_TTL_MS = 5 * 60_000;

/** Default number of wrong codes a single challenge tolerates. */
export const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;

/** HMAC-SHA256 key material must be at least this long. */
export const MIN_SECRET_BYTES = 32;

/** Longest E.164 number, in digits, ignoring the leading `+`. */
export const MAX_E164_DIGITS = 15;

/** Digits in a mainland-mobile national number (`1` + 10). */
export const MAINLAND_MOBILE_DIGIT_COUNT = 11;

/**
 * Purposes are administrator-configured labels, never caller-invented strings,
 * and they are mixed into the code hash. The pattern keeps them ASCII, lower
 * case and bounded so they cannot become a place to hide data or a way to
 * collide two purposes through Unicode normalisation.
 */
export const PURPOSE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Upper bound on configured purposes; keeps the configuration auditable. */
export const MAX_PURPOSES = 8;

/**
 * A client reference is a *server-derived* identifier: a socket address, a
 * connection id, an authenticated device row id. It must not be a header the
 * caller can choose. The value is HMAC'd before it reaches any store, but the
 * pattern still keeps it bounded.
 */
export const CLIENT_REF_PATTERN = /^[A-Za-z0-9_.:~-]{8,128}$/;

/** Bounds enforced on every configured rate-limit rule. */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 10_000;
export const MIN_WINDOW_MS = 1_000;
export const MAX_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_RULES_PER_SCOPE = 4;

/** Bounds on configurable challenge lifetimes. */
export const MIN_CODE_TTL_MS = 30_000;
export const MAX_CODE_TTL_MS = 30 * 60_000;

/** Bounds on the per-challenge attempt allowance. */
export const MIN_VERIFY_ATTEMPTS = 1;
export const MAX_VERIFY_ATTEMPTS = 10;

/** Longest accepted code string, in characters, before format rejection. */
export const MAX_CODE_INPUT_LENGTH = 32;
