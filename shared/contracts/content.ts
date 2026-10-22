// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unified content-block contract.
 *
 * Phase 1 scope: this is the single vocabulary that every extractor must
 * produce. Static HTML (Mozilla Readability + DOM walk) and Markdown
 * (remark/mdast) both normalise into `ContentBlock[]`, so downstream code
 * never needs to know which extractor ran.
 *
 * Deliberate limits:
 *  - No browser rendering, no remote fetching (see phase 1 SSRF boundary).
 *  - `id` is stable *within one document version*, not globally. Versioning
 *    of a document is a phase 3 concern; `hash` is what phase 3 will use to
 *    re-anchor a note onto a new version.
 */

/** Semantic block kinds retained by both extractors. */
export type ContentBlockType =
  | "heading"
  | "paragraph"
  | "listItem"
  | "code"
  | "quote"
  | "image"
  | "table"
  | "hr";

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
   * 0-based nesting depth of a `listItem`. The flat block array keeps nested
   * items as their own siblings in reading order; this field is what lets the
   * renderer restore the indentation. Absent values (older documents) mean
   * depth 0.
   */
  depth?: number;
  /** Task-list item (`- [ ]` in Markdown, a checkbox `<input>` in HTML). */
  task?: boolean;
  /** Whether the task box is ticked. Only set when `task` is true. */
  checked?: boolean;
  /**
   * Table cells, row-major. Only set for `table`; the first row is the header.
   *
   * Plain cell text, already normalised. `text` still carries a flat join of
   * these cells because every block needs a non-empty `text` for `hash` and
   * for the whole-document identity, and a table is a block like any other.
   */
  rows?: string[][];
  /**
   * Image source. Only set for `image`; remote http(s) URLs today. The
   * renderer refuses non-http(s)/data schemes so a stored `javascript:` URL
   * can never become an executable link.
   */
  src?: string;
  /** Alternative text, also used as the block's stored text for hashing. */
  alt?: string;
  /** Optional image title (tooltip), carried through but not rendered as text. */
  title?: string;
  /**
   * Inline emphasis inside `text`, as offsets onto it. Absent means "no
   * emphasis", which is also what every block parsed before this field
   * existed means — a missing value must render as plain text, never as
   * an error.
   */
  spans?: InlineSpan[];
}

/**
 * The flat `text` a table block carries.
 *
 * A table has no prose of its own, but `text` is not optional: `hash` is
 * computed over it and `documentTextHash` is computed over every block's
 * `hash`, so a block with no text would break whole-document identity. This
 * join is the table's readable projection, and both extractors use it so the
 * same table hashes to the same value no matter which one parsed it. The
 * cells live in `rows`; the renderer never shows this string.
 */
export function tableBlockText(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.join(" | ")).join("\n");
}

/**
 * Which pipeline produced a document.
 *
 * The naming is `<format>-<technique>`, and it describes the *pipeline*, not
 * the process that ran it: a `.md` file parsed in the browser is still
 * `"markdown-remark"`, because that is what the document is. That is why the
 * local file importers get their own ids rather than reusing an existing one —
 * an EPUB chapter walked as DOM is not something Readability produced, and
 * labelling it `"html-readability"` would make the stored provenance a
 * fabrication.
 *
 * Additive only. Nothing switches exhaustively on this union, and the ids
 * below are unreachable from the server: they are produced by
 * `src/lib/import/**`, which has no network path.
 */
export type ExtractorId =
  | "html-readability"
  | "markdown-remark"
  /** A `.html` file walked as DOM without Readability's article extraction. */
  | "html-dom"
  /** An EPUB spine item (XHTML) walked as DOM. */
  | "epub-dom"
  /** A DOCX `word/document.xml` body walked as XML. */
  | "docx-xml"
  /** Text extracted from a PDF's text layer. */
  | "pdf-text";

export interface ParsedDocument {
  title: string;
  author?: string | null;
  blocks: ContentBlock[];
  /**
   * The page's own cover image (`og:image` / `twitter:image`), absolute or
   * root-relative, when the extractor saw one. Absent for pasted text, PDFs
   * and pages that declare no share image — the reader then falls back to the
   * first image in the body, and finally to the default cover library.
   */
  coverImage?: string;
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
 * article must be rejected before it can be stored (audit finding P1#3).
 */
export function isUsableDocument(doc: ParsedDocument): boolean {
  return doc.blocks.some((b) => b.text.trim().length > 0);
}
