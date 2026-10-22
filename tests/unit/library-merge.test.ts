// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One shelf: the local/account merge.
 *
 * These are the rules a reader actually experiences — "my article must not
 * appear twice once it is on the account", "an article that only exists in the
 * account must still be listed", "the list stays newest-first". They are pure
 * data transformations, so they are pinned here rather than through a browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeLibraryRows, type LocalLibraryRow } from "../../src/lib/library-merge.js";

function localRow(overrides: Partial<LocalLibraryRow> = {}): LocalLibraryRow {
  return {
    id: "local-abc",
    title: "本机文章",
    createdAt: 1_000,
    tags: [],
    excerpt: "",
    charCount: 10,
    readMinutes: 1,
    annotationCount: 0,
    source: "local",
    ...overrides,
  };
}

test("anonymous library: no account rows, nothing changes", () => {
  const rows = mergeLibraryRows([localRow()], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "local");
});

test("an uploaded article and its account summary are one row", () => {
  const rows = mergeLibraryRows(
    [localRow({ id: "local-abc", remoteId: "art-server-1" })],
    [
      {
        id: "art-server-1",
        title: "本机文章",
        source: "text",
        sourceUrl: null,
        importedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  );
  assert.equal(rows.length, 1, "the summary must be folded into the local row");
  assert.equal(rows[0]!.id, "local-abc");
  assert.equal(rows[0]!.source, "local");
});

test("a pulled article (server id as local id) and its summary are one row", () => {
  const rows = mergeLibraryRows(
    [localRow({ id: "art-server-1", remoteId: undefined })],
    [
      {
        id: "art-server-1",
        title: "云端文章",
        source: "url",
        sourceUrl: "https://example.com/a",
        importedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "local");
});

test("an account-only article is listed as a cloud row", () => {
  const rows = mergeLibraryRows(
    [],
    [
      {
        id: "art-server-9",
        title: "只有云端",
        source: "url",
        sourceUrl: "https://example.com/b",
        importedAt: "2026-10-02T03:04:05.000Z",
      },
    ],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "art-server-9");
  assert.equal(rows[0]!.source, "cloud");
  assert.equal(rows[0]!.url, "https://example.com/b");
  assert.equal(rows[0]!.createdAt, Date.parse("2026-10-02T03:04:05.000Z"));
});

test("a summary without a title or a parsable date is still listed sanely", () => {
  const rows = mergeLibraryRows(
    [],
    [
      {
        id: "art-server-bad",
        title: "   ",
        source: "text",
        sourceUrl: null,
        importedAt: "not-a-date",
      },
    ],
  );
  assert.equal(rows[0]!.title, "(无标题)");
  assert.equal(rows[0]!.createdAt, 0);
  assert.equal(rows[0]!.url, undefined);
});

test("a duplicated summary is shown once", () => {
  const summary = {
    id: "art-server-1",
    title: "同一篇",
    source: "text",
    sourceUrl: null,
    importedAt: "2026-10-01T00:00:00.000Z",
  };
  const rows = mergeLibraryRows([], [summary, summary]);
  assert.equal(rows.length, 1);
});

test("rows are newest-first across both drawers", () => {
  const rows = mergeLibraryRows(
    [localRow({ id: "local-old", createdAt: 1_000 })],
    [
      {
        id: "art-new",
        title: "较新",
        source: "text",
        sourceUrl: null,
        importedAt: "2026-10-05T00:00:00.000Z",
      },
    ],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["art-new", "local-old"],
  );
});
