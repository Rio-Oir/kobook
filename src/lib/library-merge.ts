// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One shelf, two drawers.
 *
 * The reader's articles live in two places that are not the same store: the
 * device (zustand + IndexedDB, readable offline and without an account) and the
 * account (`/api/articles`, readable from any device). Showing them as two
 * pages is what made a signed-in reader see their library twice; this module is
 * the rule that turns both drawers into **one** list.
 *
 * ## What counts as the same article
 *
 *  - a local record that has been uploaded carries `remoteId` — that is the
 *    account row it *is*, so the summary is dropped;
 *  - a local record that was pulled down from the account carries the server id
 *    as its own id — same thing, matched by id;
 *  - everything else in the account list is kept as a `cloud` row: it exists,
 *    but its text is not on this device yet, so opening it must fetch first.
 *
 * There is deliberately no fuzzy matching (title / URL guessing) here. The
 * server already applies "same content = same article" when an upload lands
 * (see the sync route), so by the time a row reaches this function the identity
 * question has an authoritative answer; both sides are keyed by it or they are
 * genuinely different rows.
 */

import type { ArticleSummary } from "./cloud/contracts";

/** One row the library renders, whatever drawer it came from. */
export interface LibraryRow {
  id: string;
  title: string;
  url?: string;
  createdAt: number;
  tags: string[];
  excerpt: string;
  charCount: number;
  readMinutes: number;
  annotationCount: number;
  /** The article's own picture, when it has one (see `Article.coverImage`). */
  coverImage?: string;
  /**
   * `local` — the text is on this device.
   * `cloud` — the account has it; opening it downloads the body first.
   */
  source: "local" | "cloud";
}

/** A local row, plus the account binding that makes it the same as a summary. */
export interface LocalLibraryRow extends LibraryRow {
  remoteId?: string;
}

/**
 * Merge the device's shelf with the account's list into one newest-first list.
 *
 * The account list is authoritative for "does the account have this article":
 * a local row with a `remoteId` suppresses its summary, and a summary whose id
 * matches a local row (the pulled-down case) is suppressed too. Summaries are
 * deduplicated by id as well, so a paged fetch that overlaps cannot show a row
 * twice.
 */
export function mergeLibraryRows(
  local: readonly LocalLibraryRow[],
  cloud: readonly ArticleSummary[],
): LibraryRow[] {
  const seen = new Set<string>();
  const rows: LibraryRow[] = [];

  for (const row of local) {
    seen.add(row.id);
    if (row.remoteId) seen.add(row.remoteId);
    rows.push({
      id: row.id,
      title: row.title,
      url: row.url,
      createdAt: row.createdAt,
      tags: row.tags,
      excerpt: row.excerpt,
      charCount: row.charCount,
      readMinutes: row.readMinutes,
      annotationCount: row.annotationCount,
      ...(row.coverImage ? { coverImage: row.coverImage } : {}),
      source: "local",
    });
  }

  for (const summary of cloud) {
    if (seen.has(summary.id)) continue;
    seen.add(summary.id);
    const importedAt = Date.parse(summary.importedAt);
    rows.push({
      id: summary.id,
      title: summary.title.trim().length > 0 ? summary.title : "(无标题)",
      ...(summary.sourceUrl ? { url: summary.sourceUrl } : {}),
      // A row with an unparseable timestamp sorts last rather than jumping to
      // the top of a date-grouped list.
      createdAt: Number.isNaN(importedAt) ? 0 : importedAt,
      tags: [],
      excerpt: "",
      charCount: 0,
      readMinutes: 0,
      annotationCount: 0,
      source: "cloud",
    });
  }

  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
