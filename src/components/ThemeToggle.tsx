// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Mode toggle.
 *
 * One click flips day ↔ night. It never walks a list and never lands on
 * `system` — the old control cycled through four palettes, which meant you
 * could not tell what a click would do without remembering where you were.
 *
 * The icon shows the mode you are *in* (sun for day, moon for night) and
 * the label says what the click will *do*, which is what a tooltip is for.
 *
 * Lucide-style SVGs (1.5 stroke, rounded caps, 16×16), shared across Home,
 * Reader and Library so the control is the same everywhere.
 */

import { useTheme, resolveTheme, THEME_LABEL } from "@/lib/theme";

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

export default function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggleTheme);

  // While following the system the icon shows whichever mode the OS asked
  // for, so the button never looks like it disagrees with the page.
  const resolved = resolveTheme(theme);
  const Icon = resolved === "day" ? SunIcon : MoonIcon;
  const next = resolved === "day" ? "night" : "day";
  const label = `切换到${THEME_LABEL[next]}模式`;

  return (
    <button
      onClick={toggle}
      title={label}
      aria-label={label}
      className="text-gloss-textDim hover:text-gloss-text p-1.5 rounded transition-colors"
    >
      <Icon />
    </button>
  );
}
