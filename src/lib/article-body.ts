// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading an article's text from a component.
 *
 * ## Why a hook and not `article.paragraphs`
 *
 * The text is no longer part of the article record. That is the point: "this
 * device does not have the text" has to be a state the code can be in, and the
 * only reliable way to make every call site handle it is to remove the field
 * that let them not. What replaces it is this hook, plus a type that says which
 * of the three cases you are in.
 *
 * ## Why it asks the store rather than loading by itself
 *
 * The reader, the notebook, the outline and the note rail all need the same
 * article. If each loaded it, that would be several IndexedDB reads (they are
 * cheap, but they are not free), several in-flight states to reconcile, and
 * several places that could disagree about whether the text is here. One
 * `ensureBody` per article in the store means one answer.
 */

import { useEffect } from "react";
import { useStore, type BodyEntry } from "./store";
import type { Paragraph } from "./types";

/**
 * The empty list, as one object.
 *
 * A fresh `[]` would be a new reference on every render, and every `useMemo`
 * and `React.memo` downstream that depends on the paragraph list would recompute
 * or re-render on every parent render — which is exactly what happens while a
 * body is loading, the one moment the rail should be calm.
 */
export const EMPTY_PARAGRAPHS: readonly Paragraph[] = Object.freeze([]);

/**
 * One article's body state, asking for it if nobody has.
 *
 * Returns `undefined` only for the first render of a body nobody has requested
 * yet; from the next tick on it is `loading`, `present` or `absent`. Callers
 * that render the text should treat anything but `present` as "not renderable"
 * and fall back to the shell.
 */
export function useArticleBody(articleId: string | null | undefined): BodyEntry | undefined {
  const entry = useStore((s) => (articleId ? s.bodies[articleId] : undefined));
  const ensureBody = useStore((s) => s.ensureBody);

  useEffect(() => {
    if (articleId) ensureBody(articleId);
  }, [articleId, ensureBody]);

  return entry;
}

/**
 * One article's paragraphs, or the empty list.
 *
 * For call sites that build something out of the text (an outline, a notebook
 * index, a model prompt) and already sit behind a "is the body ready?" branch.
 * Using this without that branch renders an empty document rather than an
 * error, which is the right failure for a derived view — but it is not a
 * substitute for the branch.
 */
export function useArticleParagraphs(articleId: string | null | undefined): readonly Paragraph[] {
  const entry = useArticleBody(articleId);
  return entry?.state === "present" ? entry.body.paragraphs : EMPTY_PARAGRAPHS;
}
