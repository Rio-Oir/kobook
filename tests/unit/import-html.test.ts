// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `.html` file import.
 *
 * Driven through jsdom's `DOMParser` rather than a stub, so the tests exercise
 * the same code path production does — `parseFromString` → walker → blocks.
 * The walker itself takes structural types (`RawNode`), which is what makes
 * that substitution possible without a second implementation.
 *
 * The load-bearing assertions are the ones about *coordinates*: a block's
 * `text` is what every highlight and note offset is expressed against, so the
 * tests check that emphasis spans land on the characters they were measured
 * over, and that a span is dropped rather than misplaced when the two
 * traversals would disagree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseHtmlDocument } from "../../src/lib/import/html.js";
import type { ContentBlock } from "../../shared/contracts/index.js";

// The importer reads the global, exactly as it does in a browser. Installing
// jsdom's constructor is the same shape of substitution the store tests use
// for `localStorage`.
const jsdom = new JSDOM();
(globalThis as { DOMParser: unknown }).DOMParser = jsdom.window.DOMParser;

function parse(html: string, options: Parameters<typeof parseHtmlDocument>[1] = {}) {
  const result = parseHtmlDocument(html, options);
  assert.ok(result.ok, `expected a successful parse, got ${JSON.stringify(result)}`);
  return result.document;
}

function blockTexts(blocks: readonly ContentBlock[]): string[] {
  return blocks.map((b) => b.text);
}

test("paragraphs become paragraph blocks and keep their text", () => {
  const doc = parse("<html><body><p>第一段。</p><p>第二段。</p></body></html>");
  assert.deepEqual(blockTexts(doc.blocks), ["第一段。", "第二段。"]);
  assert.ok(doc.blocks.every((b) => b.type === "paragraph"));
});

test("headings carry their level and the first h1 becomes the title", () => {
  const doc = parse(
    "<html><body><h1>标题</h1><h2>小节</h2><p>正文。</p></body></html>",
  );
  assert.equal(doc.title, "标题");
  assert.equal(doc.blocks[0]?.type, "heading");
  assert.equal(doc.blocks[0]?.level, 1);
  assert.equal(doc.blocks[1]?.type, "heading");
  assert.equal(doc.blocks[1]?.level, 2);
});

test("an explicit title overrides the derived one", () => {
  const doc = parse("<html><body><h1>标题</h1><p>正文。</p></body></html>", {
    title: "文件名标题",
  });
  assert.equal(doc.title, "文件名标题");
});

test("a document with no heading falls back to the <title> element", () => {
  const doc = parse(
    "<html><head><title>页面标题</title></head><body><p>正文。</p></body></html>",
  );
  assert.equal(doc.title, "页面标题");
});

test("emphasis becomes spans measured over the stored text", () => {
  const doc = parse("<html><body><p>前 <strong>粗</strong> 后</p></body></html>");
  const block = doc.blocks[0]!;
  assert.equal(block.text, "前 粗 后");
  assert.equal(block.spans?.length, 1);
  const span = block.spans![0]!;
  assert.deepEqual(span.kinds, ["strong"]);
  // The span must cover exactly the character it was measured over. This is
  // the assertion that would catch an off-by-one in the traversal.
  assert.equal(block.text.slice(span.start, span.end), "粗");
});

test("nested emphasis keeps the canonical kind order", () => {
  const doc = parse("<html><body><p><strong><em>粗斜</em></strong></p></body></html>");
  const span = doc.blocks[0]!.spans![0]!;
  // INLINE_MARK_ORDER puts strong before em, and the reader nests by it.
  assert.deepEqual(span.kinds, ["strong", "em"]);
});

test("del and s both map to the del kind", () => {
  const doc = parse("<html><body><p><del>删</del> 和 <s>也删</s></p></body></html>");
  const spans = doc.blocks[0]!.spans ?? [];
  assert.equal(spans.length, 2);
  assert.ok(spans.every((s) => s.kinds.length === 1 && s.kinds[0] === "del"));
});

test("inline code becomes the code kind", () => {
  const doc = parse("<html><body><p>用 <code>npm ci</code> 安装</p></body></html>");
  const block = doc.blocks[0]!;
  const span = block.spans![0]!;
  assert.deepEqual(span.kinds, ["code"]);
  assert.equal(block.text.slice(span.start, span.end), "npm ci");
});

test("an absolute http link is kept with its href", () => {
  const doc = parse(
    '<html><body><p><a href="https://example.com/a">链接</a></p></body></html>',
  );
  const span = doc.blocks[0]!.spans![0]!;
  assert.deepEqual(span.kinds, ["link"]);
  assert.equal(span.href, "https://example.com/a");
});

test("a javascript: link is rendered as text, not as a link", () => {
  // The allowlist exists because a blocklist's failure mode is a scheme nobody
  // thought of. This is the case it is there for.
  const doc = parse(
    '<html><body><p><a href="javascript:alert(1)">点我</a></p></body></html>',
  );
  const block = doc.blocks[0]!;
  assert.equal(block.text, "点我");
  assert.equal(block.spans, undefined);
});

test("a relative link is dropped because there is no base URL to resolve it against", () => {
  const doc = parse('<html><body><p><a href="/about">关于</a></p></body></html>');
  const block = doc.blocks[0]!;
  assert.equal(block.text, "关于");
  // Left as-is the reader would resolve `/about` against this application's
  // own origin, which is a dead link that looks live.
  assert.equal(block.spans, undefined);
});

test("a mailto link survives the allowlist", () => {
  const doc = parse(
    '<html><body><p><a href="mailto:a@b.c">写信</a></p></body></html>',
  );
  assert.equal(doc.blocks[0]!.spans![0]!.href, "mailto:a@b.c");
});

test("script and style text is never emitted as prose", () => {
  const doc = parse(
    "<html><body><script>var x = 1;</script><style>p{color:red}</style><p>正文。</p></body></html>",
  );
  assert.deepEqual(blockTexts(doc.blocks), ["正文。"]);
});

test("unordered and ordered lists are distinguished", () => {
  const doc = parse(
    "<html><body><ul><li>甲</li><li>乙</li></ul><ol><li>一</li></ol></body></html>",
  );
  const items = doc.blocks.filter((b) => b.type === "listItem");
  assert.equal(items.length, 3);
  assert.equal(items[0]?.ordered, false);
  assert.equal(items[1]?.ordered, false);
  assert.equal(items[2]?.ordered, true);
});

test("a nested list produces its own items instead of flattening into the parent", () => {
  const doc = parse(
    "<html><body><ul><li>外层<ul><li>内层</li></ul></li></ul></body></html>",
  );
  const items = doc.blocks.filter((b) => b.type === "listItem");
  assert.deepEqual(
    items.map((b) => b.text),
    ["外层", "内层"],
  );
});

test("a list item's own text excludes its nested list", () => {
  // Regression guard for the duplicate-block failure mode: walking all of a
  // list item's children would re-emit its text as a loose paragraph.
  const doc = parse("<html><body><ul><li>只有这条<ul><li>嵌套</li></ul></li></ul></body></html>");
  const outer = doc.blocks.find((b) => b.text === "只有这条");
  assert.ok(outer, "the outer item must be exactly its own text");
  assert.equal(doc.blocks.filter((b) => b.text === "只有这条").length, 1);
});

test("a blockquote's contents become quote blocks", () => {
  const doc = parse("<html><body><blockquote><p>引用</p></blockquote></body></html>");
  assert.equal(doc.blocks[0]?.type, "quote");
  assert.equal(doc.blocks[0]?.text, "引用");
});

test("a pre block keeps its line structure and its declared language", () => {
  const doc = parse(
    '<html><body><pre class="language-ts"><code>const a = 1;\nconst b = 2;</code></pre></body></html>',
  );
  const block = doc.blocks[0]!;
  assert.equal(block.type, "code");
  assert.equal(block.lang, "ts");
  // Code is verbatim: `normalizeCode`, not `normalizeProse`, so the newline
  // survives rather than being folded to a space.
  assert.equal(block.text, "const a = 1;\nconst b = 2;");
});

test("a table becomes one table block with the first row as header", () => {
  const doc = parse(
    "<html><body><table><thead><tr><th>列一</th><th>列二</th></tr></thead><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table></body></html>",
  );
  const table = doc.blocks.find((b) => b.type === "table");
  assert.ok(table, "the table must be retained as one block");
  assert.deepEqual(table.rows, [
    ["列一", "列二"],
    ["甲", "乙"],
  ]);
  assert.equal(table.text, "列一 | 列二 甲 | 乙");
  // Tables are not prose: no list items may be emitted for their rows.
  assert.equal(doc.blocks.filter((b) => b.type === "listItem").length, 0);
});

test("a horizontal rule becomes an hr block with a non-empty label", () => {
  const doc = parse("<html><body><p>前</p><hr><p>后</p></body></html>");
  const hr = doc.blocks.find((b) => b.type === "hr");
  assert.ok(hr);
  assert.equal(hr.text, "分隔线");
  assert.deepEqual(
    doc.blocks.map((b) => b.type),
    ["paragraph", "hr", "paragraph"],
  );
});

test("nested lists carry a 0-based depth instead of being flattened", () => {
  const doc = parse(
    "<html><body><ul><li>外层<ul><li>内层一</li><li>内层二</li></ul></li><li>第二项</li></ul></body></html>",
  );
  const items = doc.blocks.filter((b) => b.type === "listItem");
  assert.deepEqual(
    items.map((b) => [b.text, b.depth]),
    [
      ["外层", 0],
      ["内层一", 1],
      ["内层二", 1],
      ["第二项", 0],
    ],
  );
});

test("a checkbox input makes a task item without adding text", () => {
  const doc = parse(
    '<html><body><ul><li><input type="checkbox"> 未完成</li><li><input type="checkbox" checked> 已完成</li><li>普通</li></ul></body></html>',
  );
  const items = doc.blocks.filter((b) => b.type === "listItem");
  assert.deepEqual(
    items.map((b) => [b.text, b.task === true, b.checked === true]),
    [
      ["未完成", true, false],
      ["已完成", true, true],
      ["普通", false, false],
    ],
  );
});

test("loose text directly inside the body is kept, not dropped", () => {
  const doc = parse("<html><body>裸文本<p>段落</p></body></html>");
  assert.deepEqual(blockTexts(doc.blocks), ["裸文本", "段落"]);
});

test("stripChrome removes nav, aside and footer", () => {
  const html =
    "<html><body><nav>导航</nav><aside>侧栏</aside><p>正文。</p><footer>页脚</footer></body></html>";
  const kept = parse(html, { stripChrome: true });
  assert.deepEqual(blockTexts(kept.blocks), ["正文。"]);

  // And the same document without the flag keeps everything: a book chapter's
  // <header> may be its title, so the stripping has to be opt-in.
  const all = parse(html, { stripChrome: false });
  assert.deepEqual(blockTexts(all.blocks), ["导航", "侧栏", "正文。", "页脚"]);
});

test("an empty document is rejected rather than stored as an empty article", () => {
  const result = parseHtmlDocument("<html><body></body></html>");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY_CONTENT");
});

test("whitespace-only input is rejected as empty", () => {
  const result = parseHtmlDocument("   \n  ");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY_CONTENT");
});

test("a leading BOM is stripped before parsing", () => {
  const doc = parse("﻿<html><body><p>正文。</p></body></html>");
  assert.deepEqual(blockTexts(doc.blocks), ["正文。"]);
});

test("the extractor id names the pipeline that actually ran", () => {
  // Without Readability the label must not claim Readability ran.
  assert.equal(parse("<html><body><p>正文。</p></body></html>").source, "html-dom");
});

test("Readability isolates the article body from a page's chrome", () => {
  // A saved web page: navigation and a sidebar around a real article. With
  // Readability on, only the article survives.
  const article = "这是一篇足够长的文章正文。".repeat(20);
  const html = `<html><head><title>文章标题</title></head><body>
    <nav><a href="https://example.com/">首页</a><a href="https://example.com/b">频道</a></nav>
    <div id="content"><h1>文章标题</h1><p>${article}</p><p>${article}</p></div>
    <aside>相关推荐</aside>
    <footer>版权所有</footer>
  </body></html>`;

  const withReadability = parse(html, { readability: true });
  assert.equal(withReadability.source, "html-readability");
  const joined = withReadability.blocks.map((b) => b.text).join("\n");
  assert.ok(joined.includes("这是一篇足够长的文章正文。"), "the article must survive");
  assert.ok(!joined.includes("相关推荐"), "the sidebar must be gone");

  // Without it, everything is walked — which is the behaviour EPUB chapters
  // depend on, and the reason the flag is opt-in.
  const without = parse(html, { readability: false });
  assert.equal(without.source, "html-dom");
  assert.ok(
    without.blocks.map((b) => b.text).join("\n").includes("相关推荐"),
    "without Readability the sidebar is part of the document",
  );
});

test("Readability falling back still produces a usable document", () => {
  // A document too short or too unusual for Readability. `charThreshold: 0`
  // covers most of these, so this asserts the contract either way: whatever
  // path was taken, a document with text comes out and the label is honest.
  const doc = parse("<html><body><p>短。</p></body></html>", { readability: true });
  assert.ok(doc.blocks.length > 0);
  assert.ok(doc.source === "html-readability" || doc.source === "html-dom");
  assert.deepEqual(blockTexts(doc.blocks), ["短。"]);
});

test("every block gets a stable id and hash", () => {
  const html = "<html><body><p>甲</p><p>乙</p></body></html>";
  const first = parse(html);
  const second = parse(html);
  assert.deepEqual(first.blocks, second.blocks, "the same input must parse identically");
  assert.equal(first.textHash, second.textHash);
  for (const block of first.blocks) {
    // `hash` is the full SHA-256 and `id` carries its first 8 hex digits —
    // whatever `shared/contracts/content.ts` says about a 16-character hash,
    // this is what `BlockCollector.add` writes, and every anchor in the
    // application is built on it.
    assert.match(block.id, /^b\d+-[0-9a-f]{8}$/);
    assert.match(block.hash, /^[0-9a-f]{64}$/);
    assert.equal(block.id, `b${block.index}-${block.hash.slice(0, 8)}`);
  }
});

test("duplicate paragraphs stay distinguishable by index", () => {
  const doc = parse("<html><body><p>重复</p><p>重复</p></body></html>");
  assert.equal(doc.blocks.length, 2);
  assert.equal(doc.blocks[0]!.hash, doc.blocks[1]!.hash);
  assert.notEqual(doc.blocks[0]!.id, doc.blocks[1]!.id);
});

test("an <img> becomes an image block with src, alt and title", () => {
  const doc = parse(
    '<html><body><p><img src="https://cdn.example.com/a.png" alt="示意图" title="图一"></p></body></html>',
  );
  const image = doc.blocks.find((b) => b.type === "image");
  assert.ok(image, "the image must be retained as its own block");
  assert.equal(image.src, "https://cdn.example.com/a.png");
  assert.equal(image.alt, "示意图");
  assert.equal(image.title, "图一");
  // The block's text is its alt text, which is what the hash is computed over.
  assert.equal(image.text, "示意图");
});

test("an image with no alt still gets a non-empty block", () => {
  const doc = parse('<html><body><img src="https://cdn.example.com/a.png"></body></html>');
  const image = doc.blocks.find((b) => b.type === "image");
  assert.ok(image);
  assert.equal(image.text, "图片");
  assert.equal(image.alt, undefined);
});

test("an image inside a paragraph does not disturb the paragraph's text", () => {
  const doc = parse(
    '<html><body><p>前 <img src="https://cdn.example.com/a.png" alt="图"> 后</p></body></html>',
  );
  const image = doc.blocks.find((b) => b.type === "image");
  assert.ok(image);
  const paragraph = doc.blocks.find((b) => b.type === "paragraph");
  assert.equal(paragraph?.text, "前 后");
});

test("an <img> inside a picture is retained", () => {
  const doc = parse(
    '<html><body><picture><source srcset="a.webp"><img src="https://cdn.example.com/a.png" alt="图"></picture></body></html>',
  );
  assert.equal(doc.blocks.filter((b) => b.type === "image").length, 1);
});

test("a root-relative image is kept when no base URL is known", () => {
  const doc = parse('<html><body><p><img src="/media/a.png" alt="图"></p></body></html>');
  const image = doc.blocks.find((b) => b.type === "image");
  assert.equal(image?.src, "/media/a.png");
});

test("relative image URLs resolve against the source URL when one is available", () => {
  const doc = parse('<html><body><p><img src="media/a.png" alt="图"></p></body></html>', {
    baseUrl: "https://example.com/posts/2026/index.html",
  });
  const image = doc.blocks.find((b) => b.type === "image");
  assert.equal(image?.src, "https://example.com/posts/2026/media/a.png");

  const rootRelative = parse('<html><body><p><img src="/media/b.png" alt="图"></p></body></html>', {
    baseUrl: "https://example.com/posts/2026/index.html",
  });
  assert.equal(
    rootRelative.blocks.find((b) => b.type === "image")?.src,
    "https://example.com/media/b.png",
  );
});

test("the page's share image becomes the document cover, resolved against its origin", () => {
  // The card shows the page's real picture instead of the generated wash, and
  // a second device gets the same one because it travels with the document.
  const doc = parse(
    '<html><head><meta property="og:image" content="/img/hero.jpg"></head>' +
      '<body><p>正文</p></body></html>',
    { baseUrl: "https://example.com/posts/2026/index.html" },
  );
  assert.equal(doc.coverImage, "https://example.com/img/hero.jpg");
});

test("a page with no share image, or only an unusable one, has no cover", () => {
  const none = parse("<html><body><p>正文</p></body></html>");
  assert.equal(none.coverImage, undefined);

  // An inline image cannot be a cover: it would be stored on every copy of the
  // article and shipped to the account.
  const inline = parse(
    '<html><head><meta property="og:image" content="data:image/png;base64,AA"></head>' +
      "<body><p>正文</p></body></html>",
  );
  assert.equal(inline.coverImage, undefined);

  // A relative share image with no origin to resolve it against is dropped
  // rather than pointed at our own domain.
  const relative = parse(
    '<html><head><meta property="og:image" content="hero.jpg"></head>' +
      "<body><p>正文</p></body></html>",
  );
  assert.equal(relative.coverImage, undefined);
});

test("unsafe or unresolvable image sources are dropped rather than rendered", () => {
  for (const src of [
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "media/relative.png",
    "",
  ]) {
    const doc = parse(`<html><body><p><img src="${src}" alt="x"></p><p>正文。</p></body></html>`);
    assert.equal(
      doc.blocks.filter((b) => b.type === "image").length,
      0,
      `${src || "(empty)"} must not become an image block`,
    );
  }
});

test("a saved known-site page is read from its own container, not from Readability", () => {
  // The shape of a saved WeChat article: the article in #js_content, the
  // site's own furniture around it. Readability would keep "扫码关注" and the
  // app's own words as prose; the container is what makes the import clean.
  const page = [
    "<!doctype html><html><head><title>标题 - 微信公众平台</title>",
    '<meta property="og:title" content="分享标题"></head><body>',
    '<h1 id="activity-name">一篇值得读的文章</h1>',
    '<div class="rich_media_content" id="js_content">',
    "<p>第一段正文，长度足够让容器判定成立。</p>",
    "<p>第二段正文。</p>",
    "</div>",
    '<div id="js_pc_qr_code">扫码关注</div>',
    "<footer>视频 小程序 赞 在看 分享 留言 收藏</footer>",
    "</body></html>",
  ].join("");
  const doc = parse(page, { readability: true, stripChrome: true });
  assert.deepEqual(blockTexts(doc.blocks), [
    "第一段正文，长度足够让容器判定成立。",
    "第二段正文。",
  ]);
  // The title comes from the rule's own selector, not from Readability's guess.
  assert.equal(doc.title, "一篇值得读的文章");
});

test("a known-site page whose container is an empty shell still falls back", () => {
  // A verification page has the container element but nothing in it. Returning
  // that as the article would import an empty document; falling back keeps the
  // old behaviour intact for every page the table cannot read.
  const page =
    '<html><body><div id="js_content"> </div>' +
    "<article><p>真正的内容在别处，也应该被抽出来。</p></article></body></html>";
  const doc = parse(page, { readability: true });
  assert.match(blockTexts(doc.blocks).join("\n"), /真正的内容在别处/);
});

test("a saved page no rule covers still goes through Readability", () => {
  const page =
    "<html><head><title>普通文章</title></head><body><nav>导航</nav>" +
    "<article><p>这是普通站点的正文段落，长度足够。</p><p>第二段。</p></article>" +
    "<footer>页脚</footer></body></html>";
  const doc = parse(page, { readability: true, stripChrome: true });
  const text = blockTexts(doc.blocks).join("\n");
  assert.match(text, /普通站点的正文段落/);
  assert.doesNotMatch(text, /导航/);
});
