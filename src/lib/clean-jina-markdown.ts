// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Conservative Markdown cleanup for **browser-Jina** output, applied before
 * the local parser sees it.
 *
 * ## Why it exists
 *
 * `r.jina.ai` returns the page's Markdown as the page presents it, which
 * for a news or temple site means the site's own chrome comes along: a
 * logo and a navigation list above the article, and the legal footer,
 * language switch and QR-code links below it. The parser faithfully turns
 * all of it into paragraphs, so the reader opens the article and finds
 * "首页 新闻 关于" as the first block.
 *
 * ## What it deliberately does *not* do
 *
 * This trims boundaries and normalizes adjacent strong-tag artifacts.
 * It never reflows text, drops a heading level, or touches the server's pipeline
 * (`server/src/lib/url-import.ts`) or the paste/file import paths. Two
 * concrete consequences:
 *
 *   - **Pasted text and already-stored articles are untouched.** A paste
 *     has no page title and no site chrome to speak of, and a stored
 *     article has already been parsed — running this over either would be
 *     editing the user's own document.
 *   - **A page that is already clean is returned byte-identical.** When
 *     neither boundary nor a strong-tag artifact is found, the original string is returned, not a
 *     normalised re-join of it. Line endings inside the kept region are
 *     preserved by splitting with the terminators kept.
 *
 * ## The two boundaries, and why both are conservative
 *
 * **Preamble.** Only an ATX heading whose *normalised* text equals the
 * *normalised* page title can start the document. The title is the
 * envelope's `data.title`, which Jina derives from the page's own
 * `<title>`; comparing normalised forms (`normalizeHeading`) absorbs the
 * decoration a title picks up on its way into a heading — a wrapping
 * `《》`, bold or emphasis markers, different whitespace and punctuation —
 * but not extra *words*, because a heading with more words in it is a
 * different heading. If no heading matches, nothing is trimmed: there is
 * no heuristic "the first heading is probably the title", because on a
 * page whose article has no heading that would throw away the article's
 * first paragraph. The match must also be near the top
 * (`PREAMBLE_LINE_LIMIT`); a heading that repeats the page title 500 lines
 * down is a section of the article, not site chrome.
 *
 * **Footer.** Only an *explicit* legal marker (`FOOTER_MARKER`: ICP and
 * 公安备案 numbers, 版权所有, Copyright, All rights reserved, the religious
 * information service licence) can end the document, and only when it is
 * near the end and the whole tail below it looks like furniture rather
 * than prose. Two tests keep a real article section: a marker line that
 * reads as a *sentence* is prose, not a notice, and a heading is never a
 * footer marker. The first is the one that matters most — a Chinese
 * article paragraph fits comfortably under any length limit, so
 * "this paragraph is short" cannot be the discriminator; "this line ends
 * in a full stop" can, because a copyright notice does not.
 *
 * ## Known limitation
 *
 * This only handles explicit page boundaries and the recognized adjacent
 * strong-tag artifact. It does not attempt general article extraction or
 * remove arbitrary symbols. Ambiguous Markdown is left intact.
 */

import { normalizeJinaStrongJoins } from "./jina-strong-joins.js";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes } from "mdast";

const markdownParser = unified().use(remarkParse).use(remarkGfm);

/** A footer line still has to be short; a long block is not a notice. */
const FOOTER_LINE_LIMIT = 120;

/**
 * Sentence-final punctuation, including the full-width forms.
 *
 * The single most useful signal that a line is prose rather than a site
 * notice: "版权所有" is a fragment, "这一段正文提到版权所有。" is a
 * sentence, and a length test cannot tell them apart because a Chinese
 * paragraph fits inside any limit that also admits a real footer line.
 */
const SENTENCE_END = /[.。．！!？?…]$/;

/** A Markdown link, inline form — the shape an ICP filing number takes. */
const MARKDOWN_LINK = /\]\([^)]*\)/;

/** A Markdown list item. */
const LIST_ITEM = /^[*+-]\s+/;

/**
 * How far down the page the title heading may be found.
 *
 * Site navigation above an article is a handful of lines; a heading that
 * repeats the page title this far in belongs to the document.
 */
const PREAMBLE_LINE_LIMIT = 60;

/** Only the part of the document a footer could plausibly live in. */
const FOOTER_SEARCH_FRACTION = 0.65;

/**
 * Explicit site-legal markers.
 *
 * Each entry names a *piece of site furniture*, not a topic: the filing
 * numbers Chinese sites are required to publish, and the copyright
 * notices a footer carries. `copyright` is matched only in the footer
 * position and only on a short line, which is what separates
 * "Copyright © 2009-2025 版权所有" from a sentence *about* copyright.
 */
const FOOTER_MARKER =
  /(?:copyright\s*©?|all rights reserved|版权所有|备案号|icp\s*备(?:案|\s*\d)|浙公网安备|公网安备|互联网宗教信息服务许可证)/i;

/**
 * Comparison key for a title.
 *
 * Removes images, unwraps links to their text, drops emphasis and
 * whitespace, and strips punctuation and symbols, then lowercases. What
 * survives is the letters and digits of the title, which is what makes
 * `### 《金刚经》文白对照` comparable to the page title
 * `《金刚经》文白对照` however the two differ in spacing or emphasis.
 * It is deliberately not a fuzzy match: a title with different characters
 * — or with extra words — is a different title.
 */
function normalizeHeading(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\*_`~]/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLocaleLowerCase();
}

/** The ATX heading text of a line, or `undefined` when it is not a heading. */
function headingText(line: string): string | undefined {
  return /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
}

/** A line without its terminator, for length and marker tests. */
const bare = (line: string) => line.replace(/\r?\n$/, "");

/**
 * Whether a line reads as a footer *notice* rather than a mention of one.
 *
 * Four conditions, each ruling out a specific false positive:
 *
 *   1. it carries an explicit legal marker;
 *   2. it is not a heading — structure is content;
 *   3. it is short — a footer line is a fragment, not a block;
 *   4. it reads as a notice rather than a sentence: a link or a list item
 *      is furniture whatever it says, and otherwise the line must not end
 *      in sentence-final punctuation.
 *
 * Condition 4 is what protects prose. A sentence *about* copyright is a
 * sentence and ends like one; `Copyright © 2009-2025 版权所有` and
 * `浙公网安备33010002000123号` do not. Being wrong here deletes the
 * reader's content, so the rule is deliberately one-sided: a genuine
 * footer written as a full sentence is kept rather than risk a paragraph
 * being cut.
 */
function isFooterMarker(line: string): boolean {
  const text = bare(line).trim();
  if (text.length === 0 || text.length > FOOTER_LINE_LIMIT) return false;
  if (headingText(text) !== undefined) return false;
  if (!FOOTER_MARKER.test(text)) return false;
  if (MARKDOWN_LINK.test(text) || LIST_ITEM.test(text)) return true;
  return !SENTENCE_END.test(text);
}

/**
 * Whether everything from `from` to the end of the document is short
 * enough to be a furniture block.
 *
 * This is the guard that protects the article's own last section: real
 * prose in a Chinese article is long, so a marker followed by prose fails
 * here and the document is left alone.
 */
function tailLooksLikeFurniture(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i += 1) {
    if (bare(lines[i]!).trim().length > FOOTER_LINE_LIMIT) return false;
  }
  return true;
}

/**
 * Trim Jina page chrome from `markdown`.
 *
 * `pageTitle` is the title Jina reported for the page (the envelope's
 * `data.title`). It governs the preamble rule only: with no title there is
 * nothing to identify the article's first heading by, so no preamble is
 * trimmed. The footer rule does not depend on it — an explicit legal
 * marker near the end of a short tail is evidence on its own — so a
 * footer is still trimmed for a caller that has no title.
 */
export function cleanJinaMarkdown(markdown: string, pageTitle?: string): string {
  if (markdown.length === 0) return markdown;
  markdown = normalizeJinaStrongJoins(markdown);
  // Split with the terminators kept, so `lines.slice(start, end).join("")`
  // reproduces the original bytes of the kept region exactly. A plain
  // `split("\n")`/`join("\n")` would silently rewrite CRLF files.
  const lines = markdown.split(/(?<=\n)/);
  const tree = markdownParser.parse(markdown);
  const protectedLines = new Set<number>();
  const protect = (node: Nodes): void => {
    if (node.type === "code" || node.type === "html" || node.type === "definition") {
      if (node.position) {
        for (let n = node.position.start.line; n <= node.position.end.line; n += 1) {
          protectedLines.add(n - 1);
        }
      }
    } else if ("children" in node) node.children.forEach(protect);
  };
  protect(tree);
  const headingLines = new Set(tree.children
    .filter((node) => node.type === "heading")
    .map((node) => (node.position?.start.line ?? 0) - 1));

  let start = 0;
  const targetTitle = pageTitle?.trim() ? normalizeHeading(pageTitle) : "";
  if (targetTitle) {
    const limit = Math.min(lines.length, PREAMBLE_LINE_LIMIT);
    for (let i = 0; i < limit; i += 1) {
      if (!headingLines.has(i)) continue;
      const heading = headingText(bare(lines[i]!));
      if (heading !== undefined && normalizeHeading(heading) === targetTitle) {
        start = i;
        break;
      }
    }
  }

  let end = lines.length;
  const tailStart = Math.max(start, Math.floor(lines.length * FOOTER_SEARCH_FRACTION));
  for (let i = tailStart; i < lines.length; i += 1) {
    if (!protectedLines.has(i) && isFooterMarker(lines[i]!) &&
        !lines.slice(i).some((_, offset) => protectedLines.has(i + offset)) &&
        tailLooksLikeFurniture(lines, i)) {
      end = i;
      break;
    }
  }

  if (start === 0 && end === lines.length) return markdown;

  // The blank line that separated the article from its footer belongs to
  // the footer. Only trailing blank lines are dropped, and only when a cut
  // actually happened — never in the untouched case above.
  while (end > start && bare(lines[end - 1]!).trim().length === 0) end -= 1;

  const cleaned = lines.slice(start, end).join("");
  // A footer marker that swallowed the whole document means the marker
  // test was wrong, not that the page had no article. Keep the original.
  return cleaned.trim().length > 0 ? cleaned : markdown;
}
