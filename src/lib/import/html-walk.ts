// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * DOM → content blocks.
 *
 * The DOM half of `server/src/lib/parse/html.ts`, lifted out unchanged so that
 * three callers can share it: the `.html` file importer, EPUB chapters, and
 * DOCX paragraphs. Only the entry point differs between them — this file never
 * parses anything, it walks a tree it is handed.
 *
 * ## Why the structural types instead of DOM types
 *
 * `RawNode` / `RawElement` declare exactly the six members the walk reads:
 * `nodeType`, `nodeName`, `textContent`, `childNodes`, `tagName`,
 * `getAttribute`. A browser `Element` satisfies that structurally, and so does
 * a jsdom one — which is what lets the unit tests drive this with jsdom while
 * production drives it with `DOMParser`, with no second implementation and no
 * `lib.dom` dependency in a file the server also compiles.
 *
 * ## The one invariant everything else serves
 *
 * A block's `text` is the coordinate system every highlight, note and
 * cross-version anchor is expressed in. So the walk measures emphasis against
 * the same string it stores and *drops the emphasis* when the two disagree
 * (see `addMeasured`). Losing bold text is recoverable; moving the text is not.
 */

import type { ContentBlockType } from "../../../shared/contracts/index.js";
import { tableBlockText } from "../../../shared/contracts/index.js";
import {
  BlockCollector,
  normalizeProse,
  type AddBlockOptions,
} from "../local-import-blocks.js";
import { InlineTextBuilder } from "../local-import-inline.js";

/**
 * The parts of a DOM node this walk reads.
 *
 * Exported so callers can type the tree they hand in without importing
 * `lib.dom` — a browser `Element` and a jsdom one both satisfy it
 * structurally.
 */
export interface RawNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: { length: number; [index: number]: RawNode };
}

export interface RawElement extends RawNode {
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

/**
 * Elements whose contents are never article prose.
 *
 * `BR` is here rather than being handled as a separator because `textContent`
 * gives it no text, and `appendElementText` reproduces `textContent` exactly.
 * `HR` is *not* here: a horizontal rule is a block of its own (`hr`), emitted
 * with the fixed label the contract requires.
 *
 * `IMG` is deliberately absent: an image is a retained block of its own, so
 * the walker emits it with its `src` / `alt` / `title` instead of dropping it.
 * `PICTURE` is absent for the same reason — the `IMG` inside it is the block,
 * and the surrounding `<source>` elements carry no text.
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

/**
 * Page chrome, skipped only when the caller says the source is a whole web
 * page. A saved article's `<nav>` is noise; an EPUB chapter's `<header>` may be
 * the chapter title, and dropping it there would silently lose a heading.
 */
const CHROME_TAGS = new Set(["NAV", "ASIDE", "FOOTER"]);

const HEADING_TAG = /^H([1-6])$/;

interface WalkContext {
  inQuote: boolean;
  orderedList: boolean;
  /** 0-based depth of the list items this context emits. */
  depth: number;
  /** Skip page chrome. Set only for whole web pages, never for book chapters. */
  stripChrome: boolean;
  /**
   * Document origin for resolving relative `<img src>`, when the caller knows
   * it. `null` means this walker holds a file whose origin is unknown.
   */
  baseUrl: string | null;
}

const ROOT_CONTEXT: WalkContext = {
  inQuote: false,
  orderedList: false,
  depth: 0,
  stripChrome: false,
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
 * Relative targets are dropped as well. This walker has no base URL — the
 * markup it walks came out of a file, with no document origin attached — so
 * `/about` cannot be resolved to the site it came from, and left as-is the
 * reader would resolve it against this application's own origin. A dead link
 * that looks live is worse than a link rendered as text.
 */
const SAFE_HREF = /^(?:https?:|mailto:)/i;

function safeHref(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  return SAFE_HREF.test(value) ? value : null;
}

/**
 * Resolve an `<img src>` into something the reader will actually load.
 *
 * The renderer only accepts absolute `http(s)` URLs and root-relative paths
 * (see `Reader.tsx`), so those are the only shapes produced here:
 *
 *  - absolute `http(s)` — kept verbatim;
 *  - root-relative — kept as-is when no base URL is known (a file import),
 *    and resolved against the source URL when one is (a fetched page);
 *  - any other relative form — resolved against the base URL when available,
 *    otherwise dropped. Without an origin, `/media/a.png` is meaningful but
 *    `media/a.png` is not: resolving it against *this* application's origin
 *    would fabricate a URL that looks live and is dead.
 *
 * `data:` and every other scheme fall out of the protocol check, so a stored
 * `javascript:` source can never reach the renderer.
 */
function resolveImageSrc(raw: string | null, baseUrl: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (baseUrl === null) {
    // Keep only root-relative paths. `//host/a.png` is protocol-relative, not
    // root-relative, and cannot be made loadable without an origin.
    return value.startsWith("/") && !value.startsWith("//") ? value : null;
  }
  try {
    const resolved = new URL(value, baseUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
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
 * Emit every image inside an element the walker otherwise treats as one text
 * block (`<p>`, a heading, a list item).
 *
 * Those branches never descend, so an `<img>` inside them would be lost.
 * Nested lists are skipped for a list item because the nested walk emits their
 * images in their own place. This contributes no text to the enclosing block,
 * which is what keeps its offsets intact.
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
 * The two strings are produced by independent traversals — `textContent` for
 * the text, `appendElementText` for the marks — so agreement is evidence, not
 * a tautology. When they disagree the marks are dropped and the text is kept.
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
 * The rows of a `<table>`, in document order.
 *
 * Each row's cells are direct `TD`/`TH` children, normalised to plain text.
 * The first row is the header by convention (that is also what GFM does), and
 * `<thead>` / `<tbody>` are containers, not rows, so the walk descends through
 * them. A nested table is not part of this table's rows.
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
 * The checkbox is an `<input type="checkbox">` somewhere inside the item, and
 * `INPUT` is in SKIP_TAGS, so the control contributes no text to the block.
 * Nested lists are skipped: their checkboxes belong to their own items.
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
 * had. Paying on entry also keeps it out of a wrap opened by the element being
 * entered: `[a](x)[b](x)` joins to `a b` with the space outside both links,
 * exactly as `.join(" ")` puts it.
 */
function listItemInline(li: RawElement, out: InlineTextBuilder): void {
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
    if (ctx.stripChrome && CHROME_TAGS.has(tag)) continue;

    const heading = HEADING_TAG.exec(tag);
    if (heading) {
      // An image inside a heading is its own block; the heading keeps the text
      // it was measured over.
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
        // Images inside a paragraph are emitted before the paragraph itself.
        // They add nothing to `text`, so the paragraph's offsets are unchanged.
        emitImagesWithin(child, ctx, out);
        addMeasured(out, ctx.inQuote ? "quote" : "paragraph", elementContent(child));
        continue;
      case "LI": {
        const builder = new InlineTextBuilder();
        listItemInline(child, builder);
        // A checkbox (`<input type="checkbox">`) is in SKIP_TAGS and therefore
        // contributes no text; `listItemTask` only reads its attribute.
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

/**
 * Walk a parsed DOM subtree into blocks.
 *
 * `stripChrome` and `baseUrl` are the two behavioural switches: the first is
 * on for whole web pages (a saved article's `<nav>` and `<aside>` are not
 * prose), off for book chapters, where a `<header>` may be the chapter title
 * and dropping it would lose a heading. The second is the document's origin
 * when a caller has one, so relative `<img src>` values become absolute URLs
 * instead of being dropped.
 */
export function walkDomInto(
  root: RawNode,
  out: BlockCollector,
  options: { stripChrome?: boolean; baseUrl?: string | null } = {},
): void {
  walk(
    root,
    {
      ...ROOT_CONTEXT,
      stripChrome: options.stripChrome ?? false,
      baseUrl: options.baseUrl ?? null,
    },
    out,
  );
}

/**
 * Best-effort heading text for a title, without walking the whole document.
 *
 * Prefers the first `<h1>`, then the first heading of any level — the same
 * order `deriveTitle` uses for Markdown, so the two importers name an untitled
 * document the same way.
 */
export function titleFromDom(root: RawNode): string {
  let firstHeading = "";
  let firstH1 = "";
  const visit = (node: RawNode): void => {
    for (const child of childArray(node)) {
      if (!isElementNode(child)) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      if (HEADING_TAG.test(tag)) {
        const text = normalizeProse(elementText(child));
        if (text.length > 0) {
          if (firstHeading.length === 0) firstHeading = text;
          if (tag === "H1" && firstH1.length === 0) {
            firstH1 = text;
            return;
          }
        }
      }
      visit(child);
    }
  };
  visit(root);
  return firstH1 || firstHeading;
}
