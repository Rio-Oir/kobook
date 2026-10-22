// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The article's own cover image.
 *
 * The rule the reader sees: a page that came with a picture is shown with that
 * picture; only an article with no picture of its own falls back to the bundled
 * paintings. These are the pure decisions behind that rule — which picture is
 * chosen from a parsed document, and which source `coverArtFor` prefers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  anonymousDocumentToLocalArticle,
  coverImageFromBlocks,
  coverImageFromParagraphs,
} from "../../src/lib/articles.js";
import { serverToLocalArticle } from "../../src/lib/account-articles.js";
import { coverArtFor, coverImagePath } from "../../src/lib/covers.js";
import type { ContentBlock, Paragraph, ParsedDocument } from "../../src/lib/types.js";

function block(overrides: Partial<ContentBlock>): ContentBlock {
  return {
    id: "b1-aaaaaaaa",
    index: 1,
    type: "image",
    text: "图",
    hash: "hash",
    ...overrides,
  } as ContentBlock;
}

function paragraph(overrides: Partial<Paragraph>): Paragraph {
  return { index: 1, text: "图", hash: "hash", type: "image", ...overrides } as Paragraph;
}

function document(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    title: "测试文章",
    author: null,
    blocks: [block({ index: 1, text: "正文", type: "paragraph" })],
    source: "html-readability",
    extractorVersion: "test",
    textHash: "0123456789abcdef",
    ...overrides,
  } as ParsedDocument;
}

test("the first content image is the cover; chrome and unsafe schemes are skipped", () => {
  const blocks = [
    block({ index: 1, type: "paragraph", text: "正文" }),
    block({ index: 2, src: "/assets/logo.png" }),
    block({ index: 3, src: "data:image/png;base64,AAAA" }),
    block({ index: 4, src: "https://cdn.example.test/photo.jpg" }),
    block({ index: 5, src: "https://cdn.example.test/second.jpg" }),
  ];
  assert.equal(coverImageFromBlocks(blocks), "https://cdn.example.test/photo.jpg");
  // No usable image at all → undefined, which is what makes the default
  // painting take over instead of a broken image box.
  assert.equal(coverImageFromBlocks([block({ index: 1, src: "/logo.svg" })]), undefined);
  assert.equal(coverImageFromBlocks([]), undefined);
});

test("the same rule reads a stored body (a pulled article)", () => {
  const paragraphs = [
    paragraph({ index: 1, type: "paragraph", text: "正文" }),
    paragraph({ index: 2, src: "/icons/icon.png" }),
    paragraph({ index: 3, src: "https://cdn.example.test/hero.jpg" }),
  ];
  assert.equal(coverImageFromParagraphs(paragraphs), "https://cdn.example.test/hero.jpg");
  assert.equal(coverImageFromParagraphs([]), undefined);
});

test("a page's own share image beats the first body image", () => {
  const withShare = document({
    coverImage: "https://cdn.example.test/og.jpg",
    blocks: [block({ index: 1, src: "https://cdn.example.test/body.jpg" })],
  });
  assert.equal(
    anonymousDocumentToLocalArticle(withShare).article.coverImage,
    "https://cdn.example.test/og.jpg",
  );

  const bodyOnly = document({
    blocks: [block({ index: 1, src: "https://cdn.example.test/body.jpg" })],
  });
  assert.equal(
    anonymousDocumentToLocalArticle(bodyOnly).article.coverImage,
    "https://cdn.example.test/body.jpg",
  );

  // Nothing of its own: no field at all, so the default library applies.
  const plain = document();
  assert.equal(anonymousDocumentToLocalArticle(plain).article.coverImage, undefined);
});

test("a pulled article derives its cover from the paragraphs it brought", () => {
  const detail = {
    article: { id: "art-1", title: "云端文章", importedAt: "2026-10-01T00:00:00.000Z", sourceUrl: null },
    version: {
      id: "ver-1",
      paragraphs: [
        { index: 1, text: "正文", hash: "h1", type: "paragraph", blockId: "b1", spans: [] },
        {
          index: 2,
          text: "图",
          hash: "h2",
          type: "image",
          blockId: "b2",
          src: "https://cdn.example.test/pulled.jpg",
        },
      ],
    },
  };
  const { article } = serverToLocalArticle(detail as never);
  assert.equal(article.coverImage, "https://cdn.example.test/pulled.jpg");
});

test("coverArtFor prefers the article's own image, then the bundled library", () => {
  const own = coverArtFor("标题", "art-1", "https://cdn.example.test/own.jpg");
  assert.equal(own.image, "https://cdn.example.test/own.jpg");

  // No picture of its own: one of the 12 bundled paintings, chosen by the
  // article id. That library exists exactly for this case — an article with
  // no image of its own still gets a cover instead of a bare wash.
  const library = coverArtFor("标题", "art-1");
  assert.match(String(library.image), /^\/covers\/\d{2}\.webp$/);

  // A scheme the reader would refuse is ignored rather than rendered, so it
  // falls back to the painting rather than to nothing.
  const unsafe = coverArtFor("标题", "art-1", "javascript:alert(1)");
  assert.match(String(unsafe.image), /^\/covers\/\d{2}\.webp$/);
});

test("a bundled painting is addressed under the application base", () => {
  // The release build is served from `/reader/`. A hard-coded `/covers/…`
  // asks the site root instead — a different site, answering 404 — and the
  // picture silently disappeared behind the wash on every deployed article
  // that had no image of its own.
  assert.equal(coverImagePath(3, "/reader/"), "/reader/covers/03.webp");
  assert.equal(coverImagePath(3, "/base/"), "/base/covers/03.webp");
  // Dev serves from the root, and so does the unit-test environment (no
  // `import.meta.env` at all).
  assert.equal(coverImagePath(3, "/"), "/covers/03.webp");
  // A base without its trailing slash still yields one slash, not two.
  assert.equal(coverImagePath(3, "/reader"), "/reader/covers/03.webp");
});
