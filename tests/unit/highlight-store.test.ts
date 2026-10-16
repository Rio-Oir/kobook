// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Highlight persistence gates.
 *
 * Two things are being pinned here:
 *
 *  1. the highlight slice behaves like the note slice it sits next to
 *     — create / recolour / delete, per-article selection, and a
 *     sign-out that actually wipes it;
 *
 *  2. **a v2 blob written before highlights existed still loads**.
 *     The store version stays 2 rather than bumping to 3, because
 *     bumping would rewrite the frozen migration assertion in
 *     `storage-migration.test.ts`. That only works if zustand's
 *     default `merge` fills the missing `highlights` key from the
 *     initial state — which is exactly the kind of thing that is true
 *     today and silently false after a dependency bump. So it is
 *     asserted rather than assumed.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { resolveHighlightStyle } from "../../src/lib/highlight.js";

const memory = new Map<string, string>();
const localStoragePolyfill = {
  getItem: (k: string): string | null => memory.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    memory.set(k, v);
  },
  removeItem: (k: string): void => {
    memory.delete(k);
  },
  clear: (): void => {
    memory.clear();
  },
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

async function store() {
  const mod = await import("../../src/lib/store.js");
  mod.useStore.getState().clearUserCache();
  return mod.useStore;
}

const ARTICLE = "article-1";

function aHighlight(paragraphIndex: number, start: number, end: number) {
  return {
    articleId: ARTICLE,
    paragraphIndex,
    startOffset: start,
    endOffset: end,
    selectionText: "x".repeat(end - start),
    color: "yellow" as const,
    style: "watercolor" as const,
  };
}

test("addHighlight stores the anchor and returns an id", async () => {
  const useStore = await store();
  const id = useStore.getState().addHighlight(aHighlight(3, 10, 14));
  const saved = useStore.getState().highlights[id];
  assert.ok(saved, "highlight must be retrievable by the id addHighlight returned");
  assert.equal(saved.articleId, ARTICLE);
  assert.equal(saved.paragraphIndex, 3);
  assert.equal(saved.startOffset, 10);
  assert.equal(saved.endOffset, 14);
  assert.equal(saved.color, "yellow");
  assert.ok(saved.createdAt > 0, "createdAt must be stamped");
});

test("setHighlightColor recolours in place without touching the anchor", async () => {
  const useStore = await store();
  const id = useStore.getState().addHighlight(aHighlight(1, 0, 5));
  useStore.getState().setHighlightColor(id, "blue");
  const saved = useStore.getState().highlights[id]!;
  assert.equal(saved.color, "blue");
  assert.equal(saved.startOffset, 0, "recolouring must not move the anchor");
  assert.equal(saved.endOffset, 5);
});

test("setHighlightColor on an unknown id is a no-op, not a crash", async () => {
  const useStore = await store();
  const before = useStore.getState().highlights;
  useStore.getState().setHighlightColor("nope", "green");
  assert.equal(useStore.getState().highlights, before);
});

test("deleteHighlight removes exactly one entry", async () => {
  const useStore = await store();
  const keep = useStore.getState().addHighlight(aHighlight(1, 0, 3));
  const drop = useStore.getState().addHighlight(aHighlight(2, 0, 3));
  useStore.getState().deleteHighlight(drop);
  const all = useStore.getState().highlights;
  assert.ok(all[keep], "the untouched highlight must survive");
  assert.equal(all[drop], undefined);
});

test("getHighlightsForArticle filters by article and sorts oldest first", async () => {
  const useStore = await store();
  const first = useStore.getState().addHighlight(aHighlight(1, 0, 3));
  // Force a distinct createdAt so the order is deterministic.
  const second = useStore.getState().addHighlight(aHighlight(2, 0, 3));
  useStore.getState().addHighlight({
    ...aHighlight(9, 0, 3),
    articleId: "other-article",
  });

  const forArticle = useStore.getState().getHighlightsForArticle(ARTICLE);
  assert.deepEqual(
    forArticle.map((h) => h.id),
    [first, second],
    "only this article's highlights, oldest first",
  );
  assert.equal(
    useStore.getState().getHighlightsForArticle("no-such-article").length,
    0,
  );
});

test("clearUserCache wipes highlights along with articles and notes", async () => {
  const useStore = await store();
  useStore.getState().addHighlight(aHighlight(1, 0, 3));
  useStore.getState().setOwner("user-A");
  assert.equal(Object.keys(useStore.getState().highlights).length, 1);

  useStore.getState().clearUserCache();
  assert.deepEqual(
    useStore.getState().highlights,
    {},
    "a sign-out must not leave the previous account's highlights on screen",
  );
  assert.equal(useStore.getState().ownerUserId, "anonymous");
});

test("a v2 blob written before highlights existed still loads (merge fills the key)", async () => {
  // Exactly the shape an existing install has on disk: no `highlights`.
  memory.set(
    "gloss-storage",
    JSON.stringify({
      state: {
        currentArticleId: "a1",
        ownerUserId: "user-existing",
        articles: {
          a1: {
            id: "a1",
            title: "旧文章",
            paragraphs: [{ index: 1, text: "正文", hash: "h" }],
            createdAt: 1,
          },
        },
        notes: {},
      },
      version: 2,
    }),
  );
  const mod = await import("../../src/lib/store.js");
  await mod.useStore.persist.rehydrate();

  const state = mod.useStore.getState();
  assert.equal(state.ownerUserId, "user-existing", "owner stamp must survive");
  assert.ok(state.articles["a1"], "articles must survive");
  assert.deepEqual(
    state.highlights,
    {},
    "a blob without highlights must hydrate to an empty slice, not undefined",
  );
  // And the freshly-hydrated store must be usable for highlights.
  const id = mod.useStore.getState().addHighlight(aHighlight(1, 0, 2));
  assert.ok(mod.useStore.getState().highlights[id]);
});

test("setHighlightStyle restyles in place without touching colour or anchor", async () => {
  const useStore = await store();
  const id = useStore.getState().addHighlight(aHighlight(2, 4, 9));
  useStore.getState().setHighlightStyle(id, "curve");
  const saved = useStore.getState().highlights[id]!;
  assert.equal(saved.style, "curve");
  assert.equal(saved.color, "yellow", "reshaping must not recolour");
  assert.equal(saved.startOffset, 4, "reshaping must not move the anchor");
  assert.equal(saved.endOffset, 9);
});

test("setHighlightStyle on an unknown id is a no-op, not a crash", async () => {
  const useStore = await store();
  const before = useStore.getState().highlights;
  useStore.getState().setHighlightStyle("nope", "line");
  assert.equal(useStore.getState().highlights, before);
});

test("highlight prefs default to yellow + watercolour and round-trip", async () => {
  const useStore = await store();
  assert.equal(useStore.getState().highlightColor, "yellow");
  assert.equal(useStore.getState().highlightStyle, "watercolor");

  useStore.getState().setHighlightPrefs({ color: "green" });
  assert.equal(useStore.getState().highlightColor, "green");
  assert.equal(
    useStore.getState().highlightStyle,
    "watercolor",
    "setting one pref must not clear the other",
  );

  useStore.getState().setHighlightPrefs({ style: "curve" });
  assert.equal(useStore.getState().highlightStyle, "curve");
  assert.equal(
    useStore.getState().highlightColor,
    "green",
    "setting one pref must not clear the other",
  );

  // An empty patch is a no-op rather than a reset.
  useStore.getState().setHighlightPrefs({});
  assert.equal(useStore.getState().highlightColor, "green");
  assert.equal(useStore.getState().highlightStyle, "curve");
});

test("prefs are persisted next to the highlights", async () => {
  const useStore = await store();
  useStore.getState().setHighlightPrefs({ color: "blue", style: "line" });
  const parsed = JSON.parse(memory.get("gloss-storage")!) as {
    state: { highlightColor: string; highlightStyle: string };
  };
  assert.equal(parsed.state.highlightColor, "blue");
  assert.equal(parsed.state.highlightStyle, "line");
});

test("clearUserCache resets the prefs as well as the marks", async () => {
  const useStore = await store();
  useStore.getState().setHighlightPrefs({ color: "red", style: "curve" });
  useStore.getState().clearUserCache();
  assert.equal(useStore.getState().highlightColor, "yellow");
  assert.equal(useStore.getState().highlightStyle, "watercolor");
});

test("a v2 blob without the prefs keys hydrates to the defaults (merge fills them)", async () => {
  // Same reasoning as the missing-`highlights` case above: the store
  // stays at version 2, so there is no `migrate` pass to add these
  // keys. They arrive only because zustand's default `merge` overlays
  // the persisted state onto the initial state.
  memory.set(
    "gloss-storage",
    JSON.stringify({
      state: {
        currentArticleId: null,
        ownerUserId: "user-existing",
        articles: {},
        notes: {},
        highlights: {},
      },
      version: 2,
    }),
  );
  const mod = await import("../../src/lib/store.js");
  await mod.useStore.persist.rehydrate();

  const state = mod.useStore.getState();
  assert.equal(state.highlightColor, "yellow");
  assert.equal(state.highlightStyle, "watercolor");
});

test("a highlight row written before shapes existed still loads, with no style field", async () => {
  // `Highlight.style` is optional precisely so this row is legal. The
  // renderer resolves the absence through `resolveHighlightStyle`;
  // asserting the shape here keeps a future "make style required"
  // refactor from breaking every existing user's marks on load.
  memory.set(
    "gloss-storage",
    JSON.stringify({
      state: {
        currentArticleId: null,
        ownerUserId: "user-existing",
        articles: {},
        notes: {},
        highlights: {
          old1: {
            id: "old1",
            articleId: ARTICLE,
            paragraphIndex: 1,
            startOffset: 0,
            endOffset: 3,
            selectionText: "abc",
            color: "green",
            createdAt: 1,
          },
        },
      },
      version: 2,
    }),
  );
  const mod = await import("../../src/lib/store.js");
  await mod.useStore.persist.rehydrate();

  const row = mod.useStore.getState().highlights["old1"]!;
  assert.equal(row.color, "green", "the colour must survive");
  assert.equal(row.style, undefined, "no style is stored, and none is invented");
  assert.equal(resolveHighlightStyle(row.style), "watercolor");
});
