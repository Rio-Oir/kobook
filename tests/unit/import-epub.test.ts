// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * EPUB import.
 *
 * Fixtures are synthetic books built by `tests/helpers/epub-fixture.ts`, so
 * the assertions are about the importer's reading of the format rather than
 * about any particular real book.
 *
 * The case that carries the most weight is the spine-order one. A manifest is
 * usually alphabetical and the spine is not, so an importer that walks the
 * manifest produces a book whose chapters are in the wrong order — a failure
 * that looks like "the book is fine, the author wrote it oddly" rather than
 * like a bug.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildEpub } from "../helpers/epub-fixture.js";
import { buildZip, bytes } from "../helpers/zip-builder.js";
import { parseEpub, resolveEpubPath } from "../../src/lib/import/epub.js";

const jsdom = new JSDOM();
(globalThis as { DOMParser: unknown }).DOMParser = jsdom.window.DOMParser;

async function parse(bytesIn: Uint8Array, options: Parameters<typeof parseEpub>[1] = {}) {
  const result = await parseEpub(bytesIn, options);
  assert.ok(result.ok, `expected a successful parse, got ${JSON.stringify(result)}`);
  return result.document;
}

test("a basic EPUB yields its metadata and its chapters' text", async () => {
  const doc = await parse(await buildEpub());
  assert.equal(doc.title, "测试书籍");
  assert.equal(doc.author, "测试作者");
  assert.equal(doc.source, "epub-dom");

  const texts = doc.blocks.map((b) => b.text);
  assert.deepEqual(texts, ["第一章", "第一章的正文。", "第二章", "第二章的正文。"]);
  // The chapter headings become heading blocks, which is what puts chapters in
  // the reader's outline without any extra table-of-contents parsing.
  assert.equal(doc.blocks[0]?.type, "heading");
  assert.equal(doc.blocks[0]?.level, 1);
});

test("an explicit title overrides the OPF metadata", async () => {
  const doc = await parse(await buildEpub(), { title: "文件名" });
  assert.equal(doc.title, "文件名");
});

test("chapters are read in spine order, not manifest or filename order", async () => {
  // Manifest order is ch1, ch2, ch3; the spine says ch3, ch1, ch2.
  const zip = await buildEpub({
    chapters: [
      { href: "a.xhtml", body: "<p>甲</p>" },
      { href: "b.xhtml", body: "<p>乙</p>" },
      { href: "c.xhtml", body: "<p>丙</p>" },
    ],
    spineOrder: [2, 0, 1],
  });
  const doc = await parse(zip);
  assert.deepEqual(doc.blocks.map((b) => b.text), ["丙", "甲", "乙"]);
});

test("an OPF at the archive root resolves its hrefs against the root", async () => {
  const doc = await parse(
    await buildEpub({
      opfDir: "",
      opfName: "package.opf",
      chapters: [{ href: "text/one.xhtml", body: "<p>根目录的书。</p>" }],
    }),
  );
  assert.deepEqual(doc.blocks.map((b) => b.text), ["根目录的书。"]);
});

test("a deeply nested OPF resolves sibling chapters", async () => {
  const doc = await parse(
    await buildEpub({
      opfDir: "EPUB/package",
      opfName: "book.opf",
      chapters: [{ href: "ch/one.xhtml", body: "<p>嵌套的书。</p>" }],
    }),
  );
  assert.deepEqual(doc.blocks.map((b) => b.text), ["嵌套的书。"]);
});

test("a chapter reaching out of its directory with .. resolves", async () => {
  // `../Text/chapter.xhtml` relative to `OEBPS/package/` lands at
  // `OEBPS/Text/chapter.xhtml`. Real books do this.
  const zip = await buildZip([
    { name: "mimetype", data: bytes("application/epub+zip"), stored: true },
    {
      name: "META-INF/container.xml",
      data: bytes(
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package/content.opf"/></rootfiles></container>',
      ),
    },
    {
      name: "OEBPS/package/content.opf",
      data: bytes(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>越级</dc:title></metadata><manifest><item id="c1" href="../Text/one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
      ),
    },
    {
      name: "OEBPS/Text/one.xhtml",
      data: bytes('<html><body><p>越级引用。</p></body></html>'),
    },
  ]);
  const doc = await parse(zip);
  assert.deepEqual(doc.blocks.map((b) => b.text), ["越级引用。"]);
});

test("resolveEpubPath handles the path shapes real books use", () => {
  assert.equal(resolveEpubPath("OEBPS", "chapter1.xhtml"), "OEBPS/chapter1.xhtml");
  assert.equal(resolveEpubPath("OEBPS", "text/ch1.xhtml"), "OEBPS/text/ch1.xhtml");
  assert.equal(resolveEpubPath("OEBPS/package", "../Text/one.xhtml"), "OEBPS/Text/one.xhtml");
  assert.equal(resolveEpubPath("OEBPS", "./ch1.xhtml"), "OEBPS/ch1.xhtml");
  assert.equal(resolveEpubPath("", "ch1.xhtml"), "ch1.xhtml");
  // hrefs are URIs, so a space arrives percent-encoded
  assert.equal(resolveEpubPath("OEBPS", "my%20chapter.xhtml"), "OEBPS/my chapter.xhtml");
  // a fragment is not part of the entry name
  assert.equal(resolveEpubPath("OEBPS", "ch1.xhtml#section2"), "OEBPS/ch1.xhtml");
});

test("an archive without container.xml is rejected as not an EPUB", async () => {
  const zip = await buildEpub({ includeContainer: false });
  const result = await parseEpub(zip);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PARSE_ERROR");
    assert.match(result.message, /container\.xml/);
  }
});

test("a container pointing at a missing OPF is rejected by name", async () => {
  const zip = await buildEpub({ containerPath: "OEBPS/nowhere.opf" });
  const result = await parseEpub(zip);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /nowhere\.opf/);
});

test("a malformed container is rejected rather than crashing", async () => {
  const zip = await buildZip([
    { name: "META-INF/container.xml", data: bytes("<container><rootfile") },
  ]);
  const result = await parseEpub(zip);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PARSE_ERROR");
});

test("a file that is not a ZIP is rejected with the reader's message", async () => {
  const result = await parseEpub(bytes("%PDF-1.7 not an epub"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PARSE_ERROR");
});

test("a book whose spine names only images is empty, not a crash", async () => {
  const zip = await buildZip([
    { name: "mimetype", data: bytes("application/epub+zip"), stored: true },
    {
      name: "META-INF/container.xml",
      data: bytes(
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      ),
    },
    {
      name: "content.opf",
      data: bytes(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>只有图</dc:title></metadata><manifest><item id="i1" href="cover.jpg" media-type="image/jpeg"/></manifest><spine><itemref idref="i1"/></spine></package>`,
      ),
    },
  ]);
  const result = await parseEpub(zip);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY_CONTENT");
});

test("a book with an empty spine is rejected as empty", async () => {
  const zip = await buildZip([
    { name: "mimetype", data: bytes("application/epub+zip"), stored: true },
    {
      name: "META-INF/container.xml",
      data: bytes(
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      ),
    },
    {
      name: "content.opf",
      data: bytes(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>空书</dc:title></metadata><manifest/><spine/></package>`,
      ),
    },
  ]);
  const result = await parseEpub(zip);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY_CONTENT");
});

test("a missing chapter file is skipped rather than aborting the book", async () => {
  // A spine that references a manifest item whose file is absent is a real
  // defect in real books. Losing that one chapter is better than refusing to
  // open the other nineteen.
  const zip = await buildZip([
    { name: "mimetype", data: bytes("application/epub+zip"), stored: true },
    {
      name: "META-INF/container.xml",
      data: bytes(
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>',
      ),
    },
    {
      name: "content.opf",
      data: bytes(
        `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf">` +
          `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>缺章</dc:title></metadata>` +
          `<manifest>` +
          `<item id="c1" href="present.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c2" href="absent.xhtml" media-type="application/xhtml+xml"/>` +
          `</manifest>` +
          `<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
      ),
    },
    // present.xhtml is written; absent.xhtml deliberately is not.
    { name: "present.xhtml", data: bytes("<html><body><p>在的章节。</p></body></html>") },
  ]);
  const doc = await parse(zip);
  assert.deepEqual(doc.blocks.map((b) => b.text), ["在的章节。"]);
});

test("chapter headings give the book an outline for free", async () => {
  const doc = await parse(
    await buildEpub({
      chapters: [
        { href: "a.xhtml", body: "<h1>甲章</h1><h2>甲节</h2><p>正文。</p>" },
        { href: "b.xhtml", body: "<h1>乙章</h1><p>正文。</p>" },
      ],
    }),
  );
  const headings = doc.blocks.filter((b) => b.type === "heading");
  assert.deepEqual(
    headings.map((b) => [b.text, b.level]),
    [
      ["甲章", 1],
      ["甲节", 2],
      ["乙章", 1],
    ],
  );
});

test("inline emphasis inside a chapter becomes spans", async () => {
  const doc = await parse(
    await buildEpub({
      chapters: [{ href: "a.xhtml", body: "<p>前 <strong>粗</strong> 后</p>" }],
    }),
  );
  const block = doc.blocks[0]!;
  const span = block.spans![0]!;
  assert.deepEqual(span.kinds, ["strong"]);
  assert.equal(block.text.slice(span.start, span.end), "粗");
});

test("the same EPUB parses identically twice", async () => {
  const zip = await buildEpub();
  const first = await parse(zip);
  const second = await parse(zip);
  assert.deepEqual(first.blocks, second.blocks);
  assert.equal(first.textHash, second.textHash);
});
