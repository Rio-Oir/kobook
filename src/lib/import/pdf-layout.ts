// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PDF text items → paragraphs.
 *
 * A PDF has no paragraphs. It has glyphs at coordinates, and `getTextContent()`
 * returns them as a flat list of runs, each with a transform matrix. Everything
 * a reader recognises as structure — lines, paragraphs, headings — was
 * expressed as geometry by whatever produced the file and has to be recovered
 * here.
 *
 * The pure half of PDF import lives in this file, separate from pdf.js, for a
 * reason that is practical rather than aesthetic: the reconstruction is where
 * the judgement calls are, and it can be tested exhaustively against synthetic
 * item lists without a real PDF, a worker, or a browser.
 *
 * ## The rules, and why each one is the one it is
 *
 * 1. **Group into lines by baseline.** Items whose baselines are within half a
 *    line height are the same line. Comparing exact `y` does not work: a run of
 *    superscript footnote markers sits a few units higher and would shatter a
 *    line into pieces.
 * 2. **Order by x within a line.** PDF has no reading order, only drawing
 *    order, and a two-column layout is drawn column by column on some
 *    producers and line by line on others. Sorting by x is right for the
 *    single-column case and wrong for two columns; document columns are not
 *    attempted, because the common reading material here is prose and a
 *    two-column paper would need a much larger investment to get right.
 * 3. **Break paragraphs on a large vertical gap.** Between consecutive lines,
 *    a gap of more than 1.6 line heights is a paragraph break. Below that it is
 *    leading, and the lines belong together. The threshold is a heuristic and
 *    is named as a constant so it can be tuned against real documents.
 * 4. **Join a line break with a space or without one, decided per boundary.**
 *    Chinese typesetting puts no space between characters, Latin puts one
 *    between words, and joining everything with a space inserts gaps inside
 *    every Chinese sentence while joining everything without one runs English
 *    words together. So the separator depends on what is on either side of the
 *    break.
 */

/** One run of text with the geometry needed to place it. */
export interface PdfTextItem {
  str: string;
  /** Left edge, in PDF user units. */
  x: number;
  /** Baseline, in PDF user units. Higher is further up the page. */
  y: number;
  /**
   * Advance width of the run, in the same units as `x`.
   *
   * Needed to tell "these two runs are adjacent" from "these two runs have a
   * space between them". Without it, a producer that emits one run per
   * character — which several do — would be read as a space between every
   * letter, because nothing else distinguishes `f`+`i` from `f`+` i`.
   */
  width: number;
  /** Font height, used to scale the tolerances. */
  height: number;
}

export interface PdfLayoutOptions {
  /**
   * Vertical gap, in multiples of the line height, that starts a new paragraph.
   *
   * 1.6 was chosen against body text set solid: normal leading is 1.15–1.4 of
   * the font size, and a paragraph gap is usually a full blank line, so the
   * boundary sits between them with room on both sides.
   */
  paragraphGapRatio?: number;
  /**
   * Baselines within this fraction of the line height are one line.
   *
   * 0.5 tolerates a superscript while still separating consecutive lines, whose
   * baselines are a full line height apart.
   */
  lineToleranceRatio?: number;
}

const DEFAULT_PARAGRAPH_GAP = 1.6;
const DEFAULT_LINE_TOLERANCE = 0.5;

interface Line {
  y: number;
  height: number;
  text: string;
}

/** True for characters that are ideographic or otherwise not space-separated. */
function isUnspaced(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  // CJK Unified Ideographs and extensions, Hiragana, Katakana, Hangul,
  // CJK punctuation, fullwidth forms.
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

/**
 * Whether a line break between these two characters should be joined with a
 * space.
 *
 * For CJK the answer is no: a line break in the middle of a Chinese sentence
 * is a layout artefact, and inserting a space would put a character into the
 * stored text that the source does not have — and every offset is measured
 * against that text.
 *
 * Hyphenation is not undone. A line ending in `-` may be a split word or may
 * genuinely end in a hyphen, and this function cannot tell; leaving it alone
 * keeps the text faithful, which matters more than the cosmetic gain.
 */
export function joinSeparator(before: string, after: string): string {
  if (before.length === 0 || after.length === 0) return "";
  const last = before[before.length - 1]!;
  const first = after[0]!;
  if (isUnspaced(last) || isUnspaced(first)) return "";
  // Whitespace already present at the join means the break is not the only
  // space; adding another would double it.
  if (/\s$/.test(before) || /^\s/.test(after)) return "";
  return " ";
}

/**
 * Whether to put a space between two runs that sit next to each other on the
 * same line.
 *
 * Decided from geometry, not from the characters — the opposite of
 * `joinSeparator`, and deliberately so. Within a line the producer told us
 * exactly where each run starts and how wide it is, so a gap is either there
 * or it is not. That is a fact, and it is more reliable than any reading of
 * the characters: it correctly keeps one-per-character runs (several producers
 * emit those) from becoming `f i r s t`, and it correctly spaces a genuinely
 * separated run whatever script it is in.
 *
 * A run whose width is unknown (`0`) reports no gap, so the conservative
 * outcome is "no space inserted" — the failure that leaves text intact rather
 * than the one that puts characters into it.
 */
function runSeparator(
  previousStr: string,
  previousEnd: number,
  nextStr: string,
  nextStart: number,
  scale: number,
): string {
  // Padding the producer already emitted is not a gap to be filled in.
  if (/\s$/.test(previousStr) || /^\s/.test(nextStr)) return "";
  if (nextStart <= previousEnd) return "";
  // A quarter of the font height is comfortably below a real word space
  // (typically 0.25–0.33 em) and comfortably above the rounding noise in a
  // producer's positions.
  return nextStart - previousEnd > scale * 0.2 ? " " : "";
}

/**
 * Rebuild lines from a flat item list.
 *
 * Exported because the line grouping is worth testing on its own: it is the
 * step where a superscript, a table cell or a footnote marker either stays
 * attached to its line or becomes a paragraph of its own.
 */
export function groupIntoLines(
  items: readonly PdfTextItem[],
  options: PdfLayoutOptions = {},
): Line[] {
  const tolerance = options.lineToleranceRatio ?? DEFAULT_LINE_TOLERANCE;

  let heightSum = 0;
  let heightCount = 0;
  for (const item of items) {
    if (item.str.length === 0) continue;
    heightSum += item.height > 0 ? item.height : 0;
    heightCount += 1;
  }
  // A producer that reports no font sizes at all still has to produce lines,
  // so fall back to a nominal height rather than a zero tolerance that would
  // put every item on its own line.
  const medianHeight = heightCount > 0 && heightSum > 0 ? heightSum / heightCount : 10;

  const sorted = [...items]
    .filter((item) => item.str.length > 0)
    // Top of the page first. PDF's y axis points up, so descending y is
    // descending down the page.
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines: Line[] = [];
  let current:
    | { y: number; height: number; parts: { x: number; width: number; str: string }[] }
    | null = null;

  const flush = (): void => {
    if (!current) return;
    const ordered = current.parts.sort((a, b) => a.x - b.x);
    let text = "";
    let end = 0;
    for (const part of ordered) {
      if (text.length === 0) {
        text = part.str;
      } else {
        text +=
          runSeparator(text, end, part.str, part.x, Math.max(current!.height, medianHeight)) +
          part.str;
      }
      // The run's own width is preferred; when a producer omits it, the string
      // length times a nominal advance keeps the cursor moving so a following
      // run is not treated as overlapping.
      end = part.x + (part.width > 0 ? part.width : part.str.length * current!.height * 0.5);
    }
    if (text.trim().length > 0) {
      lines.push({ y: current.y, height: current.height, text: text.trim() });
    }
    current = null;
  };

  for (const item of sorted) {
    const height = item.height > 0 ? item.height : medianHeight;
    if (current === null) {
      current = { y: item.y, height, parts: [{ x: item.x, width: item.width, str: item.str }] };
      continue;
    }
    const scale = Math.max(current.height, height, medianHeight);
    if (Math.abs(item.y - current.y) <= scale * tolerance) {
      current.parts.push({ x: item.x, width: item.width, str: item.str });
      // Keep the tallest run's height so a line containing one large glyph is
      // not measured as if it were all small text.
      current.height = Math.max(current.height, height);
      continue;
    }
    flush();
    current = { y: item.y, height, parts: [{ x: item.x, width: item.width, str: item.str }] };
  }
  flush();

  return lines;
}

/** A rebuilt paragraph, with the type size it was set at. */
export interface PdfParagraph {
  text: string;
  /** The largest font height in the paragraph, for heading detection. */
  height: number;
}

/**
 * Rebuild paragraphs, keeping each one's type size.
 *
 * The size is carried out because heading detection needs it and cannot
 * recover it from the string: "第一章" and "他点点头" are both four characters,
 * and the only thing that says which is a heading is how large it was set.
 */
export function paragraphObjectsFromItems(
  items: readonly PdfTextItem[],
  options: PdfLayoutOptions = {},
): PdfParagraph[] {
  const lines = groupIntoLines(items, options);
  if (lines.length === 0) return [];

  const gapRatio = options.paragraphGapRatio ?? DEFAULT_PARAGRAPH_GAP;

  // A median is used for the gap threshold rather than each line's own height,
  // so a single large heading does not make the line after it look like a
  // paragraph break.
  const heights = lines.map((line) => line.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 10;
  const paragraphHeightOf = (group: Line[]): number =>
    Math.max(...group.map((line) => line.height), 0);

  const paragraphs: PdfParagraph[] = [];
  let group: Line[] = [lines[0]!];

  for (let i = 1; i < lines.length; i += 1) {
    const previous = lines[i - 1]!;
    const line = lines[i]!;
    const gap = previous.y - line.y;
    if (gap > medianHeight * gapRatio) {
      paragraphs.push(joinLines(group, paragraphHeightOf(group)));
      group = [line];
      continue;
    }
    group.push(line);
  }
  paragraphs.push(joinLines(group, paragraphHeightOf(group)));

  return paragraphs.filter((paragraph) => paragraph.text.length > 0);
}

/** Join a group of lines into one paragraph, using the cross-line separator. */
function joinLines(lines: readonly Line[], height: number): PdfParagraph {
  let text = "";
  for (const line of lines) {
    if (text.length === 0) text = line.text;
    else text += joinSeparator(text, line.text) + line.text;
  }
  return { text: text.trim(), height };
}

/**
 * Rebuild paragraphs from a flat item list.
 *
 * Returns the paragraph strings only. Use `paragraphObjectsFromItems` when the
 * type size matters — which is whenever headings are being detected.
 */
export function paragraphsFromItems(
  items: readonly PdfTextItem[],
  options: PdfLayoutOptions = {},
): string[] {
  return paragraphObjectsFromItems(items, options).map((paragraph) => paragraph.text);
}

/** The median line height of a page's items, for heading comparison. */
export function medianItemHeight(items: readonly PdfTextItem[]): number {
  const heights = items
    .filter((item) => item.str.trim().length > 0 && item.height > 0)
    .map((item) => item.height)
    .sort((a, b) => a - b);
  if (heights.length === 0) return 10;
  return heights[Math.floor(heights.length / 2)] ?? 10;
}

/**
 * Whether a paragraph looks like a heading, given the body's typical size.
 *
 * The signals are the ones a reader uses: it is short, it has no terminal
 * punctuation, and it is set noticeably larger than the surrounding text. All
 * three are required, because any one alone misfires — a short line of dialogue
 * is short and may end without punctuation, and a pull quote is large.
 */
export function looksLikeHeading(
  text: string,
  height: number,
  medianHeight: number,
): boolean {
  if (text.length === 0 || text.length > 60) return false;
  if (/[。！？，、；：.,;:!?]$/.test(text)) return false;
  if (medianHeight <= 0) return false;
  return height >= medianHeight * 1.25;
}
