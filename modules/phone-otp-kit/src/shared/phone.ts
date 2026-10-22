// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phone-number normalisation, assessment and masking. Pure string work — this
 * file is imported by both the server and the browser entry, so it must not
 * touch `node:*`, `process`, or the DOM.
 *
 * Three separate questions, three separate answers. Conflating them is how a
 * module ends up claiming SMS reachability it does not have:
 *
 * 1. **Syntax.** `parseE164` answers "is this shaped like E.164?" — a purely
 *    formal question, with no opinion about who can receive a text message.
 * 2. **Sending country.** {@link SUPPORTED_SENDING_COUNTRY_CODES} is the list of
 *    countries this kit claims it can actually deliver to. It contains `86` and
 *    nothing else. A +1 number is syntactically perfect and still unsupported;
 *    `assessPhone` reports that as `UNSUPPORTED_COUNTRY`, not as malformed.
 * 3. **Number kind.** Within +86, only mainland mobile numbers are accepted
 *    (`1` + `[3-9]` + 9 digits). A syntactically valid +86 landline is
 *    `NOT_MAINLAND_MOBILE`.
 *
 * The module deliberately refuses to resolve the country code of a number it
 * does not support: rather than shipping a partial country-code table that
 * would guess and be wrong, `parseE164` reports `countryCode: null` for
 * anything that is not +86. "I do not know" is a better answer than a
 * plausible wrong one, because the caller's next step for `null` is to refuse.
 *
 * Normalisation is deliberately generous about *formatting* (spaces, dashes,
 * parentheses, full-width digits from a Chinese IME, `00`-prefixed dialling)
 * and strict about *content*: the only accepted output is `+86` followed by
 * exactly 11 digits.
 */

import {
  MAINLAND_MOBILE_DIGIT_COUNT,
  MAX_E164_DIGITS,
} from "./constants";

/**
 * The countries this kit claims it can deliver an SMS to. One entry, on
 * purpose. Adding a country means: a real provider route, a national-number
 * rule as precise as the mainland one, a template, and a test that a number in
 * that country round-trips. Until all of that exists, the honest list is `86`.
 */
export const SUPPORTED_SENDING_COUNTRY_CODES = ["86"] as const;

export type SupportedSendingCountryCode = (typeof SUPPORTED_SENDING_COUNTRY_CODES)[number];

export const DEFAULT_SENDING_COUNTRY_CODE: SupportedSendingCountryCode = "86";

/** E.164: `+`, a non-zero leading digit, 8–15 digits in total. */
const E164_SYNTAX = /^\+[1-9]\d{7,14}$/;

/** Mainland mobile: `1`, then `[3-9]`, then 9 more digits. */
const MAINLAND_MOBILE_NATIONAL = /^1[3-9]\d{9}$/;

/** Characters people (and diallers) put between digit groups. */
const SEPARATORS = /[\s 　().\-_/]/gu;

/**
 * Fold an input string into the shape the parsers expect: NFKC (so full-width
 * `１３８` and `＋` from a Chinese IME become their ASCII forms), separators
 * removed, trimmed. Returns `""` for anything that is not a string — the
 * parsers treat that as empty rather than throwing.
 */
function canonicalise(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").replace(SEPARATORS, "");
}

export type E164Parse =
  | {
      readonly ok: true;
      readonly e164: string;
      /** Digits only, country code included: `8613800138000`. */
      readonly digits: string;
      /** `"86"` for +86, otherwise `null` — unresolved, not "no country code". */
      readonly countryCode: "86" | null;
    }
  | { readonly ok: false; readonly reason: "EMPTY" | "MALFORMED" };

/**
 * Formal E.164 syntax check. Says nothing about deliverability.
 *
 * A bare national number (`13800138000`) is `MALFORMED` here, because E.164
 * requires the `+`; callers that accept local input must normalise first. That
 * strictness is what keeps `13800138000` and `+8613800138000` from becoming two
 * separate identities downstream.
 */
export function parseE164(raw: unknown): E164Parse {
  let value = canonicalise(raw);
  if (value.length === 0) return { ok: false, reason: "EMPTY" };

  // `00861380…` is how the number is dialled, not how it is stored.
  if (value.startsWith("00")) value = `+${value.slice(2)}`;

  if (!E164_SYNTAX.test(value)) return { ok: false, reason: "MALFORMED" };

  const digits = value.slice(1);
  return {
    ok: true,
    e164: value,
    digits,
    countryCode: digits.startsWith(DEFAULT_SENDING_COUNTRY_CODE)
      ? DEFAULT_SENDING_COUNTRY_CODE
      : null,
  };
}

export type PhoneRejectionReason =
  | "EMPTY"
  | "MALFORMED"
  | "UNSUPPORTED_COUNTRY"
  | "NOT_MAINLAND_MOBILE";

export type PhoneAssessment =
  | {
      readonly ok: true;
      readonly e164: string;
      readonly countryCode: SupportedSendingCountryCode;
      /** 11 digits, `1[3-9]` + 9. */
      readonly nationalNumber: string;
      /** Display form, e.g. `138****8000`. Safe for logs and UI. */
      readonly masked: string;
    }
  | {
      readonly ok: false;
      readonly reason: PhoneRejectionReason;
      readonly countryCode: "86" | null;
      /** Masked form, or `***`. The raw rejected input is never echoed back. */
      readonly masked: string;
    };

/**
 * The bare forms a client sends when it does not bother with E.164.
 *
 * `parseE164` deliberately rejects these — a national number without a country
 * code is not E.164. But `assessPhone` accepts them, and that is not a
 * contradiction: the kit declares exactly **one** sending country, so "an
 * 11-digit mainland mobile" is unambiguous here in a way it would not be for a
 * module that supported several. If a second country is ever added, this
 * function is the first thing that has to go, and its removal is the reason to
 * keep it isolated rather than folded into the parser.
 */
function bareMainlandE164(raw: unknown): string | null {
  const digits = canonicalise(raw);
  if (digits.length === 0 || digits.startsWith("+") || digits.startsWith("00")) return null;

  if (digits.startsWith(DEFAULT_SENDING_COUNTRY_CODE)) {
    const national = digits.slice(DEFAULT_SENDING_COUNTRY_CODE.length);
    return MAINLAND_MOBILE_NATIONAL.test(national)
      ? `+${DEFAULT_SENDING_COUNTRY_CODE}${national}`
      : null;
  }
  return MAINLAND_MOBILE_NATIONAL.test(digits) ? `+${DEFAULT_SENDING_COUNTRY_CODE}${digits}` : null;
}

/**
 * The single gate the service uses. Every accepted number comes out as
 * `+86` + 11 digits, so two spellings of the same number cannot become two
 * identities.
 *
 * Accepts E.164, and additionally the bare spellings in
 * {@link bareMainlandE164}. Everything else is refused with a reason, so a
 * caller can tell "you sent junk" (`MALFORMED`) from "that is a +1 number"
 * (`UNSUPPORTED_COUNTRY`) from "that is a +86 landline"
 * (`NOT_MAINLAND_MOBILE`).
 *
 * The failure branch carries a *masked* form rather than the input. That is
 * deliberate: this value is what a caller is most likely to log on rejection,
 * and `***` cannot leak a phone number into a log the way the raw input would.
 */
export function assessPhone(raw: unknown): PhoneAssessment {
  const parsed = parseE164(raw);

  if (!parsed.ok) {
    const bare = parsed.reason === "MALFORMED" ? bareMainlandE164(raw) : null;
    if (bare === null) {
      return { ok: false, reason: parsed.reason, countryCode: null, masked: "***" };
    }
    const nationalNumber = bare.slice(DEFAULT_SENDING_COUNTRY_CODE.length + 1);
    return {
      ok: true,
      e164: bare,
      countryCode: DEFAULT_SENDING_COUNTRY_CODE,
      nationalNumber,
      masked: maskDigits(nationalNumber),
    };
  }

  const masked = maskPhoneE164(parsed.e164);

  if (parsed.countryCode === null) {
    return { ok: false, reason: "UNSUPPORTED_COUNTRY", countryCode: null, masked };
  }

  const nationalNumber = parsed.digits.slice(DEFAULT_SENDING_COUNTRY_CODE.length);
  if (!MAINLAND_MOBILE_NATIONAL.test(nationalNumber)) {
    return { ok: false, reason: "NOT_MAINLAND_MOBILE", countryCode: "86", masked };
  }

  return {
    ok: true,
    e164: parsed.e164,
    countryCode: DEFAULT_SENDING_COUNTRY_CODE,
    nationalNumber,
    masked,
  };
}

/** Keep the first three digits and the last four; star out everything between. */
function maskDigits(digits: string): string {
  if (digits.length < 8) return "*".repeat(Math.max(digits.length, 1));
  return `${digits.slice(0, 3)}${"*".repeat(digits.length - 7)}${digits.slice(-4)}`;
}

/**
 * Mask a phone number for display or logging.
 *
 * A supported number is masked on its **national part only** — `+8613800138000`
 * becomes `138****8000` — keeping the first three digits and the last four. This
 * is the rule the product already selected for the reader
 * (`docs/手机号认证契约.md` §5.5: "UI 一律显示掩码 … 且 `+86` 要剥掉国家码再掩码"),
 * and it is the right default for a kit that supports exactly one country: the
 * country code is a constant here, so showing it costs a character and reveals
 * nothing, while omitting it keeps the masked value parseable by the same rules
 * as the national form the user typed.
 *
 * A number outside the supported country gets its digits masked with the `+`
 * kept, because there the country code is *not* known to be constant and the
 * masked value must not read as a mainland number.
 *
 * Unparseable input returns `***` rather than the input: a masking helper that
 * passes junk through unchanged is worse than useless, because it is used
 * precisely on the paths where the input is unexpected.
 */
export function maskPhoneE164(raw: unknown): string {
  const parsed = parseE164(raw);
  if (!parsed.ok) return "***";
  if (parsed.countryCode !== null) {
    return maskDigits(parsed.digits.slice(parsed.countryCode.length));
  }
  return `+${maskDigits(parsed.digits)}`;
}

/**
 * Format-as-you-type helper for the +86 panel input.
 *
 * Keeps digits only, drops a leading `+`, `00` or `86` (the country prefix is
 * rendered as a fixed label, never typed), and caps the length. Mainland mobile
 * numbers always start with `1`, so a leading `86` can only be a country prefix
 * — there is no mainland number this would mangle.
 */
export function normalizeMainlandMobileInput(
  value: unknown,
  options?: { readonly maxDigits?: number },
): string {
  let digits = canonicalise(value);
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith(DEFAULT_SENDING_COUNTRY_CODE)) {
    digits = digits.slice(DEFAULT_SENDING_COUNTRY_CODE.length);
  }
  return digits
    .replace(/\D/gu, "")
    .slice(0, options?.maxDigits ?? MAINLAND_MOBILE_DIGIT_COUNT);
}

/** `true` when `digits` is a complete mainland-mobile national number. */
export function isCompleteMainlandMobileInput(digits: unknown): boolean {
  return typeof digits === "string" && MAINLAND_MOBILE_NATIONAL.test(digits);
}

/**
 * `13800138000` → `+8613800138000`, or `null` if it is not a complete mainland
 * mobile. This is the only place the panel builds an E.164 string.
 */
export function toE164FromMainlandDigits(digits: unknown): string | null {
  if (!isCompleteMainlandMobileInput(digits)) return null;
  return `+${DEFAULT_SENDING_COUNTRY_CODE}${digits as string}`;
}

/** Whether `digits` fits in E.164 at all — used for input length limits. */
export function exceedsE164Length(digits: string): boolean {
  return digits.length > MAX_E164_DIGITS;
}
