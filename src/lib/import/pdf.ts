// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PDF import: the pdf.js integration.
 *
 * The reconstruction logic lives in `./pdf-layout.js` and is tested without a
 * PDF; this file is only the plumbing around pdf.js — configure it, walk the
 * pages, map its items onto the shape the reconstruction expects.
 *
 * ## The configuration choices, and why
 *
 * - **`cMapUrl` and `cMapPacked: true`.** Non-negotiable for Chinese. A CJK PDF
 *   usually identifies glyphs by CID with a predefined encoding, and pdf.js
 *   needs the matching CMap table to turn those into characters. Without it the
 *   text comes out as garbage — not an error, just wrong, which is the worst
 *   outcome. The tables are served from the application's own origin (see
 *   `scripts/pdfjs-assets.mjs`), so this makes no network request off-origin.
 * - **`standardFontDataUrl`.** Same reasoning for the fourteen standard fonts
 *   that PDFs are allowed to use without embedding.
 * - **`verbosity: 0`.** pdf.js logs a warning per malformed font, and real
 *   books have plenty. The console is not the place to report them.
 *
 * There is no `isEvalSupported` to turn off: pdf.js 6 removed the `new Function`
 * path entirely, so the `script-src 'self'` policy with no `'unsafe-eval'` is
 * satisfied by construction rather than by configuration.
 *
 * ## Why the worker is a static path and not a bundler import
 *
 * pdf.js parses off the main thread, so it needs a Worker, and the policy is
 * `worker-src 'self'` — which permits a same-origin worker file and forbids a
 * `blob:` one. The usual idiom for getting that URL is
 * `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`, and it was
 * tried: a production build pulled the worker into the pdf.js chunk as a module
 * instead of emitting it as an asset, leaving `workerSrc` pointing at a file
 * that was never written. Nothing in the build output said so, and the failure
 * would have surfaced only when a user opened their first PDF.
 *
 * So the worker is staged by `scripts/pdfjs-assets.mjs` alongside the CMap
 * tables and referenced by path. No bundler behaviour to depend on, and the
 * file travels in the same precache list as everything else in `dist/`.
 */

import * as pdfjs from "pdfjs-dist";
import type { ParseResult } from "../../../shared/contracts/index.js";
import {
  BlockCollector,
  EXTRACTOR_VERSION,
  documentTextHash,
  normalizeProse,
} from "../local-import-blocks.js";
import {
  looksLikeHeading,
  medianItemHeight,
  paragraphObjectsFromItems,
  type PdfTextItem,
} from "./pdf-layout.js";

/**
 * Where the staged pdf.js assets are served from.
 *
 * Resolved against the document base rather than a hard-coded `/`, so the
 * application works under a path prefix — the release build serves from
 * `/reader/`, where an absolute `/pdfjs/…` would 404.
 */
export function pdfAssetUrl(subpath: string): string {
  const base =
    typeof document !== "undefined" && document.baseURI
      ? document.baseURI
      : "http://localhost/";
  return new URL(`pdfjs/${subpath}`, base).toString();
}

// Set once at module scope: the worker script is part of this application, and
// pdf.js reads this global when it first needs to spawn it.
pdfjs.GlobalWorkerOptions.workerSrc = pdfAssetUrl("pdf.worker.min.mjs");

/**
 * Page ceiling. Text extraction is roughly linear in pages, and a 700-page
 * book is well inside this; past it the import would block a tab for minutes,
 * which is worse than refusing.
 */
export const MAX_PDF_PAGES = 2000;

export interface PdfImportOptions {
  /** Explicit title, from a caller that knows better than the document does. */
  title?: string;
  /** Title to use when the PDF has no heading to derive one from. */
  fallbackTitle?: string;
  /**
   * Base URL for the CMap tables, ending in a slash.
   *
   * Defaults to `pdfjs/cmaps/` beside the application. Only tests and packaged
   * builds should need to move it.
   */
  cMapUrl?: string;
  standardFontDataUrl?: string;
  maxPages?: number;
  /** Called with `(done, total)` as pages are read, for a progress indicator. */
  onProgress?: (done: number, total: number) => void;
}

/** pdf.js's own item shape, narrowed to what is read here. */
interface PdfJsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isTextItem(item: unknown): item is PdfJsTextItem {
  return typeof item === "object" && item !== null && typeof (item as { str?: unknown }).str === "string";
}

/**
 * Map a pdf.js text item onto the reconstruction's shape.
 *
 * The height comes from the item when pdf.js reports one, and otherwise from
 * the transform's vertical scale — a font height of zero would make the line
 * tolerances collapse and put every run on its own line.
 */
function toLayoutItem(item: PdfJsTextItem): PdfTextItem {
  const transform = item.transform;
  const scale = transform.length >= 4 ? Math.abs(transform[3] ?? 0) : 0;
  return {
    str: item.str,
    x: transform[4] ?? 0,
    y: transform[5] ?? 0,
    width: item.width ?? 0,
    height: item.height && item.height > 0 ? item.height : scale,
  };
}

/**
 * Extract a PDF's text layer into the unified `ParsedDocument`.
 *
 * Fails as a value. The case worth naming is a PDF with no text layer at all —
 * a scan — which is `EMPTY_CONTENT` here and is turned into a specific message
 * by the dispatcher, because "this is a scan" is something the user can act on
 * and "parse error" is not.
 */
export async function parsePdf(
  bytes: Uint8Array,
  options: PdfImportOptions = {},
): Promise<ParseResult> {
  const cMapUrl = options.cMapUrl ?? pdfAssetUrl("cmaps/");
  const standardFontDataUrl = options.standardFontDataUrl ?? pdfAssetUrl("standard_fonts/");
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;

  let task: pdfjs.PDFDocumentLoadingTask | null = null;
  let doc: pdfjs.PDFDocumentProxy | null = null;
  try {
    // A copy is passed because pdf.js transfers the buffer to its worker,
    // which would leave the caller's array detached.
    task = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      verbosity: 0,
    });
    doc = await task.promise;

    const total = doc.numPages;
    if (total > maxPages) {
      return {
        ok: false,
        code: "PARSE_ERROR",
        message: `PDF 页数过多（${total} 页，上限 ${maxPages} 页）。`,
      };
    }

    const collector = new BlockCollector();
    let sawText = false;

    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      page.cleanup();

      const items: PdfTextItem[] = [];
      for (const raw of content.items) {
        if (!isTextItem(raw)) continue;
        if (raw.str.length === 0) continue;
        items.push(toLayoutItem(raw));
      }
      options.onProgress?.(pageNumber, total);
      if (items.length === 0) continue;

      const medianHeight = medianItemHeight(items);
      for (const paragraph of paragraphObjectsFromItems(items)) {
        const text = normalizeProse(paragraph.text);
        if (text.length === 0) continue;
        sawText = true;
        if (looksLikeHeading(text, paragraph.height, medianHeight)) {
          // Level 2, not 1: the document title is the book's, and a level-1
          // heading inside the body would compete with it in the outline.
          collector.add("heading", text, { level: 2 });
        } else {
          collector.add("paragraph", text);
        }
      }
    }

    const blocks = collector.toBlocks();
    if (!sawText || blocks.length === 0) {
      // The scan case. Distinct from a parse failure, and the dispatcher
      // rewrites it into a message about OCR.
      return {
        ok: false,
        code: "EMPTY_CONTENT",
        message: "这个 PDF 没有文本层。",
      };
    }

    return {
      ok: true,
      document: {
        title:
          options.title?.trim() ||
          firstHeading(blocks) ||
          options.fallbackTitle?.trim() ||
          "未命名文档",
        author: null,
        blocks,
        source: "pdf-text",
        extractorVersion: EXTRACTOR_VERSION,
        textHash: documentTextHash(blocks),
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: `PDF 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // `destroy` lives on the loading task, not the document — it is what tears
    // down the worker and the page cache. Without it a session that opens
    // several PDFs accumulates one worker per file.
    if (task) {
      try {
        await task.destroy();
      } catch {
        // Destroying an already-failed document is not worth reporting.
      }
    }
  }
}

function firstHeading(blocks: readonly { type: string; text: string }[]): string {
  for (const block of blocks) {
    if (block.type === "heading" && block.text.trim().length > 0) return block.text;
  }
  return "";
}
