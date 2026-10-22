// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileHighlights } from "../../src/lib/editing/anchors.js";
import type { Highlight } from "../../src/lib/types.js";

function highlight(overrides: Partial<Highlight> & Pick<Highlight, "selectionText" | "startOffset" | "endOffset">): Highlight {
  return {
    id: "h1",
    articleId: "a1",
    paragraphIndex: 1,
    color: "yellow",
    createdAt: 0,
    ...overrides,
  };
}

test("a range that still covers the same quote stays put", () => {
  const source = highlight({ selectionText: "world", startOffset: 6, endOffset: 11 });
  const result = reconcileHighlights([source], 1, "Hello world");
  assert.equal(result.reanchored, 0);
  assert.equal(result.detached, 0);
  assert.equal(result.next[0], source);
});

test("a quote that occurs exactly once is re-anchored after an edit before it", () => {
  const source = highlight({ selectionText: "world", startOffset: 0, endOffset: 5 });
  const result = reconcileHighlights([source], 1, "Hello world");
  assert.equal(result.reanchored, 1);
  assert.equal(result.detached, 0);
  assert.deepEqual(
    { start: result.next[0]!.startOffset, end: result.next[0]!.endOffset },
    { start: 6, end: 11 },
  );
});

test("a quote that is gone (or ambiguous) is detached, never guessed", () => {
  const gone = highlight({ selectionText: "world", startOffset: 0, endOffset: 5 });
  const goneResult = reconcileHighlights([gone], 1, "Hello there");
  assert.equal(goneResult.detached, 1);
  assert.equal(goneResult.next[0]!.detached, true);

  const ambiguous = highlight({ selectionText: "foo", startOffset: 10, endOffset: 13 });
  const ambiguousResult = reconcileHighlights([ambiguous], 1, "foo bar foo");
  assert.equal(ambiguousResult.detached, 1);
  assert.equal(ambiguousResult.next[0]!.detached, true);
});

test("highlights on other paragraphs are returned untouched", () => {
  const other = highlight({ selectionText: "x", startOffset: 0, endOffset: 1, paragraphIndex: 2 });
  const result = reconcileHighlights([other], 1, "completely different");
  assert.equal(result.next[0], other);
  assert.equal(result.changed.length, 0);
});

test("an already detached highlight is not reconsidered", () => {
  const detached = { ...highlight({ selectionText: "world", startOffset: 0, endOffset: 5 }), detached: true };
  const result = reconcileHighlights([detached], 1, "Hello world");
  assert.equal(result.next[0], detached);
  assert.equal(result.reanchored, 0);
  assert.equal(result.detached, 0);
});
