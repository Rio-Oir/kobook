// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared helpers for turning extractor output into `ContentBlock`s.
 *
 * The rules that matter for the audit findings this phase must not
 * regress:
 *
 *  - There is NO minimum-length filter. The old frontend parser dropped every
 *    block shorter than 20 characters, which deleted short Chinese
 *    paragraphs and most headings (audit P1#3). A block is retained whenever
 *    it has non-whitespace content after normalisation, however short.
 *  - Block ids embed the 1-based index, so two blocks with identical text
 *    are still distinguishable (needed for duplicate-paragraph anchoring).
 *  - `hash` is over the normalised text only, so the same text at a
 *    different position keeps the same hash — that is what lets a later
 *    document version re-anchor a note.
 */

import { createHash } from "node:crypto";
import type {
  ContentBlock,
  ContentBlockType,
  InlineSpan,
} from "../../../../shared/contracts/index.js";
import { canonicalizeSpans, spansAreSound, type RawMark } from "./inline.js";

/** Bump when the parsing pipeline changes in a way that alters block output. */
export const EXTRACTOR_VERSION = "phase1.3";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

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
 * The equivalence with `normalizeProse` is exact but far from obvious, so it
 * is asserted directly in `tests/unit/inline-spans.test.ts`: any run of
 * `[\t\f\v 　\n\r ]` collapses to a single space (whitespace first,
 * then CRLF→LF, then the newline rules — they compose to that), and the
 * leading and trailing ones are trimmed away.
 *
 * **Why the whole block is normalised in one call.** The alternative —
 * normalising each emphasis run and concatenating — gets `**a**  b` wrong:
 * the second run's leading space is trimmed off, giving `ab` where the block
 * really reads `a b`. That is one character of drift, it does not throw, and
 * it silently shifts every stored highlight after it in that block. This is
 * the single most dangerous thing in the inline feature, which is why the
 * mapping exists at all instead of re-running the regexes per run.
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
            return edge === "start"
              ? segment.outStart + segment.outLen
              : segment.outStart;
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

export interface AddBlockOptions {
  level?: number;
  lang?: string | null;
  ordered?: boolean;
  src?: string;
  alt?: string;
  title?: string;
  /** Table cells (first row is the header), only applied when `type` is `table`. */
  rows?: string[][];
  /** List nesting depth (0-based), only applied when `type` is `listItem`. */
  depth?: number;
  /** Task-list state, only applied when `type` is `listItem`. */
  task?: boolean;
  checked?: boolean;
  /**
   * Emphasis found in the source, as offsets onto the *raw* text passed to
   * `add` — before normalisation. Callers only supply these when the raw
   * text they measured against is the same string they are passing as
   * `text`; see `addFromNode` in `markdown.ts` for why that guard exists.
   */
  rawMarks?: readonly RawMark[];
}

/** Accumulates blocks, assigning index / id / hash consistently. */
export class BlockCollector {
  private readonly blocks: ContentBlock[] = [];

  add(type: ContentBlockType, text: string, opts: AddBlockOptions = {}): void {
    const marks = type === "code" ? undefined : opts.rawMarks;
    // Normalise through the mapping only when there is something to map.
    // `normalizeProseWithMap` and `normalizeProse` produce the same string —
    // asserted in `tests/unit/inline-spans.test.ts` — so this branch changes
    // the resulting text not at all, only the bookkeeping.
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
    if (type === "listItem") {
      block.ordered = opts.ordered ?? false;
      block.depth = opts.depth ?? 0;
      if (opts.task) {
        block.task = true;
        block.checked = opts.checked ?? false;
      }
    }
    if (type === "image" && opts.src) block.src = opts.src;
    if (type === "image" && opts.alt) block.alt = opts.alt;
    if (type === "image" && opts.title) block.title = opts.title;
    if (type === "table" && opts.rows && opts.rows.length > 0) block.rows = opts.rows;
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
