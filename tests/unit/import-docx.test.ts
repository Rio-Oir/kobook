// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * DOCX import.
 *
 * Fixtures are minimal WordprocessingML archives built here, so the assertions
 * are about this importer's reading of the format rather than about any
 * particular Word version. The XML is written with the conventional `w:` prefix
 * and one case deliberately rebinds it, because matching on the prefix instead
 * of the namespace is the mistake that makes every heading in a document
 * silently become a paragraph.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildZip, bytes } from "../helpers/zip-builder.js";
import { parseDocx } from "../../src/lib/import/docx.js";

const jsdom = new JSDOM();
(globalThis as { DOMParser: unknown }).DOMParser = jsdom.window.DOMParser;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

/**
 * A `document.xml` wrapper.
 *
 * `xmlns:r` is declared on every fixture because real Word documents always
 * declare it, and `<w:hyperlink r:id="…">` is not well-formed XML without it.
 */
function documentXml(body: string, prefix = "w", ns = W_NS): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${prefix}:document xmlns:${prefix}="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <${prefix}:body>${body}</${prefix}:body>
</${prefix}:document>`;
}

async function buildDocx(body: string, prefix = "w", ns = W_NS): Promise<Uint8Array> {
  return buildZip([
    { name: "[Content_Types].xml", data: bytes(CONTENT_TYPES) },
    { name: "word/document.xml", data: bytes(documentXml(body, prefix, ns)) },
  ]);
}

async function parse(bytesIn: Uint8Array, options: Parameters<typeof parseDocx>[1] = {}) {
  const result = await parseDocx(bytesIn, options);
  assert.ok(result.ok, `expected a successful parse, got ${JSON.stringify(result)}`);
  return result.document;
}

/** A plain paragraph. */
function p(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

test("paragraphs become paragraph blocks", async () => {
  const doc = await parse(await buildDocx(p("第一段。") + p("第二段。")));
  assert.deepEqual(doc.blocks.map((b) => b.text), ["第一段。", "第二段。"]);
  assert.ok(doc.blocks.every((b) => b.type === "paragraph"));
  assert.equal(doc.source, "docx-xml");
});

test("multiple runs in one paragraph join without separators", async () => {
  const doc = await parse(
    await buildDocx(`<w:p><w:r><w:t>前半</w:t></w:r><w:r><w:t>后半</w:t></w:r></w:p>`),
  );
  assert.deepEqual(doc.blocks.map((b) => b.text), ["前半后半"]);
});

test("a pStyle naming Heading1 makes a level-1 heading", async () => {
  const body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>${p("正文。")}`;
  const doc = await parse(await buildDocx(body));
  assert.equal(doc.blocks[0]?.type, "heading");
  assert.equal(doc.blocks[0]?.level, 1);
  assert.equal(doc.blocks[0]?.text, "标题");
  // The first heading is also the title when the caller does not supply one.
  assert.equal(doc.title, "标题");
});

test("Heading 2 with a space, and 标题 2 from a Chinese Word, both parse", async () => {
  for (const style of ["Heading 2", "heading2", "标题 2", "标题2"]) {
    const body = `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>小节</w:t></w:r></w:p>`;
    const doc = await parse(await buildDocx(body));
    assert.equal(doc.blocks[0]?.type, "heading", `style ${style} should be a heading`);
    assert.equal(doc.blocks[0]?.level, 2, `style ${style} should be level 2`);
  }
});

test("outlineLvl wins over pStyle, because it is the unlocalized one", async () => {
  const body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>三级</w:t></w:r></w:p>`;
  const doc = await parse(await buildDocx(body));
  // Word's outline levels are 0-based, so val=2 is a level-3 heading.
  assert.equal(doc.blocks[0]?.level, 3);
});

test("a paragraph with numPr becomes a list item", async () => {
  const body = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>条目</w:t></w:r></w:p>`;
  const doc = await parse(await buildDocx(body));
  assert.equal(doc.blocks[0]?.type, "listItem");
  // Honest default: without numbering.xml the marker is unknowable, so the
  // structure survives and the claim about ordering does not get made.
  assert.equal(doc.blocks[0]?.ordered, false);
});

test("bold, italic and strike runs become spans over the stored text", async () => {
  const body =
    `<w:p>` +
    `<w:r><w:t>前 </w:t></w:r>` +
    `<w:r><w:rPr><w:b/></w:rPr><w:t>粗</w:t></w:r>` +
    `<w:r><w:t> 中 </w:t></w:r>` +
    `<w:r><w:rPr><w:i/></w:rPr><w:t>斜</w:t></w:r>` +
    `<w:r><w:t> 后 </w:t></w:r>` +
    `<w:r><w:rPr><w:strike/></w:rPr><w:t>删</w:t></w:r>` +
    `</w:p>`;
  const doc = await parse(await buildDocx(body));
  const block = doc.blocks[0]!;
  assert.equal(block.text, "前 粗 中 斜 后 删");
  const spans = block.spans ?? [];
  assert.equal(spans.length, 3);
  for (const span of spans) {
    const covered = block.text.slice(span.start, span.end);
    assert.ok(["粗", "斜", "删"].includes(covered), `span covered ${JSON.stringify(covered)}`);
  }
  assert.deepEqual(spans[0]!.kinds, ["strong"]);
  assert.deepEqual(spans[1]!.kinds, ["em"]);
  assert.deepEqual(spans[2]!.kinds, ["del"]);
});

test("a bold+italic run canonicalises as strong then em", async () => {
  const body = `<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>粗斜</w:t></w:r></w:p>`;
  const doc = await parse(await buildDocx(body));
  const span = doc.blocks[0]!.spans![0]!;
  // INLINE_MARK_ORDER puts strong before em; the HTML and Markdown paths do
  // the same, so the same document reached three ways hashes alike.
  assert.deepEqual(span.kinds, ["strong", "em"]);
});

test("a formatting flag with w:val='0' turns the emphasis off", async () => {
  const body = `<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>不粗</w:t></w:r></w:p>`;
  const doc = await parse(await buildDocx(body));
  assert.equal(doc.blocks[0]?.text, "不粗");
  assert.equal(doc.blocks[0]?.spans, undefined);
});

test("w:br becomes a line break that normalisation folds to a space", async () => {
  const body = `<w:p><w:r><w:t>上</w:t><w:br/><w:t>下</w:t></w:r></w:p>`;
  const doc = await parse(await buildDocx(body));
  // `normalizeProse` folds the intra-paragraph newline, which is the same
  // treatment the HTML path gives a soft break.
  assert.deepEqual(doc.blocks.map((b) => b.text), ["上 下"]);
});

test("w:tab becomes whitespace rather than vanishing", async () => {
  const body = `<w:p><w:r><w:t>甲</w:t><w:tab/><w:t>乙</w:t></w:r></w:p>`;
  const doc = await parse(await buildDocx(body));
  assert.deepEqual(doc.blocks.map((b) => b.text), ["甲 乙"]);
});

test("a table row becomes one readable list item", async () => {
  const body =
    `<w:tbl>` +
    `<w:tr><w:tc>${p("列一")}</w:tc><w:tc>${p("列二")}</w:tc></w:tr>` +
    `<w:tr><w:tc>${p("甲")}</w:tc><w:tc>${p("乙")}</w:tc></w:tr>` +
    `</w:tbl>`;
  const doc = await parse(await buildDocx(body));
  assert.deepEqual(doc.blocks.map((b) => b.text), ["列一 | 列二", "甲 | 乙"]);
  assert.ok(doc.blocks.every((b) => b.type === "listItem"));
});

test("a hyperlink wrapper is transparent to the text inside it", async () => {
  const body = `<w:p><w:r><w:t>见 </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>这里</w:t></w:r></w:hyperlink></w:p>`;
  const doc = await parse(await buildDocx(body));
  // The target lives in word/_rels/document.xml.rels, which is not read; the
  // text is what must not be lost.
  assert.deepEqual(doc.blocks.map((b) => b.text), ["见 这里"]);
});

test("the namespace prefix is not assumed to be w", async () => {
  // A producer that binds the same namespace to `word:`. Matching on `w:p`
  // would find nothing here and report an empty document.
  const body = `<word:p><word:pPr><word:pStyle word:val="Heading1"/></word:pPr><word:r><word:t>换个前缀</word:t></word:r></word:p>`;
  const doc = await parse(await buildDocx(body, "word"));
  assert.equal(doc.blocks[0]?.type, "heading");
  assert.equal(doc.blocks[0]?.level, 1);
  assert.equal(doc.blocks[0]?.text, "换个前缀");
});

test("an explicit title overrides the derived one", async () => {
  const body = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>`;
  const doc = await parse(await buildDocx(body), { title: "文件名" });
  assert.equal(doc.title, "文件名");
});

test("an empty body is rejected rather than stored as an empty article", async () => {
  const result = await parseDocx(await buildDocx(""));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY_CONTENT");
});

test("a ZIP without word/document.xml is rejected as not a DOCX", async () => {
  const zip = await buildZip([{ name: "something/else.xml", data: bytes("<x/>") }]);
  const result = await parseDocx(zip);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "PARSE_ERROR");
    assert.match(result.message, /document\.xml/);
  }
});

test("a file that is not a ZIP is rejected with the reader's message", async () => {
  const result = await parseDocx(bytes("PK this is not really a zip"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PARSE_ERROR");
});

test("malformed document.xml is rejected rather than crashing", async () => {
  const zip = await buildZip([
    { name: "word/document.xml", data: bytes("<w:document><w:body><w:p") },
  ]);
  const result = await parseDocx(zip);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "PARSE_ERROR");
});

test("the same DOCX parses identically twice", async () => {
  const zip = await buildDocx(p("甲") + p("乙"));
  const first = await parse(zip);
  const second = await parse(zip);
  assert.deepEqual(first.blocks, second.blocks);
  assert.equal(first.textHash, second.textHash);
});
