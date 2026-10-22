// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Setting the anonymous workspace aside has to move the *text* too.
 *
 * The failure this pins is silent and reads like a rendering bug: after
 * signing in and back out, the shelf returns and every book on it opens empty.
 * It happened because the archive was a copy of the `localStorage` blob while
 * the text had already moved to IndexedDB — so the snapshot held the records
 * and none of the paragraphs, and `clearUserCache` purged the bodies on the
 * next tick. Nothing anywhere reported a problem.
 *
 * Three properties, and the third is the one that makes a shared namespace
 * unusable rather than merely wasteful:
 *
 *   1. archiving copies the text, for the articles the snapshot lists;
 *   2. the archive survives the wipe paths, which sweep the live store by
 *      enumeration;
 *   3. an account that owns the *same* article id does not collide with the
 *      archived one. A local id is `local-<sha256(text)[0:16]>` — a pure text
 *      hash with no device or account in it — so "the anonymous space and the
 *      account imported the same passage" is the normal case, not a corner.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { installMemoryLocalStorage, resetBodyStorage } from "./storage-fixture.js";

await installMemoryLocalStorage();

const { useStore } = await import("../../src/lib/store.js");
const { ANONYMOUS_OWNER } = await import("../../src/lib/identity.js");
const { archiveAnonymousSpace, restoreAnonymousSpace } = await import(
  "../../src/lib/migration-store.js"
);
const { readBody, listArchivedBodyIds, readArchivedBodies } = await import(
  "../../src/lib/storage/bodies.js"
);
const { sha256Hex } = await import("../../src/lib/local-import-blocks.js");

const ARTICLE_ID = "local-0123456789abcdef";
const ANON_TEXT = "匿名空间里的这一段正文。";
const ACCOUNT_TEXT = "账号自己的另一段正文。";

function paragraphs(text: string, blockId = `b1-${sha256Hex(text).slice(0, 8)}`) {
  return [{ index: 1, text, hash: sha256Hex(text), blockId, type: "paragraph" as const }];
}

/** Save an article into the anonymous space, body and all. */
async function seedAnonymous(text: string): Promise<void> {
  useStore.setState({ ownerUserId: ANONYMOUS_OWNER });
  await useStore.getState().saveArticle({ id: ARTICLE_ID, title: "匿名文章", createdAt: 1 }, paragraphs(text));
}

/** Wait for the wipe's fire-and-forget body deletion to land. */
async function waitForBodyGone(articleId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readBody(articleId)) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`the body for ${articleId} was never purged`);
}

beforeEach(async () => {
  await resetBodyStorage();
  useStore.getState().clearUserCache();
  useStore.setState({ ownerUserId: ANONYMOUS_OWNER, currentArticleId: null });
});

test("a sign-in that sets the anonymous space aside gives back the records and the text", async () => {
  await seedAnonymous(ANON_TEXT);

  assert.equal(await archiveAnonymousSpace(), true);
  assert.deepEqual(
    await listArchivedBodyIds(),
    [ARTICLE_ID],
    "archiving the shelf without the books is the bug this exists to prevent",
  );

  // The account takes the live space: records cleared, bodies purged.
  useStore.getState().clearUserCache();
  useStore.getState().setOwner("user-1");
  await waitForBodyGone(ARTICLE_ID);
  assert.deepEqual(useStore.getState().articles, {}, "the account starts with a clean shelf");

  // Back to anonymous.
  assert.equal(await restoreAnonymousSpace(), true);
  assert.ok(useStore.getState().articles[ARTICLE_ID], "the shelf comes back");
  assert.deepEqual(
    (await readBody(ARTICLE_ID))?.paragraphs,
    paragraphs(ANON_TEXT),
    "and so does the text — an empty reader here is the whole failure",
  );
});

test("the archive survives the wipe paths, which sweep the live store", async () => {
  await seedAnonymous(ANON_TEXT);
  await archiveAnonymousSpace();

  // `clearUserCache` is the path a sign-out takes, and its deletion enumerates
  // the live store precisely so that orphaned bodies cannot survive it. The
  // archive is not an orphan; it is the reader's library held aside.
  useStore.getState().clearUserCache();
  await waitForBodyGone(ARTICLE_ID);

  assert.deepEqual(await listArchivedBodyIds(), [ARTICLE_ID]);
  assert.deepEqual((await readArchivedBodies([ARTICLE_ID]))[0]?.paragraphs, paragraphs(ANON_TEXT));
});

test("an account owning the same article id does not collide with the archived body", async () => {
  await seedAnonymous(ANON_TEXT);
  await archiveAnonymousSpace();

  useStore.getState().clearUserCache();
  useStore.getState().setOwner("user-1");
  await waitForBodyGone(ARTICLE_ID);

  // The account's copy of the same article id, with the block id the server
  // assigned rather than the one the anonymous parse minted. That difference is
  // the observable half of the collision: the ids are equal, the bodies are not.
  await useStore.getState().saveArticle(
    { id: ARTICLE_ID, title: "账号的文章", createdAt: 2 },
    paragraphs(ACCOUNT_TEXT, "b1-account"),
  );
  assert.equal((await readBody(ARTICLE_ID))?.paragraphs[0]?.blockId, "b1-account");

  assert.deepEqual(
    (await readArchivedBodies([ARTICLE_ID]))[0]?.paragraphs,
    paragraphs(ANON_TEXT),
    "the account's write must not reach into the anonymous archive",
  );

  // And the restore still hands back the anonymous body, not the account's.
  useStore.setState({ ownerUserId: "user-1" });
  useStore.getState().clearUserCache();
  assert.equal(await restoreAnonymousSpace(), true);
  assert.deepEqual(
    (await readBody(ARTICLE_ID))?.paragraphs,
    paragraphs(ANON_TEXT),
    "restoring must give the anonymous space its own text back",
  );
});
