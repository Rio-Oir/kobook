// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Byte → text decoding for imported files.
 *
 * ## Why this exists
 *
 * `File.text()` is specified to decode as UTF-8 and to substitute U+FFFD for
 * anything that is not valid UTF-8. It never throws and never asks. For an
 * English `.txt` that is correct; for a Chinese one it is a silent corruption:
 * a GB18030 file — which is what most Chinese `.txt` files produced by Windows
 * editors and download sites actually are — decodes into a wall of replacement
 * characters with no error anywhere. The reader then stores and displays the
 * mojibake, and the original bytes are gone.
 *
 * So the bytes are decoded here instead, with the encoding chosen by evidence
 * rather than by assumption.
 *
 * ## The order, and why it is this order
 *
 * 1. **A BOM is a statement.** If the file carries one, honour it — it is the
 *    only case where the producer told us the encoding outright.
 * 2. **UTF-16 without a BOM.** Windows' "Unicode" text export normally writes a
 *    BOM, but files round-tripped through other tools sometimes lose it. The
 *    shape is unmistakable (every other byte is NUL for ASCII-heavy text), and
 *    the cost of checking is one pass over a small prefix.
 * 3. **Valid UTF-8 wins.** Decoded with `fatal: true`, so a single invalid
 *    sequence rejects the whole file rather than being papered over. UTF-8 is
 *    the only encoding here with a checksum-like property: arbitrary GB18030
 *    bytes are very unlikely to also be well-formed UTF-8, which is what makes
 *    this test decisive rather than a coin flip.
 * 4. **Otherwise GB18030.** A superset of GBK and GB2312, so it covers the
 *    Simplified-Chinese legacy encodings with one decoder. This is a *guess*,
 *    and `guessed` says so, so a caller can tell the user rather than let them
 *    wonder why the text is wrong.
 *
 * Big5 and Shift_JIS are deliberately not attempted. `TextDecoder` supports
 * both, but neither can be told apart from GB18030 by structure — the
 * distinguishing evidence is frequency analysis, which needs a model and
 * misclassifies short files. A wrong guess there is worse than no guess, so
 * those files decode as GB18030 and look wrong, which at least points the user
 * at the real problem.
 */

/** Encodings this module can return. */
export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

export interface DecodeResult {
  text: string;
  /** The encoding the bytes were decoded as. */
  encoding: TextEncoding;
  /**
   * True when no BOM and no decisive UTF-8 validation settled the choice, so
   * `encoding` is a heuristic. Callers may surface this; nothing depends on it.
   */
  guessed: boolean;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Whether the bytes look like BOM-less UTF-16.
 *
 * The test is the NUL pattern: in UTF-16 text whose characters are mostly
 * below U+0100 — which is all Latin, and the ASCII half of any CJK document's
 * punctuation and markup — one of every two bytes is NUL. Sampling the first
 * kilobyte and requiring a clear majority on one side is enough to separate it
 * from every 8-bit encoding, where NUL is rare.
 *
 * Returns `null` when neither side dominates.
 */
function detectBomlessUtf16(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const limit = Math.min(bytes.length, 1024);
  if (limit < 4) return null;

  let evenNuls = 0;
  let oddNuls = 0;
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) evenNuls += 1;
    else oddNuls += 1;
  }

  // A quarter of the sampled bytes is a low bar that still excludes 8-bit text
  // (where NUL runs a few per mille at most) and GB18030 (which has no NUL in
  // its multi-byte forms at all).
  const threshold = limit / 4;
  if (oddNuls > threshold && evenNuls < oddNuls / 8) return "utf-16le";
  if (evenNuls > threshold && oddNuls < evenNuls / 8) return "utf-16be";
  return null;
}

/**
 * Decode imported bytes to text, choosing the encoding from the bytes.
 *
 * Never throws for undecodable input: the final GB18030 pass is non-fatal, so
 * the worst case is text with U+FFFD in it — the same outcome as `File.text()`
 * but reached only after the two decisive tests above have both declined.
 */
export function decodeText(bytes: Uint8Array): DecodeResult {
  if (bytes.length === 0) {
    return { text: "", encoding: "utf-8", guessed: false };
  }

  // 1. BOM.
  if (startsWith(bytes, UTF8_BOM)) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(UTF8_BOM.length)),
      encoding: "utf-8",
      guessed: false,
    };
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      text: new TextDecoder("utf-16le").decode(bytes.subarray(2)),
      encoding: "utf-16le",
      guessed: false,
    };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      text: new TextDecoder("utf-16be").decode(bytes.subarray(2)),
      encoding: "utf-16be",
      guessed: false,
    };
  }

  // 2. BOM-less UTF-16. Checked before UTF-8 because UTF-16LE ASCII text *is*
  //    valid UTF-8 (as a string of NULs and letters), so the UTF-8 test below
  //    would accept it and produce text with a NUL between every character.
  const utf16 = detectBomlessUtf16(bytes);
  if (utf16 !== null) {
    return {
      text: new TextDecoder(utf16).decode(bytes),
      encoding: utf16,
      guessed: true,
    };
  }

  // 3. Strict UTF-8.
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
      guessed: false,
    };
  } catch {
    // Not UTF-8. Fall through.
  }

  // 4. Legacy Chinese. Non-fatal by construction — this is the last resort, and
  //    a replacement character is a better outcome than refusing to open the
  //    file at all.
  return {
    text: new TextDecoder("gb18030").decode(bytes),
    encoding: "gb18030",
    guessed: true,
  };
}

/**
 * Decode text that arrived as a string of unknown provenance, for the paste
 * path.
 *
 * Kept separate from `decodeText` on purpose: a pasted string has already been
 * decoded by the browser's clipboard handling, so there are no bytes left to
 * inspect. What can still be wrong is an encoding that survived as *characters*
 * — a GB18030 page copied through a tool that decoded it as Latin-1 yields
 * mojibake whose "characters" are the original bytes one-for-one.
 *
 * Detecting that reliably is not possible in general, so this only strips a
 * BOM if the paste carried one as U+FEFF. Anything more aggressive would
 * corrupt legitimate text that happens to look like mojibake.
 */
export function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
