// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Theme store tests.
 *
 * Cover the behaviours the front-end relies on:
 *   1. defaults: out-of-the-box the store is in night mode with an
 *      "anonymous" owner stamp;
 *   2. `setTheme` mutates the value; `toggleTheme` flips day ↔ night
 *      and never lands on `system` — the whole point of replacing the
 *      old four-palette cycle;
 *   3. `toggleTheme` from `system` produces a visible change and stops
 *      following the OS;
 *   4. `resolveTheme("system")` follows `prefers-color-scheme`;
 *   5. `readPersistedPaletteKey` returns a concrete mode for the inline
 *      bootstrap script in `index.html`, including for blobs written by
 *      older versions whose names no longer exist;
 *   6. the v1 → v3 and v2 → v3 migrations map every retired name to the
 *      mode it implied, so a user who had picked 护眼 or 米色 keeps the
 *      light/dark intent they chose;
 *   7. `applyOwnership` (via `ownership`) resets the value on an
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

test("defaults: night theme, anonymous owner", async () => {
  const useTheme = await resetStore();
  const s = useTheme.getState();
  assert.equal(s.theme, "night");
  assert.equal(s.ownerUserId, "anonymous");
});

test("setTheme mutates the value", async () => {
  const useTheme = await resetStore();
  useTheme.getState().setTheme("day");
  assert.equal(useTheme.getState().theme, "day");
  useTheme.getState().setTheme("night");
  assert.equal(useTheme.getState().theme, "night");
});

test("toggleTheme flips between exactly two modes and never reaches 'system'", async () => {
  const useTheme = await resetStore();
  const seen: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    useTheme.getState().toggleTheme();
    seen.push(useTheme.getState().theme);
  }
  // Starting from the default (night), five clicks alternate night/day.
  assert.deepEqual(seen, ["day", "night", "day", "night", "day"]);
  assert.ok(!seen.includes("system"), "the toggle must never land on system");
});

test("toggleTheme from 'system' produces a visible change and stops following the OS", async () => {
  const useTheme = await resetStore();
  // OS prefers dark → resolved mode is night.
  prefersDark = true;
  useTheme.getState().setTheme("system");
  useTheme.getState().toggleTheme();
  assert.equal(useTheme.getState().theme, "day", "the click must move away from the resolved mode");
  assert.notEqual(useTheme.getState().theme, "system", "the click must stop following the OS");

  // Same starting point on a light OS: the click lands on night.
  prefersDark = false;
  useTheme.getState().setTheme("system");
  useTheme.getState().toggleTheme();
  assert.equal(useTheme.getState().theme, "night");
});

test("resolveTheme resolves 'system' against prefers-color-scheme", async () => {
  const { resolveTheme } = await import("../../src/lib/theme.js");
  prefersDark = true;
  assert.equal(resolveTheme("system"), "night");
  prefersDark = false;
  assert.equal(resolveTheme("system"), "day");
  // Explicit values pass through untouched.
  assert.equal(resolveTheme("day"), "day");
  assert.equal(resolveTheme("night"), "night");
});

test("persistence: setTheme is written to the blob", async () => {
  const useTheme = await resetStore();
  useTheme.getState().setTheme("day");
  useTheme.getState().setOwner("user-1");
  const raw = memory.get("gloss-theme");
  assert.ok(raw, "persist must write the blob");
  const parsed = JSON.parse(raw) as {
    state: { theme: string; ownerUserId: string };
    version: number;
  };
  assert.equal(parsed.state.theme, "day");
  assert.equal(parsed.state.ownerUserId, "user-1");
  assert.equal(parsed.version, 3);
});

test("v2 → v3 migration maps every retired palette name to a mode", async () => {
  const { useTheme } = await import("../../src/lib/theme.js");
  const cases: [string, string][] = [
    ["light", "day"],
    ["sepia", "day"],
    ["paper", "day"],
    ["dark", "night"],
    ["system", "system"],
  ];
  for (const [stored, expected] of cases) {
    memory.set(
      "gloss-theme",
      JSON.stringify({
        state: { ownerUserId: "user-legacy", theme: stored },
        version: 2,
      }),
    );
    await useTheme.persist.rehydrate();
    assert.equal(useTheme.getState().theme, expected, `${stored} must migrate to ${expected}`);
    assert.equal(useTheme.getState().ownerUserId, "user-legacy");
  }
  // The blob is rewritten at the new version.
  const persisted = JSON.parse(memory.get("gloss-theme")!) as {
    version: number;
    state: { theme: string };
  };
  assert.equal(persisted.version, 3);
  assert.equal(persisted.state.theme, "system");
});

test("v1 → v3 migration reads the old `mode` field", async () => {
  memory.set(
    "gloss-theme",
    JSON.stringify({
      state: { ownerUserId: "user-v1", mode: "light", reader: "sepia" },
      version: 1,
    }),
  );
  const { useTheme } = await import("../../src/lib/theme.js");
  await useTheme.persist.rehydrate();
  assert.equal(useTheme.getState().theme, "day");
  assert.equal(useTheme.getState().ownerUserId, "user-v1");
});

test("an unknown stored value falls back to the default", async () => {
  memory.set(
    "gloss-theme",
    JSON.stringify({ state: { ownerUserId: "user-x", theme: "midnight" }, version: 2 }),
  );
  const { useTheme } = await import("../../src/lib/theme.js");
  await useTheme.persist.rehydrate();
  assert.equal(useTheme.getState().theme, "night");
});

test("applyOwnership resets the theme on a different account sign-in", async () => {
  const useTheme = await resetStore();
  const { useStore } = await import("../../src/lib/store.js");
  const { useSettings } = await import("../../src/lib/settings.js");
  const { applyOwnership } = await import("../../src/lib/ownership.js");
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();

  // Account A picks day.
  useTheme.getState().setTheme("day");
  useTheme.getState().setOwner("user-A");
  useStore.getState().setOwner("user-A");

  // Account B signs in: the previous mode must not survive.
  const decision = applyOwnership("user-B");
  assert.equal(decision, "clear");
  assert.equal(useTheme.getState().theme, "night", "theme must reset to default");
  assert.equal(useTheme.getState().ownerUserId, "user-B", "owner stamp moves to B");
});

test("applyOwnership keeps the theme when the same account re-loads", async () => {
  const useTheme = await resetStore();
  const { useStore } = await import("../../src/lib/store.js");
  const { useSettings } = await import("../../src/lib/settings.js");
  const { applyOwnership } = await import("../../src/lib/ownership.js");
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();

  useTheme.getState().setTheme("day");
  // First sign-in attaches the stamp.
  applyOwnership("user-B");
  assert.equal(useTheme.getState().ownerUserId, "user-B");
  assert.equal(useTheme.getState().theme, "day");

  // Second probe with the same user: nothing changes.
  const decision = applyOwnership("user-B");
  assert.equal(decision, "keep");
  assert.equal(useTheme.getState().theme, "day");
  assert.equal(useTheme.getState().ownerUserId, "user-B");
});

test("applyOwnership on sign-out resets the value and the owner stamp", async () => {
  const useTheme = await resetStore();
  const { useStore } = await import("../../src/lib/store.js");
  const { useSettings } = await import("../../src/lib/settings.js");
  const { applyOwnership } = await import("../../src/lib/ownership.js");
  useStore.getState().clearUserCache();
  useSettings.getState().clearApiKey();

  useTheme.getState().setTheme("day");
  applyOwnership("user-C");
  assert.equal(useTheme.getState().ownerUserId, "user-C");

  const decision = applyOwnership(null);
  assert.equal(decision, "clear", "switching authed → anon is a clear");
  const s = useTheme.getState();
  assert.equal(s.ownerUserId, "anonymous");
  // The resetValue() path is intentional: it returns to the default
  // rather than carrying the previous account's pick into a different
  // user's session.
  assert.equal(s.theme, "night");
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

test("readPersistedPaletteKey resolves current and legacy blobs for the bootstrap script", async () => {
  const mod = await import("../../src/lib/theme.js");
  const useTheme = await resetStore();

  // No persisted blob → the default mode.
  memory.delete("gloss-theme");
  assert.equal(mod.readPersistedPaletteKey(), "night");

  // An explicit choice passes through.
  useTheme.getState().setTheme("day");
  assert.equal(mod.readPersistedPaletteKey(), "day");

  // A blob the current version wrote.
  memory.set("gloss-theme", JSON.stringify({ state: { theme: "day" }, version: 3 }));
  assert.equal(mod.readPersistedPaletteKey(), "day");

  // A blob from before the two-mode change: `sepia` has no rule any more,
  // so the bootstrap must map it rather than emit it.
  for (const [stored, expected] of [
    ["light", "day"],
    ["sepia", "day"],
    ["paper", "day"],
    ["dark", "night"],
  ] as const) {
    memory.set("gloss-theme", JSON.stringify({ state: { theme: stored }, version: 2 }));
    assert.equal(mod.readPersistedPaletteKey(), expected, `${stored} must map to ${expected}`);
  }

  // The v1 shape stored `mode`, not `theme`.
  memory.set("gloss-theme", JSON.stringify({ state: { mode: "light" }, version: 1 }));
  assert.equal(mod.readPersistedPaletteKey(), "day");

  // Persist "system" and let the OS decide.
  memory.set("gloss-theme", JSON.stringify({ state: { theme: "system" }, version: 3 }));
  prefersDark = true;
  assert.equal(mod.readPersistedPaletteKey(), "night");
  prefersDark = false;
  assert.equal(mod.readPersistedPaletteKey(), "day");

  // A corrupt blob must not throw.
  memory.set("gloss-theme", "{not json");
  assert.equal(mod.readPersistedPaletteKey(), "night");
});
