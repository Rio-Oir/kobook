// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Static HTML -> unified content blocks.
 *
 * Pipeline: jsdom parses the fixture, Mozilla Readability identifies the
 * article body and metadata, then a small DOM walker converts the article
 * into `ContentBlock[]`.
 *
 * This module never downloads anything. It only accepts an HTML string the
 * caller already holds. There is no URL parameter anywhere in this file, by
 * design: fetching an arbitrary URL is a different problem with different
 * controls (see `lib/ssrf-guard.ts` and `lib/url-import.ts`), and keeping it
 * out of the parser is what lets this file be tested without a network.
 *
 * The walker deliberately keeps every non-empty block, however short,
 * including short Chinese paragraphs and list items.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type {
  ContentBlockType,
  ParsedDocument,
  ParseResult,
} from "../../../../shared/contracts/index.js";
import {
  BlockCollector,
  EXTRACTOR_VERSION,
  documentTextHash,
  normalizeProse,
  type AddBlockOptions,
} from "./blocks.js";
import { InlineTextBuilder } from "./inline.js";

// ── Minimal structural DOM types ──────────────────────────────────────────
// Declared locally so the server tsconfig does not need the DOM lib (which
// would collide with @types/node's fetch globals).

interface RawNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: { length: number; [index: number]: RawNode };
}

interface RawElement extends RawNode {
  tagName: string;
  getAttribute(name: string): string | null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function isTextNode(n: RawNode): boolean {
  return n.nodeType === TEXT_NODE;
}

function isElementNode(n: RawNode): n is RawElement {
  return n.nodeType === ELEMENT_NODE;
}

function childArray(n: RawNode): RawNode[] {
  const out: RawNode[] = [];
  for (let i = 0; i < n.childNodes.length; i += 1) {
    const c = n.childNodes[i];
    if (c) out.push(c);
  }
  return out;
}

// ── Traversal configuration ───────────────────────────────────────────────

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SVG",
  "IFRAME",
  "FORM",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "HR",
  "BR",
  "IMG",
  "PICTURE",
  "VIDEO",
  "AUDIO",
  "CANVAS",
]);

const HEADING_TAG = /^H([1-6])$/;

interface WalkContext {
  inQuote: boolean;
  orderedList: boolean;
}

const ROOT_CONTEXT: WalkContext = { inQuote: false, orderedList: false };

function elementText(el: RawNode): string {
  return el.textContent ?? "";
}

/**
 * Link targets we are willing to hand to the browser.
 *
 * An allowlist rather than a blocklist of `javascript:` and friends, because
 * the failure mode of a blocklist is a scheme nobody thought of. Only absolute
 * `http:` / `https:` / `mailto:` survive.
 *
 * Relative targets are dropped as well. This extractor has no base URL — the
 * markup it walks is the fragment Readability returned, with no document
 * origin attached — so `/about` cannot be resolved to the site it came from,
 * and left as-is the reader would resolve it against this application's own
 * origin. A dead link that looks live is worse than a link rendered as text.
 */
const SAFE_HREF = /^(?:https?:|mailto:)/i;

function safeHref(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  return SAFE_HREF.test(value) ? value : null;
}

/**
 * Record inline emphasis for one element, then run `descend` inside it.
 *
 * Shared by the prose walk and the list-item walk so the two cannot disagree
 * about which tags carry emphasis. The descend callback is supplied by the
 * caller because the two walks differ in how they join their text nodes,
 * which is not a property of the tag.
 */
function descendInline(
  el: RawElement,
  tag: string,
  out: InlineTextBuilder,
  descend: () => void,
): void {
  switch (tag) {
    case "STRONG":
    case "B":
      out.wrap("strong", descend);
      return;
    case "EM":
    case "I":
      out.wrap("em", descend);
      return;
    case "CODE":
      out.wrap("code", descend);
      return;
    case "DEL":
    case "S":
    case "STRIKE":
      out.wrap("del", descend);
      return;
    case "A": {
      const href = safeHref(el.getAttribute("href"));
      if (href === null) descend();
      else out.wrap("link", descend, href);
      return;
    }
    default:
      descend();
  }
}

/**
 * Append an element's text, recording emphasis as it goes.
 *
 * Reproduces `textContent` — every descendant text node, in order, with no
 * separators — so that the string this builds equals `elementText` for the
 * same element. Nothing here may add or drop a character: elements that carry
 * no text of their own (`<br>`, `<img>`) fall through to an empty recursion,
 * which is exactly what they contribute to `textContent`.
 */
function appendElementText(node: RawNode, out: InlineTextBuilder): void {
  for (const child of childArray(node)) {
    if (isTextNode(child)) {
      out.append(child.textContent ?? "");
      continue;
    }
    if (!isElementNode(child)) continue;
    const tag = child.tagName.toUpperCase();
    descendInline(child, tag, out, () => appendElementText(child, out));
  }
}

/** `elementText`, plus the emphasis inside it. */
function elementContent(el: RawNode): { text: string; builder: InlineTextBuilder } {
  const builder = new InlineTextBuilder();
  appendElementText(el, builder);
  return { text: elementText(el), builder };
}

/**
 * Add a block, attaching inline marks only when the text they were measured
 * against is character-for-character the text the block stores.
 *
 * The HTML path matters more here than the Markdown one: `textContent` has
 * subtle rules (script and style text are included, comments are not, nothing
 * is inserted between elements), and a walk that got one of them wrong would
 * otherwise shift every highlight in the block. Dropping the marks costs some
 * bold text; moving the text costs the user's annotations.
 */
function addMeasured(
  out: BlockCollector,
  type: ContentBlockType,
  measured: { text: string; builder: InlineTextBuilder },
  opts: AddBlockOptions = {},
): void {
  out.add(
    type,
    measured.text,
    measured.builder.text === measured.text
      ? { ...opts, rawMarks: measured.builder.marks }
      : opts,
  );
}

/** Language declared on a `<pre>`/`<code>` pair, if any. */
function codeLanguage(pre: RawElement): string | null {
  const cls = pre.getAttribute("class") ?? "";
  const own = /(?:^|\s)(?:language|lang)-([A-Za-z0-9+#_-]+)/.exec(cls);
  if (own) return own[1] ?? null;

  for (const child of childArray(pre)) {
    if (!isElementNode(child)) continue;
    if (child.tagName.toUpperCase() !== "CODE") continue;
    const inner = /(?:^|\s)(?:language|lang)-([A-Za-z0-9+#_-]+)/.exec(
      child.getAttribute("class") ?? "",
    );
    if (inner) return inner[1] ?? null;
  }
  return null;
}

/**
 * Text owned by a list item, excluding any nested list. Nested lists are
 * visited separately by the walker so their items become their own blocks
 * rather than being flattened into the parent item.
 */
function listItemOwnText(li: RawElement): string {
  const parts: string[] = [];
  const collect = (n: RawNode): void => {
    for (const child of childArray(n)) {
      if (isTextNode(child)) {
        parts.push(child.textContent ?? "");
        continue;
      }
      if (!isElementNode(child)) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === "UL" || tag === "OL") continue;
      if (SKIP_TAGS.has(tag)) continue;
      collect(child);
    }
  };
  collect(li);
  return parts.join(" ");
}

/**
 * The same string as `listItemOwnText`, with the emphasis recorded.
 *
 * This walk joins its text nodes with a space — a separator this extractor
 * inserts, which therefore really is in the stored `text`. Marks are measured
 * over the joined string, so the separator is accounted for by construction.
 * The two functions are separate traversals on purpose: agreement between them
 * is then evidence, and `addMeasured` drops the marks when they disagree
 * rather than letting a text node be counted differently than `textContent`
 * counts it.
 *
 * The separator is paid **before** entering the next element, not when the
 * text node inside it is appended. `<li>第一项 <strong>加粗</strong></li>` is
 * the case that distinguishes the two: paying on append would put the space
 * inside `<strong>`, so the emphasis would cover a character the source never
 * had — and the Markdown extractor, whose separator sits between children,
 * would end up describing the same document differently. Paying on entry also
 * keeps it out of a wrap opened by the element being entered, which is where
 * it belongs: `[a](x)[b](x)` joins to `a b` with the space outside both links,
 * exactly as `.join(" ")` puts it.
 */
function listItemInline(li: RawElement, out: InlineTextBuilder): void {
  // A separator is owed between two parts; it is paid once, at the start of
  // whichever part comes next, and outside anything that part is wrapped in.
  let owed = false;
  const settle = (): void => {
    if (!owed) return;
    out.append(" ");
    owed = false;
  };
  const push = (value: string): void => {
    settle();
    out.append(value);
    owed = true;
  };

  const collect = (n: RawNode): void => {
    for (const child of childArray(n)) {
      if (isTextNode(child)) {
        push(child.textContent ?? "");
        continue;
      }
      if (!isElementNode(child)) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === "UL" || tag === "OL") continue;
      if (SKIP_TAGS.has(tag)) continue;
      settle();
      descendInline(child, tag, out, () => collect(child));
    }
  };
  collect(li);
}

/**
 * Descends into a list item's nested block containers only. The item's own
 * text has already been captured by `listItemOwnText`, so visiting plain text
 * or inline children here would duplicate it.
 */
function descendNestedListContent(
  li: RawElement,
  ctx: WalkContext,
  out: BlockCollector,
): void {
  for (const child of childArray(li)) {
    if (!isElementNode(child)) continue;
    const tag = child.tagName.toUpperCase();
    if (tag === "UL") walk(child, { ...ctx, orderedList: false }, out);
    else if (tag === "OL") walk(child, { ...ctx, orderedList: true }, out);
    else if (tag === "BLOCKQUOTE") walk(child, { ...ctx, inQuote: true }, out);
  }
}

function walk(node: RawNode, ctx: WalkContext, out: BlockCollector): void {
  for (const child of childArray(node)) {
    if (isTextNode(child)) {
      // Text sitting directly inside a container (not wrapped in <p>).
      // Kept rather than dropped, so unusual markup does not lose prose.
      const loose = normalizeProse(child.textContent ?? "");
      if (loose.length > 0) {
        out.add(ctx.inQuote ? "quote" : "paragraph", loose);
      }
      continue;
    }
    if (!isElementNode(child)) continue;

    const tag = child.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) continue;

    const heading = HEADING_TAG.exec(tag);
    if (heading) {
      addMeasured(out, ctx.inQuote ? "quote" : "heading", elementContent(child), {
        level: Number.parseInt(heading[1]!, 10),
      });
      continue;
    }

    switch (tag) {
      case "PRE":
        // Code is verbatim: no inline emphasis inside a fence, and
        // `normalizeCode` rather than `normalizeProse` is what preserves its
        // line structure.
        out.add("code", elementText(child), { lang: codeLanguage(child) });
        continue;
      case "P":
        addMeasured(out, ctx.inQuote ? "quote" : "paragraph", elementContent(child));
        continue;
      case "LI": {
        const builder = new InlineTextBuilder();
        listItemInline(child, builder);
        addMeasured(
          out,
          "listItem",
          { text: listItemOwnText(child), builder },
          { ordered: ctx.orderedList },
        );
        // Only nested lists / quotes are descended into. Walking *all*
        // children would re-emit the item's own text as a loose paragraph,
        // producing a duplicate block for every list item.
        descendNestedListContent(child, ctx, out);
        continue;
      }
      case "UL":
        walk(child, { ...ctx, orderedList: false }, out);
        continue;
      case "OL":
        walk(child, { ...ctx, orderedList: true }, out);
        continue;
      case "BLOCKQUOTE":
        walk(child, { ...ctx, inQuote: true }, out);
        continue;
      case "TR": {
        // GFM-style table row: keep the cells as one readable item.
        const cells = childArray(child)
          .filter(isElementNode)
          .filter((c) => {
            const t = c.tagName.toUpperCase();
            return t === "TD" || t === "TH";
          })
          .map((c) => normalizeProse(elementText(c)));
        out.add("listItem", cells.join(" | "), { ordered: false });
        continue;
      }
      default:
        walk(child, ctx, out);
    }
  }
}

interface ReadabilityOutcome {
  title: string;
  byline: string | null;
  /** Node to walk: the extracted article, or the whole body as fallback. */
  root: RawNode;
  usedReadability: boolean;
}

function extractWithReadability(html: string): ReadabilityOutcome | null {
  const dom = new JSDOM(html);
  const document = dom.window.document as unknown as RawNode & { title?: string };

  // Readability mutates the document it is given, so it gets its own copy.
  const readerDom = new JSDOM(html);
  const readerDoc = readerDom.window.document;
  // Readability defaults to a ~500 character threshold and returns null for
  // shorter documents. That default would make it silently skip exactly the
  // short Chinese articles this pipeline must support, so it is disabled
  // here; the fallback below remains for genuinely unparseable input.
  //
  // `keepClasses` preserves `class="language-xxx"` on code blocks, which
  // Readability otherwise strips — losing the fenced-code language.
  //
  // Known behaviour: Readability renumbers headings inside the extracted
  // content (an h1 duplicating the title becomes an h2). Relative heading
  // structure is preserved, but absolute depth from the HTML path is not
  // authoritative.
  const parsed = new Readability(readerDoc, {
    charThreshold: 0,
    keepClasses: true,
  }).parse();

  if (parsed?.content) {
    const contentDom = new JSDOM(parsed.content);
    return {
      title: normalizeProse(parsed.title ?? ""),
      byline: parsed.byline ? normalizeProse(parsed.byline) : null,
      root: contentDom.window.document.body as unknown as RawNode,
      usedReadability: true,
    };
  }

  // Fallback: Readability declines very short or unusual documents. Walking
  // the body keeps the contract identical instead of failing the import.
  const fallbackRoot = findBody(document);
  if (!fallbackRoot) return null;
  return {
    title: normalizeProse(document.title ?? ""),
    byline: null,
    root: fallbackRoot,
    usedReadability: false,
  };
}

/**
 * Finds the `<body>` element. It is a child of `<html>`, not of the document
 * node, so the search has to descend rather than only inspecting the
 * document's direct children.
 */
function findBody(root: RawNode): RawNode | null {
  for (const child of childArray(root)) {
    if (!isElementNode(child)) continue;
    if (child.tagName.toUpperCase() === "BODY") return child;
    const nested = findBody(child);
    if (nested) return nested;
  }
  return null;
}

export interface HtmlParseOptions {
  /** Overrides the extractor-derived title when provided. */
  title?: string;
}

export function parseHtml(html: string, options: HtmlParseOptions = {}): ParseResult {
  if (html.trim().length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "HTML input was empty." };
  }

  let outcome: ReadabilityOutcome | null;
  try {
    outcome = extractWithReadability(html);
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: `HTML could not be parsed: ${(err as Error).message}`,
    };
  }

  if (!outcome) {
    return { ok: false, code: "PARSE_ERROR", message: "No document body found." };
  }

  const collector = new BlockCollector();
  walk(outcome.root, ROOT_CONTEXT, collector);
  const blocks = collector.toBlocks();

  // An article with no retainable text must be rejected, never stored as an
  // empty article.
  if (blocks.length === 0) {
    return {
      ok: false,
      code: "EMPTY_CONTENT",
      message: "No readable text content was found in the document.",
    };
  }

  const document: ParsedDocument = {
    title: options.title?.trim() || outcome.title || "Untitled",
    author: outcome.byline,
    blocks,
    source: "html-readability",
    extractorVersion: EXTRACTOR_VERSION,
    textHash: documentTextHash(blocks),
  };
  return { ok: true, document };
}
