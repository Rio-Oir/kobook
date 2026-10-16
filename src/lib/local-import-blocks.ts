// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared helpers for turning extractor output into `ContentBlock`s —
 * browser-side.
 *
 * This is the browser counterpart of `server/src/lib/parse/blocks.ts`. Two
 * things make a straight import impossible, and both are deliberate:
 *
 *   1. the server module hashes with `node:crypto`, which does not exist in a
 *      browser bundle; and
 *   2. the browser must not depend on `server/` (which drags in jsdom).
 *
 * So `sha256Hex` is re-implemented as a synchronous, dependency-free SHA-256,
 * and the normalisation rules are reproduced verbatim. "Verbatim" is a claim
 * with a test behind it: `tests/unit/local-import-parse.test.ts` compares the
 * browser parser's complete output against the server parser's over the same
 * fixtures, and separately checks `sha256Hex` byte-for-byte against
 * `node:crypto` for empty, ASCII, Chinese and multi-block inputs. The whole
 * channel design rests on the two extractors producing the *same* blocks —
 * a note anchored to a browser-parsed article must still validate against the
 * server's copy — so equivalence is asserted rather than assumed.
 *
 * Why a hand-rolled SHA-256 rather than `crypto.subtle.digest`:
 *
 *   - `subtle.digest` is async, and `BlockCollector.add` computes the id and
 *     hash *synchronously* while walking the document. Making the walk async
 *     would either change the block ordering or spread promises through the
 *     entire extractor.
 *   - `crypto.subtle` is unavailable on non-secure origins, which would make
 *     a `http://` local deployment silently unable to parse anything.
 *
 * The rules the two implementations must not regress:
 *
 *  - There is NO minimum-length filter. The old frontend parser dropped every
 *    block shorter than 20 characters, which deleted short Chinese
 *    paragraphs and most headings. A block is retained whenever
 *    it has non-whitespace content after normalisation, however short.
 *  - Block ids embed the 1-based index, so two blocks with identical text
 *    are still distinguishable (needed for duplicate-paragraph anchoring).
 *  - `hash` is over the normalised text only, so the same text at a
 *    different position keeps the same hash — that is what lets a later
 *    document version re-anchor a note.
 */

import type {
  ContentBlock,
  ContentBlockType,
  InlineSpan,
} from "../../shared/contracts/index.js";
import { canonicalizeSpans, spansAreSound, type RawMark } from "./local-import-inline.js";

/**
 * Bump when the parsing pipeline changes in a way that alters block output.
 *
 * Held to the server's value on purpose. The two extractors describe the same
 * wire shape, and a document parsed in the browser can be uploaded and
 * compared against one the server parsed — if their version strings differed,
 * that comparison would look like a pipeline change instead of the no-op it
 * is. Divergence without a version bump would be a silent coordinate break,
 * which is why `tests/unit/local-import-parse.test.ts` asserts equality with
 * `server/src/lib/parse/blocks.ts` rather than just checking a literal here.
 */
// Kept byte-identical to the server's value: the two pipelines have to be
// interchangeable, and `tests/unit/local-import-parse.test.ts` asserts it. The
// value is persisted in every parsed document, so it is not respelled here.
export const EXTRACTOR_VERSION = "phase1.2";

// ── SHA-256 ───────────────────────────────────────────────────────────────
// A direct implementation of FIPS 180-4 §6.2. Round constants are the first
// 32 bits of the fractional parts of the cube roots of the first 64 primes;
// the initial hash value is the same for the square roots of the first 8.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** UTF-8 encode without depending on `TextEncoder` being patched in. */
function utf8Bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/**
 * `sha256(text)` as lowercase hex.
 *
 * Synchronous and allocation-light: one padded buffer proportional to the
 * input, which matters because every retained block hashes its own text while
 * a 2 MB article is being walked.
 */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  // 1 byte 0x80, then zeros, then an 8-byte big-endian bit length, rounded up
  // to a whole number of 64-byte blocks. Always at least one block (`+ 9`),
  // so the length field never collides with the 0x80 byte.
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(total - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  let out = "";
  for (const word of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    out += word.toString(16).padStart(8, "0");
  }
  return out;
}

// ── Normalisation ─────────────────────────────────────────────────────────

/**
 * Whitespace that reads as a space: tab, form feed, vertical tab, NBSP
 * (U+00A0) and ideographic space (U+3000). Built from a string so the
 * escapes stay visible in source rather than relying on literal characters.
 */
const PROSE_SPACE = new RegExp("[\\t\\f\\v\\u00a0\\u3000 ]+", "g");

/**
 * Collapse runs of whitespace in prose. Newlines inside a paragraph become a
 * single space, matching how the text is displayed.
 */
export function normalizeProse(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(PROSE_SPACE, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n+/g, " ")
    .trim();
}

/**
 * One character of the class `normalizeProse` collapses, plus the newlines it
 * turns into a space. Not global, so `.test` carries no `lastIndex` state.
 */
const PROSE_SPACE_CHAR = new RegExp("[\t\f\v\u00a0\u3000\n\r ]");

function isProseSpaceOrNewline(ch: string): boolean {
  return PROSE_SPACE_CHAR.test(ch);
}

/**
 * A piecewise translation from raw offsets to normalised offsets.
 *
 * Deliberately a segment table rather than a per-character array: the article
 * body is capped at 2 MB, and a per-character map would be some millions of
 * objects allocated per import for a mapping that is almost entirely 1:1.
 */
export interface OffsetMap {
  /**
   * Where the character at raw offset `offset` ended up.
   *
   * `edge` decides what to do when the offset lands *inside* a whitespace run
   * that several raw characters collapsed into one: a span's start shrinks
   * towards the text (`**a b**` must not begin with the space), and a span's
   * end shrinks away from it. A span that lies entirely inside a run
   * therefore maps to an empty range, which the caller drops.
   */
  toOutput(offset: number, edge: "start" | "end"): number;
}

interface OffsetSegment {
  /** Output range `[outStart, outStart + outLen)`. */
  outStart: number;
  outLen: number;
  /** Input range `[inStart, inStart + inLen)`. */
  inStart: number;
  inLen: number;
}

/**
 * `normalizeProse`, plus a table saying where each raw character went.
 *
 * The equivalence with `normalizeProse` is exact but far from obvious. The
 * danger it guards against is the one that makes this whole table necessary:
 * normalising each emphasis run separately and concatenating gets `**a**  b`
 * wrong — the second run's leading space is trimmed off, giving `ab` where the
 * block really reads `a b`. That is one character of drift, it does not throw,
 * and it silently shifts every stored highlight after it in that block.
 */
export function normalizeProseWithMap(raw: string): { text: string; map: OffsetMap } {
  const segments: OffsetSegment[] = [];
  const parts: string[] = [];
  let outLength = 0;
  let i = 0;

  while (i < raw.length) {
    let j = i + 1;
    if (isProseSpaceOrNewline(raw[i]!)) {
      while (j < raw.length && isProseSpaceOrNewline(raw[j]!)) j += 1;
      // The whole run becomes one space. Leading and trailing runs are
      // removed below, which is this function's `.trim()`.
      parts.push(" ");
      segments.push({ outStart: outLength, outLen: 1, inStart: i, inLen: j - i });
      outLength += 1;
    } else {
      while (j < raw.length && !isProseSpaceOrNewline(raw[j]!)) j += 1;
      const chunk = raw.slice(i, j);
      parts.push(chunk);
      segments.push({ outStart: outLength, outLen: chunk.length, inStart: i, inLen: chunk.length });
      outLength += chunk.length;
    }
    i = j;
  }

  let text = parts.join("");
  // At most one leading and one trailing space can exist, because every run
  // collapses to exactly one. Guarded anyway so a future change to the
  // collapse rule cannot desynchronise the table from the text.
  if (text.startsWith(" ")) {
    text = text.slice(1);
    segments.shift();
    for (const segment of segments) segment.outStart -= 1;
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    segments.pop();
  }

  const frozen = segments;
  const finalLength = text.length;
  return {
    text,
    map: {
      toOutput(offset, edge) {
        for (const segment of frozen) {
          // Only reachable for the leading region `.trim()` removed, where
          // there is no segment to land in.
          if (offset < segment.inStart) return segment.outStart;
          if (offset < segment.inStart + segment.inLen) {
            if (segment.outLen === segment.inLen) {
              return segment.outStart + (offset - segment.inStart);
            }
            return edge === "start" ? segment.outStart + segment.outLen : segment.outStart;
          }
        }
        // Past the last segment: the trailing region `.trim()` removed.
        return finalLength;
      },
    },
  };
}

/**
 * Move raw marks onto the normalised text and resolve their overlap.
 *
 * Marks that the collapsing erased fall out here: if the whole run was
 * whitespace, start and end clamp onto each other and the span is dropped.
 */
export function shiftSpans(
  marks: readonly RawMark[],
  map: OffsetMap,
  textLength: number,
): InlineSpan[] {
  const shifted: RawMark[] = [];
  for (const mark of marks) {
    const start = map.toOutput(mark.start, "start");
    const end = map.toOutput(mark.end, "end");
    if (end <= start) continue;
    shifted.push({ ...mark, start, end });
  }
  return canonicalizeSpans(shifted, textLength);
}

/**
 * Code keeps its internal line structure; only trailing whitespace and
 * leading/trailing blank lines are removed.
 */
export function normalizeCode(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.join("\n");
}

// ── Block collection ──────────────────────────────────────────────────────

export interface AddBlockOptions {
  level?: number;
  lang?: string | null;
  ordered?: boolean;
  /**
   * Emphasis found in the source, as offsets onto the *raw* text passed to
   * `add` — before normalisation. Callers only supply these when the raw
   * text they measured against is the same string they are passing as
   * `text`.
   */
  rawMarks?: readonly RawMark[];
}

/** Accumulates blocks, assigning index / id / hash consistently. */
export class BlockCollector {
  private readonly blocks: ContentBlock[] = [];

  add(type: ContentBlockType, text: string, opts: AddBlockOptions = {}): void {
    const marks = type === "code" ? undefined : opts.rawMarks;
    // Normalise through the mapping only when there is something to map.
    // `normalizeProseWithMap` and `normalizeProse` produce the same string,
    // so this branch changes the resulting text not at all, only the
    // bookkeeping.
    const measured = marks && marks.length > 0 ? normalizeProseWithMap(text) : null;
    const normalized =
      measured?.text ?? (type === "code" ? normalizeCode(text) : normalizeProse(text));
    if (normalized.length === 0) return;

    const index = this.blocks.length + 1;
    const hash = sha256Hex(normalized);
    const block: ContentBlock = {
      id: `b${index}-${hash.slice(0, 8)}`,
      index,
      type,
      text: normalized,
      hash,
    };
    if (type === "heading") block.level = opts.level ?? 1;
    if (type === "code") block.lang = opts.lang ?? null;
    if (type === "listItem") block.ordered = opts.ordered ?? false;
    if (measured && marks && marks.length > 0) {
      const spans = shiftSpans(marks, measured.map, normalized.length);
      // Drop rather than repair. Emphasis that cannot be located exactly is
      // a cosmetic loss; an offset past the end of the paragraph would put
      // every highlight in this block on the wrong characters.
      if (spans.length > 0 && spansAreSound(spans, normalized.length)) {
        block.spans = spans;
      }
    }

    this.blocks.push(block);
  }

  get length(): number {
    return this.blocks.length;
  }

  toBlocks(): ContentBlock[] {
    return this.blocks;
  }
}

/** Whole-document identity over the block hashes only. */
export function documentTextHash(blocks: ContentBlock[]): string {
  return sha256Hex(blocks.map((b) => b.hash).join("\n"));
}
