// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text import.
 *
 * Two things this does that handing the decoded string to the Markdown parser
 * does not.
 *
 * ## 1. The encoding
 *
 * `File.text()` decodes as UTF-8 and substitutes U+FFFD for everything else,
 * silently. Most Chinese `.txt` files on disk are GB18030, so the current
 * behaviour turns them into a wall of replacement characters and stores that.
 * `./encoding.js` decides from the bytes instead.
 *
 * ## 2. Where the paragraph breaks are
 *
 * A Chinese novel is usually written one paragraph per line with **no blank
 * lines**, and Markdown has no paragraph without a blank line — so the whole
 * chapter arrives as a single block. That is not a formatting detail: a
 * one-block document has one anchor, one selectable unit, and a note anchored
 * anywhere in a 300,000-character paragraph. The reader would work and be
 * useless.
 *
 * A file that *does* have blank lines is treated the other way, because that
 * shape means the lines are wrapped prose and the blank line is the real break.
 * Joining wrapped lines is what stops an 80-column email export from becoming
 * eighty paragraphs.
 *
 * The rule is therefore: blank lines are paragraph breaks; within a run of
 * non-blank lines, each line is its own paragraph **only if the file has no
 * blank lines at all**. One rule, two shapes, no frequency analysis.
 */

import type { ParsedDocument, ParseResult } from "../../../shared/contracts/index.js";
import {
  BlockCollector,
  EXTRACTOR_VERSION,
  documentTextHash,
} from "../local-import-blocks.js";
import { decodeText, stripLeadingBom, type TextEncoding } from "./encoding.js";

export interface PlainTextOptions {
  /** Explicit title, from a caller that knows better than the file does. */
  title?: string;
  /**
   * Title to use when the document has none of its own.
   *
   * Plain text never does — there are no metadata and no headings to derive
   * from, so in practice this is always the file name. Kept separate from
   * `title` anyway so the two are not confused: `title` is an instruction,
   * `fallbackTitle` is a suggestion.
   */
  fallbackTitle?: string;
}

/**
 * A line that is only a chapter marker, promoted to a heading.
 *
 * Deliberately narrow. Anything wider starts turning ordinary short lines into
 * headings, and a heading is not cosmetic here — it changes the block's `type`,
 * which `outlineOf` reads to build the table of contents. A false positive puts
 * a line of prose in the reader's outline.
 *
 * The load-bearing part is `SEPARATOR`: after the marker there must be either
 * nothing or a separator, and prose is not a separator. Without it
 * `第一章讲的是主人公如何…` matches — `第一章` is a prefix of it, and the rest fits
 * inside the length bound — and a sentence of body text becomes a chapter.
 */
const SEPARATOR = "(?:\\s|$|[：:、.．·—–\\-]|[0-9一二三四五六七八九十])";

const CHAPTER_PATTERNS: readonly RegExp[] = [
  new RegExp(`^第\\s*[0-9一二三四五六七八九十百千零两]+\\s*[章节回卷篇部]${SEPARATOR}.{0,30}$`),
  new RegExp(`^(?:chapter|part|section|book)\\s+[0-9ivxlcdm]+${SEPARATOR}.{0,30}$`, "i"),
  new RegExp(`^(?:序|楔子|前言|后记|尾声|终章|番外)${SEPARATOR}.{0,30}$`),
];

function asHeading(line: string): boolean {
  if (line.length === 0 || line.length > 40) return false;
  return CHAPTER_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Split decoded text into paragraph strings.
 *
 * `\r\n` and `\r` are already normalised away by the decoder's callers; this
 * handles the bare `\n` case and both shapes described in the module note.
 */
export function splitPlainTextParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  // Blank lines are only counted *between* content. A file that ends with a
  // newline — which is nearly every text file — would otherwise look
  // blank-line-separated because `split` leaves a trailing empty string, and
  // every line-per-paragraph novel would be joined into one paragraph.
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && lines[first]!.trim().length === 0) first += 1;
  while (last >= first && lines[last]!.trim().length === 0) last -= 1;
  const hasBlankLine = lines
    .slice(first, last + 1)
    .some((line) => line.trim().length === 0);

  if (!hasBlankLine) {
    // Line-per-paragraph. Preserve every non-empty line as its own paragraph.
    return lines.map((line) => line.trim()).filter((line) => line.length > 0);
  }

  // Blank-line-separated, with wrapped lines inside each run.
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const joined = current.join(" ").trim();
    if (joined.length > 0) paragraphs.push(joined);
    current = [];
  };
  for (const line of lines) {
    if (line.trim().length === 0) flush();
    else current.push(line.trim());
  }
  flush();
  return paragraphs;
}

/**
 * Parse decoded plain text into the unified `ParsedDocument`.
 *
 * Takes a string rather than bytes so the two callers — a file, and a paste
 * that has already been decoded by the clipboard — share one implementation.
 */
export function parsePlainText(
  raw: string,
  options: PlainTextOptions = {},
): ParseResult {
  const text = stripLeadingBom(raw);
  if (text.trim().length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "文件里没有正文。" };
  }

  const paragraphs = splitPlainTextParagraphs(text);
  if (paragraphs.length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "文件里没有正文。" };
  }

  const collector = new BlockCollector();
  for (const paragraph of paragraphs) {
    if (asHeading(paragraph)) collector.add("heading", paragraph, { level: 2 });
    else collector.add("paragraph", paragraph);
  }

  const blocks = collector.toBlocks();
  if (blocks.length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "文件里没有可提取的正文。" };
  }

  return {
    ok: true,
    document: {
      title: options.title?.trim() || options.fallbackTitle?.trim() || "未命名文章",
      author: null,
      blocks,
      // The label names the pipeline, and this one is not Markdown: nothing
      // here interprets syntax, it only decides where the breaks are.
      source: "markdown-remark",
      extractorVersion: EXTRACTOR_VERSION,
      textHash: documentTextHash(blocks),
    },
  };
}

/**
 * Decode a text file's bytes and parse them.
 *
 * The encoding is returned rather than folded into `extractorVersion`: that
 * string identifies the *pipeline* (and is asserted against a frozen value
 * elsewhere), and making it vary per file would break that identity for no
 * gain. A caller that wants to tell the user the encoding was guessed reads it
 * from here.
 */
export function parsePlainTextBytes(
  bytes: Uint8Array,
  options: PlainTextOptions = {},
): ParseResult & { encoding: TextEncoding; guessed: boolean } {
  const decoded = decodeText(bytes);
  const result = parsePlainText(decoded.text, options);
  return { ...result, encoding: decoded.encoding, guessed: decoded.guessed };
}
