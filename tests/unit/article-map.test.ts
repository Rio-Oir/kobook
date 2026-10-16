// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Server block → local paragraph mapping.
 *
 * `toLocalParagraph` is the single seam between the parse layer's
 * `ContentBlock` and the `Paragraph` the Reader renders. It is worth a
 * test of its own because it was, until recently, silently lossy: it
 * copied `index`, `text`, `hash`, `blockId` and `type` but dropped
 * `level`, `lang` and `ordered`. Everything upstream was correct — the
 * extractors record heading depth, the `paragraph` table stores it, the
 * wire carries it — and then a five-line function threw the document's
 * hierarchy away, so every article rendered as a flat stack of
 * paragraphs no matter how well structured the source was.
 *
 * The fields are optional on `Paragraph` so that the many fixtures which
 * supply only `{index, text, hash}` keep compiling; that makes an
 * accidental drop *type-safe*, which is exactly why it needs asserting
 * at runtime.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { anonymousDocumentToLocalArticle, localArticleKeyFor } from "../../src/lib/articles.js";
import type { ParsedDocument } from "../../shared/contracts/index.js";

/** A document shaped like the Markdown extractor's output. */
function documentWith(blocks: ParsedDocument["blocks"]): ParsedDocument {
  return {
    title: "带层级的文章",
    author: null,
    blocks,
    source: "markdown-remark",
    extractorVersion: "phase1.1",
    textHash: "0".repeat(64),
  };
}

test("heading depth survives the mapping", () => {
  const local = anonymousDocumentToLocalArticle(
    documentWith([
      {
        id: "b1-aaaaaaaa",
        index: 1,
        type: "heading",
        text: "第一章",
        hash: "h".repeat(64),
        level: 2,
      },
    ]),
  );
  assert.equal(local.paragraphs[0]!.type, "heading");
  assert.equal(local.paragraphs[0]!.level, 2, "heading depth must reach the reader");
});

test("code fence language and list kind survive the mapping", () => {
  const local = anonymousDocumentToLocalArticle(
    documentWith([
      {
        id: "b1-bbbbbbbb",
        index: 1,
        type: "code",
        text: "const x = 1;",
        hash: "h".repeat(64),
        lang: "ts",
      },
      {
        id: "b2-cccccccc",
        index: 2,
        type: "listItem",
        text: "第一步",
        hash: "i".repeat(64),
        ordered: true,
      },
    ]),
  );
  assert.equal(local.paragraphs[0]!.lang, "ts");
  assert.equal(local.paragraphs[1]!.ordered, true);
});

test("inline emphasis survives the mapping", () => {
  // Same class of loss as the heading depth above, caught before it happened
  // this time: an emitter that drops `spans` would leave every article's bold
  // and links on the server and render plain text, with nothing failing — the
  // spans are optional, so the type checker stays quiet.
  const local = anonymousDocumentToLocalArticle(
    documentWith([
      {
        id: "b1-11111111",
        index: 1,
        type: "paragraph",
        text: "一段 粗体 尾",
        hash: "h".repeat(64),
        spans: [
          { start: 3, end: 5, kinds: ["strong"] },
          { start: 5, end: 6, kinds: ["link"], href: "https://example.com/" },
        ],
      },
    ]),
  );
  assert.deepEqual(local.paragraphs[0]!.spans, [
    { start: 3, end: 5, kinds: ["strong"] },
    { start: 5, end: 6, kinds: ["link"], href: "https://example.com/" },
  ]);
});

test("absent optional fields stay absent rather than becoming nulls", () => {
  // A paragraph block carries no level/lang/ordered/spans, and the mapper must
  // not invent them: `blockKindOf` reads a missing `type` as prose, and
  // `headingTag` defaults a missing level — inventing values here would
  // make a plain paragraph look like a heading.
  const local = anonymousDocumentToLocalArticle(
    documentWith([
      {
        id: "b1-dddddddd",
        index: 1,
        type: "paragraph",
        text: "正文。",
        hash: "h".repeat(64),
      },
    ]),
  );
  const block = local.paragraphs[0]!;
  assert.equal(block.type, "paragraph");
  assert.equal(block.level, undefined);
  assert.equal(block.lang, undefined);
  assert.equal(block.ordered, undefined);
  // Absent means "no emphasis", which is what every block parsed before the
  // extractors recorded it means. `segmentBlock` reads it as plain text.
  assert.equal(block.spans, undefined);
});

test("the anchor fields are untouched", () => {
  // `text`, `hash` and `blockId` are the note/highlight coordinate
  // system; carrying the new structural fields must not disturb them.
  const local = anonymousDocumentToLocalArticle(
    documentWith([
      {
        id: "b7-eeeeeeee",
        index: 7,
        type: "heading",
        text: "第七个块",
        hash: "abcdef0123456789".repeat(4),
        level: 3,
      },
    ]),
  );
  const block = local.paragraphs[0]!;
  assert.equal(block.index, 7);
  assert.equal(block.text, "第七个块");
  assert.equal(block.blockId, "b7-eeeeeeee");
  assert.equal(block.hash, "abcdef012345", "the client keeps its 12-char truncation");
});

// ── Local article identity: same text, different formatting ─────────────

/**
 * `localArticleKeyFor` decides which store row a paste lands on.
 *
 * The case worth pinning is the *formatting-only* change. The document
 * `textHash` is over the normalised text of every block, so `**粗体**`
 * and `粗体` hash identically while producing different `blocks` (the
 * second carries no `spans`). Reusing the row would keep the old
 * `remoteId`, so the cloud copy would hold the previous formatting while
 * the local notes still claim to point at it.
 *
 * The fixtures below take an explicit `textHash` rather than reusing
 * `documentWith`, because the whole point is which *pairs* of
 * (textHash, blocks) collide.
 */
function docWith(textHash: string, blocks: ParsedDocument["blocks"]): ParsedDocument {
  return {
    title: "带格式的文章",
    author: null,
    blocks,
    source: "markdown-remark",
    extractorVersion: "phase1.2",
    textHash,
  };
}

const PLAIN_BLOCK = {
  id: "b1-aaaaaaaa",
  index: 1,
  type: "paragraph" as const,
  text: "正文。",
  hash: "aaaaaaaaaaaaaaaa",
};
const BOLD_BLOCK = { ...PLAIN_BLOCK, spans: [{ start: 0, end: 2, kinds: ["strong" as const] }] };

test("localArticleKeyFor: a re-paste of identical blocks keeps the base key", () => {
  const doc = docWith("h".repeat(64), [PLAIN_BLOCK]);
  const first = anonymousDocumentToLocalArticle(doc);
  first.syncDocument = doc;
  assert.equal(localArticleKeyFor(doc, undefined), first.id);
  assert.equal(localArticleKeyFor(doc, first), first.id, "same blocks must reuse the row");
});

test("localArticleKeyFor: a row with no recorded document is not overwritten", () => {
  // Rows written before `syncDocument` existed (or built by any path
  // that did not store it) cannot be proven identical — the `paragraph`
  // projection is not structurally equal to a `ContentBlock` (truncated
  // hash, no `spans`). The rule takes the suffixed key rather than
  // guessing, so a false negative costs one redundant row and a false
  // positive would cost someone else's notes.
  const doc = docWith("h".repeat(64), [PLAIN_BLOCK]);
  const legacy = anonymousDocumentToLocalArticle(doc);
  assert.equal(legacy.syncDocument, undefined);
  const key = localArticleKeyFor(doc, legacy);
  assert.notEqual(key, legacy.id, "cannot prove equal ⇒ do not reuse");
  assert.ok(key.startsWith(legacy.id));
});

test("localArticleKeyFor: a formatting-only change gets its own key, leaving the old row intact", () => {
  // Same normalised text for every block, therefore the same document
  // hash: this is the whole point of the case.
  const sharedHash = "h".repeat(64);
  const plain = docWith(sharedHash, [PLAIN_BLOCK]);
  const bold = docWith(sharedHash, [BOLD_BLOCK]);
  assert.equal(plain.textHash, bold.textHash);

  const existing = anonymousDocumentToLocalArticle(plain);
  existing.syncDocument = plain;
  existing.remoteId = "remote-plain";
  existing.remoteVersionId = "version-plain";

  const boldKey = localArticleKeyFor(bold, existing);
  assert.notEqual(boldKey, existing.id, "a formatting change must not overwrite the row");
  assert.ok(boldKey.startsWith(existing.id), "the new key stays recognisably related");
  // Deterministic: the same change always maps to the same key, so a
  // refresh that re-imports the bold version does not mint a third row.
  assert.equal(localArticleKeyFor(bold, existing), boldKey);
  // And the old row is not mutated by asking.
  assert.equal(existing.remoteId, "remote-plain");
  assert.equal(existing.remoteVersionId, "version-plain");
});

test("localArticleKeyFor: a text change simply uses the new base key", () => {
  // How `Home` calls it: the lookup is at `local-<new textHash prefix>`,
  // so a genuinely different article finds nothing there and takes the
  // plain base key.
  const before = docWith("a".repeat(64), [PLAIN_BLOCK]);
  const after = docWith("b".repeat(64), [
    { ...PLAIN_BLOCK, id: "b1-bbbbbbbb", text: "第二版。", hash: "bbbbbbbbbbbbbbbb" },
  ]);
  assert.equal(
    localArticleKeyFor(after, undefined),
    `local-${after.textHash.slice(0, 16)}`,
    "a distinct textHash needs no suffix — there is no collision to disambiguate",
  );
  assert.notEqual(localArticleKeyFor(after, undefined), anonymousDocumentToLocalArticle(before).id);
});

test("localArticleKeyFor: an unrelated row sitting at the base key is never overwritten", () => {
  // Defensive shape: if something *else* occupies the base key (a hand-
  // edited store, a hash-prefix collision), the rule falls back to the
  // suffixed key rather than clobbering notes that belong to another
  // document.
  const other = docWith("c".repeat(64), [
    { ...PLAIN_BLOCK, id: "b1-cccccccc", text: "完全不同的正文。", hash: "cccccccccccccccc" },
  ]);
  const incoming = docWith("d".repeat(64), [PLAIN_BLOCK]);
  const sitting = anonymousDocumentToLocalArticle(other);
  sitting.syncDocument = other;
  const key = localArticleKeyFor(incoming, sitting);
  assert.notEqual(key, sitting.id);
  assert.ok(key.startsWith(`local-${incoming.textHash.slice(0, 16)}`));
});
