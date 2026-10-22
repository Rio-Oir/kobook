// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-host extraction rules — the DOM half.
 *
 * The table itself lives in `shared/site-rules.ts`, because the browser's saved
 * — file path needs the same containers and must not drift from the server's.
 * This module is what runs the table against HTML the caller already holds:
 * linkedom parses, the rule's container (or embedded state) is extracted, and
 * the result is handed back as markup for the block walker.
 *
 * Nothing here fetches, so a rule is a pure function of `(html, url)` and is
 * unit-testable without a network. Which headers a host needs is also in the
 * shared table; the fetch layer reads it per hop.
 */

import { parseHTML } from "linkedom";
import {
  MIN_CONTAINER_TEXT,
  findSiteRule,
  type SiteRule,
} from "../../../shared/site-rules.js";

export type { SiteRule, SiteRequestHeaders, SiteStateRule } from "../../../shared/site-rules.js";
export { findSiteRule, requestHeadersFor, SITE_RULES } from "../../../shared/site-rules.js";

/** What a matched rule produced, in the shape the parser consumes. */
export interface SiteExtraction {
  kind: "html" | "markdown";
  content: string;
  title?: string;
  via: "container" | "state";
}

/** linkedom needs a whole document; an extracted fragment has to be wrapped. */
function asDocument(html: string): string {
  return /<(?:!doctype|html|head|body)[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><body>${html}</body></html>`;
}

/** Read a title from a selector, aware of the `meta` shape. */
function readTitle(document: ReturnType<typeof parseHTML>["document"], selector: string): string | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const raw =
    selector.startsWith("meta") && el.hasAttribute("content")
      ? el.getAttribute("content")
      : el.textContent;
  const text = (raw ?? "").trim();
  return text.length > 0 ? text : null;
}

function resolveTitle(
  document: ReturnType<typeof parseHTML>["document"],
  rule: SiteRule,
): string | undefined {
  for (const selector of rule.titles ?? []) {
    const title = readTitle(document, selector);
    if (title !== null) return title;
  }
  const og = document.querySelector('meta[property="og:title"]');
  const ogTitle = og?.getAttribute("content")?.trim();
  if (ogTitle !== undefined && ogTitle.length > 0) return ogTitle;
  const titleTag = document.querySelector("title");
  const titleText = (titleTag?.textContent ?? "").trim();
  return titleText.length > 0 ? titleText : undefined;
}

/**
 * Try one rule against `html`.
 *
 * `state` runs before `containers` because a page that ships its article as
 * JSON has a DOM container that is only a shell for it.
 */
export function extractWithRule(html: string, rule: SiteRule): SiteExtraction | null {
  if (rule.state !== undefined) {
    const match = rule.state.pattern.exec(html);
    if (match?.[1] !== undefined) {
      try {
        const parsed: unknown = JSON.parse(match[1]);
        let node: unknown = parsed;
        for (const key of rule.state.path) {
          node = typeof node === "object" && node !== null && key in node
            ? (node as Record<string, unknown>)[key]
            : undefined;
        }
        if (typeof node === "string" && node.trim().length >= MIN_CONTAINER_TEXT) {
          const title = resolveTitle(parseHTML(asDocument(html)).document, rule);
          return {
            kind: rule.state.format,
            content: node.trim(),
            ...(title === undefined ? {} : { title }),
            via: "state",
          };
        }
      } catch {
        // Malformed state: fall through to the DOM rules rather than fail the
        // import — a broken blob is exactly when the container still works.
      }
    }
  }

  if (rule.containers === undefined) return null;
  const { document } = parseHTML(asDocument(html));
  for (const selector of rule.containers) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const text = (el.textContent ?? "").trim();
    if (text.length < MIN_CONTAINER_TEXT) continue;
    const title = resolveTitle(document, rule);
    return {
      kind: "html",
      content: el.outerHTML ?? String(el),
      ...(title === undefined ? {} : { title }),
      via: "container",
    };
  }
  return null;
}

/** Try the rule that owns `url` against `html`. */
export function extractWithSiteRule(html: string, url: string | URL): SiteExtraction | null {
  const rule = findSiteRule(url);
  return rule === null ? null : extractWithRule(html, rule);
}
