// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyParagraphEdit,
  blockIdFor,
  blocksDigestOf,
  bodyStatsOf,
} from "../../src/lib/editing/apply-edit.js";
import { sha256Hex } from "../../src/lib/local-import-blocks.js";
import type { Paragraph } from "../../src/lib/types.js";

function paragraph(index: number, text: string, blockId?: string): Paragraph {
  const hash = sha256Hex(text);
  return {
    index,
    text,
    hash,
    ...(blockId ? { blockId } : {}),
  };
}

test("an edit recomputes the hash but keeps the block id", () => {
  const paragraphs = [paragraph(1, "第一段", "b1-original"), paragraph(2, "第二段", "b2-original")];
  const result = applyParagraphEdit(paragraphs, 2, { text: "第二段改过了" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.paragraph.hash, sha256Hex("第二段改过了"));
  assert.equal(result.paragraph.blockId, "b2-original");
  assert.equal(result.changed, true);
  assert.equal(result.stats.paragraphs, 2);
});

test("a paragraph that never had a block id gets the parse-layer shape", () => {
  const paragraphs = [paragraph(1, "第一段")];
  const result = applyParagraphEdit(paragraphs, 1, { text: "新的第一段" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.paragraph.blockId, blockIdFor(1, sha256Hex("新的第一段")));
});

test("editing only spans leaves the text and hash untouched", () => {
  const paragraphs = [paragraph(1, "粗体")];
  const result = applyParagraphEdit(paragraphs, 1, {
    text: "粗体",
    spans: [{ start: 0, end: 2, kinds: ["strong"] }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.paragraph.text, "粗体");
  assert.equal(result.paragraph.hash, sha256Hex("粗体"));
  assert.deepEqual(result.paragraph.spans, [{ start: 0, end: 2, kinds: ["strong"] }]);
  assert.equal(result.changed, true);
});

test("removing all emphasis drops the spans field rather than writing []", () => {
  const base = paragraph(1, "粗体");
  base.spans = [{ start: 0, end: 2, kinds: ["strong"] }];
  const result = applyParagraphEdit([base], 1, { text: "粗体", spans: [] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal("spans" in result.paragraph, false);
});

test("an empty or out-of-range edit is refused", () => {
  const paragraphs = [paragraph(1, "正文")];
  const empty = applyParagraphEdit(paragraphs, 1, { text: "   " });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "EMPTY");

  const unsound = applyParagraphEdit(paragraphs, 1, {
    text: "正文",
    spans: [{ start: 0, end: 99, kinds: ["strong"] }],
  });
  assert.equal(unsound.ok, false);
  if (!unsound.ok) assert.equal(unsound.code, "UNSOUND_SPANS");

  const missing = applyParagraphEdit(paragraphs, 9, { text: "正文" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "NOT_FOUND");
});

test("stats and digest are derived from the edited body, not the caller's numbers", () => {
  const paragraphs = [paragraph(1, "ab"), paragraph(2, "cd")];
  const result = applyParagraphEdit(paragraphs, 1, { text: "abcd" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const expected = [sha256Hex("abcd"), sha256Hex("cd")].join("\n");
  assert.equal(result.blocksDigest, sha256Hex(expected));
  assert.deepEqual(result.stats, bodyStatsOf(result.paragraphs));
  assert.deepEqual(result.stats, { paragraphs: 2, chars: 6 });
});
