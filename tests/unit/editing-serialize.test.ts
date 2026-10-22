// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  paragraphToEditorDoc,
  roundTrips,
  serializeEditorDoc,
  type EditorNodeJson,
} from "../../src/lib/editing/serialize.js";

function doc(...content: EditorNodeJson[]): EditorNodeJson {
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

test("plain text serializes to one paragraph with no spans", () => {
  const result = serializeEditorDoc(doc({ type: "text", text: "一段正文" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, "一段正文");
  assert.deepEqual(result.spans, []);
});

test("bold, italic and link marks become offsets with the contract order", () => {
  const result = serializeEditorDoc(
    doc(
      { type: "text", text: "你好", marks: [{ type: "bold" }] },
      { type: "text", text: "世界" },
      { type: "text", text: "链接", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, "你好世界链接");
  assert.deepEqual(result.spans, [
    { start: 0, end: 2, kinds: ["strong"] },
    { start: 4, end: 6, kinds: ["link"], href: "https://example.com" },
  ]);
});

test("whitespace is normalized with the import pipeline's rule, marks mapped with it", () => {
  const result = serializeEditorDoc(
    doc(
      { type: "text", text: "a  " },
      { type: "text", text: "b", marks: [{ type: "italic" }] },
    ),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, "a b");
  assert.deepEqual(result.spans, [{ start: 2, end: 3, kinds: ["em"] }]);
});

test("a hard break folds to a space instead of a newline", () => {
  const result = serializeEditorDoc(doc(
    { type: "text", text: "第一句" },
    { type: "hardBreak" },
    { type: "text", text: "第二句" },
  ));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.text, "第一句 第二句");
});

test("an empty paragraph is rejected", () => {
  const result = serializeEditorDoc(doc());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "EMPTY");
});

test("a block the contract cannot store is rejected, not silently dropped", () => {
  const result = serializeEditorDoc({
    type: "doc",
    content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "UNSUPPORTED_NODE");
});

test("stored paragraph → editor → stored paragraph round-trips", () => {
  const paragraph = {
    text: "粗体与斜体，还有链接",
    spans: [
      { start: 0, end: 2, kinds: ["strong" as const, "em" as const] },
      { start: 5, end: 7, kinds: ["link" as const], href: "https://example.com" },
    ],
  };
  assert.equal(roundTrips(paragraph), true);
});

test("a nested mark pair is one text node with two marks", () => {
  const editor = paragraphToEditorDoc({
    text: "粗体",
    spans: [{ start: 0, end: 2, kinds: ["strong", "em"] }],
  });
  const paragraph = editor.content?.[0];
  const node = paragraph?.content?.[0];
  assert.equal(node?.text, "粗体");
  assert.deepEqual(node?.marks?.map((mark) => mark.type), ["bold", "italic"]);
});
