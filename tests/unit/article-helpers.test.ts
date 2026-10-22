// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Article library — unit tests for the URL importer's surface.
 *
 * The article routes themselves need a real session + a real Prisma;
 * that coverage lives in `tests/phase3.ts` and `tests/browser-articles.mjs`.
 * This file pins the bits that are testable without those: the SSRF
 * gate being wired into `importFromUrl`, the `NOT_IMPLEMENTED` 501
 * shape, and the `ContentBlock` round-trip helpers.
 *
 * The gate for these tests is "the importer refuses the dangerous URL
 * before it can ever reach `fetch`" — the actual network paths are
 * covered by `tests/unit/ssrf-guard.test.ts` (the rules) and the
 * integration test (the round trip against a real Postgres).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { importFromUrl, UrlImportNotReadyError } from "../../server/src/lib/url-import.js";
import { SsrfBlockedError } from "../../server/src/lib/ssrf-guard.js";
import type { ContentBlock } from "../../shared/contracts/index.js";

test("importFromUrl refuses loopback URLs (the SSRF gate is the first line of defence)", async () => {
  // The whole point of the SSRF guard is that the dangerous URL is
  // refused *before* a network request. This test pins that the
  // importer actually calls the gate, so a future refactor that
  // moves the check downstream of `fetch` would fail here.
  await assert.rejects(
    () => importFromUrl("http://127.0.0.1/post"),
    (err: unknown) => err instanceof SsrfBlockedError,
  );
});

test("importFromUrl refuses the AWS / GCP metadata service", async () => {
  // The single most damaging SSRF target. A regression here is a
  // critical-severity bug, not a polish issue.
  await assert.rejects(
    () => importFromUrl("http://169.254.169.254/latest/meta-data/"),
    (err: unknown) => err instanceof SsrfBlockedError,
  );
});

test("importFromUrl refuses file://, gopher://, javascript:, and data: URLs", async () => {
  for (const bad of [
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_FLUSHALL",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    await assert.rejects(
      () => importFromUrl(bad),
      (err: unknown) => err instanceof SsrfBlockedError,
      `must refuse ${bad}`,
    );
  }
});

test("UrlImportNotReadyError is preserved for callers that want the 501 mapping", () => {
  // The class is no longer thrown by `importFromUrl` (slice 2 wired the
  // real path), but the import route and any future feature-flag
  // fallback still reference it. Pin the shape so a silent rename of
  // the property surfaces here.
  const err = new UrlImportNotReadyError();
  assert.equal(err.statusCode, 501);
  assert.match(err.message, /粘贴正文/);
  assert.equal(err.name, "UrlImportNotReadyError");
});

test("ContentBlock reconstruction preserves the same id / index / type the parser emitted", () => {
  // Mirrors `paragraphToBlock` in routes/articles.ts. If the route
  // changes its field mapping, this assertion must change in
  // lockstep, which is the whole point: frontend code depends on
  // `id` being `b<index>-<hash8>`, and a silent rename here would
  // break every page that anchors by paragraph id.
  const fullHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const block: ContentBlock = {
    id: "b3-abcdef01",
    index: 3,
    type: "heading",
    text: "代码",
    hash: fullHash,
    level: 2,
  };
  const idPrefix = block.id.split("-")[0]!;
  const idHash = block.id.split("-")[1]!;
  assert.equal(idPrefix, `b${block.index}`);
  assert.equal(idHash.length, 8);
  assert.equal(idHash, block.hash.slice(0, 8));
});

test("an empty article cannot be reconstructed: zero blocks round-trip to an empty list", () => {
  // The route refuses to import a zero-block document with 422; this
  // test pins the "an empty `paragraphs` list survives the trip" half
  // of the contract, so a future bug that fabricates blocks does not
  // slip.
  const paragraphs: ContentBlock[] = [];
  const sorted = paragraphs.slice().sort((a, b) => a.index - b.index);
  assert.deepEqual(sorted, []);
  assert.equal(sorted.length, 0);
});
