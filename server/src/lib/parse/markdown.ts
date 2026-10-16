// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Markdown -> unified content blocks, via remark (unified + remark-parse +
 * remark-gfm) rather than the regex/character-threshold guessing used by the
 * character-threshold guessing this reader used before.
 *
 * The output contract is identical to the HTML path: same `ContentBlock`
 * shape, same id/hash rules, same refusal to emit an empty document.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";
import type { List, ListItem, Nodes, Root, RootContent } from "mdast";
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

const processor = unified().use(remarkParse).use(remarkGfm);

interface WalkContext {
  inQuote: boolean;
  orderedList: boolean;
}

const ROOT_CONTEXT: WalkContext = { inQuote: false, orderedList: false };

/**
 * The parts of an mdast node this file looks at.
 *
 * Loosely typed on purpose: the inline walk has to handle whatever the parser
 * produced, and narrowing `Nodes` at every branch would add ceremony without
 * adding safety — the result is checked against `toString` before it is used.
 */
interface InlineNode {
  type: string;
  value?: unknown;
  alt?: unknown;
  url?: unknown;
  children?: unknown;
}

/** Leading YAML front matter is metadata, not article prose. */
function stripFrontMatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const match = /^---\n[\s\S]*?\n---\n?/.exec(normalized);
  return match ? normalized.slice(match[0].length) : normalized;
}

function isParent(node: Nodes | RootContent): node is Extract<Nodes, { children: unknown }> {
  return Array.isArray((node as { children?: unknown }).children);
}

/**
 * Append a node's text, recording emphasis as it goes.
 *
 * The traversal mirrors `mdast-util-to-string`'s `one()` deliberately and
 * branch for branch: a plain-text field wins, then `alt`, then the children.
 * Both functions are asked for the same block's text and the result is
 * compared before any span is attached (see `addMeasured`), so a node type
 * this switch handles differently costs the block its emphasis — it can never
 * move the text, which is what `hash` and therefore `blockId` are built from.
 */
function appendNode(node: InlineNode, out: InlineTextBuilder): void {
  if (typeof node.value === "string") {
    // `inlineCode` has a `value` like `text` does, and unlike every other
    // inline construct it is *also* an emphasis. Handled first so the generic
    // branch below cannot swallow it as plain text.
    if (node.type === "inlineCode") out.wrap("code", () => out.append(node.value as string));
    else out.append(node.value);
    return;
  }
  if (typeof node.alt === "string" && node.alt.length > 0) {
    out.append(node.alt);
    return;
  }
  if (!Array.isArray(node.children)) return;

  const descend = (): void => {
    for (const child of node.children as InlineNode[]) appendNode(child, out);
  };

  switch (node.type) {
    case "strong":
      out.wrap("strong", descend);
      return;
    case "emphasis":
      out.wrap("em", descend);
      return;
    case "delete":
      out.wrap("del", descend);
      return;
    case "link": {
      const url = typeof node.url === "string" ? node.url.trim() : "";
      // An empty target is not a link. Recording one would produce a span
      // whose `href` is the empty string, which the contract forbids.
      if (url.length === 0) descend();
      else out.wrap("link", descend, url);
      return;
    }
    default:
      descend();
  }
}

/**
 * Add a block, attaching inline marks only when the text they were measured
 * against is character-for-character the text the block stores.
 *
 * The two strings are produced by independent traversals — `toString` for the
 * text, `appendNode` for the marks — so agreement is evidence, not a
 * tautology. When they disagree the marks are dropped and the text is kept:
 * emphasis is decoration, `text` is the coordinate system every note,
 * highlight and cross-version anchor is expressed in.
 */
function addMeasured(
  out: BlockCollector,
  type: ContentBlockType,
  text: string,
  builder: InlineTextBuilder,
  opts: AddBlockOptions = {},
): void {
  out.add(
    type,
    text,
    builder.text === text ? { ...opts, rawMarks: builder.marks } : opts,
  );
}

/** Add a node whose stored text is exactly `toString(node)`. */
function addFromNode(
  out: BlockCollector,
  type: ContentBlockType,
  node: RootContent,
  opts: AddBlockOptions = {},
): void {
  const builder = new InlineTextBuilder();
  appendNode(node as InlineNode, builder);
  addMeasured(out, type, toString(node), builder, opts);
}

/**
 * Text owned by a list item, excluding nested lists — those are emitted as
 * their own items so list structure survives.
 */
function listItemOwnText(item: ListItem): string {
  return item.children
    .filter((child) => child.type !== "list")
    .map((child) => toString(child))
    .join(" ");
}

/**
 * The same string as `listItemOwnText`, with the emphasis recorded.
 *
 * The space between children is inserted by this extractor, not present in the
 * source, so it is a real character in the stored `text` and the marks are
 * recorded over the joined string rather than over the children. Building
 * both through one pass is what keeps them on the same coordinates.
 */
function listItemInline(item: ListItem, out: InlineTextBuilder): void {
  let first = true;
  for (const child of item.children) {
    if (child.type === "list") continue;
    if (!first) out.append(" ");
    first = false;
    appendNode(child as InlineNode, out);
  }
}

function walkList(list: List, ctx: WalkContext, out: BlockCollector): void {
  const ordered = list.ordered ?? false;
  for (const item of list.children) {
    const builder = new InlineTextBuilder();
    listItemInline(item, builder);
    addMeasured(out, "listItem", listItemOwnText(item), builder, { ordered });
    for (const child of item.children) {
      if (child.type === "list") walkList(child, ctx, out);
      else if (child.type === "blockquote") {
        walkNodes(child.children, { ...ctx, inQuote: true }, out);
      }
    }
  }
}

function walkNodes(nodes: readonly RootContent[], ctx: WalkContext, out: BlockCollector): void {
  for (const node of nodes) {
    switch (node.type) {
      case "heading":
        addFromNode(out, ctx.inQuote ? "quote" : "heading", node, { level: node.depth });
        break;

      case "paragraph":
        addFromNode(out, ctx.inQuote ? "quote" : "paragraph", node);
        break;

      case "code":
        out.add("code", node.value, { lang: node.lang ?? null });
        break;

      case "list":
        walkList(node, ctx, out);
        break;

      case "blockquote":
        walkNodes(node.children, { ...ctx, inQuote: true }, out);
        break;

      case "table": {
        // GFM table: one list item per row, cells joined readably.
        for (const row of node.children) {
          const cells = row.children.map((cell) => normalizeProse(toString(cell)));
          out.add("listItem", cells.join(" | "), { ordered: false });
        }
        break;
      }

      case "thematicBreak":
        break;

      case "html": {
        // Raw HTML block. Strip tags so embedded prose is not silently lost,
        // then keep it only if any text remains.
        const text = normalizeProse(node.value.replace(/<[^>]*>/g, " "));
        if (text.length > 0) out.add(ctx.inQuote ? "quote" : "paragraph", text);
        break;
      }

      case "definition":
      case "footnoteDefinition":
        break;

      default:
        if (isParent(node)) {
          walkNodes(node.children as RootContent[], ctx, out);
        }
        break;
    }
  }
}

function deriveTitle(root: Root): string {
  for (const node of root.children) {
    if (node.type === "heading" && node.depth === 1) {
      const t = normalizeProse(toString(node));
      if (t.length > 0) return t;
    }
  }
  for (const node of root.children) {
    if (node.type === "heading") {
      const t = normalizeProse(toString(node));
      if (t.length > 0) return t;
    }
  }
  return "";
}

export interface MarkdownParseOptions {
  /** Overrides the extractor-derived title when provided. */
  title?: string;
}

export function parseMarkdown(
  markdown: string,
  options: MarkdownParseOptions = {},
): ParseResult {
  if (markdown.trim().length === 0) {
    return { ok: false, code: "EMPTY_CONTENT", message: "Markdown input was empty." };
  }

  const body = stripFrontMatter(markdown);
  if (body.trim().length === 0) {
    return {
      ok: false,
      code: "EMPTY_CONTENT",
      message: "Markdown contained only front matter and no article text.",
    };
  }

  let root: Root;
  try {
    root = processor.parse(body);
  } catch (err) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: `Markdown could not be parsed: ${(err as Error).message}`,
    };
  }

  const collector = new BlockCollector();
  walkNodes(root.children, ROOT_CONTEXT, collector);
  const blocks = collector.toBlocks();

  if (blocks.length === 0) {
    return {
      ok: false,
      code: "EMPTY_CONTENT",
      message: "No readable text content was found in the markdown.",
    };
  }

  const document: ParsedDocument = {
    title: options.title?.trim() || deriveTitle(root) || "Untitled",
    author: null,
    blocks,
    source: "markdown-remark",
    extractorVersion: EXTRACTOR_VERSION,
    textHash: documentTextHash(blocks),
  };
  return { ok: true, document };
}
