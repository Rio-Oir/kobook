// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `.html` file import, in the browser.
 *
 * The counterpart of `server/src/lib/parse/html.ts` for a file the user chose
 * rather than a page we fetched. Two differences from that pipeline, both
 * deliberate:
 *
 *  - **The DOM comes from `DOMParser`, not jsdom.** jsdom is a server
 *    dependency and has no business in a browser bundle; the walker itself
 *    (`./html-walk.js`) is DOM-implementation-agnostic, which is what makes
 *    the swap a one-line change rather than a second implementation.
 *  - **Readability is opt-in, not automatic.** A saved article benefits from
 *    it; an EPUB chapter or a hand-written document does not, and running it
 *    there would silently renumber headings and drop structure. The `.html`
 *    file path turns it on, the book paths do not.
 *  - **A known site is read from its own container first.** `site-container.ts`
 *    probes the shared rule table (`shared/site-rules.ts`) before Readability
 *    runs, so a saved WeChat / Zhihu / news page yields its article without the
 *    site's furniture. No match, or a match with an empty shell, falls through
 *    to Readability exactly as before.
 *
 * Readability's own parameters match the server's, including the two that are
 * load-bearing: `charThreshold: 0`, because the default ~500-character floor
 * makes it decline exactly the short Chinese articles this must support, and
 * `keepClasses: true`, which is what preserves `class="language-xxx"` on code
 * blocks.
 */

import { Readability } from "@mozilla/readability";
import type {
  ParsedDocument,
  ParseResult,
} from "../../../shared/contracts/index.js";
import {
  BlockCollector,
  EXTRACTOR_VERSION,
  documentTextHash,
  normalizeProse,
} from "../local-import-blocks.js";
import { stripLeadingBom } from "./encoding.js";
import { shareImageFromDocument } from "./image-url.js";
import { probeSiteContainer } from "./site-container.js";
import { titleFromDom, walkDomInto, type RawNode } from "./html-walk.js";

export interface HtmlImportOptions {
  /** Explicit title, from a caller that knows better than the document does. */
  title?: string;
  /** Title to use when the document offers none of its own. */
  fallbackTitle?: string;
  /**
   * Run Readability to isolate the article body.
   *
   * On for a saved web page, where the surrounding navigation is noise. Off
   * for anything that is already a document — an EPUB chapter's `<header>` may
   * be its title, and Readability would also renumber its headings.
   */
  readability?: boolean;
  /**
   * Drop `<nav>` / `<aside>` / `<footer>` while walking. Independent of
   * Readability: it still applies on the fallback path when Readability
   * declines the document.
   */
  stripChrome?: boolean;
  /**
   * Document origin, when the caller knows it (a fetched page rather than a
   * file on disk). Relative `<img src>` values are resolved against it; with
   * no origin only root-relative paths survive.
   */
  baseUrl?: string | null;
}

/** The subset of a parsed document this module needs. */
interface ParsedDom {
  body: RawNode | null;
  title: string;
  /**
   * The parsed document itself, kept because the page's share image
   * (`og:image` / `twitter:image`) lives in `<head>`, which the body walk
   * never sees.
   */
  document: Document;
}

function parseDom(html: string): ParsedDom {
  if (typeof DOMParser !== "function") {
    throw new Error("当前环境不支持 HTML 解析。");
  }
  // `text/html` even for XHTML. The HTML parser is lenient, and book chapters
  // in the wild are full of the things strict XML parsing rejects — unescaped
  // ampersands, unclosed `<br>`, stray entities. Refusing those would fail
  // imports that every other reader opens without complaint.
  const doc = new DOMParser().parseFromString(html, "text/html");
  return {
    body: (doc.body as unknown as RawNode | null) ?? null,
    title: doc.title ?? "",
    document: doc,
  };
}

/** The subset of Readability's result this module reads. */
interface ReadabilityResult {
  content?: string | null;
  title?: string | null;
  byline?: string | null;
}

/**
 * Readability's extraction, or `null` when it declines.
 *
 * Readability mutates the document it is handed, so it is given a document
 * parsed from the same string rather than the one the caller will fall back
 * to. On success its `content` is an HTML fragment, which is re-parsed so the
 * walker sees a normal tree.
 */
function readabilityRoot(
  html: string,
): { root: RawNode; title: string; byline: string | null } | null {
  let parsed: ReadabilityResult | null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    parsed = new Readability(doc, { charThreshold: 0, keepClasses: true }).parse();
  } catch {
    // Readability throws on documents it cannot handle. That is a reason to
    // fall back, not a reason to fail the import.
    return null;
  }
  if (!parsed?.content) return null;

  const content = parseDom(parsed.content);
  if (!content.body) return null;
  return {
    root: content.body,
    title: normalizeProse(parsed.title ?? ""),
    byline: parsed.byline ? normalizeProse(parsed.byline) : null,
  };
}

/**
 * Parse an HTML document into the unified `ParsedDocument`.
 *
 * Failure is a value, not an exception, and an article that yields no text is
 * rejected here so it can never be persisted as an empty article — the same
 * rule the Markdown importer follows.
 */
export function parseHtmlDocument(
  html: string,
  options: HtmlImportOptions = {},
): ParseResult {
  const source = stripLeadingBom(html);
  if (source.trim().length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "HTML 文件是空的。" };
  }

  let dom: ParsedDom;
  try {
    dom = parseDom(source);
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: `HTML 解析失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let root: RawNode | null = null;
  let derivedTitle = "";
  let byline: string | null = null;
  let usedReadability = false;

  if (options.readability ?? false) {
    // A saved page from a site the rule table knows is read from its own
    // article container first. Readability's failure mode on those pages is
    // "keeps the site chrome" — a WeChat page ends with its QR block and the
    // app's own words ("视频", "小程序", "赞", "在看"), which Readability treats
    // as prose. The container removes that whole class of error for one
    // selector, and anything without a match (or with an empty one) falls
    // through unchanged.
    const hit = probeSiteContainer(dom.document);
    if (hit) {
      root = hit.root;
      derivedTitle = hit.title;
    } else {
      const extracted = readabilityRoot(source);
      if (extracted) {
        root = extracted.root;
        derivedTitle = extracted.title;
        byline = extracted.byline;
        usedReadability = true;
      }
    }
  }

  if (root === null) {
    // Readability declines very short or unusual documents, and is switched
    // off for book chapters. Walking the body keeps the contract identical
    // instead of failing the import.
    root = dom.body;
  }
  if (root === null) {
    return { ok: false, code: "PARSE_ERROR", message: "HTML 里找不到 <body>。" };
  }

  const collector = new BlockCollector();
  walkDomInto(root, collector, {
    stripChrome: options.stripChrome ?? false,
    baseUrl: options.baseUrl ?? null,
  });
  const blocks = collector.toBlocks();

  if (blocks.length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "HTML 里没有可提取的正文。" };
  }

  // Share image, resolved against the page's own origin. `undefined` when the
  // page declares none, or declares one we cannot turn into a loadable
  // address — the caller then falls back to the body's first image.
  const shareImage = shareImageFromDocument(dom.document, options.baseUrl ?? null);

  const document: ParsedDocument = {
    title:
      options.title?.trim() ||
      derivedTitle ||
      titleFromDom(root) ||
      normalizeProse(dom.title) ||
      options.fallbackTitle?.trim() ||
      "未命名文章",
    author: byline,
    blocks,
    // The page's own share image, when it declares one. This is what lets a
    // card show the real picture instead of the generated wash; the body's
    // first image is the fallback, and that is resolved later (`articles.ts`).
    ...(shareImage ? { coverImage: shareImage } : {}),
    // The label describes the pipeline that actually ran, so a file Readability
    // declined is `html-dom`, not `html-readability`.
    source: usedReadability ? "html-readability" : "html-dom",
    extractorVersion: EXTRACTOR_VERSION,
    textHash: documentTextHash(blocks),
  };
  return { ok: true, document };
}
