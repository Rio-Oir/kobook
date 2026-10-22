// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The merge rules behind highlight sync.
 *
 * A reader who draws a line on one device and opens the article on another
 * must see the line; a mark deleted elsewhere must disappear; and a mark this
 * device has not uploaded yet must never be dropped just because the server
 * list does not contain it. Those three rules are the whole merge, so they are
 * pinned here without a network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { useStore } from "../../src/lib/store.js";
import type { Highlight } from "../../src/lib/types.js";

function reset(): void {
  useStore.setState({ articles: {}, highlights: {} });
}

function localMark(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: "h1",
    articleId: "art-1",
    paragraphIndex: 1,
    startOffset: 0,
    endOffset: 2,
    selectionText: "测试",
    color: "yellow",
    createdAt: 1_000,
    ...overrides,
  };
}

test("a pulled mark is inserted, bound, and detached when its version differs", () => {
  reset();
  useStore.getState().applyRemoteHighlights("art-1", [
    localMark({
      id: "remote-hl-r1",
      remoteId: "r1",
      remoteVersionId: "v2",
      detached: true,
      color: "green",
    }),
  ]);
  const marks = Object.values(useStore.getState().highlights);
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.remoteId, "r1");
  assert.equal(marks[0]!.detached, true);
  assert.equal(marks[0]!.color, "green");
});

test("a bound mark is updated in place, not duplicated", () => {
  reset();
  useStore.setState({ highlights: { h1: localMark({ remoteId: "r1", note: "旧备注" }) } });
  useStore.getState().applyRemoteHighlights("art-1", [
    localMark({
      id: "remote-hl-r1",
      remoteId: "r1",
      color: "blue",
      note: "新备注",
      detached: false,
    }),
  ]);
  const marks = Object.values(useStore.getState().highlights);
  assert.equal(marks.length, 1, "the bound mark must not be duplicated");
  assert.equal(marks[0]!.id, "h1");
  assert.equal(marks[0]!.color, "blue");
  assert.equal(marks[0]!.note, "新备注");
});

test("a bound mark the server no longer has is removed; unbound local work survives", () => {
  reset();
  useStore.setState({
    highlights: {
      h1: localMark({ id: "h1", remoteId: "gone" }),
      h2: localMark({ id: "h2" }),
    },
  });
  useStore.getState().applyRemoteHighlights("art-1", []);
  const marks = Object.values(useStore.getState().highlights);
  assert.equal(marks.length, 1, "only the unsent local mark should remain");
  assert.equal(marks[0]!.id, "h2");
});

test("the merge never touches another article's marks", () => {
  reset();
  useStore.setState({
    highlights: {
      other: localMark({ id: "other", articleId: "art-2", remoteId: "r2" }),
    },
  });
  useStore.getState().applyRemoteHighlights("art-1", []);
  assert.ok(useStore.getState().highlights["other"], "art-2's mark must be untouched");
});

test("setHighlightRemote binds a local mark to its server row", () => {
  reset();
  useStore.setState({ highlights: { h1: localMark() } });
  useStore.getState().setHighlightRemote("h1", "r9", "v3");
  const mark = useStore.getState().highlights["h1"]!;
  assert.equal(mark.remoteId, "r9");
  assert.equal(mark.remoteVersionId, "v3");
});

test("an empty remark is stored as absence, not an empty string", () => {
  reset();
  useStore.setState({ highlights: { h1: localMark({ remoteId: "r1", note: "有备注" }) } });
  useStore.getState().applyRemoteHighlights("art-1", [
    localMark({ id: "remote-hl-r1", remoteId: "r1", note: "" }),
  ]);
  const mark = useStore.getState().highlights["h1"]!;
  assert.equal("note" in mark, false, "no remark must be one state: the field is absent");
});
