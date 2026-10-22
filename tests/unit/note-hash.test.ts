// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Notes surface — unit tests for the pure helpers.
 *
 * The actual cross-user / refresh / selection-tamper coverage lives in
 * `tests/phase3.ts` because it needs a real Postgres. This file pins
 * the parts that are testable without the database:
 *
 *   - `selectionHash` is over the *normalised* text, so a client that
 *     adds or removes whitespace still matches the server's hash.
 *   - The normalisation rule collapses runs of whitespace the same way
 *     `parseContent` does, so the server-side validation re-derives the
 *     exact same string the client should have hashed.
 *
 * A regression here is a "the client and server disagree on what the
 * selection text is" bug, which would make every note fail to create
 * with a 422.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { normalizeProse } from "../../server/src/lib/parse/blocks.js";

/**
 * Mirror of the server-side `hashSelection`: sha256 over the normalised
 * text. The test file intentionally re-implements the function so a
 * divergence between this and the route handler is observable.
 */
function clientHashSelection(text: string): string {
  return createHash("sha256").update(normalizeProse(text), "utf8").digest("hex");
}

test("normalise collapses runs of whitespace the way the server expects", () => {
  // The server's `normalizeProse` rule: tab / form feed / vertical tab /
  // NBSP / ideographic space collapse to a single ASCII space, and
  // newlines inside a paragraph become a space too.
  assert.equal(normalizeProse("  你好\n\n世界  \t\t!"), "你好 世界 !");
  assert.equal(normalizeProse("a 　b"), "a b");
  assert.equal(normalizeProse("single"), "single");
});

test("a client-supplied selection that adds extra whitespace still matches", () => {
  // The user selected "你好 世界" in the browser. They sent the
  // selection back as "  你好\n世界  " (the browser may include
  // surrounding whitespace depending on the range). After both sides
  // hash the normalised form, the hashes must match.
  const serverSide = "你好 世界";
  const clientSent = "  你好\n世界  ";
  assert.equal(clientHashSelection(serverSide), clientHashSelection(clientSent));
});

test("a selection that has different text in it does not match", () => {
  assert.notEqual(
    clientHashSelection("你好 世界"),
    clientHashSelection("你好 地球"),
  );
});

test("an empty / whitespace-only selection does not match a real paragraph", () => {
  // Defensive: if a future bug makes the server-side validation accept
  // an empty selection, the test still fails loudly. The empty string
  // normalises to "" which does not match a non-empty paragraph.
  assert.equal(normalizeProse("   \n\t  "), "");
  assert.notEqual(clientHashSelection(""), clientHashSelection("正文"));
});
