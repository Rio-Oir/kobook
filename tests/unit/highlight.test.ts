// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Highlight vocabulary gates.
 *
 * `lib/highlight.ts` is what the toolbar, the manage-popover and the
 * paragraph renderer all read, so a table that is complete in one
 * place and not another is a rendering bug waiting to happen — and
 * the failure mode is silent. Two of them are worth pinning:
 *
 *  1. **every colour and shape has a label**. The controls map over
 *     `HIGHLIGHT_COLORS` / `HIGHLIGHT_STYLES` and look each value up
 *     in the label table; a missing key renders an unlabelled,
 *     unreadable button (`undefined` in a `title`/`aria-label`), which
 *     no unit test elsewhere would notice.
 *
 *  2. **an unknown stored value resolves to a renderable one**. Both
 *     `color` and `style` come out of localStorage, where a hand-edit
 *     or a rolled-back rename can leave a value with no matching CSS
 *     rule. `.gloss-mark[data-style="gelato"]` matches nothing, so the
 *     mark renders invisible — indistinguishable from the user's data
 *     having been deleted. The resolvers turn that into the default
 *     look instead.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_HIGHLIGHT_STYLE,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_LABEL,
  HIGHLIGHT_STYLES,
  HIGHLIGHT_STYLE_LABEL,
  resolveHighlightColor,
  resolveHighlightStyle,
} from "../../src/lib/highlight.js";

test("every colour and shape has a label (and vice versa)", () => {
  assert.deepEqual(
    Object.keys(HIGHLIGHT_COLOR_LABEL).sort(),
    [...HIGHLIGHT_COLORS].sort(),
  );
  assert.deepEqual(
    Object.keys(HIGHLIGHT_STYLE_LABEL).sort(),
    [...HIGHLIGHT_STYLES].sort(),
  );

  for (const value of Object.values(HIGHLIGHT_COLOR_LABEL)) {
    assert.ok(value.length > 0, "labels must not be empty strings");
  }
  for (const value of Object.values(HIGHLIGHT_STYLE_LABEL)) {
    assert.ok(value.length > 0, "labels must not be empty strings");
  }
});

test("the tables hold no duplicates", () => {
  // A duplicated entry renders the same button twice, and React would
  // warn about the duplicate key rather than the duplicate concept.
  assert.equal(new Set(HIGHLIGHT_COLORS).size, HIGHLIGHT_COLORS.length);
  assert.equal(new Set(HIGHLIGHT_STYLES).size, HIGHLIGHT_STYLES.length);
});

test("the default shape is one of the shapes", () => {
  assert.ok(HIGHLIGHT_STYLES.includes(DEFAULT_HIGHLIGHT_STYLE));
});

test("resolveHighlightStyle passes known shapes through", () => {
  for (const style of HIGHLIGHT_STYLES) {
    assert.equal(resolveHighlightStyle(style), style);
  }
});

test("resolveHighlightStyle falls back for missing or unknown shapes", () => {
  assert.equal(resolveHighlightStyle(undefined), DEFAULT_HIGHLIGHT_STYLE);
  assert.equal(resolveHighlightStyle(""), DEFAULT_HIGHLIGHT_STYLE);
  assert.equal(resolveHighlightStyle("gelato"), DEFAULT_HIGHLIGHT_STYLE);
  // Not just any string: a shape name that is a *prototype* member
  // would be truthy under a naive `in`-style check.
  assert.equal(resolveHighlightStyle("constructor"), DEFAULT_HIGHLIGHT_STYLE);
  assert.equal(resolveHighlightStyle("toString"), DEFAULT_HIGHLIGHT_STYLE);
});

test("resolveHighlightColor passes known colours through and falls back otherwise", () => {
  for (const color of HIGHLIGHT_COLORS) {
    assert.equal(resolveHighlightColor(color), color);
  }
  assert.equal(resolveHighlightColor("mauve"), "yellow");
  assert.equal(resolveHighlightColor(""), "yellow");
  assert.equal(resolveHighlightColor("constructor"), "yellow");
});
