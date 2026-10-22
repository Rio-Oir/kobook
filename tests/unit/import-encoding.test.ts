// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Encoding detection for imported files.
 *
 * The behaviour under test is the one that decides whether a Chinese `.txt`
 * opens as prose or as a wall of U+FFFD. `File.text()` would decode every case
 * below as UTF-8 and substitute replacement characters for the GB18030 and
 * UTF-16 files without reporting anything, so the assertions here are about
 * *which* encoding was chosen, not only about the text that came out — a
 * decoder that guessed wrong and still produced plausible-looking output would
 * pass a text-only assertion.
 *
 * The GB18030 byte sequences are written out literally rather than produced by
 * an encoder, because the point is to pin the bytes a real file contains. A
 * helper that encoded with the same table the decoder uses would agree with it
 * by construction and could not catch a wrong code page.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decodeText, stripLeadingBom } from "../../src/lib/import/encoding.js";

/** "你好" — the canonical two-character probe. */
const NIHAO = "你好";
/** GBK/GB18030 bytes for 你好. Verified against a GB18030 decoder. */
const NIHAO_GB18030 = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]);
/** "中文" in GBK. A second sample, so one lucky byte pattern cannot carry the test. */
const ZHONGWEN_GB18030 = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

test("a UTF-8 BOM is honoured and stripped", () => {
  const result = decodeText(concat(Uint8Array.from([0xef, 0xbb, 0xbf]), utf8(NIHAO)));
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.guessed, false);
  assert.equal(result.text, NIHAO);
  // The BOM must not survive into the text: it would become a leading U+FEFF in
  // the first block, which changes that block's hash and therefore its id.
  assert.equal(result.text.charCodeAt(0), NIHAO.charCodeAt(0));
});

test("a UTF-16LE BOM selects little-endian and is stripped", () => {
  const body = Uint8Array.from([0x60, 0x4f, 0x7d, 0x59]); // 你好, UTF-16LE code units
  const result = decodeText(concat(Uint8Array.from([0xff, 0xfe]), body));
  assert.equal(result.encoding, "utf-16le");
  assert.equal(result.guessed, false);
  assert.equal(result.text, NIHAO);
});

test("a UTF-16BE BOM selects big-endian and is stripped", () => {
  const body = Uint8Array.from([0x4f, 0x60, 0x59, 0x7d]); // 你好, UTF-16BE code units
  const result = decodeText(concat(Uint8Array.from([0xfe, 0xff]), body));
  assert.equal(result.encoding, "utf-16be");
  assert.equal(result.guessed, false);
  assert.equal(result.text, NIHAO);
});

test("plain UTF-8 is accepted without a guess", () => {
  const result = decodeText(utf8(`${NIHAO}\n\nSecond paragraph.`));
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.guessed, false);
  assert.equal(result.text, `${NIHAO}\n\nSecond paragraph.`);
});

test("GB18030 bytes fall back to GB18030 and are reported as a guess", () => {
  const result = decodeText(NIHAO_GB18030);
  assert.equal(result.encoding, "gb18030");
  assert.equal(result.guessed, true, "a heuristic choice must be visible to the caller");
  assert.equal(result.text, NIHAO);
});

test("the GB18030 fallback is not fooled by a second sample", () => {
  // 中文 in GBK. Asserted separately from 你好 so that a byte pattern which
  // happened to decode correctly by accident cannot carry the whole case.
  const result = decodeText(ZHONGWEN_GB18030);
  assert.equal(result.encoding, "gb18030");
  assert.equal(result.text, "中文");
});

test("a GB18030 file with ASCII structure keeps its ASCII intact", () => {
  const mixed = concat(ZHONGWEN_GB18030, utf8("\n\nChapter 1\n"));
  const result = decodeText(mixed);
  assert.equal(result.encoding, "gb18030");
  assert.equal(result.text, "中文\n\nChapter 1\n");
});

test("BOM-less UTF-16LE is detected by its NUL pattern", () => {
  // "hello world hello world" as UTF-16LE, no BOM. This is the case that makes
  // the ordering in `decodeText` load-bearing: these bytes ARE valid UTF-8, so
  // the strict-UTF-8 test would accept them and produce a NUL between every
  // character.
  const ascii = "hello world, hello world";
  const body = new Uint8Array(ascii.length * 2);
  for (let i = 0; i < ascii.length; i += 1) {
    body[i * 2] = ascii.charCodeAt(i);
    body[i * 2 + 1] = 0;
  }
  const result = decodeText(body);
  assert.equal(result.encoding, "utf-16le");
  assert.equal(result.guessed, true);
  assert.equal(result.text, ascii);
  assert.ok(!result.text.includes("\u0000"), "no NUL may survive into the text");
});

test("BOM-less UTF-16BE is detected by its NUL pattern", () => {
  const ascii = "hello world, hello world";
  const body = new Uint8Array(ascii.length * 2);
  for (let i = 0; i < ascii.length; i += 1) {
    body[i * 2] = 0;
    body[i * 2 + 1] = ascii.charCodeAt(i);
  }
  const result = decodeText(body);
  assert.equal(result.encoding, "utf-16be");
  assert.equal(result.text, ascii);
});

test("a short ASCII file is not mistaken for UTF-16", () => {
  // Under four bytes the NUL heuristic declines; and at any length, text with
  // no NULs must stay UTF-8.
  assert.equal(decodeText(utf8("a")).encoding, "utf-8");
  assert.equal(decodeText(utf8("abc")).encoding, "utf-8");
  assert.equal(decodeText(utf8("hello")).encoding, "utf-8");
});

test("empty input decodes to empty text without guessing", () => {
  const result = decodeText(new Uint8Array(0));
  assert.equal(result.text, "");
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.guessed, false);
});

test("bytes that are valid UTF-8 but invalid GB18030 stay UTF-8", () => {
  // A four-byte emoji sequence. The strict UTF-8 pass must win, which is what
  // keeps the fallback from firing on ordinary modern text.
  const result = decodeText(utf8("emoji \u{1f600} end"));
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.guessed, false);
  assert.equal(result.text, "emoji \u{1f600} end");
});

test("undecodable bytes still produce a string rather than throwing", () => {
  // 0xFF is not valid UTF-8 and not a valid GB18030 lead byte either. The last
  // resort is non-fatal on purpose: replacement characters are a better
  // outcome than refusing to open the file.
  const result = decodeText(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]));
  assert.equal(typeof result.text, "string");
  assert.ok(result.text.length > 0);
});

test("stripLeadingBom removes a U+FEFF that survived as a character", () => {
  assert.equal(stripLeadingBom("﻿hello"), "hello");
  assert.equal(stripLeadingBom("hello"), "hello");
  assert.equal(stripLeadingBom(""), "");
  // Only leading. A U+FEFF mid-document is content, not a byte-order mark.
  assert.equal(stripLeadingBom("a﻿b"), "a﻿b");
});
