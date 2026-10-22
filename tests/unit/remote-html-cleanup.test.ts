// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import test from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../../server/src/lib/parse/html.js";

test("remote HTML excludes navigation and legal footer while preserving short Chinese and emphasis", () => {
  const result = parseHtml(`<html><head><title>测试文章</title></head><body>
    <nav><p>站点导航杂质</p></nav>
    <div role="navigation"><p>角色导航杂质</p></div>
    <article><h1>测试文章</h1><p><strong>你好。</strong></p><p>这是正文，正文讨论版权和导航设计，仍然应当保留。</p></article>
    <footer><p>页脚杂质 版权所有</p></footer>
    <div role="contentinfo"><p>角色页脚杂质</p></div>
    </body></html>`, { remoteArticle: true });
  assert.ok(result.ok);
  const text = result.document.blocks.map((b) => b.text).join("\n");
  assert.ok(!text.includes("杂质"));
  const short = result.document.blocks.find((b) => b.text === "你好。");
  assert.ok(short);
  assert.deepEqual(short.spans, [{ start: 0, end: 3, kinds: ["strong"] }]);
  assert.ok(text.includes("正文讨论版权和导航设计"));
});

test("remote data table with a chrome-like class survives and code text is unchanged", () => {
  const result = parseHtml(`<html><head><title>统计</title></head><body><article>
    <p>这里是数据说明。这里是数据说明。这里是数据说明。</p>
    <table class="sidebar"><caption>年度统计</caption><thead><tr><th>年份</th><th>数量</th></tr></thead>
    <tbody><tr><td>2026</td><td>42</td></tr><tr><td>2025</td><td>41</td></tr></tbody></table>
    <pre><code>const stars = "****";</code></pre>
    <p>表格结束。</p></article></body></html>`, { remoteArticle: true });
  assert.ok(result.ok);
  // The table is a single table block whose first row is the header; the
  // chrome-like class must not have caused it to be dropped.
  const table = result.document.blocks.find((b) => b.type === "table");
  assert.ok(table);
  assert.deepEqual(table.rows, [
    ["年份", "数量"],
    ["2026", "42"],
    ["2025", "41"],
  ]);
  assert.ok(result.document.blocks.some((b) => b.type === "code" && b.text === 'const stars = "****";'));
});

test("a remote page containing only explicit furniture cannot become an article", () => {
  const result = parseHtml('<html><body><nav><p>首页</p></nav><footer><p>版权所有</p></footer></body></html>', { remoteArticle: true });
  assert.equal(result.ok, false);
});
