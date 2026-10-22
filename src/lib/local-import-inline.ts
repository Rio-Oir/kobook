// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Inline emphasis: the span algebra, browser-side.
 *
 * This is the browser counterpart of `server/src/lib/parse/inline.ts`. The
 * server module cannot be imported here: it is written for NodeNext and pulls
 * its types through `../../../../shared/contracts/index.js`, which the browser
 * bundle has no reason to resolve — and more to the point, the browser must not
 * depend on `server/` at all (server 依赖 node/jsdom，见交接文档 §3).
 *
 * So the algorithm is reproduced, not re-derived. The rules that make the two
 * implementations interchangeable are asserted, not assumed:
 * `tests/unit/local-import-parse.test.ts` parses the same fixtures with both
 * and compares the complete `ParsedDocument` — spans included — field by field.
 * If this file and the server's ever disagree, that test goes red instead of
 * the two channels quietly anchoring notes on different coordinates.
 *
 * Two stages, same split as the server:
 *
 *   1. `InlineTextBuilder` accumulates text and *raw* marks. Raw marks may
 *      nest and overlap freely, because that is how markup is written.
 *   2. `canonicalizeSpans` flattens them into the non-overlapping, merged form
 *      the contract requires.
 *
 * Every offset here is a UTF-16 offset into the *raw* string the extractor
 * assembled. Turning those into offsets onto the normalised `text` — where
 * whitespace has been collapsed — happens in `local-import-blocks.ts`.
 */

import { INLINE_MARK_ORDER } from "../../shared/contracts/index.js";
import type { InlineMarkKind, InlineSpan } from "../../shared/contracts/index.js";

/**
 * Canonical order for `InlineSpan.kinds`, and the closed set of kinds.
 *
 * Owned by the contract (`shared/contracts/content.ts`) rather than declared
 * here, because the reader nests by the same order and a private copy on
 * either side would eventually disagree.
 */
export const MARK_ORDER = INLINE_MARK_ORDER;

/** A mark as found in the source, before overlap is resolved. */
export interface RawMark {
  start: number;
  end: number;
  kind: InlineMarkKind;
  /** Only ever set for `kind === "link"`. */
  href?: string;
}

/**
 * Accumulates a block's text and the emphasis found inside it.
 *
 * Text is accumulated rather than sliced afterwards because the extractor
 * assembles it from several places — a Markdown list item joins its children
 * with a space — and those inserted separators are real characters in the
 * stored `text`. Recording marks while appending keeps them on the same
 * coordinate system as the separators by construction.
 */
export class InlineTextBuilder {
  private readonly parts: string[] = [];
  private readonly found: RawMark[] = [];
  private length = 0;

  /** Append text the block owns. Empty input is a no-op. */
  append(value: string): void {
    if (value.length === 0) return;
    this.parts.push(value);
    this.length += value.length;
  }

  /**
   * Record that everything `run` appends is drawn with `kind`.
   *
   * A run that appends nothing records nothing. `<strong></strong>` is not a
   * zero-width emphasis, it is no emphasis — and an empty span would break
   * the "`start < end`" invariant for no benefit.
   */
  wrap(kind: InlineMarkKind, run: () => void, href?: string): void {
    const start = this.length;
    run();
    const end = this.length;
    if (end <= start) return;
    this.found.push(href === undefined ? { start, end, kind } : { start, end, kind, href });
  }

  get text(): string {
    return this.parts.join("");
  }

  get marks(): readonly RawMark[] {
    return this.found;
  }
}

/**
 * Flatten overlapping marks into the contract's canonical span list.
 *
 * Works by cutting the block at every mark boundary: between two consecutive
 * cuts the set of active marks cannot change, so each elementary interval
 * carries exactly one `kinds` set. Adjacent intervals with the same set are
 * then merged, which is what makes the output canonical — `[a](x)[b](x)`
 * describes one span, not two identical neighbours.
 */
export function canonicalizeSpans(marks: readonly RawMark[], length: number): InlineSpan[] {
  if (marks.length === 0 || length <= 0) return [];

  const cuts = new Set<number>([0, length]);
  for (const mark of marks) {
    if (mark.start > 0 && mark.start < length) cuts.add(mark.start);
    if (mark.end > 0 && mark.end < length) cuts.add(mark.end);
  }
  const bounds = [...cuts].sort((a, b) => a - b);

  const spans: InlineSpan[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    if (start === end) continue;

    const active = marks.filter((m) => m.start <= start && m.end >= end);
    if (active.length === 0) continue;

    const kinds = MARK_ORDER.filter((kind) => active.some((m) => m.kind === kind));
    const href = active.find((m) => m.kind === "link")?.href;

    const previous = spans[spans.length - 1];
    if (
      previous &&
      previous.end === start &&
      previous.href === href &&
      previous.kinds.length === kinds.length &&
      previous.kinds.every((kind, index) => kind === kinds[index])
    ) {
      previous.end = end;
      continue;
    }

    spans.push(href === undefined ? { start, end, kinds: [...kinds] } : { start, end, kinds: [...kinds], href });
  }
  return spans;
}

/**
 * Whether a span list is safe to store and render against `text`.
 *
 * Checked rather than assumed because the spans may come from a database row
 * written by an older build, or from a source the extractor could not fully
 * model. A malformed list is dropped at the call site: losing some bold text
 * is a cosmetic loss, whereas an offset past the end of a paragraph would
 * corrupt every highlight in that block.
 */
export function spansAreSound(spans: readonly InlineSpan[], textLength: number): boolean {
  let previousEnd = 0;
  for (const span of spans) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) return false;
    if (span.start < 0 || span.start >= span.end || span.end > textLength) return false;
    if (span.start < previousEnd) return false;

    if (span.kinds.length === 0) return false;
    if (new Set(span.kinds).size !== span.kinds.length) return false;
    const ordered = MARK_ORDER.filter((kind) => span.kinds.includes(kind));
    if (ordered.length !== span.kinds.length) return false;
    if (ordered.some((kind, index) => kind !== span.kinds[index])) return false;

    const isLink = span.kinds.includes("link");
    if (isLink !== (span.href !== undefined)) return false;
    if (isLink && (span.href ?? "").length === 0) return false;

    previousEnd = span.end;
  }
  return true;
}
