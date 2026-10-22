// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * File import: one entry point for every local format.
 *
 * ## The two thresholds, and why there have to be two
 *
 * The previous file import compared `file.size` against the *text* budget. For
 * a `.txt` those are the same number; for a PDF they are not remotely the same
 * — a 20 MB book exports a few hundred kilobytes of text, and a scanned page
 * exports none. Under one threshold every PDF was refused before it was
 * opened, which is why the limit is split here:
 *
 *   - `maxFileBytes` bounds the **container** — what has to be held in memory
 *     while it is read. It is generous, because the container is discarded.
 *   - `maxTextBytes` bounds the **extracted text** — what is actually stored,
 *     and what the reader's storage budget has to hold.
 *
 * ## Format choice
 *
 * By bytes first, by name second; see `./sniff.js`. The name only decides
 * between Markdown and plain text, which have no signature.
 *
 * ## The PDF parser is loaded on demand
 *
 * `pdfjs-dist` is an order of magnitude larger than everything else here
 * combined, and a session that only reads pasted text should not pay to parse
 * it. The offline shell precaches the chunk either way, so this costs nothing
 * offline — it only keeps the initial evaluation out of the common path.
 */

import type {
  ParsedDocument,
  ParseResult,
} from "../../../shared/contracts/index.js";
import { parseLocalMarkdown } from "../local-import-parse.js";
import { decodeText, type TextEncoding } from "./encoding.js";
import { parseDocx } from "./docx.js";
import { parseEpub } from "./epub.js";
import { parseHtmlDocument, type HtmlImportOptions } from "./html.js";
import { parsePlainTextBytes } from "./text.js";
import { sniffFormat, type ImportFormat } from "./sniff.js";

/**
 * Container ceiling. Sized for a book: a 700-page illustrated PDF is well
 * under this, and it is the point past which holding the whole file in memory
 * to read it stops being reasonable.
 */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Extracted-text ceiling, in UTF-8 bytes.
 *
 * Higher than the paste ceiling (2 MiB) because a book is not a pasted
 * article and refusing every full-length novel would make the format support
 * nominal. It is bounded because the text is what gets stored and re-read.
 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export type FileImportFailureCode =
  /** The container is past `maxFileBytes`. */
  | "TOO_LARGE"
  /** The extracted text is past `maxTextBytes`. */
  | "TEXT_TOO_LARGE"
  /** A recognised container this importer cannot read: a plain ZIP, a scan. */
  | "UNSUPPORTED_FORMAT"
  /** The bytes are not a format this importer knows at all. */
  | "UNKNOWN_FORMAT"
  /** The file is empty. */
  | "EMPTY_INPUT"
  /** The format was read, but held no retainable text. */
  | "EMPTY_CONTENT"
  /** The parser refused the content. */
  | "PARSE_ERROR";

export interface FileImportSuccess {
  ok: true;
  format: ImportFormat;
  document: ParsedDocument;
  /** Size of the container that was read. */
  fileBytes: number;
  /** Size of the extracted text, in UTF-8 bytes. */
  textBytes: number;
  /** Which encoding a text file was decoded as. Only set for `text`. */
  encoding?: TextEncoding;
  /** True when no BOM or valid-UTF-8 test settled the encoding. */
  guessedEncoding?: boolean;
}

export interface FileImportFailure {
  ok: false;
  code: FileImportFailureCode;
  message: string;
  fileBytes: number;
}

export type FileImportResult = FileImportSuccess | FileImportFailure;

export interface FileImportOptions {
  /** Overrides the derived title when provided. */
  title?: string;
  maxFileBytes?: number;
  maxTextBytes?: number;
}

/**
 * The name minus its known extension, for use as a title.
 *
 * Every extension this importer reads, so a `.xhtml` file does not end up
 * titled "chapter1.xhtml".
 */
const KNOWN_EXTENSION = /\.(md|markdown|mdown|txt|text|html?|xhtml|epub|docx|pdf)$/i;

export function titleFromFilename(filename: string): string {
  return filename.replace(KNOWN_EXTENSION, "").trim();
}

function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function textBytesOf(document: ParsedDocument): number {
  return document.blocks.reduce((sum, block) => sum + block.text.length, 0);
}

/** Turn an inner `ParseResult` failure into this module's failure vocabulary. */
function fromParseFailure(
  result: Extract<ParseResult, { ok: false }>,
  fileBytes: number,
): FileImportFailure {
  const code: FileImportFailureCode =
    result.code === "EMPTY_CONTENT" ? "EMPTY_CONTENT" : "PARSE_ERROR";
  return { ok: false, code, message: result.message, fileBytes };
}

/**
 * Import a file's bytes into the unified `ParsedDocument`.
 *
 * Async because ZIP-based formats have to be inflated and the PDF parser is
 * loaded on demand. Failures are values with a code, so a caller can tell
 * "too big" from "not a format I know" from "the file was empty" without
 * matching on a message.
 */
export async function importFromFileBytes(
  bytes: Uint8Array,
  filename: string,
  options: FileImportOptions = {},
): Promise<FileImportResult> {
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTextBytes = options.maxTextBytes ?? MAX_TEXT_BYTES;
  const fileBytes = bytes.length;

  if (fileBytes === 0) {
    return { ok: false, code: "EMPTY_INPUT", message: "文件是空的。", fileBytes };
  }
  if (fileBytes > maxFileBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `文件超过 ${megabytes(maxFileBytes)} MB 上限。`,
      fileBytes,
    };
  }

  const format = sniffFormat(bytes, filename);
  if (format === null) {
    return {
      ok: false,
      code: "UNKNOWN_FORMAT",
      message:
        "无法识别这个文件的格式。目前支持 PDF、EPUB、DOCX、HTML、Markdown 和纯文本。",
      fileBytes,
    };
  }

  const title = options.title?.trim();
  // The file name is a *fallback*, not an override. A book carries its own
  // title — in the OPF, in the document's first heading, in the PDF outline —
  // and that is authoritative; the name on disk is often a catalogue number
  // like `9787115428028.epub`. Only when the document offers nothing does the
  // name get used, and `title` (from an explicit caller) still wins over both.
  const fallbackTitle = titleFromFilename(filename) || undefined;
  const parserOptions: { title?: string; fallbackTitle?: string } = {};
  if (title) parserOptions.title = title;
  if (fallbackTitle) parserOptions.fallbackTitle = fallbackTitle;

  let result: ParseResult;
  let encoding: TextEncoding | undefined;
  let guessedEncoding: boolean | undefined;

  try {
    switch (format) {
      case "pdf": {
        const { parsePdf } = await import("./pdf.js");
        result = await parsePdf(bytes, parserOptions);
        break;
      }
      case "epub":
        result = await parseEpub(bytes, parserOptions);
        break;
      case "docx":
        result = await parseDocx(bytes, parserOptions);
        break;
      case "html": {
        // A whole web page saved to disk carries its navigation; a fragment
        // does not. `stripChrome` is set for both, because a saved page is the
        // overwhelmingly common case and Readability is what recovers prose
        // from one.
        const htmlOptions: HtmlImportOptions = {
          ...parserOptions,
          readability: true,
          stripChrome: true,
        };
        result = parseHtmlDocument(decodeText(bytes).text, htmlOptions);
        break;
      }
      case "markdown":
        result = parseLocalMarkdown(decodeText(bytes).text, parserOptions);
        break;
      case "text": {
        const decoded = parsePlainTextBytes(bytes, parserOptions);
        encoding = decoded.encoding;
        guessedEncoding = decoded.guessed;
        result = decoded;
        break;
      }
    }
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: `解析失败：${err instanceof Error ? err.message : String(err)}`,
      fileBytes,
    };
  }

  if (!result.ok) {
    // A book that opens but is a scan rather than text is the one failure the
    // user can act on, so it gets its own wording rather than "parse error".
    if (format === "pdf" && result.code === "EMPTY_CONTENT") {
      return {
        ok: false,
        code: "UNSUPPORTED_FORMAT",
        message:
          "这个 PDF 里没有可提取的文字（可能是扫描版或纯图片）。本机版暂不支持 OCR。",
        fileBytes,
      };
    }
    return fromParseFailure(result, fileBytes);
  }

  const document = result.document;
  const textBytes = textBytesOf(document);
  if (textBytes > maxTextBytes) {
    return {
      ok: false,
      code: "TEXT_TOO_LARGE",
      message: `正文超过 ${megabytes(maxTextBytes)} MB 上限，请改用较小的文件或分卷。`,
      fileBytes,
    };
  }

  const success: FileImportSuccess = {
    ok: true,
    format,
    document,
    fileBytes,
    textBytes,
  };
  if (encoding !== undefined) success.encoding = encoding;
  if (guessedEncoding !== undefined) success.guessedEncoding = guessedEncoding;
  return success;
}

/** Import a browser `File`. The only place the DOM type is needed. */
export async function importFromFile(
  file: File,
  options: FileImportOptions = {},
): Promise<FileImportResult> {
  // Checked before reading so a 4 GB file is refused without loading it. The
  // byte-level check in `importFromFileBytes` still runs — `file.size` is a
  // claim, and this is the cheap early exit, not the enforcement.
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  if (file.size > maxFileBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `文件超过 ${megabytes(maxFileBytes)} MB 上限。`,
      fileBytes: file.size,
    };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return importFromFileBytes(bytes, file.name, options);
}

export { sniffFormat } from "./sniff.js";
export type { ImportFormat } from "./sniff.js";
export { decodeText } from "./encoding.js";
export type { TextEncoding } from "./encoding.js";
