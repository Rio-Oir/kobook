// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Note turns: the structured conversation a note carries.
 *
 * The original question and each follow-up are stored separately. The store
 * is where that structure is maintained, and it is maintained for **every**
 * note — including one that will never be uploaded — because:
 *
 *   - a follow-up's context is built from the turns. A note whose history
 *     lives only in the flattened `answer` reaches the model with the
 *     question and one undivided blob, so after the second follow-up the
 *     boundaries between exchanges are gone;
 *   - an upload sends `turns`. A note whose turns were never recorded locally
 *     would arrive as a question with one undivided answer.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";

const memory = new Map<string, string>();
const localStoragePolyfill = {
  getItem: (k: string): string | null => memory.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    memory.set(k, v);
  },
  removeItem: (k: string): void => {
    memory.delete(k);
  },
  clear: (): void => memory.clear(),
  key: (i: number): string | null => Array.from(memory.keys())[i] ?? null,
  get length(): number {
    return memory.size;
  },
};

before(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStoragePolyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStoragePolyfill,
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  memory.clear();
});

async function loadFresh() {
  const { useStore } = await import("../../src/lib/store.js");
  useStore.getState().clearUserCache();
  return useStore;
}

function newNote(useStore: Awaited<ReturnType<typeof loadFresh>>): string {
  return useStore.getState().addNote({
    articleId: "art-1",
    paragraphIndex: 1,
    type: "explain",
    selectionText: "第一段正文",
    question: "这段说了什么？",
    answer: "",
    model: "mock",
  });
}

test("a new note already has the original question as its first turn", async () => {
  const useStore = await loadFresh();
  const id = newNote(useStore);
  const note = useStore.getState().notes[id]!;
  assert.equal(note.turns?.length, 1, "the question is turn 1 from the moment the note exists");
  assert.equal(note.turns?.[0]?.role, "user");
  assert.equal(note.turns?.[0]?.content, "这段说了什么？");
  assert.equal(note.question, "这段说了什么？", "and `question` still holds it");
  assert.equal(note.localQuestionCount, 1);
  assert.equal(note.localStatus, "running");
});

test("turns accumulate in order with their own sequence numbers", async () => {
  const useStore = await loadFresh();
  const id = newNote(useStore);

  useStore.getState().appendTurn(id, { role: "assistant", content: "第一个回答。", status: "succeeded" });
  useStore.getState().appendTurn(id, { role: "user", content: "那成本呢？" });
  useStore.getState().appendTurn(id, { role: "assistant", content: "第二个回答。", status: "succeeded" });

  const note = useStore.getState().notes[id]!;
  assert.deepEqual(
    note.turns?.map((t) => `${t.role}:${t.content}`),
    [
      "user:这段说了什么？",
      "assistant:第一个回答。",
      "user:那成本呢？",
      "assistant:第二个回答。",
    ],
  );
  assert.deepEqual(note.turns?.map((t) => t.sequence), [1, 2, 3, 4]);
  assert.equal(note.localQuestionCount, 2);
  assert.equal(note.localAnswerCount, 2);
  assert.equal(note.localStatus, "succeeded");
});

test("appending a turn to a deleted note is a no-op, not a resurrect", async () => {
  const useStore = await loadFresh();
  const id = newNote(useStore);
  useStore.getState().deleteNote(id);
  useStore.getState().appendTurn(id, { role: "assistant", content: "迟到的回答" });
  assert.equal(useStore.getState().notes[id], undefined, "a late turn must not bring the note back");
});

test("the original question survives every follow-up", async () => {
  // The defect this pins: the follow-up handler used to write the follow-up
  // text into `note.question`, so the card header, the migrated copy and
  // the next follow-up's context all lost the question the note was for.
  const useStore = await loadFresh();
  const id = newNote(useStore);
  useStore.getState().appendTurn(id, { role: "user", content: "那成本呢？" });
  const note = useStore.getState().notes[id]!;
  assert.equal(note.question, "这段说了什么？", "`question` is the note's question, not the last one asked");
  assert.equal(
    note.turns?.filter((t) => t.role === "user").length,
    2,
    "both questions are kept, the original and the follow-up",
  );
});
