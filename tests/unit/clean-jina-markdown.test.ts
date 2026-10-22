// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Jina site-chrome trim gates.
 *
 * `lib/clean-jina-markdown.ts` sits in front of the parser on the
 * browser-Jina path, which makes it the one place in the import pipeline
 * that can *delete* the user's content before anything has stored it. The
 * asymmetry is the whole point of these tests:
 *
 *   - the two things it is allowed to remove — a navigation preamble and
 *     an explicit legal footer — are asserted to be removed;
 *   - the things it must never remove are asserted to survive: a paragraph
 *     that merely mentions copyright, an article *section* about
 *     copyright, and a page whose Markdown has no chrome at all (which
 *     must come back byte-identical, not re-joined and re-normalised).
 *
 * Pure string in, string out: no network, no parser, no DOM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanJinaMarkdown } from "../../src/lib/clean-jina-markdown.js";
import { parseLocalMarkdown } from "../../src/lib/local-import-parse.js";

const lines = (...items: string[]) => items.join("\n");

test("Jina adjacent strong tags no longer leak stars into the parsed article", () => {
  const input = "**佛说：****‘****须菩提！你认为普通修行的人，能看见如来的形体吗？****’**";
  const expected = "佛说：‘须菩提！你认为普通修行的人，能看见如来的形体吗？’";
  const cleaned = cleanJinaMarkdown(input);
  assert.equal(cleaned, `**${expected}**`);
  const parsed = parseLocalMarkdown(cleaned);
  assert.ok(parsed.ok);
  assert.equal(parsed.document.blocks[0]?.text, expected);
  assert.deepEqual(parsed.document.blocks[0]?.spans, [
    { start: 0, end: expected.length, kinds: ["strong"] },
  ]);
  assert.equal(cleanJinaMarkdown(cleaned), cleaned);
});

test("strong joins split by Jina soft wraps preserve CRLF and text", () => {
  const input = "**佛说：****‘*\r\n***须菩提！****’**\r\n";
  assert.equal(cleanJinaMarkdown(input), "**佛说：‘\r\n须菩提！’**\r\n");
});

test("literal stars and other Markdown constructs remain byte-identical", () => {
  const cases = [
    "普通文字 **** 普通文字", "****", "***粗斜体***", "**甲**普通文字**乙**",
    "**甲\\*\\*\\*\\*乙**", "`**甲****乙**`",
    "```md\n**甲****乙**\n```", "~~~md\n**甲****乙**\n~~~",
    "    **甲****乙**", "**甲 `****` 乙**",
    "**[链接](https://example.test/a****b)****乙**",
    "> **甲****乙**", "- **甲****乙**", "**甲***乙***丙**",
  ];
  for (const input of cases) assert.equal(cleanJinaMarkdown(input), input, input);
});

test("a matching title heading drops the navigation above it and nothing below", () => {
  const input = lines(
    "![Logo](https://example.test/logo.png)",
    "* 首页",
    "* 新闻",
    "",
    "### 《金刚经》文白对照",
    "编辑：性恩行者",
    "**法会因由分第一**",
    "如是我闻。",
    "**弟子阿难说**",
    "这段解释保留。",
  );
  const cleaned = cleanJinaMarkdown(input, "《金刚经》文白对照");
  assert.ok(cleaned.startsWith("### 《金刚经》文白对照"));
  assert.ok(!cleaned.includes("首页"));
  assert.ok(cleaned.includes("如是我闻。"));
  assert.ok(cleaned.includes("这段解释保留。"));
});

test("an explicit legal footer near the end is trimmed, ICP and copyright included", () => {
  const input = lines(
    "# 正文标题",
    "第一章",
    "这是一段很短但有意义的正文。",
    "结尾仍然属于正文。",
    "",
    "浙公网安备33010002000123号",
    "Copyright © 2009-2025 版权所有",
    "* English",
    "* 灵隐寺微信",
  );
  const cleaned = cleanJinaMarkdown(input, "正文标题");
  assert.ok(cleaned.includes("这是一段很短但有意义的正文。"));
  assert.ok(cleaned.includes("结尾仍然属于正文。"));
  assert.ok(!cleaned.includes("公网安备"));
  assert.ok(!cleaned.includes("English"));
  // The blank line that separated the article from its footer belongs to
  // the footer, so the kept text ends at the article's last line.
  assert.ok(cleaned.endsWith("结尾仍然属于正文。\n"));
});

test("the 备案号 form is a footer marker too", () => {
  const input = lines("# 标题", "正文。", "", "备案号：京ICP备05000000号", "© 某某");
  // The kept region is the original bytes up to the cut, so the line
  // terminator that used to separate the article from its footer stays.
  assert.equal(cleanJinaMarkdown(input, "标题"), "# 标题\n正文。\n");
});

test("a standalone ICP filing link is trimmed without another legal marker", () => {
  const input = lines("# 标题", "正文第一段。", "正文第二段。", "正文第三段。", "", "[浙ICP备12015887号](https://beian.miit.gov.cn/)");
  assert.equal(cleanJinaMarkdown(input, "标题"), "# 标题\n正文第一段。\n正文第二段。\n正文第三段。\n");
});

test("a sentence mentioning an ICP filing remains article content", () => {
  const input = lines("# 标题", "正文第一段。", "正文第二段。", "该网站的登记号码为浙ICP备12015887号。");
  assert.equal(cleanJinaMarkdown(input, "标题"), input);
});

test("a footer is trimmed even when the caller has no title", () => {
  const input = lines("正文第一段。", "正文第二段。", "", "版权所有 © 2026", "* 联系我们");
  assert.equal(cleanJinaMarkdown(input), "正文第一段。\n正文第二段。\n");
});

test("prose that merely mentions copyright is kept, because it reads as a sentence", () => {
  const input = lines(
    "# 版权制度史",
    "第一章 起源",
    "这一段正文讨论版权制度的起源，其中提到 Copyright © 与 版权所有 的历史含义，" +
      "但这是文章正文的一部分，而不是站点页脚，因此任何一个字都不应该被删除。",
  );
  // Byte-identical, not merely "still contains the paragraph": a trimmer
  // that returned a re-joined copy would be rewriting the document.
  assert.equal(cleanJinaMarkdown(input, "版权制度史"), input);
});

test("a short line about copyright is still a sentence, not a footer notice", () => {
  const input = lines("# 标题", "正文。", "本站版权所有。", "* 联系");
  assert.equal(cleanJinaMarkdown(input, "标题"), input);
});

test("a section about copyright is structure, not a legal footer", () => {
  const input = lines(
    "# 版权说明",
    "第一章",
    "正文内容。",
    "## 版权所有",
    "该章节说明版权归属。",
  );
  assert.equal(cleanJinaMarkdown(input, "版权说明"), input);
});

test("a legal marker in the first half of a document is not a boundary", () => {
  const input = lines(
    "# 标题",
    "版权所有声明段落。",
    "正文第一段内容。",
    "正文第二段内容。",
    "正文第三段内容。",
  );
  assert.equal(cleanJinaMarkdown(input, "标题"), input);
});

test("a heading that repeats the page title deep in the article is not chrome", () => {
  const article = Array.from({ length: 65 }, (_, i) => `第${i + 1}段正文内容。`);
  const input = lines(...article, "# 文章标题", "标题之后的正文。");
  assert.equal(cleanJinaMarkdown(input, "文章标题"), input);
});

test("a document with no matching title heading is returned byte-identical", () => {
  const input = lines("![Logo](https://example.test/logo.png)", "", "正文没有可匹配的标题");
  assert.equal(cleanJinaMarkdown(input, "别的标题"), input);
  // …including when there is no title to compare against at all.
  assert.equal(cleanJinaMarkdown(input), input);
});

test("CRLF line endings survive, both when nothing is trimmed and when something is", () => {
  const clean = "# 标题\r\n正文内容。\r\n";
  assert.equal(cleanJinaMarkdown(clean, "标题"), clean);
  const chrome = "导航\r\n# 标题\r\n正文。\r\n";
  assert.equal(cleanJinaMarkdown(chrome, "标题"), "# 标题\r\n正文。\r\n");
});

test("a marker that would swallow the whole document leaves it alone", () => {
  assert.equal(cleanJinaMarkdown("版权所有", "标题"), "版权所有");
  assert.equal(cleanJinaMarkdown("", "标题"), "");
});

test("Markdown code examples cannot become title or footer cleanup boundaries", () => {
  const cases = [
    "介绍段落。\n\n```md\n# 标题\n正文示例\n```\n\n结尾。",
    "# 标题\n\n正文。\n\n```text\nCopyright 2026\n```",
    "# 标题\n\n正文。\n\n    版权所有 © 2026",
    "# 标题\n\n正文。\n\n<!-- 版权所有 © 2026 -->",
    "# 标题\n\n正文。\n\n[备案号]: https://example.test/",
  ];
  for (const input of cases) assert.equal(cleanJinaMarkdown(input, "标题"), input);
});
