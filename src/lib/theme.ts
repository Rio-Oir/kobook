// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Theme store — single-axis design.
 *
 * The reader and the app shell used to have independent theme axes
 * (`mode` for the shell, `reader` for the article body), which made
 * the picker two-tier: a global mode toggle and a separate reader
 * swatch. The merge keeps the four reading-friendly palettes the
 * reader was offering but applies them to the entire page, so the
 * whole UI flips together — closer to how Kindle, Pocket, Foliate
 * and Instapaper work.
 *
 * Four fixed themes:
 *   - light   white-ish background, near-black text
 *   - dark    near-black background, warm white text
 *   - sepia   warm beige background, dark brown text
 *   - paper   cool beige background, very dark brown text
 *
 * Plus one meta option:
 *   - system  resolves to `light` or `dark` against
 *             `prefers-color-scheme`. Only meaningful when the user
 *             wants OS to drive the binary light/dark flip; not
 *             applicable to sepia/paper (those are explicit picks).
 *
 * Persisted under `gloss-theme`, owner-stamped like the other
 * stores. On a sign-in that does not match the previous owner the
 * values are reset to defaults (themes are not credentials, but
 * carrying the previous account's picks into a different user's
 * session would be unexpected).
 *
 * Persisted schema version 2. The v1 envelope had a `mode` and a
 * `reader` field; v2 collapses them to a single `theme`. v1 blobs
 * are migrated to "system" if the previous owner had picked light
 * or dark, and to "light" otherwise — a conservative default
 * because the v1 reader pick is dropped.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ANONYMOUS_OWNER } from "./identity";

export type Theme = "light" | "dark" | "sepia" | "paper" | "system";

export const THEMES: Theme[] = ["light", "dark", "sepia", "paper", "system"];

export const THEME_LABEL: Record<Theme, string> = {
  light: "浅色",
  dark: "深色",
  sepia: "护眼",
  paper: "米色",
  system: "跟随系统",
};

/**
 * Preview colours for the settings swatches.
 *
 * These are the *only* colours that live in TypeScript rather than
 * `index.css`, and they exist purely so the settings panel can show
 * what a theme looks like before the user commits to it — CSS
 * variables only describe the theme that is currently applied.
 *
 * Keeping the map here (rather than inside `SettingsPanel`) means
 * `THEMES` and this table are read side by side, and the unit test
 * asserts the two key sets match exactly, so adding a theme without a
 * swatch fails in CI instead of rendering an empty button.
 *
 * `bg` / `surface` / `text` mirror the corresponding `index.css`
 * values. `system` has no palette of its own — it renders as a
 * light/dark split to make the meta nature obvious.
 */
export const THEME_SWATCH: Record<
  Theme,
  { bg: string; surface: string; text: string; split?: boolean }
> = {
  light: { bg: "rgb(251 250 247)", surface: "rgb(241 238 232)", text: "rgb(24 23 21)" },
  dark: { bg: "rgb(12 12 12)", surface: "rgb(22 22 22)", text: "rgb(235 233 230)" },
  sepia: { bg: "rgb(246 239 222)", surface: "rgb(236 227 206)", text: "rgb(74 58 44)" },
  paper: { bg: "rgb(232 224 206)", surface: "rgb(221 212 192)", text: "rgb(40 35 30)" },
  system: { bg: "", surface: "", text: "", split: true },
};

type ThemeState = {
  /** Same owner semantics as `store` and `settings`. */
  ownerUserId: string;
  /** The chosen theme. */
  theme: Theme;

  setTheme: (t: Theme) => void;
  /** Cycle through the four fixed themes; `system` is reachable from settings only. */
  cycleTheme: () => void;

  /**
   * Drop the value back to the default but keep the owner stamp.
   * Used by `applyOwnership` on the "clear" branch of an account
   * switch — themes are not credentials, so the next sign-in starts
   * fresh rather than inheriting the previous account's pick.
   */
  resetValue: () => void;
  /** Attach the resolved user id as the new owner. */
  setOwner: (userId: string) => void;
};

const DEFAULT_THEME: Theme = "dark";

/**
 * Resolve a `Theme` to a concrete palette key (`"light" | "dark" |
 * "sepia" | "paper"`). The inline bootstrap script in
 * `index.html` and the runtime effect in `App.tsx` both need this
 * and keeping the rule in one place stops the two from drifting.
 *
 * `system` is only meaningful when the binary light/dark split is
 * what the user wants; sepia and paper are always explicit picks
 * and `system` falls back to the default for them.
 */
export function resolveTheme(theme: Theme): "light" | "dark" | "sepia" | "paper" {
  if (theme === "system") {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return "light";
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

/**
 * The zustand-persist envelope: `{ state, version }`. The inline
 * script in `index.html` reads the same shape to set `data-theme`
 * before React mounts, so keep it stable across versions.
 */
interface PersistedEnvelope {
  state?: { theme?: Theme; ownerUserId?: string };
  version?: number;
}

/**
 * Read the persisted envelope and return the resolved palette key.
 * Used by the inline bootstrap script — kept here (rather than
 * inlined in `index.html`) so the two stay in sync.
 */
export function readPersistedPaletteKey(): "light" | "dark" | "sepia" | "paper" {
  if (typeof localStorage === "undefined") return "dark";
  const raw = localStorage.getItem("gloss-theme");
  if (!raw) return "dark";
  try {
    const parsed = JSON.parse(raw) as PersistedEnvelope;
    const theme = parsed.state?.theme ?? DEFAULT_THEME;
    return resolveTheme(theme);
  } catch {
    return "dark";
  }
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      ownerUserId: ANONYMOUS_OWNER,
      theme: DEFAULT_THEME,

      setTheme: (t) => set({ theme: t }),
      cycleTheme: () =>
        set((s) => {
          // The cycle visits the four fixed palettes in order;
          // `system` is reachable through the settings panel only
          // (it is not a visual state the user wants to "see").
          //
          // When the current value is `system`, resume the cycle
          // from whatever the OS resolved to, so the first click
          // always produces a visible change. Otherwise a user in
          // "system" on a dark OS would click and land back on
          // `dark` — indistinguishable from no-op.
          const cycle: Theme[] = ["light", "dark", "sepia", "paper"];
          const current = s.theme === "system" ? resolveTheme("system") : s.theme;
          const idx = cycle.indexOf(current);
          const safeIdx = idx < 0 ? 0 : idx;
          return { theme: cycle[(safeIdx + 1) % cycle.length] };
        }),

      resetValue: () => set({ theme: DEFAULT_THEME }),
      setOwner: (userId) => set({ ownerUserId: userId }),
    }),
    {
      name: "gloss-theme",
      version: 2,
      migrate: (persisted, version) => {
        // The v1 envelope looked like:
        //   { state: { mode: "dark", reader: "sepia", ownerUserId } }
        // and we collapse it to a single `theme`. v1's `mode` is the
        // closest analogue, so use it. The reader pick is dropped;
        // a user upgrading from v1 lands on the binary they had
        // chosen and the four-palette menu is one click away.
        const state = (persisted ?? {}) as Record<string, unknown>;
        const ownerUserId =
          typeof state.ownerUserId === "string"
            ? state.ownerUserId
            : ANONYMOUS_OWNER;
        if (version < 2) {
          const v1Mode = state.mode;
          const theme: Theme =
            v1Mode === "light" || v1Mode === "dark" || v1Mode === "system"
              ? v1Mode
              : DEFAULT_THEME;
          return { ownerUserId, theme };
        }
        return { ownerUserId, theme: DEFAULT_THEME } as ThemeState;
      },
    },
  ),
);

/** Snapshot helper for non-React call sites. */
export function readTheme() {
  return useTheme.getState();
}
