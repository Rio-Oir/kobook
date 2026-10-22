// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure helpers behind the library's date sections and tag filter.
 *
 * Kept out of `Library.tsx` so the rules that decide "今天 / 昨天 / 10月18日"
 * and how a tag list is counted can be unit-tested without a DOM, and so the
 * Reader can reuse the date/time formatters for its metadata rows.
 *
 * Everything here reads local time on purpose: a reader's "today" is their
 * own calendar day, not UTC's. `Date` already resolves to the local zone, and
 * the grouping key is built from local Y/M/D rather than `toISOString()`
 * (which would shift a 23:30 import into tomorrow for UTC+8 users).
 */

export type Dated = { createdAt: number };
export type Tagged = { tags?: string[] | null };

export type DateGroup<T> = {
  /** Local `YYYY-MM-DD`; stable React key. */
  key: string;
  /** 今天 / 昨天 / 10月18日 周六 / 2025年10月18日 周六 */
  label: string;
  items: T[];
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local calendar key. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Section heading for a timestamp.
 *
 * `now` is injectable so tests do not depend on the wall clock. Older days
 * carry the weekday because "10月18日" alone does not say whether that was a
 * weekend; the year appears only when it is not the current one.
 */
export function dateGroupLabel(ts: number, now: number = Date.now()): string {
  const today = new Date(now);
  const target = new Date(ts);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(target, today)) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(target, yesterday)) return "昨天";

  const md = `${target.getMonth() + 1}月${target.getDate()}日 ${WEEKDAYS[target.getDay()]}`;
  return target.getFullYear() === today.getFullYear()
    ? md
    : `${target.getFullYear()}年${md}`;
}

/** `14:32` — the card meta line; the section heading already carries the day. */
export function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * The card footer's age, in the "刚刚 / 12 分钟前 / 18 小时前 / 4 天前" form
 * used by collection apps. The day section heading already says *which* day,
 * so this answers "how long ago" without repeating a date; past a week an
 * absolute `M月D日` is shorter and more useful than "37 天前".
 */
export function relativeTimeLabel(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (!Number.isFinite(diff) || diff <= 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** `2026-10-20 05:56:31` — the Reader's 创建时间 row, matching the reference. */
export function fullDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Group a newest-first row list into one section per local day.
 *
 * Rows are bucket-sorted rather than re-sorted, so a caller that already
 * ordered by `createdAt` keeps its ordering (and any deliberate overrides)
 * inside each section. Sections themselves stay in first-seen order, which
 * for newest-first input is newest day first.
 */
export function groupRowsByDay<T extends Dated>(
  rows: readonly T[],
  now: number = Date.now(),
): DateGroup<T>[] {
  const groups = new Map<string, DateGroup<T>>();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: dateGroupLabel(row.createdAt, now), items: [] };
      groups.set(key, group);
    }
    group.items.push(row);
  }
  return Array.from(groups.values());
}

/** `{ tag, count }`, most-used first, then by name for a stable order. */
export function aggregateTags(rows: readonly Tagged[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const raw of row.tags ?? []) {
      const tag = raw.trim();
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"),
  );
}

/** Rows carrying `tag`; `null` means "everything". A row may carry many. */
export function filterRowsByTag<T extends Tagged>(rows: readonly T[], tag: string | null): T[] {
  if (!tag) return [...rows];
  return rows.filter((row) => (row.tags ?? []).includes(tag));
}

/**
 * A one-or-two-line teaser for a card.
 *
 * Newlines collapse to spaces because the line clamp measures a single
 * paragraph; headings that end in a colon are skipped when a following
 * paragraph exists, so the teaser is prose rather than a section title.
 */
export function excerptOf(text: string, max = 110): string {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (normalised.length <= max) return normalised;
  return `${normalised.slice(0, max - 1).trimEnd()}…`;
}

/** Characters that count as "reading volume": everything but whitespace. */
export function charCountOf(paragraphs: readonly { text: string }[]): number {
  let total = 0;
  for (const paragraph of paragraphs) {
    total += paragraph.text.replace(/\s+/g, "").length;
  }
  return total;
}

/**
 * Minutes at 400 CJK characters per minute, the slow end of common
 * Chinese-reading estimates. Never below one: "1 分钟" reads better than
 * "0 分钟" on a short note.
 */
export function readingMinutes(charCount: number): number {
  return Math.max(1, Math.round(charCount / 400));
}

/** `2314` -> `2,314`; used in the card meta and the Reader header. */
export function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}
