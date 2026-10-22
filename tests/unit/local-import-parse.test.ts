// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract gate: the browser's Markdown parser must produce the **same**
 * `ParsedDocument` as the server's. A note anchored on a browser-parsed
 * article must still validate against the server's copy of the same
 * article, and the only way that holds is byte-for-byte equality of
 * `title`, `author`, every `block`, `source`, `extractorVersion` and
 * `textHash` on the same input. This is the load-bearing test of the
 * dual-channel design.
 *
 * `EXTRACTOR_VERSION` is asserted too: if the two implementations ever
 * diverge, the version string is what is supposed to bump, and a
 * difference here without a bump would be a silent coordinate break.
 *
 * `sha256Hex` is checked against `node:crypto` separately, because
 * `BlockCollector.add` calls it from the synchronous walk and the
 * browser implementation is a hand-rolled SHA-256 (no `node:crypto`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseMarkdown } from "../../server/src/lib/parse/markdown.js";
import { parseLocalMarkdown } from "../../src/lib/local-import-parse.js";
import {
  EXTRACTOR_VERSION,
  sha256Hex,
  documentTextHash,
  normalizeProse,
  normalizeCode,
  normalizeProseWithMap,
} from "../../src/lib/local-import-blocks.js";
import { importFromPastedText, MAX_LOCAL_INPUT_BYTES, utf8ByteLength } from "../../src/lib/local-import.js";
import type { ParseResult } from "../../shared/contracts/index.js";

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function usable(result: ParseResult): Extract<ParseResult, { ok: true }>["document"] {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.document;
}

/** Compare every field the parser produces. Spans included — see the
 *  test for the markdown parse. */
function assertSameDocument(a: unknown, b: unknown, label: string): void {
  assert.deepEqual(a, b, label);
}

test("local parser agrees with server parser on the Chinese article fixture", async () => {
  const md = await fixture("article-zh.md");
  const local = usable(parseLocalMarkdown(md));
  const server = usable(parseMarkdown(md));
  assertSameDocument(local, server, "article-zh.md local vs server");
});

test("local parser agrees with server parser on a heading-only fixture", async () => {
  const md = "# 标题\n\n短段。\n";
  const local = usable(parseLocalMarkdown(md));
  const server = usable(parseMarkdown(md));
  assertSameDocument(local, server, "headings+short Chinese");
});

test("local parser agrees on a GFM list / code / link / emphasis fixture", async () => {
  const md = [
    "## 列表与代码",
    "",
    "- alpha **bold**",
    "- beta `code`",
    "- [link](https://example.com/)",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "混合 **_x_** 与 `y` 和 ~~z~~。",
  ].join("\n");
  const local = usable(parseLocalMarkdown(md));
  const server = usable(parseMarkdown(md));
  assertSameDocument(local, server, "gfm+emphasis");
});

test("local parser agrees on the duplicate-paragraph fixture", async () => {
  const md = await fixture("duplicate-blocks.md");
  const local = usable(parseLocalMarkdown(md));
  const server = usable(parseMarkdown(md));
  assertSameDocument(local, server, "duplicate-blocks.md");
});

test("EXTRACTOR_VERSION is the same in both packages", async () => {
  // The server constant is the load-bearing one — the two extractors
  // describe the same wire shape, and a drift here would be a silent
  // coordinate break. We import the server's value statically and
  // compare; a change has to be made in the same commit on both sides.
  const server = await import("../../server/src/lib/parse/blocks.js");
  assert.equal(EXTRACTOR_VERSION, server.EXTRACTOR_VERSION);
});

test("EXTRACTOR_VERSION is phase1.3 (current pipeline)", () => {
  assert.equal(EXTRACTOR_VERSION, "phase1.3");
});

test("local sha256Hex matches node:crypto on multiple inputs", () => {
  const cases = [
    "",
    "a",
    "abc",
    "hello, world",
    "你好，世界。",
    "中英文混合 " + "x".repeat(200) + " 末段",
    "x".repeat(1024 * 4),
    "line1\nline2\nline3",
    "trailing  ",
  ];
  for (const input of cases) {
    const expected = createHash("sha256").update(input, "utf8").digest("hex");
    assert.equal(sha256Hex(input), expected, `sha256 mismatch for length=${input.length}`);
  }
});

test("documentTextHash and normalizeProse match server behaviour", async () => {
  const md = await fixture("article-zh.md");
  const local = usable(parseLocalMarkdown(md));
  const server = usable(parseMarkdown(md));
  assert.equal(local.textHash, server.textHash);
  // Spot-check normalisation on a few strings; the server's identity
  // is asserted separately in tests/unit/inline-spans.test.ts.
  assert.equal(normalizeProse("  你好  世界  \n"), "你好 世界");
  assert.equal(normalizeProse("\n\n"), "");
  // `normalizeCode` only strips leading/trailing *blank* lines; the
  // leading indentation of a code block is preserved verbatim. The
  // observable is the symmetry with the server, not the specific
  // output.
  const codeOut = normalizeCode("  const x = 1;\n\n  console.log(x);\n\n");
  assert.equal(codeOut, "  const x = 1;\n\n  console.log(x);");
  const mapped = normalizeProseWithMap("  abc  def  ");
  assert.equal(mapped.text, "abc def");
  // Past the end: the trailing trimmed space maps to the final length.
  assert.equal(mapped.map.toOutput(100, "end"), "abc def".length);
});

test("importFromPastedText: success on a typical Chinese article", async () => {
  const md = await fixture("article-zh.md");
  const result = importFromPastedText(md);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.source, "local");
  assert.equal(result.bytes, utf8ByteLength(md));
  // The local-import-parse test already proves the local parser agrees
  // with the server; this is a smoke test on the wrapper.
  assert.ok(result.document.blocks.length > 5);
  assert.equal(result.document.textHash, usable(parseLocalMarkdown(md)).textHash);
});

test("importFromPastedText: empty input is rejected with EMPTY_INPUT", () => {
  for (const blank of ["", "   ", "\n\n", "\t  \n"]) {
    const r = importFromPastedText(blank);
    assert.equal(r.ok, false);
    if (r.ok) continue;
    assert.equal(r.code, "EMPTY_INPUT");
    assert.equal(r.message, "请粘贴文章正文。");
  }
});

test("importFromPastedText: oversized input is rejected with TOO_LARGE", () => {
  // 2 MB + 1 byte of ASCII.
  const huge = "a".repeat(MAX_LOCAL_INPUT_BYTES + 1);
  const r = importFromPastedText(huge, { maxBytes: MAX_LOCAL_INPUT_BYTES });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "TOO_LARGE");
  assert.match(r.message, /上限/);
});

test("importFromPastedText: front-matter-only input is rejected with EMPTY_CONTENT", async () => {
  const r = importFromPastedText(await fixture("frontmatter-only.md"));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "EMPTY_CONTENT");
  assert.match(r.message, /未能从这段内容中提取正文/);
});

test("importFromPastedText: title override wins over the first heading", () => {
  const r = importFromPastedText("# 自动派生\n\n正文一段。", { title: "显式标题" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.document.title, "显式标题");
});

test("importFromPastedText: blocks carry id/index/hash/spans when emphasis is present", () => {
  const r = importFromPastedText("这一段有 **粗体** 与 *斜体*。");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const para = r.document.blocks.find((b) => b.type === "paragraph");
  assert.ok(para);
  assert.equal(para?.text, "这一段有 粗体 与 斜体。");
  assert.ok(para?.spans && para.spans.length >= 2);
  // The hash is sha256(text); the id is `b<index>-<hash8>`.
  assert.equal(para?.hash, sha256Hex(para?.text ?? ""));
  assert.equal(para?.id, `b${para?.index}-${para?.hash.slice(0, 8)}`);
});

test("utf8ByteLength counts Chinese as 3 bytes per character", () => {
  // '你' is U+4F60, encodes to 3 UTF-8 bytes.
  assert.equal(utf8ByteLength("你"), 3);
  assert.equal(utf8ByteLength("你好"), 6);
  // A surrogate pair encodes to 4 bytes.
  assert.equal(utf8ByteLength("𝄞"), 4);
  // ASCII stays 1 byte.
  assert.equal(utf8ByteLength("a"), 1);
});

test("MAX_LOCAL_INPUT_BYTES matches server's MAX_INPUT_BYTES intent (2 MB)", () => {
  // The number is asserted, not the server's constant: that one lives
  // behind a 16-byte body limit and a different cap. The contract is
  // that "too large" means the same thing on both channels, and a
  // divergence is easier to spot when both numbers are local and
  // uncommented.
  assert.equal(MAX_LOCAL_INPUT_BYTES, 2 * 1024 * 1024);
});

test("local and server parsers agree on a GFM table and a thematic break", () => {
  const md = [
    "# 结构",
    "",
    "| 列一 | 列二 |",
    "| --- | --- |",
    "| 甲 | 乙 |",
    "| 丙 | 丁 |",
    "",
    "---",
    "",
    "结尾。",
  ].join("\n");
  const local = usable(parseLocalMarkdown(md));
  const server = usable(parseMarkdown(md));
  assertSameDocument(local, server, "table+hr local vs server");

  const table = local.blocks.find((b) => b.type === "table");
  assert.ok(table, "a GFM table must become a table block");
  assert.deepEqual(table.rows, [
    ["列一", "列二"],
    ["甲", "乙"],
    ["丙", "丁"],
  ]);
  // `text` is the flat join `hash` is computed over; `normalizeProse`
  // collapses the newlines, so it is one line on the wire.
  assert.equal(table.text, "列一 | 列二 甲 | 乙 丙 | 丁");
  assert.equal(table.hash, sha256Hex(table.text));

  const hr = local.blocks.find((b) => b.type === "hr");
  assert.ok(hr, "a thematic break must become an hr block");
  assert.equal(hr.text, "分隔线");
  assert.equal(hr.rows, undefined);
  assert.equal(hr.level, undefined);
});

test("local and server parsers agree on nested lists and GFM task items", () => {
  const md = [
    "- 外层",
    "  - 内层一",
    "  - 内层二",
    "- [ ] 未完成",
    "- [x] 已完成",
    "- 外层二",
    "  - [ ] 嵌套未完成",
  ].join("\n");
  const local = usable(parseLocalMarkdown(md));
  const server = usable(parseMarkdown(md));
  assertSameDocument(local, server, "nested+task local vs server");

  const items = local.blocks.filter((b) => b.type === "listItem");
  assert.deepEqual(
    items.map((b) => [b.text, b.depth, b.task === true, b.checked === true]),
    [
      ["外层", 0, false, false],
      ["内层一", 1, false, false],
      ["内层二", 1, false, false],
      ["未完成", 0, true, false],
      ["已完成", 0, true, true],
      ["外层二", 0, false, false],
      ["嵌套未完成", 1, true, false],
    ],
  );
  // The checkbox is metadata, not text: it must not be inside the block's
  // `text`, because that string is the coordinate system for highlights.
  assert.ok(!items.some((b) => b.text.includes("[")));
  assert.equal(items[3]!.task, true);
  assert.equal(items[3]!.checked, false);
  assert.equal(items[4]!.checked, true);
});
