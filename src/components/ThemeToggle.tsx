// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Theme toggle.
 *
 * Single-axis design: the four fixed themes (light / dark / sepia /
 * paper) cycle in order, and the icon mirrors the current pick.
 * `system` is reachable from the settings panel only — it is not
 * a visual state the user wants to "see" in the top bar; it would
 * just look like one of the binary pair depending on the OS.
 *
 * Lucide-style SVGs (1.5 stroke, rounded caps, 16×16) for the
 * binary pair; the warm palettes get a small filled swatch as
 * their indicator so the two are visually distinct from the
 * light/dark pair.
 *
 * Shared across Home, Reader and Library so the
 * control is the same everywhere.
 */

import { useTheme } from "@/lib/theme";

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.93 19.07 1.41-1.41" />
      <path d="m17.66 6.34 1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

// A simple page with a warm fill; visually distinct from the
// binary sun/moon pair so a glance at the top bar is enough to
// know the user is in a warm palette.
function SepiaSwatch() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="5" y="3" width="14" height="18" rx="2" fillOpacity="0.18" />
      <rect x="7" y="6" width="10" height="1.6" rx="0.8" />
      <rect x="7" y="9.5" width="10" height="1.6" rx="0.8" />
      <rect x="7" y="13" width="7" height="1.6" rx="0.8" />
    </svg>
  );
}

function PaperSwatch() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="5" y="3" width="14" height="18" rx="2" fillOpacity="0.18" />
      <rect x="7" y="6" width="10" height="1.6" rx="0.8" />
      <rect x="7" y="9.5" width="10" height="1.6" rx="0.8" />
      <rect x="7" y="13" width="7" height="1.6" rx="0.8" />
      <rect x="7" y="16" width="9" height="1.6" rx="0.8" />
    </svg>
  );
}

function iconFor(theme: string) {
  switch (theme) {
    case "light":
      return SunIcon;
    case "dark":
      return MoonIcon;
    case "sepia":
      return SepiaSwatch;
    case "paper":
      return PaperSwatch;
    default:
      return MoonIcon;
  }
}

function labelFor(theme: string) {
  switch (theme) {
    case "light":
      return "浅色";
    case "dark":
      return "深色";
    case "sepia":
      return "护眼";
    case "paper":
      return "米色";
    case "system":
      return "跟随系统";
    default:
      return "深色";
  }
}

export default function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const cycle = useTheme((s) => s.cycleTheme);

  // `system` is reachable only from the settings panel; the cycle
  // starts the user on a fixed palette. If the stored value is
  // `system` (e.g. just upgraded) the toggle still shows the
  // resolved icon.
  const Icon = iconFor(theme === "system" ? "dark" : theme);
  const title = `主题：${labelFor(theme)}（点击切换）`;

  return (
    <button
      onClick={cycle}
      title={title}
      aria-label="切换主题"
      className="text-gloss-textDim hover:text-gloss-text p-1.5 rounded transition-colors"
    >
      <Icon />
    </button>
  );
}
