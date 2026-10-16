// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: [
          "Charter",
          "Georgia",
          "Cambria",
          "Times New Roman",
          "Times",
          "serif",
        ],
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        // Single-axis theme tokens. All `gloss-*` classes
        // (e.g. `bg-gloss-bg`, `text-gloss-text`, `bg-gloss-bg/80`)
        // resolve to the same CSS variables that `index.css` flips
        // when `<html data-theme>` changes. There is no separate
        // reader palette — the article body uses the same tokens
        // as the app shell.
        //
        // The `rgb(var(--x) / <alpha-value>)` form is mandatory for
        // Tailwind v3: the `<alpha-value>` placeholder is what lets
        // `bg-gloss-bg/80` inject 0.8 into the alpha slot. A plain
        // `var(--x)` colour silently produces no rule for the
        // opacity variant. The variables therefore hold
        // space-separated channel triplets (`10 10 10`), not hex.
        gloss: {
          bg: "rgb(var(--bg) / <alpha-value>)",
          surface: "rgb(var(--surface) / <alpha-value>)",
          surface2: "rgb(var(--surface2) / <alpha-value>)",
          border: "rgb(var(--border) / <alpha-value>)",
          // Control boundaries (text inputs, selects). Held to WCAG
          // 1.4.11's 3:1 rather than the ~1.3:1 a decorative hairline
          // needs, which is why it is a separate token from `border`.
          outline: "rgb(var(--outline) / <alpha-value>)",
          text: "rgb(var(--text) / <alpha-value>)",
          textDim: "rgb(var(--textDim) / <alpha-value>)",
          accent: "rgb(var(--accent) / <alpha-value>)",
          highlight: "rgb(var(--highlight) / <alpha-value>)",
        },
      },
      typography: () => ({
        DEFAULT: {
          css: {
            maxWidth: "none",
          },
        },
      }),
      animation: {
        "fade-in": "fadeIn 200ms ease-out",
        "slide-up": "slideUp 200ms ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
