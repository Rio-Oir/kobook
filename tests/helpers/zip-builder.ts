// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A minimal ZIP *writer*, for tests only.
 *
 * The ZIP reader is the code under test; using a library to produce its input
 * would mean testing one implementation against another and calling agreement
 * correctness. Writing the archives here instead keeps the two sides
 * independent — a bug in the reader has to be a bug in the reader, not a
 * shared misunderstanding of the format.
 *
 * Only what the reader's callers actually produce is supported: stored and
 * deflate entries, no ZIP64, no encryption, no data descriptors. Deflate uses
 * `CompressionStream("deflate-raw")` — the same primitive the reader inflates
 * with, which is deliberate: it pins the framing (raw, not zlib, not gzip)
 * that EPUB and DOCX both use and that is easy to get wrong by one header.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** Flag bit 11: entry names are UTF-8. EPUB requires it; DOCX does not care. */
const FLAG_UTF8 = 0x0800;

export interface ZipFixtureEntry {
  name: string;
  data: Uint8Array;
  /** Store uncompressed instead of deflating. Useful for the stored branch. */
  stored?: boolean;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  // Same `lib.dom` declaration mismatch the reader documents: `CompressionStream`'s
  // writable side is declared as `WritableStream<BufferSource>`, wider than the
  // `Uint8Array` `pipeThrough` infers. Both accept the same values.
  const stream = source.pipeThrough(
    new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** CRC-32 (IEEE 802.3), as ZIP requires. Table built once per call — fine for tests. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive from the given entries.
 *
 * Streaming quirks are not modelled: every entry is written once, in order,
 * with its real sizes in both headers, which is what the reader expects of the
 * archives it will actually meet.
 */
export async function buildZip(entries: readonly ZipFixtureEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const method = entry.stored ? 0 : 8;
    const payload = entry.stored ? entry.data : await deflateRaw(entry.data);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, FLAG_UTF8, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // no extra field
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_SIGNATURE, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, FLAG_UTF8, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true); // extra
    centralView.setUint16(32, 0, true); // comment
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of locals) {
    out.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centrals) {
    out.set(part, cursor);
    cursor += part.length;
  }
  out.set(eocd, cursor);
  return out;
}

/** UTF-8 bytes, for fixture convenience. */
export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
