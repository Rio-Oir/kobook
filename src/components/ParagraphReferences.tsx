// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Render an AI answer with its `¶N` paragraph references as buttons.
 *
 * The system prompt asks the model to mark the paragraph each claim comes
 * from, and the answer arrives as plain text containing `¶27`. Printing
 * that verbatim leaves the reader with a number they have to find by hand;
 * making it a button turns the reference into the navigation it was
 * always meant to be.
 *
 * ## Why unavailable references are rendered, not hidden
 *
 * The index is checked against the paragraphs actually on screen, so a
 * reference to a paragraph that is not in this document — a stale answer,
 * a model that invented a number, a document that was re-imported shorter
 * — is still shown, as a *disabled* button with a title explaining why.
 * Dropping it would silently edit the model's answer, and the reader
 * would have no way to tell a reference that failed to resolve from one
 * the model never made.
 *
 * ## Why this is not `dangerouslySetInnerHTML`
 *
 * The answer is untrusted text (it comes from a model, over the network).
 * It is split into a flat array of strings and React elements, so no part
 * of it is ever parsed as markup.
 */

import type { ReactNode } from "react";

export default function ParagraphReferences({
  text,
  indices,
  onJump,
}: {
  text: string;
  /** Paragraph indices present in the article being read. */
  indices: Set<number>;
  onJump?: (index: number) => void;
}) {
  const content: ReactNode[] = [];
  let offset = 0;
  // `matchAll` rather than a `while (exec)` loop: the loop's `lastIndex`
  // state is shared mutable state that a re-entrant render can corrupt.
  for (const match of text.matchAll(/¶(\d+)/g)) {
    content.push(text.slice(offset, match.index));
    const index = Number(match[1]);
    const available = indices.has(index) && !!onJump;
    content.push(
      <button
        key={match.index}
        type="button"
        disabled={!available}
        title={available ? `跳转到原文第 ${index} 段` : "此引用在当前正文中不可定位"}
        onClick={() => onJump?.(index)}
        className="inline rounded px-1 text-gloss-accent bg-gloss-accent/10 disabled:text-gloss-textDim disabled:cursor-default hover:underline"
      >
        第 {index} 段
      </button>,
    );
    offset = match.index! + match[0].length;
  }
  content.push(text.slice(offset));
  return <>{content}</>;
}
