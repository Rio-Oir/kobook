// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Library grouping and cover art are pure functions, so they are pinned here
 * rather than in a browser test: the date labels, the filter counts and the
 * deterministic cover are exactly the parts that a refactor is most likely to
 * break silently (a wrong "昨天" or a tag counted twice is invisible until a
 * reader notices their library lies).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateTags,
  charCountOf,
  dateGroupLabel,
  dayKey,
  excerptOf,
  filterRowsByTag,
  fullDateTime,
  groupRowsByDay,
  readingMinutes,
  relativeTimeLabel,
  timeLabel,
} from "../../src/lib/library-groups.js";
import { COVER_IMAGE_COUNT, coverArtFor, coverGlyph, coverImageFor } from "../../src/lib/covers.js";

/** Local noon, so no timezone offset can move the calendar day. */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

const NOW = noon(2026, 10, 20);

test("dateGroupLabel distinguishes today, yesterday and older days", () => {
  assert.equal(dateGroupLabel(noon(2026, 10, 20), NOW), "今天");
  assert.equal(dateGroupLabel(noon(2026, 10, 19), NOW), "昨天");
  // 2026-10-18 was a Sunday.
  assert.equal(dateGroupLabel(noon(2026, 10, 18), NOW), "10月18日 周日");
  assert.equal(dateGroupLabel(noon(2025, 10, 18), NOW), "2025年10月18日 周六");
});

test("dayKey is local, not UTC", () => {
  // 23:30 local on the 20th must stay the 20th even east of UTC.
  assert.equal(dayKey(new Date(2026, 9, 20, 23, 30).getTime()), "2026-10-20");
  assert.equal(timeLabel(new Date(2026, 9, 20, 9, 5).getTime()), "09:05");
  assert.equal(
    fullDateTime(new Date(2026, 9, 20, 5, 56, 31).getTime()),
    "2026-10-20 05:56:31",
  );
});

test("groupRowsByDay keeps newest-first order inside each day", () => {
  const rows = [
    { id: "a", createdAt: noon(2026, 10, 20) + 2000 },
    { id: "b", createdAt: noon(2026, 10, 20) },
    { id: "c", createdAt: noon(2026, 10, 19) },
  ];
  const groups = groupRowsByDay(rows, NOW);
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((r) => r.id)]),
    [
      ["今天", ["a", "b"]],
      ["昨天", ["c"]],
    ],
  );
});

test("aggregateTags counts each tag once per article and sorts by use", () => {
  const tags = aggregateTags([
    { tags: ["哲学", "佛教"] },
    { tags: ["哲学"] },
    { tags: ["科技", "哲学"] },
    { tags: undefined },
  ]);
  assert.deepEqual(tags, [
    { tag: "哲学", count: 3 },
    { tag: "佛教", count: 1 },
    { tag: "科技", count: 1 },
  ]);
});

test("filterRowsByTag treats null as everything and matches exactly", () => {
  const rows = [{ tags: ["哲学"] }, { tags: ["科技"] }, {}];
  assert.equal(filterRowsByTag(rows, null).length, 3);
  assert.equal(filterRowsByTag(rows, "哲学").length, 1);
  assert.equal(filterRowsByTag(rows, "哲").length, 0);
});

test("excerptOf collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(excerptOf("  一\n\n段 文字 "), "一 段 文字");
  const long = "字".repeat(200);
  const excerpt = excerptOf(long, 10);
  assert.equal(Array.from(excerpt).length, 10);
  assert.ok(excerpt.endsWith("…"));
});

test("relativeTimeLabel reads like a collection app, then falls back to a date", () => {
  assert.equal(relativeTimeLabel(NOW - 30_000, NOW), "刚刚");
  assert.equal(relativeTimeLabel(NOW - 12 * 60_000, NOW), "12 分钟前");
  assert.equal(relativeTimeLabel(NOW - 18 * 3_600_000, NOW), "18 小时前");
  assert.equal(relativeTimeLabel(NOW - 4 * 86_400_000, NOW), "4 天前");
  assert.equal(relativeTimeLabel(noon(2026, 9, 1), NOW), "9月1日");
});

test("reading length helpers ignore whitespace and never read as 0 minutes", () => {
  assert.equal(charCountOf([{ text: "一二 三\n四" }]), 4);
  assert.equal(readingMinutes(1), 1);
  assert.equal(readingMinutes(4000), 10);
});

test("cover art is deterministic and strips title punctuation", () => {
  const first = coverArtFor("《金刚经》文白对照");
  const second = coverArtFor("《金刚经》文白对照");
  assert.deepEqual(first, second);
  assert.equal(first.glyph, "金");
  assert.match(first.background, /rgb\(var\(--surface2\)\)/);
  assert.notEqual(coverArtFor("科技").background, "");
  assert.equal(coverGlyph("「庄子」"), "庄");
  assert.equal(coverGlyph("一份关于注意力的产品笔记"), "份");
  assert.equal(coverGlyph("   "), "文");
});

test("the default cover library is deterministic and keyed by the article id", () => {
  // The 12 paintings in `public/covers/` are the cover for articles with no
  // picture of their own. The pick comes from the article id, not the title:
  // two articles that share a title still get different pictures, and one
  // article keeps its picture across reloads and devices — a cover that
  // reshuffles under the reader reads as a bug, not as design.
  const a = coverArtFor("同名文章", "art-one");
  const b = coverArtFor("同名文章", "art-two");
  assert.equal(a.image, coverArtFor("同名文章", "art-one").image);
  assert.match(String(a.image), /^\/covers\/\d{2}\.webp$/);
  assert.match(String(b.image), /^\/covers\/\d{2}\.webp$/);
  // Every id has to land inside the shipped set: no `13.webp` that does not
  // exist, no leading-slash-less path.
  const seen = new Set<string>();
  for (let i = 0; i < 40; i += 1) {
    const path = coverImageFor(`id-${i}`);
    assert.ok(path, `coverImageFor(id-${i}) must return a path`);
    const index = Number(path!.slice("/covers/".length, -".webp".length));
    assert.ok(index >= 1 && index <= COVER_IMAGE_COUNT, `${path} is inside the library`);
    seen.add(path!);
  }
  // A library of one painting would be a constant; the set has to actually
  // spread ids across the shipped files.
  assert.ok(seen.size > 1, `the library must offer more than one painting, got ${seen.size}`);
});
