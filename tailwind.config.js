// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import typography from "@tailwindcss/typography";

/**
 * The reading typography scale.
 *
 * `@tailwindcss/typography` (pinned at 0.5.20 — the Tailwind 3 line; the
 * project stays on Tailwind 3.4) supplies the *base* rhythm for headings,
 * paragraphs, lists, quotes and code, and this block is where that base is
 * retuned for Chinese reading. Keeping the retune here rather than in
 * `index.css` means there is one statement of each rule: the plugin emits
 * `.prose :where(p) { … }` from this config, so a second `.gloss-prose p`
 * rule in the stylesheet would be a competing base style rather than an
 * override (the selection doc's "不叠加两套完整基础样式").
 *
 * Sizes are in `em` so the whole scale follows `--reading-font-size` — the
 * user's font size is a zoom on the article, not a change to the body text
 * alone. Colours are the existing `gloss` theme tokens routed through the
 * plugin's `--tw-prose-*` variables, so the reader inherits the four
 * palettes and this file introduces no new colour.
 *
 * Two of the plugin's defaults are actively wrong for this reader and are
 * switched off below:
 *
 *   - `code::before/after` renders literal backticks around inline code.
 *     Generated content is counted by `Range.toString()` in Chromium (see
 *     `src/lib/blocks.ts` and `src/index.css`), so those two characters
 *     would shift every stored highlight offset in any block containing
 *     inline code. `content: none` is a correctness fix, not a taste one.
 *   - `blockquote p:first-of-type::before/after` adds curly quotes, the
 *     same class of problem, and a synthesised quote pair on a Chinese
 *     paragraph reads as a typo.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: [
          "Charter",
          "Georgia",
          "Cambria",
          "Noto Serif SC",
          "Source Han Serif SC",
          "Songti SC",
          "SimSun",
          "serif",
        ],
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "Courier New",
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
            // The column width is the reading measure, set by
            // `.gloss-reading-column` from `--reading-measure`. The plugin's
            // own `65ch` would be a second, competing width.
            maxWidth: "none",

            // Reading parameters. Defaults live in `index.css`; the Reader
            // overrides them per user preference.
            fontSize: "var(--reading-font-size)",
            lineHeight: "var(--reading-line-height)",
            // Left-aligned, no letter-spacing, no first-line indent — the
            // first version's agreed defaults. Stated rather than inherited
            // so a later change to these is a visible edit.
            textAlign: "start",
            letterSpacing: "0",
            textIndent: "0",

            // Colour roles → the four theme palettes.
            "--tw-prose-body": "rgb(var(--text))",
            "--tw-prose-headings": "rgb(var(--text))",
            "--tw-prose-lead": "rgb(var(--textDim))",
            "--tw-prose-links": "rgb(var(--accent))",
            "--tw-prose-bold": "rgb(var(--text))",
            "--tw-prose-counters": "rgb(var(--textDim))",
            "--tw-prose-bullets": "rgb(var(--textDim))",
            "--tw-prose-hr": "rgb(var(--border))",
            "--tw-prose-quotes": "rgb(var(--textDim))",
            "--tw-prose-quote-borders": "rgb(var(--border))",
            "--tw-prose-captions": "rgb(var(--textDim))",
            "--tw-prose-kbd": "rgb(var(--text))",
            "--tw-prose-kbd-shadows": "rgb(var(--border))",
            "--tw-prose-code": "rgb(var(--text))",
            "--tw-prose-pre-code": "rgb(var(--text))",
            "--tw-prose-pre-bg": "rgb(var(--surface))",
            "--tw-prose-th-borders": "rgb(var(--border))",
            "--tw-prose-td-borders": "rgb(var(--border))",

            p: {
              marginTop: "0",
              marginBottom: "var(--reading-para-gap)",
            },

            a: {
              // Links keep the body weight: a bolded run inside a Chinese
              // paragraph breaks the even grey of the column.
              fontWeight: "inherit",
              textDecoration: "underline",
              textDecorationThickness: "0.06em",
              textUnderlineOffset: "0.18em",
              // A pasted URL with no break opportunity would otherwise widen
              // the whole column and push the layout sideways.
              overflowWrap: "anywhere",
            },
            "a:hover": {
              textDecorationThickness: "0.12em",
            },

            // Struck-through text is text the author retracted, so it
            // recedes rather than competing with the surrounding prose.
            del: {
              color: "rgb(var(--textDim))",
            },

            // Depth reads from three signals at once — size, weight and the
            // space above — because a single one is easy to miss while
            // scrolling. `marginTop` deliberately exceeds `marginBottom` so
            // a heading groups with the text it introduces instead of
            // floating between two sections. `headingTag` maps a document's
            // top-level heading to `<h2>`, so `h2` is the body's largest.
            h2: {
              fontSize: "1.5em",
              fontWeight: "600",
              lineHeight: "1.3",
              letterSpacing: "0",
              marginTop: "1.5em",
              marginBottom: "0.5em",
            },
            h3: {
              fontSize: "1.25em",
              fontWeight: "600",
              lineHeight: "1.35",
              letterSpacing: "0",
              marginTop: "1.4em",
              marginBottom: "0.45em",
            },
            h4: {
              fontSize: "1.1em",
              fontWeight: "600",
              lineHeight: "1.4",
              letterSpacing: "0",
              marginTop: "1.3em",
              marginBottom: "0.4em",
            },
            h5: {
              fontSize: "1em",
              fontWeight: "600",
              lineHeight: "1.45",
              letterSpacing: "0",
              marginTop: "1.2em",
              marginBottom: "0.35em",
            },
            h6: {
              fontSize: "0.9em",
              fontWeight: "600",
              lineHeight: "1.5",
              letterSpacing: "0",
              marginTop: "1.1em",
              marginBottom: "0.3em",
              color: "rgb(var(--textDim))",
            },

            ul: {
              listStyleType: "disc",
              marginTop: "0",
              marginBottom: "var(--reading-para-gap)",
              paddingInlineStart: "0.75rem",
            },
            ol: {
              listStyleType: "decimal",
              marginTop: "0",
              marginBottom: "var(--reading-para-gap)",
              paddingInlineStart: "0.75rem",
            },
            li: {
              marginTop: "0",
              marginBottom: "0.375rem",
            },

            // A rule in the gutter plus a dimmed colour — deliberately not
            // italic, which for CJK is a synthesised oblique that costs
            // legibility instead of adding emphasis.
            blockquote: {
              fontStyle: "normal",
              fontWeight: "400",
              color: "rgb(var(--textDim))",
              borderInlineStartWidth: "2px",
              borderInlineStartColor: "rgb(var(--border))",
              paddingInlineStart: "1em",
              marginTop: "0",
              marginBottom: "var(--reading-para-gap)",
            },
            // See the header comment: generated quote glyphs are counted by
            // `Range.toString()` and would shift stored offsets.
            "blockquote p:first-of-type::before": { content: "none" },
            "blockquote p:last-of-type::after": { content: "none" },

            code: {
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: "0.85em",
              fontWeight: "400",
              color: "rgb(var(--text))",
              backgroundColor: "rgb(var(--highlight) / var(--code-alpha))",
              borderRadius: "0.25rem",
              paddingTop: "0.125em",
              paddingBottom: "0.125em",
              paddingInlineStart: "0.375em",
              paddingInlineEnd: "0.375em",
            },
            // See the header comment: the plugin's default renders two
            // backticks as generated content.
            "code::before": { content: "none" },
            "code::after": { content: "none" },

            pre: {
              fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
              fontSize: "0.75em",
              lineHeight: "1.65",
              color: "rgb(var(--text))",
              backgroundColor: "rgb(var(--surface))",
              overflowX: "auto",
              whiteSpace: "pre",
              tabSize: "2",
            },
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
  plugins: [typography],
};
