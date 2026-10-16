// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unified content-block contract.
 *
 * This is the single vocabulary every extractor must produce. Static HTML
 * (Mozilla Readability + DOM walk) and Markdown (remark/mdast) both normalise
 * into `ContentBlock[]`, so downstream code never needs to know which
 * extractor ran.
 *
 * Deliberate limits:
 *  - No browser rendering and no remote fetching happen here; this module
 *    describes a document the caller already holds.
 *  - `id` is stable *within one document version*, not globally. Versioning
 *    of a document belongs to whatever stores it; `hash` is what a later
 *    version uses to re-anchor a note onto a new version.
 */

/** Semantic block kinds retained by both extractors. */
export type ContentBlockType =
  | "heading"
  | "paragraph"
  | "listItem"
  | "code"
  | "quote";

/** Inline emphasis a block's text can carry. */
export type InlineMarkKind = "strong" | "em" | "code" | "del" | "link";

/**
 * Canonical order for `InlineSpan.kinds`.
 *
 * Declared here rather than in either extractor so both sides of the wire
 * agree by construction: the two parsers sort by it, so the same run of text
 * produces equal arrays, and the reader nests by it, so `**_x_**` always
 * renders `<strong><em>` and never the reverse. An order that lived in one
 * extractor would be a silent asymmetry the moment the other was edited.
 */
export const INLINE_MARK_ORDER: readonly InlineMarkKind[] = [
  "strong",
  "em",
  "code",
  "del",
  "link",
];

/**
 * One run of characters inside a block that is rendered with emphasis.
 *
 * Spans are *offsets onto the block's own `text`*, not a parallel copy of
 * it. That is the whole design: `text` stays the single source of truth
 * for what the characters are, and a span only records how part of them
 * is drawn. The consequences are deliberate:
 *
 *  - `hash` is over `text` alone, so adding emphasis to a paragraph does
 *    not invalidate a note anchored on it. A reader who bolded a word
 *    must not lose everyone else's annotations.
 *  - the server's selection check (`lib/selection.ts`) slices `text`, so
 *    inline emphasis cannot make a stored note unverifiable.
 *  - the client measures selections with `Range.toString()` over the
 *    block element, and inline elements (`<strong>`, `<em>`, `<a>`, …)
 *    contribute only their text — so a block still renders exactly
 *    `text.length` characters (see `src/lib/text-offset.ts`).
 *
 * The alternative — storing `text` as a run tree and deriving the string
 * by joining it — would have made emphasis a change to *what the text
 * is*, and every offset in the system would have had to be re-argued.
 */
export interface InlineSpan {
  /** 0-based, half-open, UTF-16 offsets into the block's `text`. */
  start: number;
  end: number;
  /**
   * Which emphases apply. A non-empty subset of `InlineMarkKind`, listed
   * in that union's declaration order so two extractors describing the
   * same run produce byte-identical output. `**_x_**` is one span with
   * `["strong", "em"]`, not two overlapping spans — a flat list of
   * non-overlapping runs has exactly one representation per document,
   * which is what makes the cross-extractor assertion meaningful.
   */
  kinds: InlineMarkKind[];
  /** Link target. Present iff `kinds` includes `"link"`. */
  href?: string;
}

export interface ContentBlock {
  /**
   * Stable identifier within one parsed document.
   * Format: `b<index>-<hash8>`. Two blocks with identical text still get
   * different ids because the index prefix differs — duplicate paragraphs
   * must remain distinguishable. The hash8 suffix is what lets a later
   * version match "same text, new position".
   */
  id: string;
  /** 1-based reading order. */
  index: number;
  type: ContentBlockType;
  /** Normalised plain text. Never empty for a retained block. */
  text: string;
  /** sha256(text).slice(0, 16) — hex. */
  hash: string;
  /** Heading level 1..6. Only set for `heading`. */
  level?: number;
  /** Fenced-code language, if declared. Only set for `code`. */
  lang?: string | null;
  /** Ordered vs bullet list. Only set for `listItem`. */
  ordered?: boolean;
  /**
   * Inline emphasis inside `text`, as offsets onto it. Absent means "no
   * emphasis", which is also what every block parsed before this field
   * existed means — a missing value must render as plain text, never as
   * an error.
   */
  spans?: InlineSpan[];
}

export type ExtractorId = "html-readability" | "markdown-remark";

export interface ParsedDocument {
  title: string;
  author?: string | null;
  blocks: ContentBlock[];
  /** Which extractor produced this document. */
  source: ExtractorId;
  /** Version of the extractor pipeline, so stored documents stay traceable. */
  extractorVersion: string;
  /** sha256 over the joined block hashes — cheap whole-document identity. */
  textHash: string;
}

export type ParseFailureCode =
  | "EMPTY_CONTENT"
  | "UNSUPPORTED_INPUT"
  | "PARSE_ERROR";

export interface ParseSuccess {
  ok: true;
  document: ParsedDocument;
}

export interface ParseFailure {
  ok: false;
  code: ParseFailureCode;
  message: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Extractors must never silently return a zero-block document: an empty
 * article must be rejected before it can be stored.
 */
export function isUsableDocument(doc: ParsedDocument): boolean {
  return doc.blocks.some((b) => b.text.trim().length > 0);
}
