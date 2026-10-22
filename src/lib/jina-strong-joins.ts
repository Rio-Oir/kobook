// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes } from "mdast";

const processor = unified().use(remarkParse).use(remarkGfm);

function isPlainEmphasis(node: Nodes): boolean {
  if (node.type === "text") return true;
  return (
    (node.type === "paragraph" || node.type === "strong" || node.type === "emphasis") &&
    node.children.every(isPlainEmphasis)
  );
}

/**
 * Jina can serialize adjacent HTML strong elements as **a****b**.
 * Merge only entire bold paragraphs with two-star outer delimiters and
 * four-star joins. Preserve soft wraps, including a join split by a wrap.
 * Code, links, escapes, mixed emphasis and standalone star runs stay intact.
 */
export function normalizeJinaStrongJoins(markdown: string): string {
  if (!markdown.includes("****") && !/\*\r?\n\*/.test(markdown)) return markdown;
  const root = processor.parse(markdown);
  let result = markdown;
  // Reverse offsets keep all replacements relative to the original input.
  for (const node of [...root.children].reverse()) {
    if (node.type !== "paragraph" || !isPlainEmphasis(node)) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const raw = markdown.slice(start, end);
    if (/[\\`]/.test(raw)) continue;
    const runs = [...raw.matchAll(/\*+(?:[ \t]*\r?\n[ \t]*\*+)*/g)];
    if (runs.length < 3) continue;
    const first = runs[0]!;
    const last = runs[runs.length - 1]!;
    if (
      first.index !== 0 || first[0] !== "**" ||
      last.index! + last[0].length !== raw.length || last[0] !== "**" ||
      !runs.slice(1, -1).every((run) => run[0].replace(/\s/g, "") === "****")
    ) continue;
    let merged = raw;
    for (const run of runs.slice(1, -1).reverse()) {
      merged = merged.slice(0, run.index) + run[0].replace(/\*/g, "") +
        merged.slice(run.index! + run[0].length);
    }
    result = result.slice(0, start) + merged + result.slice(end);
  }
  return result;
}
