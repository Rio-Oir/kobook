// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Normalisation, rejection and masking.
 *
 * The load-bearing claim here is that *one number has one identity*. Two
 * spellings that reach the challenge store as two different strings would mean
 * two challenges for one phone, two budgets, and a verify that cannot find the
 * code the user was sent. Every accepted spelling below is asserted to land on
 * the same E.164 string.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessPhone,
  DEFAULT_SENDING_COUNTRY_CODE,
  isCompleteMainlandMobileInput,
  MAINLAND_MOBILE_DIGIT_COUNT,
  maskPhoneE164,
  MAX_E164_DIGITS,
  normalizeMainlandMobileInput,
  parseE164,
  SUPPORTED_SENDING_COUNTRY_CODES,
  toE164FromMainlandDigits,
} from "../src/server";

/* ───────────────────────── the declared claim ───────────────────────── */

test("the kit claims exactly one sending country", () => {
  assert.deepEqual([...SUPPORTED_SENDING_COUNTRY_CODES], ["86"]);
  assert.equal(DEFAULT_SENDING_COUNTRY_CODE, "86");
});

/* ─────────────────────────── accepted spellings ─────────────────────────── */

const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
  ["already E.164", "+8613800138000"],
  ["national digits", "13800138000"],
  ["national with spaces", "138 0013 8000"],
  ["country code, no plus", "8613800138000"],
  ["international dialling prefix", "008613800138000"],
  ["dashes", "+86-138-0013-8000"],
  ["parentheses and spaces", "(+86) 138 0013 8000"],
  ["dots", "+86.138.0013.8000"],
  ["padding whitespace", "  +86 13800138000\n"],
  ["full-width digits from a Chinese IME", "＋８６１３８００１３８０００"],
];

for (const [label, input] of ACCEPTED) {
  test(`assessPhone accepts ${label} and returns one canonical identity`, () => {
    const assessed = assessPhone(input);
    if (!assessed.ok) throw new Error(`expected ${label} to be accepted: ${JSON.stringify(assessed)}`);
    assert.equal(assessed.e164, "+8613800138000");
    assert.equal(assessed.countryCode, "86");
    assert.equal(assessed.nationalNumber, "13800138000");
    assert.equal(assessed.masked, "138****8000");
  });
}

test("every accepted spelling collapses to the same phoneRef", () => {
  // The identity that matters downstream is the hash, not the string.
  const refs = new Set(
    ACCEPTED.map(([, input]) => {
      const assessed = assessPhone(input);
      if (!assessed.ok) throw new Error(`expected ${input} to be accepted`);
      return assessed.e164;
    }),
  );
  assert.equal(refs.size, 1);
});

/* ───────────────────────────── E.164 syntax ───────────────────────────── */

test("parseE164 answers the syntax question and nothing else", () => {
  const us = parseE164("+14155552671");
  if (!us.ok) throw new Error("a well-formed +1 number is still well-formed E.164");
  assert.equal(us.e164, "+14155552671");
  assert.equal(us.digits, "14155552671");
  // Not resolved to "1": the module refuses to guess a country it cannot send to.
  assert.equal(us.countryCode, null);
});

test("a syntactically valid number outside +86 is unsupported, not malformed", () => {
  // The two questions stay separate: this is the case that a module which
  // conflated them would report as "invalid format", sending the caller looking
  // for a typo that is not there.
  const assessed = assessPhone("+14155552671");
  if (assessed.ok) throw new Error("+1 is not a supported sending country");
  assert.equal(assessed.reason, "UNSUPPORTED_COUNTRY");
  assert.equal(assessed.countryCode, null);
  assert.equal(assessed.masked, "+141****2671");
});

test("parseE164 stays strict about the plus, even though assessPhone is not", () => {
  // The asymmetry is the point: the formal question keeps the `+` requirement,
  // and the default-country convenience lives in the assessing layer, where the
  // "exactly one supported country" assumption is stated.
  assert.equal(parseE164("13800138000").ok, false);
  const assessed = assessPhone("13800138000");
  if (!assessed.ok) throw new Error("a bare mainland mobile is accepted for sending");
  assert.equal(assessed.e164, "+8613800138000");
});

test("a bare number that is not a mainland mobile stays refused", () => {
  for (const input of ["1380013800", "12800138000", "861380013800", "24155552671", "008613800138000x"]) {
    const assessed = assessPhone(input);
    if (assessed.ok) throw new Error(`expected ${input} to be refused`);
    assert.equal(assessed.masked, "***", input);
  }
});

test("a bare mobile-shaped string resolves to +86, and the plus takes precedence", () => {
  // The documented precedence, stated as a test because it has a cost worth
  // remembering: `+1 4155552671` typed without its plus is eleven digits
  // starting `1[3-9]`, which is exactly the shape of a mainland mobile, and the
  // kit has only one country to resolve it against. Callers that accept
  // international input must send E.164 with the plus. Recorded as a residual
  // risk in the module README.
  const bare = assessPhone("14155552671");
  if (!bare.ok) throw new Error("the unqualified form resolves against the single supported country");
  assert.equal(bare.e164, "+8614155552671");

  // The same digits with the plus are a +1 number and are refused.
  const withPlus = assessPhone("+14155552671");
  if (withPlus.ok) throw new Error("+1 is not a supported sending country");
  assert.equal(withPlus.reason, "UNSUPPORTED_COUNTRY");
});

test("a +86 number that is not a mobile is unsupported, not malformed", () => {
  // 11 digits that do not match `1[3-9]…`, plus two that are simply the wrong
  // length for a mobile — both are well-formed E.164, so neither is "malformed".
  for (const input of [
    "+8610123456789",
    "+8612345678901",
    "+8610800138000",
    "+861380013800",
    "+8601380013800",
  ]) {
    const assessed = assessPhone(input);
    if (assessed.ok) throw new Error(`expected ${input} to be refused`);
    assert.equal(assessed.reason, "NOT_MAINLAND_MOBILE", input);
    assert.equal(assessed.countryCode, "86");
  }
});

test("parseE164 rejects junk as malformed or empty", () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    [undefined, "EMPTY"],
    [null, "EMPTY"],
    [13800138000, "EMPTY"],
    ["abc", "MALFORMED"],
    ["+", "MALFORMED"],
    ["+86", "MALFORMED"],
    ["+8613", "MALFORMED"],
    ["+861380013800012345", "MALFORMED"],
    ["13800138000", "MALFORMED"],
    ["++8613800138000", "MALFORMED"],
  ];
  for (const [input, reason] of cases) {
    const parsed = parseE164(input);
    if (parsed.ok) throw new Error(`expected ${String(input)} to be rejected`);
    assert.equal(parsed.reason, reason, String(input));
  }
});

test("the digit budget matches E.164", () => {
  assert.equal(MAX_E164_DIGITS, 15);
  const longest = `+${"1".repeat(15)}`;
  const parsed = parseE164(longest);
  if (!parsed.ok) throw new Error("15 digits is the E.164 maximum, so it parses");
  assert.equal(parsed.digits.length, 15);
  assert.equal(parseE164(`+${"1".repeat(16)}`).ok, false);
});

/* ─────────────────────── the +86 form input helper ─────────────────────── */

test("normalizeMainlandMobileInput keeps digits and drops the country prefix", () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    ["13800138000", "13800138000"],
    ["+8613800138000", "13800138000"],
    ["8613800138000", "13800138000"],
    ["008613800138000", "13800138000"],
    ["138 0013 8000", "13800138000"],
    ["138-0013-8000", "13800138000"],
    ["１３８００１３８０００", "13800138000"],
    ["abc138def", "138"],
    ["", ""],
    ["    ", ""],
    [undefined, ""],
    [null, ""],
    [{}, ""],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeMainlandMobileInput(input), expected, String(input));
  }
});

test("the +86 input helper stops at 11 digits", () => {
  assert.equal(normalizeMainlandMobileInput("138001380001234"), "13800138000");
  assert.equal(MAINLAND_MOBILE_DIGIT_COUNT, 11);
  assert.equal(normalizeMainlandMobileInput("1380013800012", { maxDigits: 13 }), "1380013800012");
});

test("isCompleteMainlandMobileInput wants exactly 11 digits starting 1[3-9]", () => {
  assert.equal(isCompleteMainlandMobileInput("13800138000"), true);
  assert.equal(isCompleteMainlandMobileInput("1380013800"), false);
  assert.equal(isCompleteMainlandMobileInput("138001380000"), false);
  assert.equal(isCompleteMainlandMobileInput("12800138000"), false);
  assert.equal(isCompleteMainlandMobileInput("10800138000"), false);
  assert.equal(isCompleteMainlandMobileInput("+8613800138000"), false);
  assert.equal(isCompleteMainlandMobileInput(13800138000 as unknown), false);
});

test("toE164FromMainlandDigits is the only place the panel builds E.164", () => {
  assert.equal(toE164FromMainlandDigits("13800138000"), "+8613800138000");
  assert.equal(toE164FromMainlandDigits("138"), null);
  assert.equal(toE164FromMainlandDigits(""), null);
});

/* ─────────────────────────────── masking ─────────────────────────────── */

test("masking keeps the country code, three digits and the last four", () => {
  assert.equal(maskPhoneE164("+8613800138000"), "138****8000");
  assert.equal(maskPhoneE164("13800138000"), "***", "a bare national number is not parseable");
  assert.equal(maskPhoneE164("+14155552671"), "+141****2671");
  assert.equal(maskPhoneE164("+8613800138000"), maskPhoneE164("＋８６１３８００１３８０００"));
});

test("masking never echoes input it could not parse", () => {
  // The whole reason this function exists is the paths where the input is
  // unexpected; returning it unchanged would put a raw number in a log line.
  const junk: readonly unknown[] = ["", "junk", "+", "not a phone", undefined, null, 42, {}, ["+8613800138000"]];
  for (const input of junk) {
    assert.equal(maskPhoneE164(input), "***", JSON.stringify(input) ?? "undefined");
  }
});

test("masking leaves seven of the eleven national digits visible", () => {
  const masked = maskPhoneE164("+8613800138000");
  assert.equal(masked, "138****8000");
  const nationalShown = masked.replace("+86", "").replace(/\D/gu, "");
  assert.equal(nationalShown.length, 7);
  assert.ok(masked.includes("****"));
});

/* ───────────────────────── the failure branch ───────────────────────── */

test("a rejection reports a masked form, never the input", () => {
  const assessed = assessPhone("+14155552671");
  if (assessed.ok) throw new Error("expected a refusal");
  assert.equal(assessed.masked, "+141****2671");
  assert.ok(!assessed.masked.includes("555"));
  const empty = assessPhone("");
  if (empty.ok) throw new Error("expected a refusal");
  assert.equal(empty.masked, "***");
});

test("assessPhone refuses non-strings without throwing", () => {
  for (const input of [undefined, null, 0, false, {}, [], Symbol("x")]) {
    const assessed = assessPhone(input);
    assert.equal(assessed.ok, false);
  }
});
