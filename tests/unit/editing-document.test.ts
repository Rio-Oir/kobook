// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  paragraphsToEditorDoc,
  serializeEditorDocument,
} from "../../src/lib/editing/document.js";

const paragraphs = [
  { type: "heading" as const, text: "标题", spans: [], level: 1 },
  { type: "paragraph" as const, text: "第一段", spans: [{ start: 0, end: 2, kinds: ["strong" as const] }] },
  { type: "listItem" as const, text: "列表一", spans: [], ordered: false },
  { type: "listItem" as const, text: "列表二", spans: [], ordered: false },
  { type: "quote" as const, text: "引用", spans: [] },
  { type: "code" as const, text: "const x = 1;\nconst y = 2;", spans: [], lang: "ts" },
];

test("whole document round-trips block types, marks and list grouping", () => {
  const serialized = serializeEditorDocument(paragraphsToEditorDoc(paragraphs));
  assert.equal(serialized.ok, true);
  if (!serialized.ok) return;
  assert.deepEqual(
    serialized.blocks.map((block) => block.type),
    ["heading", "paragraph", "listItem", "listItem", "quote", "code"],
  );
  assert.equal(serialized.blocks[0]!.level, 1);
  assert.deepEqual(serialized.blocks[1]!.spans, [{ start: 0, end: 2, kinds: ["strong"] }]);
  assert.equal(serialized.blocks[2]!.ordered, false);
  assert.equal(serialized.blocks[4]!.type, "quote");
  assert.equal(serialized.blocks[5]!.lang, "ts");
  assert.match(serialized.blocks[5]!.text, /\n/);
});

test("an emptied document is refused rather than saved blank", () => {
  const result = serializeEditorDocument({ type: "doc", content: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EMPTY");
});

test("a structural edit produces the new block order", () => {
  const doc = paragraphsToEditorDoc([
    { type: "paragraph", text: "第一段", spans: [] },
    { type: "paragraph", text: "第二段", spans: [] },
  ]);
  // Append a paragraph node the way the editor would after Enter+typing.
  doc.content = [
    ...(doc.content ?? []),
    { type: "paragraph", content: [{ type: "text", text: "第三段" }] },
  ];
  const result = serializeEditorDocument(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.blocks.map((block) => block.text),
    ["第一段", "第二段", "第三段"],
  );
});

test("image, table and hr blocks round-trip through the editor document", () => {
  const source = [
    {
      type: "image" as const,
      text: "示意图",
      spans: [],
      src: "https://cdn.example.com/a.png",
      alt: "示意图",
      title: "图一",
    },
    {
      type: "table" as const,
      text: "列一 | 列二 甲 | 乙",
      spans: [],
      rows: [
        ["列一", "列二"],
        ["甲", "乙"],
      ],
    },
    { type: "hr" as const, text: "分隔线", spans: [] },
  ];
  const doc = paragraphsToEditorDoc(source);
  // The image must become a real image node, not be skipped.
  assert.equal(doc.content?.[0]?.type, "image");
  assert.equal(doc.content?.[0]?.attrs?.src, "https://cdn.example.com/a.png");
  assert.equal(doc.content?.[1]?.type, "table");
  assert.equal(doc.content?.[1]?.content?.[0]?.type, "tableRow");
  assert.equal(doc.content?.[1]?.content?.[0]?.content?.[0]?.type, "tableHeader");
  assert.equal(doc.content?.[1]?.content?.[1]?.content?.[0]?.type, "tableCell");
  assert.equal(doc.content?.[2]?.type, "horizontalRule");

  const result = serializeEditorDocument(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.blocks.map((block) => block.type),
    ["image", "table", "hr"],
  );
  const [image, table, hr] = result.blocks;
  assert.equal(image!.src, "https://cdn.example.com/a.png");
  assert.equal(image!.alt, "示意图");
  assert.equal(image!.title, "图一");
  assert.equal(image!.text, "示意图");
  assert.deepEqual(table!.rows, [
    ["列一", "列二"],
    ["甲", "乙"],
  ]);
  // The flat text is the normalised join the parser would have produced, so
  // the hash agrees with a freshly parsed copy of the same table.
  assert.equal(table!.text, "列一 | 列二 甲 | 乙");
  assert.equal(hr!.text, "分隔线");
});

test("nested and task lists round-trip with depth and checked state", () => {
  const source = [
    { type: "listItem" as const, text: "外层", spans: [], ordered: false, depth: 0 },
    { type: "listItem" as const, text: "内层一", spans: [], ordered: false, depth: 1 },
    { type: "listItem" as const, text: "内层二", spans: [], ordered: false, depth: 1 },
    { type: "listItem" as const, text: "任务一", spans: [], ordered: false, depth: 0, task: true, checked: true },
    { type: "listItem" as const, text: "任务二", spans: [], ordered: false, depth: 0, task: true, checked: false },
    { type: "listItem" as const, text: "任务内层", spans: [], ordered: false, depth: 1, task: true, checked: true },
  ];
  const doc = paragraphsToEditorDoc(source);
  // The nested bullet list lives inside the first item's content.
  const bullet = doc.content?.[0];
  assert.equal(bullet?.type, "bulletList");
  assert.equal(bullet?.content?.[0]?.content?.[1]?.type, "bulletList");
  assert.equal(doc.content?.[1]?.type, "taskList");
  assert.equal(doc.content?.[1]?.content?.[0]?.type, "taskItem");
  assert.deepEqual(doc.content?.[1]?.content?.[0]?.attrs, { checked: true });

  const result = serializeEditorDocument(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.blocks.map((block) => [block.text, block.depth, block.task === true, block.checked === true]),
    [
      ["外层", 0, false, false],
      ["内层一", 1, false, false],
      ["内层二", 1, false, false],
      ["任务一", 0, true, true],
      ["任务二", 0, true, false],
      ["任务内层", 1, true, true],
    ],
  );
});

test("an unsupported image source is refused, not silently saved", () => {
  const result = serializeEditorDocument({
    type: "doc",
    content: [{ type: "image", attrs: { src: "javascript:alert(1)" } }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "UNSUPPORTED_NODE");
});
