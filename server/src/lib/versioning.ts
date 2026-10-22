// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Version numbering for article refreshes.
 *
 * `refresh` means "write the next integer version and demote the current
 * one". Doing that as a plain read-then-write races: two concurrent
 * refreshes on the same article both read `latest = 1`, both try to
 * insert `version = 2`, and the loser hits the
 * `article_version_articleId_version_key` unique index — which surfaces
 * as an unhandled 500 rather than as a conflict the caller can reason
 * about.
 *
 * The fix is to serialise the pair with a row-level lock on the parent
 * `article` row, taken *before* the `max(version)` read. Concurrent
 * refreshes on one article then queue up and each gets a distinct
 * version; refreshes on different articles still run in parallel, which
 * is what a per-article lock buys over a global one.
 *
 * Both the text refresh (`routes/notes.ts`) and the URL re-import
 * (`routes/articles.ts`) go through here so the two paths cannot drift.
 */

import type { AppPrisma } from "../db.js";

/**
 * The subset of the Prisma client available inside `$transaction` that
 * these helpers need. Declared structurally so callers can pass either
 * the interactive-transaction client or the plain client.
 */
export interface VersioningTx {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  articleVersion: {
    findFirst(args: {
      where: { articleId: string };
      orderBy: { version: "desc" };
      select: { version: true };
    }): Promise<{ version: number } | null>;
  };
}

/**
 * Take the per-article lock. Must be called inside the transaction that
 * also writes the new version, before reading the current maximum.
 *
 * `FOR UPDATE` on a row that exists blocks any other transaction that
 * asks for the same row; the second refresh waits, then reads the
 * committed `max(version)` including the first refresh's insert.
 */
export async function lockArticleForRefresh(
  tx: VersioningTx,
  articleId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "article" WHERE id = ${articleId} FOR UPDATE`;
}

/** The next 1-based version for an article. Call under the lock. */
export async function nextVersionNumber(
  tx: VersioningTx,
  articleId: string,
): Promise<number> {
  const latest = await tx.articleVersion.findFirst({
    where: { articleId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return (latest?.version ?? 0) + 1;
}

/**
 * Convenience wrapper: lock, then compute. Kept as one call so a caller
 * cannot accidentally read the version without holding the lock.
 */
export async function reserveNextVersion(
  tx: VersioningTx,
  articleId: string,
): Promise<number> {
  await lockArticleForRefresh(tx, articleId);
  return nextVersionNumber(tx, articleId);
}

/** Re-exported so call sites do not need a second import. */
export type { AppPrisma };
