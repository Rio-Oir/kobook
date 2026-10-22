// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Static HTML -> unified content blocks.
 *
 * Pipeline: linkedom parses the fixture, Mozilla Readability identifies the
 * article body and metadata, then a small DOM walker converts the article
 * into `ContentBlock[]`.
 *
 * **Why linkedom and not jsdom.** The three-pass shape below (pre-clean, read
 * metadata, extract) needs more than one document, and a jsdom document costs
 * 0.2–0.4s to build regardless of page size: measured on the same 54KB article,
 * four jsdom documents plus Readability took 0.94–1.59s, the same work with
 * linkedom 0.14–0.21s, for byte-identical blocks. Upstream Gloss (`lib/
 * fetch-article.ts`) uses linkedom for exactly this. jsdom stays a dev
 * dependency because the unit tests that shim `DOMParser` still use it.
 *
 * Phase 1 boundary: this module never downloads anything. It only accepts an
 * HTML string that the caller already holds, plus — for a page the caller
 * fetched — the origin it came from, which is used *only* to resolve relative
 * `<img src>` values. Nothing here performs a request.
 *
 * The walker deliberately keeps every non-empty block, including very short
 * Chinese paragraphs and list items (audit P1#3).
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type {
  ContentBlockType,
  ParsedDocument,
  ParseResult,
} from "../../../../shared/contracts/index.js";
import { tableBlockText } from "../../../../shared/contracts/index.js";
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

/**
 * `IMG` and `PICTURE` are deliberately absent: an image is a retained block of
 * its own, emitted with its `src` / `alt` / `title` rather than dropped. The
 * `<source>` children of `<picture>` carry no text, so descending into the
 * element only reaches the `<img>` it wraps.
 *
 * `HR` is absent too: a horizontal rule is an `hr` block, not a skipped node.
 */
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
  "BR",
  "VIDEO",
  "AUDIO",
  "CANVAS",
]);

const HEADING_TAG = /^H([1-6])$/;

interface WalkContext {
  inQuote: boolean;
  orderedList: boolean;
  /** 0-based depth of the list items this context emits. */
  depth: number;
  /** Document origin for resolving relative `<img src>`, when known. */
  baseUrl: string | null;
}

const ROOT_CONTEXT: WalkContext = {
  inQuote: false,
  orderedList: false,
  depth: 0,
  baseUrl: null,
};

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
 * Resolve an `<img src>` into something the reader will load.
 *
 * Mirrors `resolveImageSrc` in `src/lib/import/html-walk.ts` exactly: only
 * absolute `http(s)` and root-relative paths are representable, so a relative
 * path is resolved against the source origin when the caller has one and
 * dropped when it does not (resolving it against *this* server's origin would
 * fabricate a dead URL). `data:` and every other scheme fall out.
 */
function resolveImageSrc(raw: string | null, baseUrl: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (baseUrl === null) {
    return value.startsWith("/") && !value.startsWith("//") ? value : null;
  }
  try {
    const resolved = new URL(value, baseUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The page's own share image, in the order publishers mean it.
 *
 * `og:image` is what social previews use; `twitter:image` is the fallback;
 * `link[rel=image_src]` is the older convention. The value is resolved exactly
 * like a body `<img>` (absolute, or relative to the fetched origin) and
 * nothing is requested here.
 */
const COVER_META_SELECTORS = [
  'meta[property="og:image:secure_url"]',
  'meta[property="og:image"]',
  'meta[name="og:image"]',
  'meta[name="twitter:image"]',
  'meta[property="twitter:image"]',
  'link[rel="image_src"]',
] as const;

type MetaQueryable = {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
};

function extractCoverImage(document: MetaQueryable, baseUrl: string | null): string | null {
  for (const selector of COVER_META_SELECTORS) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const src = resolveImageSrc(
      el.getAttribute("content") ?? el.getAttribute("href"),
      baseUrl,
    );
    if (src !== null) return src;
  }
  return null;
}

/** Emit one `<img>` as an image block, exactly the way Markdown does. */
function emitImage(el: RawElement, ctx: WalkContext, out: BlockCollector): void {
  const src = resolveImageSrc(el.getAttribute("src"), ctx.baseUrl);
  if (src === null) return;
  const alt = (el.getAttribute("alt") ?? "").trim();
  const title = (el.getAttribute("title") ?? "").trim();
  out.add("image", alt.length > 0 ? alt : "图片", {
    src,
    ...(alt.length > 0 ? { alt } : {}),
    ...(title.length > 0 ? { title } : {}),
  });
}

/**
 * Emit every image inside an element the walker treats as one text block
 * (`<p>`, a heading, a list item). Those branches do not descend, so an
 * `<img>` inside them would otherwise be lost. Nested lists are skipped for a
 * list item because their own walk emits their images in place.
 */
function emitImagesWithin(
  node: RawNode,
  ctx: WalkContext,
  out: BlockCollector,
  skipLists = false,
): void {
  for (const child of childArray(node)) {
    if (!isElementNode(child)) continue;
    const tag = child.tagName.toUpperCase();
    if (tag === "IMG") {
      emitImage(child, ctx, out);
      continue;
    }
    if (skipLists && (tag === "UL" || tag === "OL")) continue;
    if (SKIP_TAGS.has(tag)) continue;
    emitImagesWithin(child, ctx, out, skipLists);
  }
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
 * The rows of a `<table>`, in document order (same shape as the browser
 * walker's `tableRowsOf`). `THEAD` / `TBODY` are containers, not rows; a
 * nested table is not part of this table's rows.
 */
function tableRowsOf(table: RawElement): string[][] {
  const rows: string[][] = [];
  const visit = (node: RawNode): void => {
    for (const child of childArray(node)) {
      if (!isElementNode(child)) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === "TR") {
        rows.push(
          childArray(child)
            .filter(isElementNode)
            .filter((cell) => {
              const cellTag = cell.tagName.toUpperCase();
              return cellTag === "TD" || cellTag === "TH";
            })
            .map((cell) => normalizeProse(elementText(cell))),
        );
        continue;
      }
      if (tag === "TABLE") continue;
      visit(child);
    }
  };
  visit(table);
  return rows;
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
 * Whether a list item is a task item, and whether its box is ticked.
 *
 * The checkbox is an `<input type="checkbox">` inside the item; `INPUT` is in
 * SKIP_TAGS, so the control contributes no text to the block. Nested lists are
 * skipped because their checkboxes belong to their own items.
 */
function listItemTask(li: RawElement): { checked: boolean } | null {
  const visit = (node: RawNode): { checked: boolean } | null => {
    for (const child of childArray(node)) {
      if (!isElementNode(child)) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === "UL" || tag === "OL") continue;
      if (tag === "INPUT") {
        const type = (child.getAttribute("type") ?? "").toLowerCase();
        if (type === "checkbox") {
          return { checked: child.getAttribute("checked") !== null };
        }
        continue;
      }
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const fromInput = visit(li);
  if (fromInput) return fromInput;
  // Readability strips form controls from extracted article markup but keeps
  // the class a task list carries. Without the input the tick state is
  // unrecoverable, so such an item is reported as a task that is not ticked
  // rather than silently becoming an ordinary bullet.
  const className = li.getAttribute("class") ?? "";
  if (/(?:^|\s)task-list-item(?:\s|$)/.test(className)) return { checked: false };
  return null;
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
    if (tag === "UL") walk(child, { ...ctx, orderedList: false, depth: ctx.depth + 1 }, out);
    else if (tag === "OL") walk(child, { ...ctx, orderedList: true, depth: ctx.depth + 1 }, out);
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
      emitImagesWithin(child, ctx, out);
      addMeasured(out, ctx.inQuote ? "quote" : "heading", elementContent(child), {
        level: Number.parseInt(heading[1]!, 10),
      });
      continue;
    }

    switch (tag) {
      case "IMG":
        emitImage(child, ctx, out);
        continue;
      case "PRE":
        // Code is verbatim: no inline emphasis inside a fence, and
        // `normalizeCode` rather than `normalizeProse` is what preserves its
        // line structure.
        out.add("code", elementText(child), { lang: codeLanguage(child) });
        continue;
      case "P":
        emitImagesWithin(child, ctx, out);
        addMeasured(out, ctx.inQuote ? "quote" : "paragraph", elementContent(child));
        continue;
      case "LI": {
        const builder = new InlineTextBuilder();
        listItemInline(child, builder);
        const task = listItemTask(child);
        emitImagesWithin(child, ctx, out, true);
        addMeasured(
          out,
          "listItem",
          { text: listItemOwnText(child), builder },
          {
            ordered: ctx.orderedList,
            depth: ctx.depth,
            ...(task ? { task: true, checked: task.checked } : {}),
          },
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
      case "HR":
        // `text` must be non-empty so `hash` and `textHash` stay well defined.
        out.add("hr", "分隔线");
        continue;
      case "TABLE": {
        const rows = tableRowsOf(child);
        if (rows.length > 0) out.add("table", tableBlockText(rows), { rows });
        continue;
      }
      case "TR": {
        // A row outside a `<table>` (malformed markup or a fragment). Inside
        // one, the TABLE case above already consumed the rows.
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
  /** The page's own share image, when it declared one. */
  coverImage: string | null;
}

function extractWithReadability(
  html: string,
  remoteArticle = false,
  baseUrl: string | null = null,
): ReadabilityOutcome | null {
  // Remote pages carry site furniture. Remove explicit structural elements
  // before Readability can flatten them, also protecting the body fallback.
  // Local HTML imports retain their existing behavior.
  if (remoteArticle) {
    const prepared = parseHTML(asDocument(html));
    const doc = prepared.document;
    doc.querySelectorAll('nav, footer, [role="navigation"], [role="contentinfo"]').forEach((el: { remove(): void }) => el.remove());
    // As in Gloss, data tables with header cells or captions should not be
    // mistaken for page chrome because of classes such as sticky-header.
    for (const table of doc.querySelectorAll("table")) {
      if (table.getAttribute("role") === "presentation") continue;
      if (table.querySelector("th, thead, caption")) table.removeAttribute("class");
    }
    html = doc.toString();
  }

  // One document for the metadata Readability is about to consume, and — only
  // when Readability declines — a second one for the body fallback, because
  // `parse()` rewrites the document it is given.
  const dom = parseHTML(asDocument(html));
  const document = dom.document;
  // Read before Readability runs: it gets its own DOM copy, and this one is
  // only used for the `<title>` and the share image.
  const coverImage = extractCoverImage(
    document as unknown as MetaQueryable,
    baseUrl,
  );

  const parsed = new Readability(dom.document as unknown as ReadabilityDocument, {
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
    charThreshold: 0,
    keepClasses: true,
  }).parse();

  if (parsed?.content) {
    const root = parseFragment(parsed.content);
    if (root === null) return null;
    return {
      title: normalizeProse(parsed.title ?? ""),
      byline: parsed.byline ? normalizeProse(parsed.byline) : null,
      root,
      usedReadability: true,
      coverImage,
    };
  }

  // Fallback: Readability declines very short or unusual documents. Walking
  // the body keeps the contract identical instead of failing the import.
  //
  // Re-parsed because the attempt above may have rewritten the document it was
  // handed: a fallback that walks half-mutated markup would be worse than the
  // extra parse, and a linkedom parse of a page this size is a few milliseconds.
  const fresh = parseHTML(asDocument(html)).document;
  const fallbackRoot = findBody(fresh as unknown as RawNode);
  if (!fallbackRoot) return null;
  return {
    title: normalizeProse(documentTitle(fresh as unknown as TitleQueryable)),
    byline: null,
    root: fallbackRoot,
    usedReadability: false,
    coverImage,
  };
}

/**
 * Whether a string already is a whole document rather than a fragment.
 *
 * This matters because of the one behavioural difference between the two
 * parsers: jsdom accepted any snippet and put it in a synthesized body, while
 * linkedom's `parseHTML` assumes a document. Given a fragment it hoists the
 * first tag and leaves `<body>` empty (and given bare text it throws), so a
 * pasted HTML fragment — an explicit product input — would silently parse to
 * nothing. Anything without a document-level tag is therefore wrapped first.
 */
const DOCUMENT_SHAPE = /<(?:!doctype|html|head|body)[\s>]/i;

function asDocument(html: string): string {
  return DOCUMENT_SHAPE.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`;
}

/**
 * Parse a fragment — Readability's extracted `content` — and return its
 * container element.
 *
 * The same linkedom constraint as `asDocument`: a bare fragment must be given a
 * document to live in. The wrapper's id is deliberately improbable, because a
 * collision would return a node *inside* the article instead of the container
 * that holds all of it.
 */
const FRAGMENT_ROOT_ID = "__gloss_parse_root__";

function parseFragment(content: string): RawNode | null {
  const { document } = parseHTML(
    `<!doctype html><html><body><div id="${FRAGMENT_ROOT_ID}">${content}</div></body></html>`,
  );
  const root = document.getElementById(FRAGMENT_ROOT_ID);
  return (root as unknown as RawNode) ?? null;
}

/**
 * The document type Readability's own signature accepts, taken from the
 * library rather than spelled as the DOM lib's `Document` — the server
 * tsconfig deliberately has no DOM lib (see the RawNode note above), so the
 * only correct source for this type is the consumer that requires it.
 */
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

/** Enough of a document to read its `<title>`. */
type TitleQueryable = {
  querySelector(selector: string): { textContent: string | null } | null;
};

function documentTitle(document: TitleQueryable): string {
  return (document.querySelector("title")?.textContent ?? "").trim();
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
  /** Enable structural page-chrome filtering only for fetched webpages. */
  remoteArticle?: boolean;
  /**
   * Origin of the fetched page, when the caller has one. Used only to make
   * relative `<img src>` values absolute; it triggers no request.
   */
  baseUrl?: string | null;
}

export function parseHtml(html: string, options: HtmlParseOptions = {}): ParseResult {
  if (html.trim().length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "HTML input was empty." };
  }

  let outcome: ReadabilityOutcome | null;
  try {
    outcome = extractWithReadability(
      html,
      options.remoteArticle,
      options.baseUrl ?? null,
    );
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
  walk(outcome.root, { ...ROOT_CONTEXT, baseUrl: options.baseUrl ?? null }, collector);
  const blocks = collector.toBlocks();

  // An article with no retainable text must be rejected, never stored as an
  // empty article (audit P1#3).
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
    ...(outcome.coverImage ? { coverImage: outcome.coverImage } : {}),
  };
  return { ok: true, document };
}
