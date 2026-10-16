// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Frontend client for anonymous URL extraction, and the pure mapping from a
 * parsed document to a local article.
 *
 * Both halves of this module belong to the reader. Reading an article the user
 * pasted or fetched is not an account feature, so a signed-out reader goes
 * through `extractAnonymous` — the server's anonymous extractor, the same
 * `ParsedDocument` shape, but nothing is written to a database and no user row
 * is created.
 *
 * The account-side article client (import to a hosted library, list, delete,
 * export, upload) is **not** here. If a deployment has one, it is installed
 * through `cloud/contract.ts`; this module has no endpoint to call for it and
 * no type that names it.
 *
 * `anonymousDocumentToLocalArticle` and `localArticleKeyFor` are the reason
 * this file stays: they are what makes a re-import idempotent and what keeps a
 * note anchored across a refresh, and both are properties of the local data
 * format rather than of any server.
 */

import {
  ROUTES,
  type AnonymousExtractRequest,
  type AnonymousExtractResponse,
  type ContentBlock,
  type ParsedDocument,
} from "./types";
import { ApiRequestError, apiRequest } from "./api-error";
import { sha256Hex } from "./local-import-blocks";
import type { Article as LocalArticle, Paragraph as LocalParagraph } from "./types";

/**
 * Localise an error from the extraction path.
 *
 * The wording must not tell the reader that URL import is unavailable — it
 * works for anonymous readers, so saying otherwise would be false. What
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
 * Map a server `ContentBlock` to the legacy local `Paragraph` shape.
 *
 * The block id and block kind are carried through: the id is what lets a note
 * name the exact occurrence of a duplicated paragraph, and the kind is what
 * lets the reader render headings and code differently from prose without a
 * second round trip. `level`, `lang` and `ordered` ride along for the same
 * reason — the parse layer stores them, so dropping them here would throw away
 * a Markdown document's whole hierarchy one function before it is rendered.
 */
function toLocalParagraph(block: ContentBlock): LocalParagraph {
  return {
    index: block.index,
    text: block.text,
    hash: block.hash.slice(0, 12),
    blockId: block.id,
    type: block.type,
    level: block.level,
    lang: block.lang,
    ordered: block.ordered,
    spans: block.spans,
  };
}

/**
 * Convert an anonymous extraction into the local shape.
 *
 * The id is derived from the document's own `textHash`, not from the clock, so
 * re-extracting the same article produces the same local id. That is what
 * keeps a double-submit (a double click, a retry after a dropped response)
 * from filling localStorage with two copies of one article — and it means a
 * refresh that re-extracts the same text does not orphan the highlights
 * anchored to it.
 */
export function anonymousDocumentToLocalArticle(document: ParsedDocument): LocalArticle {
  return {
    id: `local-${document.textHash.slice(0, 16)}`,
    title: document.title,
    author: document.author ?? undefined,
    paragraphs: document.blocks.map(toLocalParagraph),
    createdAt: Date.now(),
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
 *  3. **Equality has to be provable.** `existing.syncDocument` is the only
 *     field that records the document verbatim; the fallback
 *     `existing.paragraphs` is a *projection* (truncated `hash`, no `spans`),
 *     so it is never structurally equal to a `ContentBlock` and a row that
 *     lacks `syncDocument` therefore takes the suffixed key. That is
 *     deliberate: a false negative costs one redundant row, a false positive
 *     would cost someone else's notes.
 *
 * The suffix is a digest of the blocks, not a counter or a timestamp, so the
 * same formatting change always maps to the same key.
 */
export function localArticleKeyFor(
  document: ParsedDocument,
  existing: LocalArticle | undefined,
): string {
  const base = `local-${document.textHash.slice(0, 16)}`;
  if (!existing) return base;
  const existingBlocks = existing.syncDocument?.blocks ?? existing.paragraphs;
  if (JSON.stringify(existingBlocks) !== JSON.stringify(document.blocks)) {
    return `${base}-${sha256Hex(JSON.stringify(document.blocks)).slice(0, 12)}`;
  }
  return base;
}
