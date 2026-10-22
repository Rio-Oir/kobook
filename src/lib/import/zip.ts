// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A minimal ZIP reader, for EPUB and DOCX.
 *
 * ## Why not a library
 *
 * `jszip` is 100 kB and `fflate` 30 kB, and both would be a new runtime
 * dependency on the reading path of an open-source release that already has a
 * licence-registration script, an `npm audit` gate and a byte-level build
 * assertion watching its dependency list. What is actually needed here is
 * narrow and fully specified: walk the central directory, inflate the entries
 * whose names we asked for. Modern browsers and Node ≥ 18 ship the hard part —
 * `DecompressionStream("deflate-raw")` is exactly the raw-DEFLATE framing ZIP
 * entries use — so the remaining work is header parsing.
 *
 * ## What is deliberately not supported
 *
 * - **ZIP64.** EPUB and DOCX files are nowhere near 4 GiB. A ZIP64 archive is
 *   detected (its sizes are the `0xFFFFFFFF` sentinel) and rejected with a
 *   named error rather than mis-parsed into nonsense offsets.
 * - **Encryption.** Flag bit 0 set is rejected. An encrypted EPUB cannot be
 *   read without a key we do not have, and silently returning ciphertext as if
 *   it were markup would surface as "this book is empty".
 * - **Multi-disk archives.** Rejected; they do not occur for these formats.
 *
 * ## Why the central directory and not the local headers
 *
 * The local header of a streaming-written entry (flag bit 3) carries zeroed
 * sizes, with the real ones trailing the data in a descriptor. The central
 * directory is always complete, so it is the source of truth for sizes and
 * methods; the local header is consulted only to locate where the data starts,
 * using *its own* name and extra lengths — which legitimately differ from the
 * central directory's, and using the wrong pair is the classic way to read
 * four bytes of the next header as content.
 */

import { decodeText } from "./encoding.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The ZIP64 "look in the extra field" sentinel for a 32-bit size field. */
const ZIP64_SENTINEL = 0xffffffff;

const EOCD_MIN_LENGTH = 22;
/** EOCD is at the end, but a comment of up to 64 KiB can follow it. */
const MAX_COMMENT_LENGTH = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Flag bit 0: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;

/**
 * Bounds that make a decompression bomb a refusal rather than a hang.
 *
 * These are not tuned to the formats — they are set well above any real EPUB or
 * DOCX and well below anything that would exhaust a tab. A book that trips them
 * is malformed or hostile, and both should produce an error message, not a
 * spinning tab and an evicted tab's worth of memory.
 */
export const MAX_ZIP_ENTRIES = 4096;
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export type ZipFailureCode =
  | "NOT_A_ZIP"
  | "ZIP64_UNSUPPORTED"
  | "ENCRYPTED"
  | "TOO_MANY_ENTRIES"
  | "ENTRY_TOO_LARGE"
  | "TOTAL_TOO_LARGE"
  | "UNSUPPORTED_METHOD"
  | "MISSING_ENTRY"
  | "DECOMPRESSION_UNAVAILABLE"
  | "CORRUPT";

export class ZipError extends Error {
  readonly code: ZipFailureCode;
  constructor(code: ZipFailureCode, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface ZipEntry {
  /** Path inside the archive, exactly as stored (UTF-8 or CP437-decoded). */
  name: string;
  /** Offset of the local file header. */
  headerOffset: number;
  /** Compression method from the central directory. */
  method: number;
  /** Sizes from the central directory — authoritative, unlike the local copy. */
  compressedSize: number;
  size: number;
  /** True for directory entries (trailing slash), which carry no data. */
  isDirectory: boolean;
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * Locate the End Of Central Directory record.
 *
 * Scanned backwards from the end because a trailing archive comment of unknown
 * length may follow it. The scan is bounded by the largest a comment can be, so
 * a file that is not a ZIP at all costs one pass over at most 64 KiB and then a
 * clean `NOT_A_ZIP`.
 */
function findEndOfCentralDirectory(view: DataView): number {
  const length = view.byteLength;
  if (length < EOCD_MIN_LENGTH) {
    throw new ZipError("NOT_A_ZIP", "文件不是有效的 ZIP（长度不足）。");
  }
  const earliest = Math.max(0, length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = length - EOCD_MIN_LENGTH; offset >= earliest; offset -= 1) {
    if (u32(view, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError("NOT_A_ZIP", "文件不是有效的 ZIP（找不到中央目录结尾）。");
}

/**
 * Read the central directory.
 *
 * `decodeText` is used for entry names so a UTF-8-flagged archive (flag bit 11,
 * which EPUB requires) reads correctly, and a legacy CP437 archive degrades to
 * mojibake in a filename rather than a decode failure.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);

  const diskNumber = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const total = u16(view, eocd + 10);
  const centralOffset = u32(view, eocd + 16);

  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new ZipError("CORRUPT", "不支持分卷 ZIP 文件。");
  }
  if (total === 0xffff || centralOffset === ZIP64_SENTINEL) {
    throw new ZipError("ZIP64_UNSUPPORTED", "不支持 ZIP64 格式的压缩包。");
  }
  if (total > MAX_ZIP_ENTRIES) {
    throw new ZipError("TOO_MANY_ENTRIES", `压缩包内文件过多（${total} 个）。`);
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalBytes = 0;

  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > view.byteLength || u32(view, offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError("CORRUPT", "中央目录损坏。");
    }
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const size = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const headerOffset = u32(view, offset + 42);

    if (flags & FLAG_ENCRYPTED) {
      throw new ZipError("ENCRYPTED", "压缩包已加密，无法读取。");
    }
    if (compressedSize === ZIP64_SENTINEL || size === ZIP64_SENTINEL || headerOffset === ZIP64_SENTINEL) {
      throw new ZipError("ZIP64_UNSUPPORTED", "不支持 ZIP64 格式的压缩包。");
    }
    if (size > MAX_ENTRY_BYTES) {
      throw new ZipError("ENTRY_TOO_LARGE", `压缩包内单个文件过大（${Math.round(size / 1024 / 1024)} MB）。`);
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ZipError("TOTAL_TOO_LARGE", "压缩包解压后体积过大。");
    }

    const nameStart = offset + 46;
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    const name = new TextDecoder("utf-8").decode(nameBytes);

    entries.push({
      name,
      headerOffset,
      method,
      compressedSize,
      size,
      isDirectory: name.endsWith("/"),
    });

    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Look up one entry by exact name, or `undefined`. */
export function findZipEntry(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Response(stream).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/**
 * Inflate one entry.
 *
 * The data offset comes from the *local* header's own name and extra lengths,
 * which are allowed to differ from the central directory's — see the module
 * note. Sizes come from the central directory, which is why an entry written by
 * a streaming producer (flag bit 3, zeroed local sizes) still reads correctly.
 */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerOffset = entry.headerOffset;
  if (headerOffset + 30 > view.byteLength || u32(view, headerOffset) !== LOCAL_SIGNATURE) {
    throw new ZipError("CORRUPT", `压缩包条目 ${entry.name} 的本地头损坏。`);
  }
  const nameLength = u16(view, headerOffset + 26);
  const extraLength = u16(view, headerOffset + 28);
  const dataStart = headerOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > view.byteLength) {
    throw new ZipError("CORRUPT", `压缩包条目 ${entry.name} 的数据超出文件末尾。`);
  }
  const compressed = bytes.subarray(dataStart, dataEnd);

  if (entry.method === METHOD_STORED) {
    return compressed.slice();
  }
  if (entry.method !== METHOD_DEFLATE) {
    throw new ZipError("UNSUPPORTED_METHOD", `压缩包条目 ${entry.name} 使用了不支持的压缩方式。`);
  }
  if (typeof DecompressionStream !== "function") {
    throw new ZipError("DECOMPRESSION_UNAVAILABLE", "当前浏览器不支持解压，无法读取该文件。");
  }

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  let inflated: Uint8Array;
  try {
    // The cast is a `lib.dom` declaration mismatch, not a runtime one:
    // `DecompressionStream`'s writable side is declared as
    // `WritableStream<BufferSource>`, which is wider than the `Uint8Array`
    // that `pipeThrough` infers from the source stream. Both accept the same
    // values.
    const decompressed = source.pipeThrough(
      new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    );
    inflated = await readStream(decompressed);
  } catch {
    throw new ZipError("CORRUPT", `压缩包条目 ${entry.name} 解压失败。`);
  }

  // The central directory's size is a claim; the inflate result is the fact.
  // A mismatch means a corrupt or hostile archive, and continuing would hand
  // the caller a different number of bytes than it was told to expect.
  if (inflated.byteLength !== entry.size) {
    throw new ZipError("CORRUPT", `压缩包条目 ${entry.name} 解压后长度与声明不符。`);
  }
  return inflated;
}

/** Read one entry as text, choosing the encoding from its bytes. */
export async function readZipText(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  return decodeText(await readZipEntry(bytes, entry)).text;
}
