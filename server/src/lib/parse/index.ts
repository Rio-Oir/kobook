// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Extractor entry point.
 *
 * Both extractors return the same `ParseResult`, so callers never branch on
 * which one ran. `EMPTY_CONTENT` is a first-class outcome: a document that
 * yields no text is rejected here and must not be persisted.
 */

import type { ParseResult } from "../../../../shared/contracts/index.js";
import { parseHtml, type HtmlParseOptions } from "./html.js";
import { parseMarkdown, type MarkdownParseOptions } from "./markdown.js";

export type ParseKind = "html" | "markdown";

export interface ParseOptions {
  title?: string;
}

export function parseContent(
  kind: ParseKind,
  content: string,
  options: ParseOptions = {},
): ParseResult {
  switch (kind) {
    case "html":
      return parseHtml(content, options as HtmlParseOptions);
    case "markdown":
      return parseMarkdown(content, options as MarkdownParseOptions);
    default: {
      const exhaustive: never = kind;
      return {
        ok: false,
        code: "UNSUPPORTED_INPUT",
        message: `Unsupported parse kind: ${String(exhaustive)}`,
      };
    }
  }
}

export { parseHtml } from "./html.js";
export { parseMarkdown } from "./markdown.js";
export { EXTRACTOR_VERSION, sha256Hex } from "./blocks.js";
