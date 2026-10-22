// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * EPUB import.
 *
 * An EPUB is a ZIP holding an XHTML book, so this module is mostly
 * bookkeeping: find the OPF, read the spine, and hand each chapter to the DOM
 * walker that `.html` import already uses. No new parsing concepts, and no new
 * dependency — the ZIP reader is `./zip.js` and the walker is `./html-walk.js`.
 *
 * ## The three files that define the structure
 *
 * 1. `META-INF/container.xml` — the only path fixed by the spec. It names the
 *    OPF, which may be anywhere in the archive (`OEBPS/content.opf`,
 *    `content.opf`, `EPUB/package.opf`, …), so it is never guessed.
 * 2. The OPF — `<metadata>` for title and author, `<manifest>` for id → href,
 *    `<spine>` for reading order. Spine order is the book; manifest order is
 *    not, and neither is filename order.
 * 3. The spine items themselves — XHTML chapters, walked in order.
 *
 * ## What is deliberately not done
 *
 * - **No cover, images or CSS.** The reader renders text blocks; a cover image
 *   has nowhere to go in the block contract, and remote images are never
 *   fetched. `SKIP_TAGS` drops `<img>` the same way the HTML path does.
 * - **No synthetic chapter headings.** A chapter that opens with `<h1>` yields
 *   a heading block and therefore appears in the outline for free. One that
 *   does not is left alone — inventing a heading would put text into the
 *   document that the source does not have, and every offset is measured
 *   against that text.
 * - **No NCX or EPUB3 nav parsing.** Both are tables of contents, and the
 *   table of contents is already derived from the headings in the spine
 *   (`outlineOf` in `src/lib/blocks.ts`). Reading them would add a second,
 *   disagreeing source of truth for the same thing.
 */

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
import { decodeText } from "./encoding.js";
import { walkDomInto, type RawNode } from "./html-walk.js";
import {
  ZipError,
  findZipEntry,
  listZipEntries,
  readZipEntry,
  type ZipEntry,
} from "./zip.js";

/**
 * Bounds on a book, so a malformed or hostile archive is refused rather than
 * walked until the tab dies. Both are far above any real book: a long novel is
 * a few hundred spine items, and a 700-page book is well under a million
 * characters.
 */
export const MAX_SPINE_ITEMS = 2048;
export const MAX_EPUB_CHARS = 8 * 1024 * 1024;

export interface EpubImportOptions {
  /** Explicit title, from a caller that knows better than the OPF does. */
  title?: string;
  /**
   * Title to use when the OPF has none.
   *
   * A fallback rather than an override: a book's `dc:title` is what the book
   * is called, and the name on disk is frequently a catalogue number.
   */
  fallbackTitle?: string;
}

/**
 * Resolve an OPF-relative href against the directory the OPF lives in.
 *
 * `href` is a URI, so it is percent-decoded before being matched against ZIP
 * entry names, which are stored as literal paths. `..` segments are resolved
 * rather than rejected: real books do reach out of their own directory
 * (`../Text/chapter1.xhtml` is common), and the ZIP entry name is the
 * normalized form.
 */
export function resolveEpubPath(baseDir: string, href: string): string {
  const withoutFragment = href.split("#")[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // A stray `%` that is not a valid escape. Use the raw text rather than
    // failing: the entry name may genuinely contain a percent sign.
    decoded = withoutFragment;
  }
  if (decoded.length === 0) return "";

  const segments = baseDir.length > 0 ? baseDir.split("/") : [];
  const out: string[] = [];
  for (const segment of [...segments, ...decoded.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/** Directory portion of a path, or `""` for a path at the archive root. */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/**
 * Parse XML, or return `null` when the input is not well-formed.
 *
 * Browsers do not throw on malformed XML — they return a document whose root
 * is `<parsererror>`. Both that and jsdom's behaviour are checked, because the
 * OPF is the one file whose absence of structure cannot be recovered from.
 */
function parseXml(text: string): Document | null {
  if (typeof DOMParser !== "function") return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, "application/xml");
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root) return null;
  if (root.nodeName === "parsererror" || root.getElementsByTagName("parsererror").length > 0) {
    return null;
  }
  return doc;
}

/** All elements with a local name, ignoring any namespace prefix. */
function elementsByLocalName(root: Document | Element, localName: string): Element[] {
  const all = root.getElementsByTagName("*");
  const out: Element[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i]!;
    const name = el.localName ?? el.nodeName;
    if (name === localName) out.push(el);
  }
  return out;
}

function firstByLocalName(root: Document | Element, localName: string): Element | null {
  return elementsByLocalName(root, localName)[0] ?? null;
}

interface EpubMetadata {
  title: string;
  author: string | null;
  /** Archive path of the OPF, for resolving relative hrefs. */
  opfPath: string;
}

/**
 * Import an EPUB into the unified `ParsedDocument`.
 *
 * Async because the archive has to be inflated; every failure is a value
 * rather than an exception, so a caller cannot accidentally treat "not an
 * EPUB" as "empty book".
 */
export async function parseEpub(
  bytes: Uint8Array,
  options: EpubImportOptions = {},
): Promise<ParseResult> {
  let entries: ZipEntry[];
  try {
    entries = listZipEntries(bytes);
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: err instanceof ZipError ? err.message : "无法读取 EPUB 压缩包。",
    };
  }

  const containerEntry = findZipEntry(entries, "META-INF/container.xml");
  if (!containerEntry) {
    return { ok: false, code: "PARSE_ERROR", message: "不是有效的 EPUB：缺少 META-INF/container.xml。" };
  }

  let opfPath = "";
  try {
    const containerText = decodeText(await readZipEntry(bytes, containerEntry)).text;
    const containerDoc = parseXml(containerText);
    if (!containerDoc) {
      return { ok: false, code: "PARSE_ERROR", message: "EPUB 的 container.xml 无法解析。" };
    }
    const rootfile = firstByLocalName(containerDoc, "rootfile");
    opfPath = rootfile?.getAttribute("full-path")?.trim() ?? "";
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: err instanceof ZipError ? err.message : "EPUB 的 container.xml 读取失败。",
    };
  }
  if (opfPath.length === 0) {
    return { ok: false, code: "PARSE_ERROR", message: "EPUB 的 container.xml 没有指明内容文件。" };
  }

  const opfEntry = findZipEntry(entries, opfPath);
  if (!opfEntry) {
    return { ok: false, code: "PARSE_ERROR", message: `EPUB 内容文件 ${opfPath} 不在压缩包里。` };
  }

  let opfDoc: Document | null;
  try {
    opfDoc = parseXml(decodeText(await readZipEntry(bytes, opfEntry)).text);
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: err instanceof ZipError ? err.message : "EPUB 内容文件读取失败。",
    };
  }
  if (!opfDoc) {
    return { ok: false, code: "PARSE_ERROR", message: "EPUB 内容文件无法解析。" };
  }

  const metadata = readMetadata(opfDoc, opfPath);
  const baseDir = directoryOf(opfPath);

  // Manifest: id -> href, so the spine can name items by id.
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const item of elementsByLocalName(opfDoc, "item")) {
    const id = item.getAttribute("id")?.trim() ?? "";
    const href = item.getAttribute("href")?.trim() ?? "";
    if (id.length === 0 || href.length === 0) continue;
    manifest.set(id, { href, mediaType: item.getAttribute("media-type")?.trim() ?? "" });
  }

  const spine = elementsByLocalName(opfDoc, "itemref")
    .map((ref) => ref.getAttribute("idref")?.trim() ?? "")
    .filter((idref) => idref.length > 0);

  if (spine.length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "EPUB 的阅读顺序为空。" };
  }
  if (spine.length > MAX_SPINE_ITEMS) {
    return { ok: false, code: "PARSE_ERROR", message: `EPUB 章节过多（${spine.length} 节）。` };
  }

  const collector = new BlockCollector();
  let chaptersRead = 0;
  let chars = 0;
  let skipped = 0;

  for (const idref of spine) {
    const item = manifest.get(idref);
    if (!item) {
      skipped += 1;
      continue;
    }
    // Only markup is prose. A spine that points at an image or a font is
    // malformed, and inflating it to feed the walker would be wasted work.
    if (item.mediaType.length > 0 && !/xhtml|html|xml/i.test(item.mediaType)) {
      skipped += 1;
      continue;
    }
    const path = resolveEpubPath(baseDir, item.href);
    const entry = findZipEntry(entries, path);
    if (!entry) {
      skipped += 1;
      continue;
    }

    let html: string;
    try {
      html = decodeText(await readZipEntry(bytes, entry)).text;
    } catch {
      skipped += 1;
      continue;
    }

    if (typeof DOMParser !== "function") {
      return { ok: false, code: "PARSE_ERROR", message: "当前环境不支持 HTML 解析。" };
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = (doc.body as unknown as RawNode | null) ?? null;
    if (!body) {
      skipped += 1;
      continue;
    }

    const before = collector.length;
    // Book chapters keep their chrome: a chapter's `<header>` may be its
    // title, and `<nav>` inside a chapter is a per-chapter table of contents
    // the reader can legitimately show.
    walkDomInto(body, collector, { stripChrome: false });
    if (collector.length > before) chaptersRead += 1;

    chars = collector.toBlocks().reduce((sum, block) => sum + block.text.length, 0);
    if (chars > MAX_EPUB_CHARS) {
      return {
        ok: false,
        code: "PARSE_ERROR",
        message: `EPUB 正文超过 ${Math.round(MAX_EPUB_CHARS / 1024 / 1024)} MB 上限。`,
      };
    }
  }

  if (chaptersRead === 0) {
    return {
      ok: false,
      code: "EMPTY_CONTENT",
      message:
        skipped > 0
          ? "EPUB 里的章节都读不出来（可能缺少正文文件）。"
          : "EPUB 里没有可提取的正文。",
    };
  }

  const blocks = collector.toBlocks();
  const document: ParsedDocument = {
    title:
      options.title?.trim() || metadata.title || options.fallbackTitle?.trim() || "未命名书籍",
    author: metadata.author,
    blocks,
    source: "epub-dom",
    extractorVersion: EXTRACTOR_VERSION,
    textHash: documentTextHash(blocks),
  };
  return { ok: true, document };
}

function readMetadata(opfDoc: Document, opfPath: string): Omit<EpubMetadata, "opfPath"> {
  const titleEl = firstByLocalName(opfDoc, "title");
  const creatorEl = firstByLocalName(opfDoc, "creator");
  return {
    title: normalizeProse(titleEl?.textContent ?? ""),
    author: creatorEl ? normalizeProse(creatorEl.textContent ?? "") || null : null,
  };
}
