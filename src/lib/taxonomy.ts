// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 分类与搜索 —— 一篇文章归到哪一类，以及一次搜索命中什么。
 *
 * ## 分类从哪来
 *
 * 文章没有单独的分类字段，也不新增一个：AI 打标签（`lib/tagging.ts`）已经
 * 给每篇生成了 2–4 个短标签，而「分类」本来就是这个列表的第一项——模型被
 * 要求按相关度从高到低给标签，第一个就是它认为最贴近全文的那个主题。把它
 * 提出来当分类，一本书就不必为了归类和打标签存两套词表，也不会出现「标签
 * 说佛教，分类说哲学」这种自相矛盾。
 *
 * 规则只有一条，且写在这里而不是散在页面里：**`tags[0]` 是分类，其余是
 * 标签**。空字符串和纯空白不算标签，`normalizeTags` 负责把它们剔掉，
 * 所以「第一个标签」不会是一个空格。
 *
 * ## 搜索命中什么
 *
 * 标题，或任一标签（含分类）。查询串做最小归一化：去首尾空白、小写。中文
 * 没有词形变化，所以子串匹配就够；不做分词、不做拼音、不做模糊纠错——这些
 * 每一个都会让「我输的明明是标题里的字，却搜不到」变得可能，而那正是搜索
 * 最不该有的失败。
 *
 * 纯函数，无 DOM、无 store：书库页、阅读页和单元测试用的是同一套判断。
 */

/** 一行能被搜索/归类所需的最小形状。书库行和文章记录都满足它。 */
export type Taxable = {
  title?: string | null;
  tags?: readonly string[] | null;
};

/** 一篇最多认几个标签；与 `lib/tagging.ts` 的 `MAX_TAGS` 一致。 */
export const MAX_TAGS = 4;

/**
 * 去掉空白项、去重（按小写比较）、保留原大小写与顺序。
 *
 * 顺序就是语义：第一个是分类，所以这里绝不能排序。
 */
export function normalizeTags(raw: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw ?? []) {
    const tag = typeof item === "string" ? item.trim() : "";
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * 这篇文章的分类：第一个标签。
 *
 * `null` 表示还没有标签（没配密钥、或正文不在本机、或生成失败）。调用方
 * 据此显示「未分类」，而不是显示一个空字符串。
 */
export function categoryOf(row: Taxable | null | undefined): string | null {
  return normalizeTags(row?.tags)[0] ?? null;
}

/** 分类之外的标签。分类不在这份列表里重复出现。 */
export function tagsBesidesCategory(row: Taxable | null | undefined): string[] {
  return normalizeTags(row?.tags).slice(1);
}

/** 一篇文章的全部标签（分类在前）。生成/重新生成后的展示用。 */
export function allTagsOf(row: Taxable | null | undefined): string[] {
  return normalizeTags(row?.tags);
}

/** 查询串归一化：去首尾空白、转小写。空串表示「没有查询」。 */
export function normalizeQuery(query: string | null | undefined): string {
  return (query ?? "").trim().toLowerCase();
}

/**
 * 这一行是否命中查询。
 *
 * 空查询命中所有行——调用方通常先用 `normalizeQuery` 判断空值，这里再判一次
 * 只是为了让「清空搜索框」的行为不依赖调用方写对。
 *
 * 标签按「包含」匹配：输入「佛」能找到「佛教」，这是中文搜索里读者真正
 * 期待的粒度。
 */
export function matchesQuery(row: Taxable, query: string | null | undefined): boolean {
  const q = normalizeQuery(query);
  if (q.length === 0) return true;
  const title = (row.title ?? "").toLowerCase();
  if (title.includes(q)) return true;
  return normalizeTags(row.tags).some((tag) => tag.toLowerCase().includes(q));
}

/** 过滤一组行；空查询原样返回（不是空数组）。 */
export function filterRowsByQuery<T extends Taxable>(
  rows: readonly T[],
  query: string | null | undefined,
): T[] {
  const q = normalizeQuery(query);
  if (q.length === 0) return [...rows];
  return rows.filter((row) => matchesQuery(row, q));
}
