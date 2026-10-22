// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Account metadata that lives on the article record: tags, the generated
 * summary, and the cover / published date.
 *
 * All three used to be device-only. The tagger and the summariser are model
 * calls — expensive and identical everywhere — and the cover is a property of
 * the page, not of the laptop that fetched it, so every one of them belongs to
 * the account.
 *
 * The push is deliberately coarse: whole-value PUTs, idempotent on the server,
 * and one attempt per article per page load (`pushed`). A failed push is not
 * retried in a loop — the next open tries again, and nothing the reader is
 * doing depends on the request having landed.
 */

import { putArticleBrief, putArticleMeta, putArticleTags } from "./account-articles";
import { actingUserId, getSyncedArticleId, isCloudEnabled } from "./cloud-notes";
import { useStore } from "./store";

/** Articles whose metadata has already been offered to the server this load. */
const pushed = new Set<string>();

/**
 * Push everything the local record knows about this article.
 *
 * Called when the Reader opens an article. The server keeps whatever it has
 * for fields this device does not know (a `coverImage` that is absent from the
 * request is not cleared), so a device that never fetched the page cannot
 * erase the picture another device stored.
 */
export async function pushArticleMetadata(articleId: string): Promise<void> {
  if (!isCloudEnabled() || pushed.has(articleId)) return;
  const ownerUserId = actingUserId();
  if (!ownerUserId) return;
  const serverArticleId = getSyncedArticleId(articleId);
  if (!serverArticleId) return;
  const article = useStore.getState().articles[articleId];
  if (!article) return;
  pushed.add(articleId);

  const tasks: Promise<unknown>[] = [];
  if (article.tags && article.tags.length > 0) {
    tasks.push(
      putArticleTags(serverArticleId, {
        tags: article.tags,
        ...(article.tagsModel ? { model: article.tagsModel } : {}),
        ...(article.tagsAt ? { at: article.tagsAt } : {}),
      }),
    );
  }
  if (article.brief) {
    tasks.push(putArticleBrief(serverArticleId, { brief: article.brief, at: article.brief.generatedAt }));
  }
  if (article.coverImage || article.publishedAt) {
    tasks.push(
      putArticleMeta(serverArticleId, {
        ...(article.coverImage ? { coverImage: article.coverImage } : {}),
        ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}),
      }),
    );
  }
  await Promise.allSettled(tasks);
}

/** Push tags immediately after a successful tagging run (bypasses the guard). */
export async function pushTagsNow(articleId: string): Promise<void> {
  if (!isCloudEnabled()) return;
  const ownerUserId = actingUserId();
  if (!ownerUserId) return;
  const serverArticleId = getSyncedArticleId(articleId);
  if (!serverArticleId) return;
  const article = useStore.getState().articles[articleId];
  if (!article?.tags || article.tags.length === 0) return;
  pushed.add(articleId);
  try {
    await putArticleTags(serverArticleId, {
      tags: article.tags,
      ...(article.tagsModel ? { model: article.tagsModel } : {}),
      ...(article.tagsAt ? { at: article.tagsAt } : {}),
    });
  } catch {
    // Not fatal: the next open's `pushArticleMetadata` retries it.
  }
}

/** Push a freshly generated summary (bypasses the once-per-load guard). */
export async function pushBriefNow(articleId: string): Promise<void> {
  if (!isCloudEnabled()) return;
  const ownerUserId = actingUserId();
  if (!ownerUserId) return;
  const serverArticleId = getSyncedArticleId(articleId);
  if (!serverArticleId) return;
  const article = useStore.getState().articles[articleId];
  if (!article?.brief) return;
  pushed.add(articleId);
  try {
    await putArticleBrief(serverArticleId, {
      brief: article.brief,
      at: article.brief.generatedAt,
    });
  } catch {
    // Same as tags: the next open retries.
  }
}

/** Test seam: forget which articles were pushed this load. */
export function resetMetadataPushState(): void {
  pushed.clear();
}
