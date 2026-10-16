// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Theme store tests.
 *
 * Cover the behaviours the front-end relies on:
 *   1. defaults: out-of-the-box the store is dark with an
 *      "anonymous" owner stamp;
 *   2. `setTheme` mutates the value; `cycleTheme` walks the four
 *      fixed palettes;
 *   3. `resolveTheme("system")` follows `prefers-color-scheme`;
 *   4. `readPersistedPaletteKey` returns a concrete palette key
 *      for the inline bootstrap script in `index.html`;
 *   5. the v1 → v2 migration collapses the old `mode` / `reader`
 *      envelope into a single `theme`;
 *   6. `applyOwnership` (via `ownership`) resets the value on an
 *      account switch but keeps it on a re-login.
 *
 * The localStorage polyfill is the same shape as
 * `storage-migration.test.ts`: seed the map, then call
 * `useTheme.persist.rehydrate()`. Re-importing the module does NOT
 * give a fresh instance (Node caches ESM), so the explicit
 * `rehydrate` is what makes the migration assertions meaningful.
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
  clear: (): void => {
    memory.clear();
  },
  key: (i: number): string | null => Array.from(memory.keys())[i] ?? null,
  get length(): number {
    return memory.size;
  },
};

// A controllable matchMedia: tests set `prefersDark` to flip the
// resolved value.
let prefersDark = true;
const matchMediaPolyfill = (query: string): MediaQueryList => {
  assert.ok(query.includes("prefers-color-scheme"));
  return {
    matches: query.includes("dark") ? prefersDark : !prefersDark,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
};

before(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStoragePolyfill, matchMedia: matchMediaPolyfill },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStoragePolyfill,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "matchMedia", {
    value: matchMediaPolyfill,
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  memory.clear();
  prefersDark = true;
});

/** Reset the in-memory state to the defaults (no persistence side effects). */
async function resetStore() {
  const { useTheme } = await import("../../src/lib/theme.js");
  useTheme.getState().resetValue();
  useTheme.getState().setOwner("anonymous");
  return useTheme;
}

test("defaults: dark theme, anonymous owner", async () => {
  const useTheme = await resetStore();
  const s = useTheme.getState();
  assert.equal(s.theme, "dark");
  assert.equal(s.ownerUserId, "anonymous");
});

test("setTheme mutates the value", async () => {
  const useTheme = await resetStore();
  useTheme.getState().setTheme("sepia");
  assert.equal(useTheme.getState().theme, "sepia");
  useTheme.getState().setTheme("paper");
  assert.equal(useTheme.getState().theme, "paper");
});

test("cycleTheme walks dark → sepia → paper → light → dark", async () => {
  const useTheme = await resetStore();
  assert.equal(useTheme.getState().theme, "dark");
  useTheme.getState().cycleTheme();
  assert.equal(useTheme.getState().theme, "sepia");
  useTheme.getState().cycleTheme();
  assert.equal(useTheme.getState().theme, "paper");
  useTheme.getState().cycleTheme();
  assert.equal(useTheme.getState().theme, "light");
  useTheme.getState().cycleTheme();
  assert.equal(useTheme.getState().theme, "dark");
});

test("cycleTheme from 'system' resumes from the resolved palette so the click always changes", async () => {
  const useTheme = await resetStore();
  useTheme.getState().setTheme("system");
  // OS prefers dark (the default in this file):  the cycle resumes
  // from "dark" and advances to "sepia".
  prefersDark = true;
  useTheme.getState().cycleTheme();
  assert.notEqual(useTheme.getState().theme, "system");
  assert.equal(useTheme.getState().theme, "sepia");

  // OS prefers light:  the cycle resumes from "light" and advances
  // to "dark".
  useTheme.getState().setTheme("system");
  prefersDark = false;
  useTheme.getState().cycleTheme();
  assert.equal(useTheme.getState().theme, "dark");
});

test("resolveTheme resolves 'system' against prefers-color-scheme", async () => {
  const { resolveTheme } = await import("../../src/lib/theme.js");
  prefersDark = true;
  assert.equal(resolveTheme("system"), "dark");
  prefersDark = false;
  assert.equal(resolveTheme("system"), "light");
  // Explicit values pass through untouched.
  assert.equal(resolveTheme("dark"), "dark");
  assert.equal(resolveTheme("light"), "light");
  assert.equal(resolveTheme("sepia"), "sepia");
  assert.equal(resolveTheme("paper"), "paper");
});

test("persistence: setTheme is written to the blob", async () => {
  const useTheme = await resetStore();
  useTheme.getState().setTheme("paper");
  useTheme.getState().setOwner("user-1");
  const raw = memory.get("gloss-theme");
  assert.ok(raw, "persist must write the blob");
  const parsed = JSON.parse(raw) as {
    state: { theme: string; ownerUserId: string };
    version: number;
  };
  assert.equal(parsed.state.theme, "paper");
  assert.equal(parsed.state.ownerUserId, "user-1");
  assert.equal(parsed.version, 2);
});

test("v1 → v2 migration collapses mode/reader into theme", async () => {
  // A blob written by the old (two-axis) store.
  memory.set(
    "gloss-theme",
    JSON.stringify({
      state: { ownerUserId: "user-legacy", mode: "light", reader: "sepia" },
      version: 1,
    }),
  );
  const { useTheme } = await import("../../src/lib/theme.js");
  await useTheme.persist.rehydrate();
  const s = useTheme.getState();
  // The old `mode` (light) is the closest analogue; the `reader`
  // pick is dropped.
  assert.equal(s.theme, "light");
  assert.equal(s.ownerUserId, "user-legacy");
  // Migration rewrote the blob to v2.
  const persisted = JSON.parse(memory.get("gloss-theme")!) as {
    version: number;
    state: { theme: string };
  };
  assert.equal(persisted.version, 2);
  assert.equal(persisted.state.theme, "light");
});

test("a v2 blob with 'system' is left untouched", async () => {
  memory.set(
    "gloss-theme",
    JSON.stringify({
      state: { ownerUserId: "user-2", theme: "system" },
      version: 2,
    }),
  );
  const { useTheme } = await import("../../src/lib/theme.js");
  await useTheme.persist.rehydrate();
  const s = useTheme.getState();
  assert.equal(s.theme, "system");
  assert.equal(s.ownerUserId, "user-2");
});

test("applyOwnership resets the theme on a different account sign-in", async () => {
  const useTheme = await resetStore();
  const { useStore } = await import("../../src/lib/store.js");
  const { useSettings } = await import("../../src/lib/settings.js");
  const { applyOwnership } = await import("../../src/lib/ownership.js");
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();

  // Account A picks sepia.
  useTheme.getState().setTheme("sepia");
  useTheme.getState().setOwner("user-A");
  useStore.getState().setOwner("user-A");

  // Account B signs in: the previous theme must not survive.
  const decision = applyOwnership("user-B");
  assert.equal(decision, "clear");
  assert.equal(useTheme.getState().theme, "dark", "theme must reset to default");
  assert.equal(useTheme.getState().ownerUserId, "user-B", "owner stamp moves to B");
});

test("applyOwnership keeps the theme when the same account re-loads", async () => {
  const useTheme = await resetStore();
  const { useStore } = await import("../../src/lib/store.js");
  const { useSettings } = await import("../../src/lib/settings.js");
  const { applyOwnership } = await import("../../src/lib/ownership.js");
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();

  useTheme.getState().setTheme("paper");
  // First sign-in attaches the stamp.
  applyOwnership("user-B");
  assert.equal(useTheme.getState().ownerUserId, "user-B");
  assert.equal(useTheme.getState().theme, "paper");

  // Second probe with the same user: nothing changes.
  const decision = applyOwnership("user-B");
  assert.equal(decision, "keep");
  assert.equal(useTheme.getState().theme, "paper");
  assert.equal(useTheme.getState().ownerUserId, "user-B");
});

test("applyOwnership on sign-out resets the value and the owner stamp", async () => {
  const useTheme = await resetStore();
  const { useStore } = await import("../../src/lib/store.js");
  const { useSettings } = await import("../../src/lib/settings.js");
  const { applyOwnership } = await import("../../src/lib/ownership.js");
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();

  useTheme.getState().setTheme("paper");
  applyOwnership("user-C");
  assert.equal(useTheme.getState().ownerUserId, "user-C");

  const decision = applyOwnership(null);
  assert.equal(decision, "clear", "switching authed → anon is a clear");
  const s = useTheme.getState();
  assert.equal(s.ownerUserId, "anonymous");
  // The resetValue() path is intentional: it returns to the dark
  // default rather than carrying the previous account's pick into
  // a different user's session.
  assert.equal(s.theme, "dark");
});

test("every theme has a settings swatch entry (and vice versa)", async () => {
  const { THEMES, THEME_LABEL, THEME_SWATCH } = await import("../../src/lib/theme.js");
  // The settings panel maps over THEMES and looks each one up in
  // THEME_SWATCH / THEME_LABEL. A theme added to one table but not the
  // others renders an unlabelled, colourless button — silent, and only
  // noticed by looking at the panel. Asserting the key sets match
  // turns that into a test failure.
  const themeKeys = [...THEMES].sort();
  assert.deepEqual(Object.keys(THEME_SWATCH).sort(), themeKeys);
  assert.deepEqual(Object.keys(THEME_LABEL).sort(), themeKeys);

  // Every non-`system` theme must carry a real preview palette: an
  // empty string would render a transparent swatch that looks broken.
  for (const theme of THEMES) {
    const swatch = THEME_SWATCH[theme];
    if (theme === "system") {
      assert.equal(swatch.split, true, "system renders as a split swatch");
      continue;
    }
    assert.match(swatch.bg, /^rgb\(/, `${theme} swatch bg must be a colour`);
    assert.match(swatch.surface, /^rgb\(/, `${theme} swatch surface must be a colour`);
    assert.match(swatch.text, /^rgb\(/, `${theme} swatch text must be a colour`);
    assert.notEqual(swatch.bg, swatch.surface, `${theme} surface must differ from bg`);
  }
});

test("readPersistedPaletteKey returns the resolved palette for the bootstrap script", async () => {
  const mod = await import("../../src/lib/theme.js");
  const useTheme = await resetStore();
  // No persisted blob → default dark.
  memory.delete("gloss-theme");
  assert.equal(mod.readPersistedPaletteKey(), "dark");

  // Persist an explicit light choice and re-read.
  useTheme.getState().setTheme("light");
  assert.equal(mod.readPersistedPaletteKey(), "light");

  // Sepia passes through untouched (no system resolution).
  useTheme.getState().setTheme("sepia");
  assert.equal(mod.readPersistedPaletteKey(), "sepia");

  // Persist "system" with the OS dark → dark.
  useTheme.getState().setTheme("system");
  prefersDark = true;
  assert.equal(mod.readPersistedPaletteKey(), "dark");

  // Same blob, OS flips to light → light.
  prefersDark = false;
  assert.equal(mod.readPersistedPaletteKey(), "light");
});
