// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared-element vocabulary for the library ↔ reader morph.
 *
 * Three names per article, identical on both surfaces:
 *
 *   - `post-shell-<id>` — the card surface. The library draws a small card;
 *     the reader draws the article header card. `vt-expand` animates the
 *     geometry and paints the intermediate surface.
 *   - `post-cover-<id>` — the cover tile. The library's square thumbnail
 *     grows into the reader's wide banner, clipped by `vt-cover`.
 *   - `post-title-<id>` — the title. `vt-text` keeps the glyph size natural
 *     while the box around it changes, so the title reads as text rather
 *     than as a stretched bitmap.
 *
 * The class names are consumed by the view-transition CSS at the bottom of
 * `src/index.css`, which is keyed off the *transition type*:
 * `post-open` uses the default timing, `post-close` adds `vt-quick` so the
 * return trip is shorter than the way in.
 *
 * The id is part of the name because a view-transition-name must be unique
 * in the document; two cards sharing one name would make the browser skip
 * the whole transition.
 */

export const POST_VT_PARTS = ["shell", "cover", "title"] as const;

export type PostVtPart = (typeof POST_VT_PARTS)[number];

/** `post-<part>-<articleId>`; ids are `local-<hex>` or a cuid, both safe. */
export function postVtName(part: PostVtPart, articleId: string): string {
  return `post-${part}-${articleId}`;
}

/** Per-part class lists, with the faster close variants. */
export const POST_VT_SHARE: Record<
  PostVtPart,
  { default: string; "post-close": string }
> = {
  shell: { default: "vt-move vt-expand", "post-close": "vt-move vt-expand vt-quick" },
  cover: { default: "vt-move vt-cover", "post-close": "vt-move vt-cover vt-quick" },
  title: { default: "vt-move vt-text", "post-close": "vt-move vt-text vt-quick" },
};
