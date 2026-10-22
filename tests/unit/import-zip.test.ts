// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ZIP reader, against archives built by `tests/helpers/zip-builder.ts`.
 *
 * The builder is deliberately a separate implementation from the reader — if
 * both shared a misunderstanding of the format, a round-trip test would pass
 * and EPUB import would still fail on real books. The cases below therefore
 * cover both directions: archives the builder produces (round-trip), and
 * archives the builder would never produce (encrypted, ZIP64, truncated),
 * hand-patched into a valid file so the reader's refusal is what is measured.
 *
 * Every rejection is asserted by `code` rather than by message, so the tests
 * pin the contract EPUB and DOCX callers switch on rather than the wording.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildZip, bytes } from "../helpers/zip-builder.js";
import {
  ZipError,
  findZipEntry,
  listZipEntries,
  readZipEntry,
  readZipText,
} from "../../src/lib/import/zip.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_SENTINEL = 0xffffffff;

/** Find the first central-directory record offset. */
function centralOffset(zip: Uint8Array): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i + 4 <= zip.byteLength; i += 1) {
    if (view.getUint32(i, true) === CENTRAL_SIGNATURE) return i;
  }
  throw new Error("fixture has no central directory");
}

function eocdOffset(zip: Uint8Array): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = zip.byteLength - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  throw new Error("fixture has no EOCD");
}

/** Read a field back, so a patch can be asserted to have landed. */
function centralU16(zip: Uint8Array, offset: number): number {
  return new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint16(offset, true);
}

function centralU32(zip: Uint8Array, offset: number): number {
  return new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint32(offset, true);
}

function assertZipError(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`expected a ZipError with code ${code}`);
  } catch (err) {
    assert.ok(err instanceof ZipError, `expected ZipError, got ${String(err)}`);
    assert.equal(err.code, code);
  }
}

test("a deflated entry round-trips", async () => {
  const text = "第一章 中文正文\n\n第二段。".repeat(20);
  const zip = await buildZip([{ name: "content.txt", data: bytes(text) }]);

  const entries = listZipEntries(zip);
  assert.equal(entries.length, 1);
  const entry = findZipEntry(entries, "content.txt");
  assert.ok(entry);
  assert.equal(entry.method, 8, "the builder deflates by default");
  assert.equal(entry.size, bytes(text).length, "central directory size is the uncompressed one");

  assert.equal(await readZipText(zip, entry), text);
});

test("a stored entry round-trips", async () => {
  const text = "stored, not deflated";
  const zip = await buildZip([{ name: "plain.txt", data: bytes(text), stored: true }]);

  const entry = findZipEntry(listZipEntries(zip), "plain.txt");
  assert.ok(entry);
  assert.equal(entry.method, 0);
  assert.equal(await readZipText(zip, entry), text);
});

test("the data offset comes from the local header, not the central one", async () => {
  // The two headers legitimately carry different extra-field lengths in real
  // archives; reading the data at the central directory's idea of the offset
  // is the classic way to get four bytes of the next header as content. The
  // builder writes no extra fields, so correctness here means the reader used
  // the local header's own lengths rather than assuming either.
  const zip = await buildZip([
    { name: "a.txt", data: bytes("first entry") },
    { name: "b.txt", data: bytes("second entry") },
    { name: "c.txt", data: bytes("third entry") },
  ]);
  const entries = listZipEntries(zip);
  assert.equal(entries.length, 3);
  assert.equal(await readZipText(zip, findZipEntry(entries, "b.txt")!), "second entry");
  assert.equal(await readZipText(zip, findZipEntry(entries, "c.txt")!), "third entry");
});

test("names are matched exactly and a miss returns undefined", async () => {
  const zip = await buildZip([
    { name: "META-INF/container.xml", data: bytes("<container/>") },
    { name: "OEBPS/content.opf", data: bytes("<package/>") },
  ]);
  const entries = listZipEntries(zip);
  assert.ok(findZipEntry(entries, "OEBPS/content.opf"));
  // Case matters: EPUB paths are case-sensitive on the platforms that produce
  // them, and a case-insensitive lookup would silently open the wrong part.
  assert.equal(findZipEntry(entries, "oebps/content.opf"), undefined);
  assert.equal(findZipEntry(entries, "OEBPS/missing.opf"), undefined);
});

test("directory entries are flagged and carry no data", async () => {
  const zip = await buildZip([
    { name: "OEBPS/", data: new Uint8Array(0) },
    { name: "OEBPS/chapter1.xhtml", data: bytes("<p>hi</p>") },
  ]);
  const entries = listZipEntries(zip);
  assert.equal(findZipEntry(entries, "OEBPS/")?.isDirectory, true);
  assert.equal(findZipEntry(entries, "OEBPS/chapter1.xhtml")?.isDirectory, false);
});

test("GB18030 content inside an archive decodes as GB18030", async () => {
  // The encoding path and the archive path have to compose: a GB18030 chapter
  // inside an EPUB is a real thing, and the ZIP layer must not assume UTF-8.
  const gb18030 = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
  const zip = await buildZip([{ name: "gb.txt", data: gb18030 }]);
  const entry = findZipEntry(listZipEntries(zip), "gb.txt");
  assert.ok(entry);
  assert.equal(await readZipText(zip, entry), "中文\n");
});

test("a file that is not a ZIP is rejected as NOT_A_ZIP", async () => {
  assertZipError(() => listZipEntries(bytes("%PDF-1.7\nnot a zip at all")), "NOT_A_ZIP");
  assertZipError(() => listZipEntries(new Uint8Array(0)), "NOT_A_ZIP");
  assertZipError(() => listZipEntries(bytes("short")), "NOT_A_ZIP");
});

test("an encrypted entry is refused rather than returned as ciphertext", async () => {
  const zip = await buildZip([{ name: "secret.txt", data: bytes("hello") }]);
  const offset = centralOffset(zip);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint16(offset + 8, centralU16(zip, offset + 8) | 0x0001, true);
  assert.ok(centralU16(zip, offset + 8) & 0x0001, "the patch must have landed");

  assertZipError(() => listZipEntries(zip), "ENCRYPTED");
});

test("a ZIP64 archive is named rather than mis-parsed", async () => {
  const zip = await buildZip([{ name: "big.txt", data: bytes("hello") }]);
  const offset = centralOffset(zip);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint32(offset + 24, ZIP64_SENTINEL, true);
  assert.equal(centralU32(zip, offset + 24), ZIP64_SENTINEL);

  assertZipError(() => listZipEntries(zip), "ZIP64_UNSUPPORTED");
});

test("an entry count above the ceiling is refused before any entry is read", async () => {
  const zip = await buildZip([{ name: "a.txt", data: bytes("a") }]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint16(eocdOffset(zip) + 10, 5000, true);

  assertZipError(() => listZipEntries(zip), "TOO_MANY_ENTRIES");
});

test("entry data running past the end of the file is a corruption error", async () => {
  // The shape of a truncated download: the central directory survived and still
  // claims a full-size entry, but the bytes are not there. Chopping the tail of
  // the archive would not model this — the last bytes are the EOCD, so the
  // entry data would still be intact. The declared compressed size is what has
  // to overrun.
  const text = "the quick brown fox ".repeat(50);
  const zip = await buildZip([{ name: "long.txt", data: bytes(text) }]);
  const offset = centralOffset(zip);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint32(offset + 20, zip.byteLength, true);
  assert.equal(centralU32(zip, offset + 20), zip.byteLength, "the patch must have landed");

  const entry = findZipEntry(listZipEntries(zip), "long.txt")!;
  await assert.rejects(
    () => readZipEntry(zip, entry),
    (err: unknown) => err instanceof ZipError && err.code === "CORRUPT",
  );
});

test("inflated length disagreeing with the declared size is rejected", async () => {
  // A hostile archive can declare a small size and inflate to something much
  // larger. The reader must not hand the caller a different byte count than it
  // was told to expect.
  const zip = await buildZip([{ name: "lie.txt", data: bytes("actual content here") }]);
  const offset = centralOffset(zip);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  view.setUint32(offset + 24, 3, true); // claim 3 bytes, inflate to 19

  const entry = findZipEntry(listZipEntries(zip), "lie.txt")!;
  await assert.rejects(
    () => readZipEntry(zip, entry),
    (err: unknown) => err instanceof ZipError && err.code === "CORRUPT",
  );
});

test("an empty archive lists no entries", async () => {
  const zip = await buildZip([]);
  assert.deepEqual(listZipEntries(zip), []);
});
