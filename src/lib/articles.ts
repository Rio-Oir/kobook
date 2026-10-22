// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontend client for anonymous URL extraction, and the pure mapping from a
 * parsed document to a local article.
 *
 * Base owns both halves of this module. Reading an article the user pasted or
 * fetched is not an account feature, so a signed-out reader goes through
 * `extractAnonymous` — the server's anonymous extractor, the same
 * `ParsedDocument` shape, but nothing is written to a database and no user row
 * is created.
 *
 * The account-side article client (import to a library, list, delete, export,
 * upload) is **not** here. It is part of the value-added line and is
 * installed through `cloud/contract.ts`; base has no endpoint to call for it
 * and no type that names it.
 *
 * `anonymousDocumentToLocalArticle` and `localArticleKeyFor` are the reason
 * this file stays in base: they are what makes a re-import idempotent and what
 * keeps a note anchored across a refresh, and both are properties of the local
 * data format rather than of any server.
 */

import {
  ROUTES,
  type AnonymousExtractRequest,
  type AnonymousExtractResponse,
  type ContentBlock,
  type ParsedDocument,
} from "./types";
import { ApiRequestError, apiRequest } from "./api-error";
import { sha256Hex, documentTextHash, EXTRACTOR_VERSION } from "./local-import-blocks";
import { CHROME_IMAGE_PATTERN } from "./import/image-url";
import type { Article, ArticleDraft, Paragraph } from "./types";

/**
 * Rebuild the upload document for an article whose text is already stored.
 *
 * Replaces reading `Article.syncDocument` back off the record. That field held
 * a verbatim copy of the parsed document so a retry after a reload could
 * re-send exactly what the first attempt would have — at the cost of storing
 * the article's text a second time, in the same `localStorage` key, for every
 * article that had ever been through the extractor.
 *
 * The body is now the only copy, and it is sufficient: `Paragraph` carries the
 * block id, kind, level/lang/ordered, the inline spans and the **full** hash,
 * which together reconstruct a `ContentBlock` that the sync route will accept.
 * (The hash used to be stored truncated, which made this impossible — that is
 * why `Paragraph.hash` is now the whole digest.)
 *
 * `source` is a provenance label, not a claim about who parsed what. The
 * *channel* a synced document arrived through travels separately, as the sync
 * request's own `source` field. A rebuilt document came from a paste
 * (`markdown-remark`) unless the article records a URL channel.
 */
export function documentFromArticle(
  article: Article,
  paragraphs: readonly Paragraph[],
): ParsedDocument {
  const blocks: ContentBlock[] = paragraphs.map((p) => {
    const block: ContentBlock = {
      // A paragraph written before the parse layer stamped an id falls back to
      // the documented derivation, which is what `BlockCollector` would have
      // produced for the same index and text.
      id: p.blockId ?? `b${p.index}-${p.hash.slice(0, 8)}`,
      index: p.index,
      type: p.type ?? "paragraph",
      text: p.text,
      hash: p.hash,
    };
    if (block.type === "heading") block.level = p.level ?? 1;
    if (block.type === "code") block.lang = p.lang ?? null;
    if (block.type === "listItem") {
      block.ordered = p.ordered ?? false;
      block.depth = p.depth ?? 0;
      if (p.task) {
        block.task = true;
        block.checked = p.checked === true;
      }
    }
    if (block.type === "image") {
      if (p.src) block.src = p.src;
      if (p.alt) block.alt = p.alt;
      if (p.title) block.title = p.title;
    }
    if (block.type === "table" && p.rows && p.rows.length > 0) block.rows = p.rows;
    if (p.spans && p.spans.length > 0) block.spans = p.spans;
    return block;
  });
  return {
    title: article.title,
    author: article.author ?? null,
    blocks,
    source:
      article.syncSource === "local" || article.syncSource === undefined
        ? "markdown-remark"
        : "html-readability",
    extractorVersion: EXTRACTOR_VERSION,
    textHash: documentTextHash(blocks),
  };
}

/**
 * A stable digest of the exact blocks a document was parsed into.
 *
 * The record keeps this instead of keeping the document. It answers the one
 * question the old `syncDocument` copy was retained for — "are these the same
 * blocks?" — without holding a second copy of the article's text in
 * `localStorage`, and it is the same value that names the suffixed local key.
 */
export function blocksDigest(blocks: readonly ContentBlock[]): string {
  return sha256Hex(JSON.stringify(blocks));
}

/**
 * Localise an error from the extraction path.
 *
 * The wording no longer promises "下一阶段上线" — URL import works for
 * anonymous readers, so telling them it is not available would be false. What
 * remains true is that some sources cannot be reached, and the server's own
 * Chinese message already says which.
 */
function localizeImportError(err: ApiRequestError): ApiRequestError {
  if (err.code === "EMPTY_ARTICLE") {
    return new ApiRequestError(
      "未能从内容中提取正文，请尝试粘贴更完整的文章。",
      err.status,
      err.code,
      err.requestId,
    );
  }
  return err;
}

/**
 * Extract content anonymously: the server parses it with the same extractors
 * the account import uses, returns the same document shape, and writes
 * nothing.
 *
 * This is the path a signed-out reader uses, and it is why reading does not
 * require an account. No key, no email verification, no session.
 */
export async function extractAnonymous(
  input: AnonymousExtractRequest,
): Promise<AnonymousExtractResponse> {
  try {
    return await apiRequest<AnonymousExtractResponse>(ROUTES.anonymousExtract, {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    if (err instanceof ApiRequestError) throw localizeImportError(err);
    throw err;
  }
}

/**
 * Map a server `ContentBlock` to the local `Paragraph` shape.
 *
 * The block id and block kind are carried through: the id is what lets a note
 * name the exact occurrence of a duplicated paragraph, and the kind is what
 * lets the reader render headings and code differently from prose without a
 * second round trip. `level`, `lang` and `ordered` ride along for the same
 * reason — the parse layer stores them, so dropping them here would throw away
 * a Markdown document's whole hierarchy one function before it is rendered.
 *
 * Exported because the account library needs the identical mapping when it
 * pulls a server article down (`account-articles.ts`). Two converters that
 * have to agree is how a body ends up with a hash the sync upload will not
 * accept; there is one, and it is here.
 */
export function toLocalParagraph(block: ContentBlock): Paragraph {
  return {
    index: block.index,
    text: block.text,
    // The full digest, not a prefix: the sync upload re-derives it from `text`
    // and refuses a mismatch, so a truncated value would make the article
    // permanently un-uploadable. See `Paragraph.hash` in `types.ts`.
    hash: block.hash,
    blockId: block.id,
    type: block.type,
    level: block.level,
    lang: block.lang,
    ordered: block.ordered,
    ...(block.type === "listItem" && block.depth !== undefined ? { depth: block.depth } : {}),
    ...(block.task ? { task: true, checked: block.checked === true } : {}),
    ...(block.src ? { src: block.src } : {}),
    ...(block.alt ? { alt: block.alt } : {}),
    ...(block.title ? { title: block.title } : {}),
    ...(block.type === "table" && block.rows ? { rows: block.rows } : {}),
    spans: block.spans,
  };
}

/**
 * Pictures that are page furniture rather than the article's own image.
 *
 * A scraped page's first `<img>` is very often a logo, an avatar or a tracking
 * pixel; using one of those as the cover is worse than using the default
 * painting. The names are matched as whole path/name segments so
 * `photo-logo-forest.jpg` still passes.
 *
 * The pattern itself lives in `lib/import/image-url.ts`, next to the rest of
 * the "is this address a picture" rules, so the extractor that decides what to
 * store and this module that decides what to promote cannot disagree.
 */
const COVER_IMAGE_EXCLUDE = CHROME_IMAGE_PATTERN;

/** A source the reader is allowed to put in an `<img>` at all. */
function usableCoverSource(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const value = src.trim();
  if (value.length === 0 || value.length > 2048) return undefined;
  if (!/^(?:https?:\/\/|\/)/i.test(value)) return undefined;
  return value;
}

/** The first image block that reads as content, not chrome. */
export function coverImageFromBlocks(blocks: readonly ContentBlock[]): string | undefined {
  for (const block of blocks) {
    if (block.type !== "image") continue;
    const src = usableCoverSource(block.src);
    if (!src || COVER_IMAGE_EXCLUDE.test(src)) continue;
    return src;
  }
  return undefined;
}

/** The same rule over stored paragraphs (a body loaded from the account). */
export function coverImageFromParagraphs(
  paragraphs: readonly Paragraph[],
): string | undefined {
  for (const paragraph of paragraphs) {
    if (paragraph.type !== "image") continue;
    const src = usableCoverSource(paragraph.src);
    if (!src || COVER_IMAGE_EXCLUDE.test(src)) continue;
    return src;
  }
  return undefined;
}

/**
 * Convert an anonymous extraction into the local shape.
 *
 * Two values, not one: the record and the text are stored separately now, and
 * a function that returned them fused would have to be undone by every caller.
 *
 * The id is derived from the document's own `textHash`, not from the clock, so
 * re-extracting the same article produces the same local id. That is what
 * keeps a double-submit (a double click, a retry after a dropped response)
 * from filling storage with two copies of one article — and it means a
 * refresh that re-extracts the same text does not orphan the highlights
 * anchored to it.
 */
export function anonymousDocumentToLocalArticle(document: ParsedDocument): {
  article: ArticleDraft;
  paragraphs: Paragraph[];
} {
  // The page's own share image wins; when it declares none, the first content
  // image stands in. Both are "the article's picture"; only when neither
  // exists does the reader show the default cover library.
  const coverImage = document.coverImage ?? coverImageFromBlocks(document.blocks);
  return {
    article: {
      id: `local-${document.textHash.slice(0, 16)}`,
      title: document.title,
      author: document.author ?? undefined,
      createdAt: Date.now(),
      ...(coverImage ? { coverImage } : {}),
      // Kept so a later import of the same text can prove these are the same
      // blocks. It is derived here, where the blocks are in hand, because once
      // they are a body the record has no way back to them.
      blocksDigest: blocksDigest(document.blocks),
    },
    paragraphs: document.blocks.map(toLocalParagraph),
  };
}

/**
 * The local store key a freshly parsed document should be saved under, given
 * whatever already occupies the obvious slot.
 *
 * Two rules, and the second is the one that needed deciding:
 *
 *  1. **The default key is the document's `textHash`**, so re-importing the
 *     same text lands on the same row (`anonymousDocumentToLocalArticle`).
 *     That is what makes a double-submit idempotent and keeps a note anchored
 *     across a refresh.
 *
 *  2. **Same textHash, different blocks ⇒ a distinct key.** The text hash
 *     covers the *normalised text* of every block, so it does not change when
 *     only the *formatting* does: pasting `**粗体**` and then `粗体` yields the
 *     same `textHash` and a different `blocks` array (the second has no
 *     `spans`). Overwriting the row in place would keep the old `remoteId`,
 *     and a cloud copy would then hold the *previous* formatting while every
 *     local note still claims to point at it — a silent mismatch between the
 *     note anchors and the document they were measured against. So a
 *     formatting-only change gets its own key, and the old article (with its
 *     notes and its remote binding) stays intact and reachable.
 *
 *  3. **Equality has to be provable.** The record keeps `blocksDigest`, a
 *     digest of the exact blocks it was parsed from — and nothing else. When
 *     the digest is absent (an article written before the field existed, or
 *     one whose text arrived without blocks) equality cannot be proven, so the
 *     row takes the suffixed key. That is deliberate: a false negative costs
 *     one redundant row, a false positive would cost someone's notes.
 *
 * The suffix is a digest of the blocks, not a counter or a timestamp, so the
 * same formatting change always maps to the same key.
 */
export function localArticleKeyFor(
  document: ParsedDocument,
  existing: Article | undefined,
): string {
  const base = `local-${document.textHash.slice(0, 16)}`;
  if (!existing) return base;
  const digest = blocksDigest(document.blocks);
  if (existing.blocksDigest !== digest) {
    return `${base}-${digest.slice(0, 12)}`;
  }
  return base;
}
