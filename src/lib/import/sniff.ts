// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a file actually is.
 *
 * Decided from the bytes first and the name second, because the name is a hint
 * the user controls and the bytes are not. A `.pdf` that is really a ZIP (some
 * exporters do this), or a `.txt` that is really HTML (a browser's "save as"),
 * both import correctly under the bytes-first order and fail under the
 * name-first one — and the failure is a parse error on content the reader
 * could have shown.
 *
 * The name is still consulted for the two formats that have no signature:
 * Markdown and plain text are both just text, and nothing in the bytes says
 * which the reader meant.
 */

import { findZipEntry, listZipEntries, type ZipEntry } from "./zip.js";

export type ImportFormat = "pdf" | "epub" | "docx" | "html" | "markdown" | "text";

const PDF_MAGIC = "%PDF-";
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
/** An empty archive is legal ZIP and starts with the end-of-central-directory record. */
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06] as const;

/** EPUB's `mimetype` payload, which the specification requires to be first. */
const EPUB_MIMETYPE = "application/epub+zip";

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function startsWithText(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/** The extension, lowercased and without the dot. `""` when there is none. */
export function extensionOf(filename: string): string {
  const cut = filename.lastIndexOf(".");
  if (cut < 0 || cut === filename.length - 1) return "";
  return filename.slice(cut + 1).toLowerCase();
}

/**
 * Whether the bytes are plausibly text.
 *
 * Checked before falling back to "it must be text", so a binary file with an
 * unknown extension is refused with "unsupported format" instead of being
 * decoded as GB18030 and stored as a page of replacement characters.
 *
 * The test is a NUL byte in the first few kilobytes — no text encoding in
 * scope puts one there, and every common binary format does. Control
 * characters other than tab/newline/carriage-return are counted too, since a
 * compiled object file is full of them.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 4096);
  if (limit === 0) return false;
  let controls = 0;
  for (let i = 0; i < limit; i += 1) {
    const byte = bytes[i]!;
    if (byte === 0) return false;
    // 0x09 tab, 0x0a LF, 0x0d CR are text; 0x0b and 0x0c are rare but legal.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0b && byte !== 0x0c) {
      controls += 1;
    }
  }
  // A couple of stray control bytes is a corrupt text file; a tenth of the
  // sample is a binary that happens to have no NULs.
  return controls * 10 < limit;
}

/** True when the markup looks like a whole HTML document or fragment. */
function looksLikeHtml(bytes: Uint8Array): boolean {
  // Skip a BOM and leading whitespace, then look for the doctype or `<html`.
  let start = 0;
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) start = 3;
  const window = bytes.subarray(start, start + 512);
  const head = new TextDecoder("latin1").decode(window).toLowerCase().trimStart();
  if (!head.startsWith("<")) return false;
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    head.startsWith("<?xml") && head.includes("<html")
  );
}

/**
 * A ZIP that is neither an EPUB nor a DOCX.
 *
 * Returned so the caller can say "this is a ZIP archive, not a book" rather
 * than "unknown format", which is the difference between a user knowing what
 * to do next and not.
 */
export type ZipFlavour = "epub" | "docx" | "other";

export function classifyZip(bytes: Uint8Array): ZipFlavour {
  let entries;
  try {
    entries = listZipEntries(bytes);
  } catch {
    return "other";
  }
  const mimetype = findZipEntry(entries, "mimetype");
  if (mimetype && !mimetype.isDirectory && mimetype.size === EPUB_MIMETYPE.length) {
    // The `mimetype` entry is defined to be stored, uncompressed and first, so
    // its name alone is strong evidence — but the payload is cheap to confirm,
    // and a ZIP that merely has a file called `mimetype` should not be read as
    // a book.
    const raw = entryPayload(bytes, mimetype);
    if (raw && startsWithText(raw, EPUB_MIMETYPE)) return "epub";
  }
  if (findZipEntry(entries, "word/document.xml")) return "docx";
  return "other";
}

/**
 * The stored bytes of one entry, without inflating.
 *
 * Only valid for a stored (uncompressed) entry — which `mimetype` is required
 * to be, and which is the only thing this is used for. The data offset comes
 * from the *local* header's own name and extra lengths, which are allowed to
 * differ from the central directory's; using the central directory's would
 * read the wrong bytes, or in this case the entry's own name.
 */
function entryPayload(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const offset = entry.headerOffset;
  if (offset + 30 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(offset, true) !== 0x04034b50) return null;
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.size;
  if (end > bytes.length) return null;
  return bytes.subarray(start, end);
}

/**
 * Decide how to read a file.
 *
 * Returns `null` for content this importer has no way to read — a ZIP that is
 * neither a book nor a document, a JPEG with its extension removed, an empty
 * file. The caller turns that into a message; guessing "probably text" here
 * would store garbage as an article.
 */
export function sniffFormat(bytes: Uint8Array, filename: string): ImportFormat | null {
  if (bytes.length === 0) return null;

  if (startsWithText(bytes, PDF_MAGIC)) return "pdf";

  if (startsWithBytes(bytes, ZIP_MAGIC) || startsWithBytes(bytes, ZIP_EMPTY_MAGIC)) {
    const flavour = classifyZip(bytes);
    if (flavour === "epub") return "epub";
    if (flavour === "docx") return "docx";
    // Content sniffing came back inconclusive — an unusual archive layout, or
    // a book missing the entry that identifies it. Trusting the name here does
    // not risk misreading a file: it routes to the parser for that format,
    // which will refuse a ZIP that is not one with a message naming what it
    // looked for, which is more useful than "unrecognised format".
    const zipExtension = extensionOf(filename);
    if (zipExtension === "epub") return "epub";
    if (zipExtension === "docx") return "docx";
    return null;
  }

  if (looksLikeHtml(bytes)) return "html";

  const extension = extensionOf(filename);
  if (extension === "pdf") return "pdf";
  if (extension === "epub") return "epub";
  if (extension === "docx") return "docx";
  if (extension === "html" || extension === "htm" || extension === "xhtml") return "html";
  if (extension === "md" || extension === "markdown" || extension === "mdown") return "markdown";
  if (extension === "txt" || extension === "text") {
    // A `.txt` whose bytes are not text is a mislabelled binary. Refusing is
    // the honest answer; decoding it would produce a page of U+FFFD.
    return looksLikeText(bytes) ? "text" : null;
  }

  // No signature and no known extension. Text files are the common case for a
  // reader — `.log`, `.srt`, a file with no extension at all — so text wins
  // when the bytes allow it, and everything else is refused.
  return looksLikeText(bytes) ? "text" : null;
}
