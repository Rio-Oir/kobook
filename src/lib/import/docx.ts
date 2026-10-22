// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * DOCX import.
 *
 * A DOCX is a ZIP whose `word/document.xml` holds the body as WordprocessingML.
 * The ZIP half is `./zip.js`; this file is the XML half, and it is the same
 * shape as the HTML walker — build a text string and the marks over it in one
 * pass, then hand both to `BlockCollector`.
 *
 * ## The one place this differs from the HTML path
 *
 * The HTML walker measures marks against `textContent` and *drops them when the
 * two disagree*, because `textContent` is produced by the DOM and the marks by
 * its own traversal — two independent sources that can drift. Here there is no
 * second source: this file produces the text and the marks together, so they
 * agree by construction and there is nothing to check.
 *
 * ## What is deliberately not done
 *
 * - **No `numbering.xml`.** Whether a list is ordered lives in a separate part
 *   (`word/numbering.xml`), referenced by abstract numbering ids that
 *   themselves inherit from other ids. Resolving it is a real feature, and
 *   guessing from it would be worse than the honest answer: a numbered
 *   paragraph is emitted as a list item with `ordered: false`, so the structure
 *   survives even when the marker does not.
 * - **No images, no styles, no headers or footers.** The block contract has no
 *   place for them, and the body is what a reader reads.
 * - **No tracked-change resolution.** Insertions and deletions are read as they
 *   are; a document under active revision is not a case worth guessing at.
 */

import type {
  ContentBlockType,
  ParseResult,
  ParsedDocument,
} from "../../../shared/contracts/index.js";
import {
  BlockCollector,
  EXTRACTOR_VERSION,
  documentTextHash,
  normalizeProse,
} from "../local-import-blocks.js";
import { InlineTextBuilder } from "../local-import-inline.js";
import { decodeText } from "./encoding.js";
import { ZipError, findZipEntry, listZipEntries, readZipEntry } from "./zip.js";

/** Bound on how much of a document is walked, mirroring the EPUB ceiling. */
export const MAX_DOCX_CHARS = 8 * 1024 * 1024;

export interface DocxImportOptions {
  /** Explicit title, from a caller that knows better than the document does. */
  title?: string;
  /** Title to use when the document has no heading to derive one from. */
  fallbackTitle?: string;
}

/**
 * WordprocessingML local names this walk looks at.
 *
 * Matched by *local name* rather than qualified name, because the namespace
 * prefix is `w` by convention and not by rule — a file written by a different
 * producer may bind it to anything, or use a default namespace with no prefix
 * at all. Matching on `w:p` would silently find nothing in those files.
 */
const W = {
  body: "body",
  paragraph: "p",
  run: "r",
  text: "t",
  tab: "tab",
  break: "br",
  carriageReturn: "cr",
  paragraphStyle: "pStyle",
  outlineLevel: "outlineLvl",
  numberingProperties: "numPr",
  bold: "b",
  italic: "i",
  strike: "strike",
  table: "tbl",
  tableRow: "tr",
  tableCell: "tc",
  value: "val",
} as const;

/** Direct children with a given local name. */
function childrenNamed(parent: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i]!;
    if ((child.localName ?? child.nodeName) === localName) out.push(child);
  }
  return out;
}

function firstChildNamed(parent: Element, localName: string): Element | null {
  return childrenNamed(parent, localName)[0] ?? null;
}

/**
 * The `w:val` attribute of a WordprocessingML element, whatever prefix the
 * namespace is bound to.
 *
 * Looked up by local name rather than by qualified name. `w:val` is the
 * convention but not the rule, and an attribute can never be in a default
 * namespace — so a producer that binds the WordprocessingML namespace to
 * `word:` writes `word:val`, and a lookup for `w:val` finds nothing and reports
 * every heading as a plain paragraph.
 */
function attributeValue(el: Element): string {
  const attributes = el.attributes;
  for (let i = 0; i < attributes.length; i += 1) {
    const attribute = attributes[i]!;
    if ((attribute.localName ?? attribute.name) === W.value) return attribute.value;
  }
  return "";
}

/**
 * Heading level from a paragraph's own properties, or `null`.
 *
 * Two independent declarations, both consulted because Word writes one or the
 * other depending on how the document was authored: `w:pStyle` naming a style
 * (`Heading1`, `Heading 2`, and — from a Chinese-locale Word — `标题 1`), and
 * `w:outlineLvl` giving the level directly. The outline level wins when both
 * are present, because it is the unlocalized one.
 */
function headingLevel(paragraph: Element): number | null {
  const properties = firstChildNamed(paragraph, "pPr");
  if (!properties) return null;

  const outline = firstChildNamed(properties, W.outlineLevel);
  if (outline) {
    const raw = Number.parseInt(attributeValue(outline), 10);
    // Word's outline levels are 0-based, so 0 is a level-1 heading.
    if (Number.isInteger(raw) && raw >= 0 && raw <= 5) return raw + 1;
  }

  const style = firstChildNamed(properties, W.paragraphStyle);
  if (style) {
    const name = attributeValue(style).trim();
    // `Heading1` / `heading 2` / `标题 1` / `标题1`, with an optional space.
    const latin = /^heading\s*([1-6])$/i.exec(name);
    if (latin) return Number.parseInt(latin[1]!, 10);
    const chinese = /^标题\s*([1-6])$/.exec(name);
    if (chinese) return Number.parseInt(chinese[1]!, 10);
  }
  return null;
}

/** Whether the paragraph belongs to a numbered or bulleted list. */
function isListItem(paragraph: Element): boolean {
  const properties = firstChildNamed(paragraph, "pPr");
  if (!properties) return false;
  return firstChildNamed(properties, W.numberingProperties) !== null;
}

interface RunProperties {
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

/**
 * Character formatting declared on a run.
 *
 * Word writes emphasis as an empty flag element (`<w:b/>`) and writes
 * `<w:b w:val="0"/>` to turn it *off* — so presence is not enough, and the
 * value has to be checked. The value is also written `"false"` by some
 * producers rather than `"0"` or `"off"`, which is why it is parsed as a token
 * rather than compared to a literal.
 */
function runProperties(run: Element): RunProperties {
  const properties = firstChildNamed(run, "rPr");
  if (!properties) return { bold: false, italic: false, strike: false };

  const flag = (localName: string): boolean => {
    const el = firstChildNamed(properties, localName);
    if (!el) return false;
    const value = attributeValue(el).trim().toLowerCase();
    if (value.length === 0) return true;
    return value !== "0" && value !== "false" && value !== "off";
  };

  return {
    bold: flag(W.bold),
    italic: flag(W.italic),
    strike: flag(W.strike),
  };
}

/**
 * Append a paragraph's text and emphasis.
 *
 * Line breaks are real characters in the stored text, which is why they are
 * appended as `"\n"` here rather than being treated as separators: `BlockCollector`
 * normalises prose afterwards, so a soft break inside a paragraph folds to a
 * space exactly as it should, and the marks measured over the raw string shift
 * with it through `normalizeProseWithMap`.
 */
function appendParagraph(paragraph: Element, out: InlineTextBuilder, depth = 0): void {
  // Bounded so a malformed nesting cannot recurse without end.
  if (depth > 32) return;

  for (let i = 0; i < paragraph.children.length; i += 1) {
    const child = paragraph.children[i]!;
    const name = child.localName ?? child.nodeName;

    if (name === W.run) {
      const props = runProperties(child);
      const inside = (): void => appendParagraph(child, out, depth + 1);
      // Nesting order matches INLINE_MARK_ORDER so a run that is both bold and
      // italic canonicalises the same way the Markdown and HTML paths do.
      if (props.bold && props.italic) {
        out.wrap("strong", () => out.wrap("em", inside));
      } else if (props.bold) {
        out.wrap("strong", inside);
      } else if (props.italic) {
        out.wrap("em", inside);
      } else if (props.strike) {
        out.wrap("del", inside);
      } else {
        inside();
      }
      continue;
    }

    if (name === W.text) {
      // `xml:space="preserve"` is what keeps leading and trailing spaces in a
      // run; the DOM reports them either way, so no special handling is needed
      // beyond taking the text verbatim.
      out.append(child.textContent ?? "");
      continue;
    }
    if (name === W.tab) {
      out.append("\t");
      continue;
    }
    if (name === W.break || name === W.carriageReturn) {
      out.append("\n");
      continue;
    }
    // `w:hyperlink`, `w:ins`, `w:smartTag` and friends are transparent
    // containers: their text is the paragraph's text.
    if (child.children.length > 0) appendParagraph(child, out, depth + 1);
  }
}

/** One table row as a readable single line, matching the HTML table path. */
function tableRowText(row: Element): string {
  return childrenNamed(row, W.tableCell)
    .map((cell) => {
      const builder = new InlineTextBuilder();
      const paragraph = firstChildNamed(cell, W.paragraph);
      if (paragraph) appendParagraph(paragraph, builder);
      return normalizeProse(builder.text);
    })
    .join(" | ");
}

function addParagraph(collector: BlockCollector, paragraph: Element, inQuote: boolean): void {
  const builder = new InlineTextBuilder();
  appendParagraph(paragraph, builder);
  const text = builder.text;
  if (text.trim().length === 0) return;

  const level = headingLevel(paragraph);
  const type: ContentBlockType = level !== null ? "heading" : isListItem(paragraph) ? "listItem" : "paragraph";
  const resolved: ContentBlockType = inQuote ? "quote" : type;

  const options: { level?: number; ordered?: boolean; rawMarks?: typeof builder.marks } = {
    rawMarks: builder.marks,
  };
  if (level !== null && !inQuote) options.level = level;
  // See the module note: without `numbering.xml` the marker is unknowable, and
  // claiming "ordered" would be a guess presented as a fact.
  if (type === "listItem" && !inQuote) options.ordered = false;

  collector.add(resolved, text, options);
}

/** Walk `<w:body>`, honouring block quotes' nesting through tables and the like. */
function walkBody(body: Element, collector: BlockCollector): void {
  for (let i = 0; i < body.children.length; i += 1) {
    const child = body.children[i]!;
    const name = child.localName ?? child.nodeName;

    if (name === W.paragraph) {
      addParagraph(collector, child, false);
      continue;
    }
    if (name === W.table) {
      for (const row of childrenNamed(child, W.tableRow)) {
        const text = tableRowText(row);
        if (text.length > 0) collector.add("listItem", text, { ordered: false });
      }
      continue;
    }
    // `w:sectPr` (section properties) and anything else carry no prose.
  }
}

/** Best-effort title from the document's first heading. */
function firstHeadingText(body: Element): string {
  for (const paragraph of childrenNamed(body, W.paragraph)) {
    if (headingLevel(paragraph) === null) continue;
    const builder = new InlineTextBuilder();
    appendParagraph(paragraph, builder);
    const text = normalizeProse(builder.text);
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * Import a DOCX into the unified `ParsedDocument`.
 *
 * Async because the archive has to be inflated. Failures are values, so a
 * caller cannot confuse "not a DOCX" with "empty document".
 */
export async function parseDocx(
  bytes: Uint8Array,
  options: DocxImportOptions = {},
): Promise<ParseResult> {
  let entries;
  try {
    entries = listZipEntries(bytes);
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: err instanceof ZipError ? err.message : "无法读取 DOCX 压缩包。",
    };
  }

  const entry = findZipEntry(entries, "word/document.xml");
  if (!entry) {
    return { ok: false, code: "PARSE_ERROR", message: "不是有效的 DOCX：缺少 word/document.xml。" };
  }

  let xml: string;
  try {
    xml = decodeText(await readZipEntry(bytes, entry)).text;
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: err instanceof ZipError ? err.message : "DOCX 正文读取失败。",
    };
  }

  if (typeof DOMParser !== "function") {
    return { ok: false, code: "PARSE_ERROR", message: "当前环境不支持 XML 解析。" };
  }
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (!root || root.nodeName === "parsererror") {
    return { ok: false, code: "PARSE_ERROR", message: "DOCX 正文 XML 无法解析。" };
  }
  const body = firstChildNamed(root, W.body);
  if (!body) {
    return { ok: false, code: "PARSE_ERROR", message: "DOCX 正文里找不到 <w:body>。" };
  }

  const collector = new BlockCollector();
  walkBody(body, collector);
  const blocks = collector.toBlocks();

  if (blocks.length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "DOCX 里没有可提取的正文。" };
  }

  const chars = blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (chars > MAX_DOCX_CHARS) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: `DOCX 正文超过 ${Math.round(MAX_DOCX_CHARS / 1024 / 1024)} MB 上限。`,
    };
  }

  const document: ParsedDocument = {
    title:
      options.title?.trim() ||
      firstHeadingText(body) ||
      options.fallbackTitle?.trim() ||
      "未命名文档",
    author: null,
    blocks,
    source: "docx-xml",
    extractorVersion: EXTRACTOR_VERSION,
    textHash: documentTextHash(blocks),
  };
  return { ok: true, document };
}
