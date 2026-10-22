// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * File import dispatch, and the plain-text path underneath it.
 *
 * Two things are being pinned here that the earlier tests cannot reach.
 *
 * The first is the encoding fix. A GB18030 `.txt` is the common case for a
 * Chinese reader and the case the previous implementation silently corrupted:
 * `File.text()` decodes as UTF-8, substitutes U+FFFD for every non-ASCII byte,
 * and reports nothing. The assertions below check the decoded *text*, because
 * a decoder that guessed wrong and still returned a plausible-looking string
 * would pass a length check.
 *
 * The second is the paragraph rule. A Chinese novel is one paragraph per line
 * with no blank lines; Markdown has no paragraph without a blank line, so the
 * whole chapter would arrive as a single 300,000-character block with one
 * anchor. The shape of the output is the feature.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
  importFromFile,
  importFromFileBytes,
  titleFromFilename,
} from "../../src/lib/import/index.js";
import { looksLikeText, sniffFormat, extensionOf } from "../../src/lib/import/sniff.js";
import { splitPlainTextParagraphs } from "../../src/lib/import/text.js";
import { buildEpub } from "../helpers/epub-fixture.js";
import { buildZip, bytes } from "../helpers/zip-builder.js";

const jsdom = new JSDOM();
(globalThis as { DOMParser: unknown }).DOMParser = jsdom.window.DOMParser;

/** "你好" as a GB18030 file would contain it. */
const NIHAO_GB18030 = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]);

/** "第一段。" as GB18030. */
const DIYIDUAN_GB18030 = Uint8Array.from([0xb5, 0xda, 0xd2, 0xbb, 0xb6, 0xce, 0xa1, 0xa3]);
/** "第二段。" as GB18030. */
const DIERDUAN_GB18030 = Uint8Array.from([0xb5, 0xda, 0xb6, 0xfe, 0xb6, 0xce, 0xa1, 0xa3]);
/** An ASCII LF, which is byte-identical in GB18030 and UTF-8. */
const LF = Uint8Array.from([0x0a]);

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

// ── Detection ─────────────────────────────────────────────────────────────

test("a PDF is recognised by its signature whatever the name says", () => {
  const pdf = concat(utf8("%PDF-1.7\n"), new Uint8Array(64));
  assert.equal(sniffFormat(pdf, "book.pdf"), "pdf");
  // The name is a hint the user controls; the bytes are not.
  assert.equal(sniffFormat(pdf, "book.txt"), "pdf");
  assert.equal(sniffFormat(pdf, "book"), "pdf");
});

test("an EPUB is recognised from the archive, not the extension", async () => {
  const epub = await buildEpub();
  assert.equal(sniffFormat(epub, "book.epub"), "epub");
  // Renamed to something with no meaning, it is still an EPUB.
  assert.equal(sniffFormat(epub, "book"), "epub");
  assert.equal(sniffFormat(epub, "book.txt"), "epub");

  const docx = await buildZip([
    { name: "word/document.xml", data: utf8("<w:document/>") },
  ]);
  assert.equal(sniffFormat(docx, "report.docx"), "docx");
  assert.equal(sniffFormat(docx, "report"), "docx");
});

test("an HTML file is recognised from its markup", () => {
  assert.equal(sniffFormat(utf8("<!DOCTYPE html><html><body><p>x</p></body></html>"), "a.html"), "html");
  assert.equal(sniffFormat(utf8("<html><body><p>x</p></body></html>"), "a.txt"), "html");
  // A fragment with no doctype or <html> is not detected from bytes...
  assert.equal(sniffFormat(utf8("<p>just a fragment</p>"), "a"), "text");
  // ...but the extension still routes it.
  assert.equal(sniffFormat(utf8("<p>just a fragment</p>"), "a.html"), "html");
});

test("markdown and plain text are told apart by extension alone", () => {
  // Nothing in the bytes distinguishes them, which is why the name is still
  // consulted for these two.
  const text = utf8("# 标题\n\n正文。");
  assert.equal(sniffFormat(text, "a.md"), "markdown");
  assert.equal(sniffFormat(text, "a.markdown"), "markdown");
  assert.equal(sniffFormat(text, "a.txt"), "text");
  assert.equal(sniffFormat(text, "a.text"), "text");
});

test("a file with no known extension defaults to text when the bytes allow it", () => {
  assert.equal(sniffFormat(utf8("some prose without a known extension"), "README"), "text");
  assert.equal(sniffFormat(utf8("log line\n"), "app.log"), "text");
});

test("binary content with an unknown extension is refused, not decoded", () => {
  // Decoding this as GB18030 would store a page of replacement characters.
  const jpeg = concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), new Uint8Array(256));
  assert.equal(sniffFormat(jpeg, "photo"), null);
  assert.equal(sniffFormat(jpeg, "photo.bin"), null);
});

test("a .txt whose bytes are binary is refused", () => {
  const binary = concat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), new Uint8Array(64));
  assert.equal(sniffFormat(binary, "mislabelled.txt"), null);
});

test("an empty file is refused before anything else runs", () => {
  assert.equal(sniffFormat(new Uint8Array(0), "empty.txt"), null);
});

test("a ZIP that is neither an EPUB nor a DOCX is not guessed at", async () => {
  const zip = await buildZip([{ name: "random.txt", data: utf8("hello") }]);
  assert.equal(sniffFormat(zip, "archive.zip"), null);
  assert.equal(sniffFormat(zip, "archive"), null);
});

test("looksLikeText accepts real text and rejects NUL-bearing bytes", () => {
  assert.equal(looksLikeText(utf8("普通中文文本\n")), true);
  assert.equal(looksLikeText(NIHAO_GB18030), true, "GB18030 must count as text");
  assert.equal(looksLikeText(new Uint8Array([0, 0, 0, 0])), false);
  assert.equal(looksLikeText(new Uint8Array(0)), false);
});

test("extensionOf handles the awkward names", () => {
  assert.equal(extensionOf("a.txt"), "txt");
  assert.equal(extensionOf("a.b.TXT"), "txt");
  assert.equal(extensionOf("a"), "");
  assert.equal(extensionOf("a."), "");
  assert.equal(extensionOf(".hidden"), "hidden");
});

test("titleFromFilename strips every extension this importer reads", () => {
  assert.equal(titleFromFilename("我的书.txt"), "我的书");
  assert.equal(titleFromFilename("我的书.md"), "我的书");
  assert.equal(titleFromFilename("book.epub"), "book");
  assert.equal(titleFromFilename("report.final.docx"), "report.final");
  assert.equal(titleFromFilename("page.xhtml"), "page");
  assert.equal(titleFromFilename("noext"), "noext");
});

// ── Plain text ────────────────────────────────────────────────────────────

test("a GB18030 txt file decodes to real Chinese, not replacement characters", async () => {
  // The headline fix. `File.text()` would return "������" here.
  //
  // Every byte in this file is GB18030 — including the LF separators, which
  // are byte-identical in every encoding in scope. Mixing UTF-8 content into it
  // would build a file no producer writes, and the decoder would be right to
  // mangle the part that is not GB18030.
  const file = concat(
    DIYIDUAN_GB18030,
    LF,
    LF,
    DIERDUAN_GB18030,
    LF,
  );
  const result = await importFromFileBytes(file, "novel.txt");

  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.format, "text");
  assert.equal(result.encoding, "gb18030");
  assert.equal(result.guessedEncoding, true, "a heuristic choice must be visible");
  assert.deepEqual(
    result.document.blocks.map((b) => b.text),
    ["第一段。", "第二段。"],
  );
  const joined = result.document.blocks.map((b) => b.text).join("");
  assert.ok(!joined.includes("�"), "no replacement character may survive");
});

test("a UTF-8 txt file is not misdetected", async () => {
  const result = await importFromFileBytes(utf8("第一段。\n\n第二段。\n"), "novel.txt");
  assert.ok(result.ok);
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.guessedEncoding, false);
  assert.deepEqual(result.document.blocks.map((b) => b.text), ["第一段。", "第二段。"]);
});

test("a line-per-paragraph novel becomes one block per paragraph", () => {
  // The shape of a Chinese .txt: no blank lines anywhere.
  const paragraphs = splitPlainTextParagraphs("第一段。\n第二段。\n第三段。");
  assert.deepEqual(paragraphs, ["第一段。", "第二段。", "第三段。"]);
});

test("a blank-line file is treated as wrapped prose and joined", () => {
  // The other shape: lines are wrapped at some column and the blank line is
  // the real break. Joining is what stops an 80-column export becoming eighty
  // paragraphs.
  const paragraphs = splitPlainTextParagraphs("第一段的第一行\n第一段的第二行\n\n第二段。");
  assert.deepEqual(paragraphs, ["第一段的第一行 第一段的第二行", "第二段。"]);
});

test("blank lines at the start and end do not produce empty paragraphs", () => {
  assert.deepEqual(splitPlainTextParagraphs("\n\n正文。\n\n"), ["正文。"]);
  assert.deepEqual(splitPlainTextParagraphs("正文。\n\n"), ["正文。"]);
});

test("CRLF and lone CR are both handled", () => {
  assert.deepEqual(splitPlainTextParagraphs("甲。\r\n乙。\r\n丙。"), ["甲。", "乙。", "丙。"]);
  assert.deepEqual(splitPlainTextParagraphs("甲。\r乙。\r丙。"), ["甲。", "乙。", "丙。"]);
});

test("chapter markers become headings so the reader gets an outline", async () => {
  const result = await importFromFileBytes(
    utf8("第一章 起源\n这是正文。\n第二章 发展\n更多正文。\n"),
    "book.txt",
  );
  assert.ok(result.ok);
  const blocks = result.document.blocks;
  assert.equal(blocks[0]?.type, "heading");
  assert.equal(blocks[0]?.text, "第一章 起源");
  assert.equal(blocks[1]?.type, "paragraph");
  assert.equal(blocks[2]?.type, "heading");
  // A sentence that merely starts like a chapter marker is not promoted: the
  // pattern is anchored and length-bounded for exactly this reason.
  const notHeading = await importFromFileBytes(
    utf8("第一章讲的是主人公如何在一个漫长的冬天里学会与自己和别人相处。\n"),
    "b.txt",
  );
  assert.ok(notHeading.ok);
  assert.equal(notHeading.document.blocks[0]?.type, "paragraph");
});

test("a heading marker in a Latin book is also recognised", async () => {
  const result = await importFromFileBytes(utf8("Chapter 1\nText here.\n"), "b.txt");
  assert.ok(result.ok);
  assert.equal(result.document.blocks[0]?.type, "heading");
});

// ── Dispatch and limits ───────────────────────────────────────────────────

test("a container over the file ceiling is refused before it is read", async () => {
  const result = await importFromFileBytes(utf8("x"), "big.txt", { maxFileBytes: 0 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TOO_LARGE");
});

test("extracted text over the text ceiling is refused with its own code", async () => {
  // The whole point of splitting the two thresholds: the *container* here is
  // tiny and well within the file budget, and it is the extracted text that is
  // over. Under a single threshold this would report the wrong reason.
  const result = await importFromFileBytes(utf8("正文。".repeat(50)), "a.txt", {
    maxTextBytes: 10,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TEXT_TOO_LARGE");
});

test("the two ceilings are independent and both generous", () => {
  // A PDF's container is orders of magnitude larger than its text, which is
  // the asymmetry the old single limit could not express.
  assert.ok(MAX_FILE_BYTES > MAX_TEXT_BYTES);
});

test("an unrecognised format gets a message naming what is supported", async () => {
  const jpeg = concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), new Uint8Array(256));
  const result = await importFromFileBytes(jpeg, "photo.jpg");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "UNKNOWN_FORMAT");
    assert.match(result.message, /PDF/);
    assert.match(result.message, /EPUB/);
  }
});

test("an empty file is refused as empty", async () => {
  const result = await importFromFileBytes(new Uint8Array(0), "empty.txt");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY_INPUT");
});

test("bytes win over the name: an HTML file called .txt is read as HTML", async () => {
  const html = utf8("<!DOCTYPE html><html><body><h1>标题</h1><p>正文。</p></body></html>");
  const result = await importFromFileBytes(html, "mislabeled.txt");
  assert.ok(result.ok);
  assert.equal(result.format, "html");
  assert.equal(result.document.blocks[0]?.text, "标题");
});

// ── End to end, one per format ────────────────────────────────────────────

test("markdown still works and keeps its block types", async () => {
  const result = await importFromFileBytes(utf8("# 标题\n\n- 甲\n- 乙\n\n正文。\n"), "a.md");
  assert.ok(result.ok);
  assert.equal(result.format, "markdown");
  assert.equal(result.document.source, "markdown-remark");
  const types = result.document.blocks.map((b) => b.type);
  assert.deepEqual(types, ["heading", "listItem", "listItem", "paragraph"]);
});

test("EPUB imports end to end through the dispatcher", async () => {
  const zip = await buildEpub({ title: "整本书" });
  const result = await importFromFileBytes(zip, "book.epub");
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.format, "epub");
  assert.equal(result.document.title, "整本书");
  assert.ok(result.document.blocks.length >= 4);
});

test("DOCX imports end to end through the dispatcher", async () => {
  const zip = await buildZip([
    { name: "[Content_Types].xml", data: utf8("<Types/>") },
    {
      name: "word/document.xml",
      data: utf8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          "<w:p><w:r><w:t>文档正文。</w:t></w:r></w:p>" +
          "</w:body></w:document>",
      ),
    },
  ]);
  const result = await importFromFileBytes(zip, "report.docx");
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.format, "docx");
  assert.deepEqual(result.document.blocks.map((b) => b.text), ["文档正文。"]);
});

test("the file name supplies the title when the document has none", async () => {
  const result = await importFromFileBytes(utf8("没有标题的正文。\n"), "我的笔记.txt");
  assert.ok(result.ok);
  assert.equal(result.document.title, "我的笔记");
});

test("an explicit title beats the file name", async () => {
  const result = await importFromFileBytes(utf8("正文。\n"), "我的笔记.txt", { title: "指定标题" });
  assert.ok(result.ok);
  assert.equal(result.document.title, "指定标题");
});

test("a markdown file with no heading falls back to its file name", async () => {
  // The fallback is not cosmetic: without it this document is titled
  // "Untitled", in English, which is the string the markdown parser hard-codes
  // for "nothing to derive a title from". `fallbackTitle` has to be declared on
  // this parser's options for the dispatcher's value to survive — a parser that
  // does not declare it drops it silently, because the argument is a variable
  // and so is exempt from excess-property checking.
  const result = await importFromFileBytes(utf8("没有标题的正文。\n"), "我的笔记.md");
  assert.ok(result.ok);
  assert.equal(result.document.title, "我的笔记");
});

test("a markdown file's own heading beats its file name", async () => {
  // And the direction matters as much: the heading is what the article is
  // called, the name on disk is often a slug or a date. This is also what
  // pasting the same text already does, so the two paths agree.
  const result = await importFromFileBytes(utf8("# 真正的标题\n\n正文。\n"), "2024-01-05-draft.md");
  assert.ok(result.ok);
  assert.equal(result.document.title, "真正的标题");
});

test("a text file reports no encoding field for non-text formats", async () => {
  const result = await importFromFileBytes(utf8("# 标题\n\n正文。\n"), "a.md");
  assert.ok(result.ok);
  assert.equal(result.encoding, undefined);
});

// ── The browser `File` wrapper ────────────────────────────────────────────

test("importFromFile reads a File through the same path as raw bytes", async () => {
  // Everything above drives `importFromFileBytes`; this is the function the
  // page actually calls, and it had no test at all. The interesting property is
  // that it is *only* a wrapper — the parsed document must be identical, or the
  // UI is exercising a path the tests never see.
  const source = "# 标题\n\n正文。\n";
  // Built from the string rather than from `utf8(source)`: `File` encodes a
  // string as UTF-8 itself, so the bytes the wrapper reads are the same ones
  // the comparison below feeds to `importFromFileBytes`.
  const file = new File([source], "a.md", { type: "text/markdown" });
  const fromFile = await importFromFile(file);
  const fromBytes = await importFromFileBytes(utf8(source), "a.md");
  assert.ok(fromFile.ok && fromBytes.ok);
  assert.deepEqual(fromFile.document, fromBytes.document);
  assert.equal(fromFile.format, "markdown");
});

test("an oversized file is refused without being read", async () => {
  // The cheap early exit is the whole reason `importFromFile` exists rather
  // than the page reading the bytes itself: a PDF is routinely tens of
  // megabytes, and `file.size` is known before a single byte is touched. The
  // stub's `arrayBuffer` throws, so this passes only if the check really does
  // come first — asserting the error *code* would not have distinguished the
  // two, since the byte-level check returns the same one.
  const oversized = {
    name: "huge.pdf",
    size: MAX_FILE_BYTES + 1,
    arrayBuffer: () => {
      throw new Error("the file was read");
    },
  } as unknown as File;

  const result = await importFromFile(oversized);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : null, "TOO_LARGE");
});
