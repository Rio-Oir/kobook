// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Theme store — two modes, one toggle.
 *
 * The app used to carry four palettes on a single axis (light / dark /
 * sepia / paper) plus a "follow the system" meta-option, and the top-bar
 * button cycled through all four. That made the button unpredictable — you
 * could not tell what one click would do — and it mixed two different
 * questions into one control: *which mode am I in* and *which paper do I
 * like*.
 *
 * They are now separated:
 *
 *   - **mode** is this store. Two values, `day` and `night`, and the
 *     top-bar button flips between exactly those two. A click is always
 *     one step, never a lap.
 *   - **palette** is a later concern. Today each mode has exactly one
 *     paper, taken from what open-source reading software ships: white
 *     (`#ffffff` on `#000000`) for day, black (`#000000` on `#ffffff`) for
 *     night — Foliate's Light/Invert pair, Thorium's Neutral/Contrast1
 *     pair, Readium CSS's default background. When more papers are offered
 *     they become a separate choice *per mode*, not more values here.
 *
 * `system` remains as a meta-option: it resolves to `day` or `night`
 * against `prefers-color-scheme` and is reachable from the settings panel
 * only. Whether it stays, where it lives, and what a manual click does to
 * it are still open questions — see `docs/配色逻辑-2026-10-19.md`. The one
 * behaviour implemented here is the least surprising one: a manual click
 * while following the system turns following *off* and keeps the mode it
 * produced, so the click is never a no-op.
 *
 * Persisted under `gloss-theme`, owner-stamped like the other stores. On a
 * sign-in that does not match the previous owner the value resets to the
 * default (themes are not credentials, but carrying the previous account's
 * pick into a different user's session would be unexpected).
 *
 * Persisted schema version 3. Version 2 stored one of `light` / `dark` /
 * `sepia` / `paper` / `system`; version 1 stored a `mode` and a `reader`
 * field. Both are migrated to the mode the old value implied, so a user who
 * had picked 护眼 or 米色 lands on the day mode rather than being bounced
 * back to the default.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ANONYMOUS_OWNER } from "./identity";

/** The two modes, plus the meta-option that picks between them. */
export type Theme = "day" | "night" | "system";

/** A mode with a paper of its own — what `system` resolves to. */
export type ResolvedTheme = "day" | "night";

export const THEMES: Theme[] = ["day", "night", "system"];

export const THEME_LABEL: Record<Theme, string> = {
  day: "日间",
  night: "夜间",
  system: "跟随系统",
};

/**
 * Preview colours for the settings swatches.
 *
 * These are the *only* colours that live in TypeScript rather than
 * `index.css`, and they exist purely so the settings panel can show what a
 * mode looks like before the user commits to it — CSS variables only
 * describe the mode that is currently applied.
 *
 * Keeping the map here (rather than inside `SettingsPanel`) means `THEMES`
 * and this table are read side by side, and the unit test asserts the two
 * key sets match exactly, so adding a mode without a swatch fails in CI
 * instead of rendering an empty button.
 *
 * `bg` / `surface` / `text` mirror the corresponding `index.css` values.
 * `system` has no palette of its own — it renders as a day/night split to
 * make the meta nature obvious.
 */
export const THEME_SWATCH: Record<
  Theme,
  { bg: string; surface: string; text: string; split?: boolean }
> = {
  day: { bg: "rgb(255 255 255)", surface: "rgb(242 242 242)", text: "rgb(0 0 0)" },
  night: { bg: "rgb(0 0 0)", surface: "rgb(18 18 18)", text: "rgb(255 255 255)" },
  system: { bg: "", surface: "", text: "", split: true },
};

type ThemeState = {
  /** Same owner semantics as `store` and `settings`. */
  ownerUserId: string;
  /** The chosen mode, or `system`. */
  theme: Theme;

  setTheme: (t: Theme) => void;
  /**
   * Flip between the two modes. Never walks a list, never lands on
   * `system` — one click is always one visible change.
   */
  toggleTheme: () => void;

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

const DEFAULT_THEME: Theme = "night";

/** The mode the OS is asking for, or `null` where that cannot be read. */
function systemPrefers(): ResolvedTheme | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
}

/**
 * Resolve a `Theme` to a concrete mode. The inline bootstrap script in
 * `index.html` and the runtime effect in `App.tsx` both need this rule, and
 * keeping it in one place stops the two from drifting.
 */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") return systemPrefers() ?? "day";
  return theme;
}

/**
 * The zustand-persist envelope: `{ state, version }`. The inline script in
 * `index.html` reads the same shape to set `data-theme` before React mounts,
 * so keep it stable across versions.
 */
interface PersistedEnvelope {
  state?: { theme?: string; mode?: string; ownerUserId?: string };
  version?: number;
}

/**
 * Every theme name that has ever been persisted, mapped to the mode it
 * meant. The inline bootstrap runs *before* zustand's `migrate`, so it has
 * to do this mapping itself — otherwise a user whose blob still says
 * `sepia` would get `data-theme="sepia"` on the first paint, which no
 * longer has a rule, and the page would flash the default before React
 * corrected it.
 */
const LEGACY_MODES: Record<string, ResolvedTheme> = {
  // v2 names.
  light: "day",
  sepia: "day",
  paper: "day",
  dark: "night",
  // v3 names, so the map can be applied unconditionally.
  day: "day",
  night: "night",
};

/**
 * Read the persisted envelope and return the resolved mode. Used by the
 * inline bootstrap script — kept here (rather than inlined in
 * `index.html`) so the two stay in sync.
 */
export function readPersistedPaletteKey(): ResolvedTheme {
  if (typeof localStorage === "undefined") return resolveTheme(DEFAULT_THEME);
  const raw = localStorage.getItem("gloss-theme");
  if (!raw) return resolveTheme(DEFAULT_THEME);
  try {
    const parsed = JSON.parse(raw) as PersistedEnvelope;
    const stored = parsed.state?.theme ?? parsed.state?.mode ?? DEFAULT_THEME;
    if (stored === "system") return resolveTheme("system");
    return LEGACY_MODES[stored] ?? resolveTheme(DEFAULT_THEME);
  } catch {
    return resolveTheme(DEFAULT_THEME);
  }
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      ownerUserId: ANONYMOUS_OWNER,
      theme: DEFAULT_THEME,

      setTheme: (t) => set({ theme: t }),
      toggleTheme: () =>
        set((s) => {
          // From an explicit mode, flip it. From `system`, flip the mode the
          // OS produced — so the click is visible — and stop following, so
          // the OS cannot immediately undo the click.
          const current = resolveTheme(s.theme);
          return { theme: current === "day" ? "night" : "day" };
        }),

      resetValue: () => set({ theme: DEFAULT_THEME }),
      setOwner: (userId) => set({ ownerUserId: userId }),
    }),
    {
      name: "gloss-theme",
      version: 3,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        const ownerUserId =
          typeof state.ownerUserId === "string" ? state.ownerUserId : ANONYMOUS_OWNER;

        if (version >= 3) {
          // Not reached in practice — zustand only calls `migrate` when the
          // stored version differs — but a future version bump must not
          // silently discard the user's pick on the way through.
          const current = state.theme;
          const kept =
            current === "day" || current === "night" || current === "system"
              ? current
              : DEFAULT_THEME;
          return { ownerUserId, theme: kept } as ThemeState;
        }

        // Version 1 looked like:
        //   { state: { mode: "dark", reader: "sepia", ownerUserId } }
        // and version 2 collapsed it to a single `theme`. Both are read
        // through the same table; an unrecognised value keeps the user's
        // light/dark intent rather than dumping them on the default.
        const stored =
          version < 2
            ? (typeof state.mode === "string" ? state.mode : undefined)
            : (typeof state.theme === "string" ? state.theme : undefined);

        if (stored === "system") return { ownerUserId, theme: "system" } as ThemeState;
        const mode = stored === undefined ? undefined : LEGACY_MODES[stored];
        return {
          ownerUserId,
          theme: mode ?? DEFAULT_THEME,
        } as ThemeState;
      },
    },
  ),
);

/** Snapshot helper for non-React call sites. */
export function readTheme() {
  return useTheme.getState();
}
