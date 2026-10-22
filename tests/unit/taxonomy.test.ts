// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 分类与搜索是纯函数，所以钉在这里而不是浏览器里。
 *
 * 这两条规则各有一个「看起来对、实际上会让读者困惑」的失效方式：
 *
 *   - 分类取错项（比如排序一下标签，让「哲学」变成分类而模型本意是「佛教」），
 *     文章页就会给出一个和标签自相矛盾的说法；
 *   - 搜索把空白查询当成命中零条，或者对大小写敏感，读者就会盯着一个
 *     明显有内容的书库说「搜不到」。
 *
 * 两个都不是崩溃，只是错，且只有读的人会发现。所以每条规则单独钉一遍。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TAGS,
  allTagsOf,
  categoryOf,
  filterRowsByQuery,
  matchesQuery,
  normalizeQuery,
  normalizeTags,
  tagsBesidesCategory,
} from "../../src/lib/taxonomy.js";

const rows = [
  { title: "Our Uncertain Uncertainties", tags: ["人工智能", "科学", "未来"] },
  { title: "金刚经讲什么", tags: ["佛教", "佛学"] },
  { title: "Untagged essay", tags: [] },
  { title: "Partially tagged", tags: ["哲学"] },
];

test("分类是标签列表的第一项，顺序不排序", () => {
  assert.equal(categoryOf({ tags: ["佛教", "哲学", "历史"] }), "佛教");
  assert.equal(categoryOf({ tags: ["哲学", "佛教"] }), "哲学");
});

test("没有标签时分类是 null，而不是空字符串", () => {
  assert.equal(categoryOf({ tags: [] }), null);
  assert.equal(categoryOf({ tags: undefined }), null);
  assert.equal(categoryOf(null), null);
  assert.equal(categoryOf({}), null);
});

test("空白标签被剔除，所以第一个有效标签才是分类", () => {
  assert.equal(categoryOf({ tags: ["  ", "", "佛教", "哲学"] }), "佛教");
  assert.deepEqual(normalizeTags([" 佛教 ", "", "佛教", "哲学"]), ["佛教", "哲学"]);
});

test("分类不在标签行里重复出现", () => {
  assert.deepEqual(tagsBesidesCategory({ tags: ["佛教", "哲学", "历史"] }), ["哲学", "历史"]);
  assert.deepEqual(tagsBesidesCategory({ tags: ["佛教"] }), []);
  assert.deepEqual(tagsBesidesCategory({ tags: [] }), []);
});

test("全部标签与分类视图合起来等于原标签（分类在前）", () => {
  const row = { tags: ["佛教", "哲学", "历史"] };
  assert.deepEqual(
    [categoryOf(row), ...tagsBesidesCategory(row)],
    allTagsOf(row),
  );
});

test("只有标签项缺失时才为空，其他形状不影响", () => {
  assert.deepEqual(allTagsOf({ title: "x", tags: null }), []);
  assert.deepEqual(allTagsOf({ title: "x" }), []);
});

test("搜索命中标题，不区分大小写", () => {
  assert.equal(matchesQuery(rows[0]!, "uncertain"), true);
  assert.equal(matchesQuery(rows[0]!, "UNCERTAIN"), true);
  assert.equal(matchesQuery(rows[0]!, "不存在的词"), false);
});

test("搜索命中标签（含分类），中文按子串匹配", () => {
  assert.equal(matchesQuery(rows[1]!, "佛教"), true);
  // 单字命中「佛学」「佛教」两个标签。
  assert.equal(matchesQuery(rows[1]!, "佛"), true);
  assert.equal(matchesQuery(rows[0]!, "未来"), true);
});

test("空白查询命中一切，但不匹配任何东西的查询命中零条", () => {
  assert.equal(matchesQuery(rows[0]!, ""), true);
  assert.equal(matchesQuery(rows[0]!, "   "), true);
  assert.equal(matchesQuery(rows[0]!, null), true);
  assert.equal(matchesQuery(rows[0]!, "zzz"), false);
});

test("过滤：空查询返回全部（拷贝），而不是空数组", () => {
  const all = filterRowsByQuery(rows, "");
  assert.equal(all.length, rows.length);
  assert.notEqual(all, rows);
});

test("过滤：标题与标签两路都能命中，未命中的行消失", () => {
  assert.deepEqual(
    filterRowsByQuery(rows, "金刚").map((r) => r.title),
    ["金刚经讲什么"],
  );
  assert.deepEqual(
    filterRowsByQuery(rows, "哲学").map((r) => r.title),
    ["Partially tagged"],
  );
  assert.deepEqual(filterRowsByQuery(rows, "e").map((r) => r.title), [
    "Our Uncertain Uncertainties",
    "Untagged essay",
    "Partially tagged",
  ]);
});

test("查询归一化只做去空白和小写，不去重音、不切词", () => {
  assert.equal(normalizeQuery("  FoO  "), "foo");
  assert.equal(normalizeQuery(null), "");
  assert.equal(normalizeQuery(undefined), "");
});

test("标签上限与打标签模块保持一致", () => {
  // 文章页标签行按 `MAX_TAGS - 1` 截断（分类占一个），两处必须是同一个数。
  assert.equal(MAX_TAGS, 4);
});
