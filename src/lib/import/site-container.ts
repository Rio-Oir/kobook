// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The browser half of the site-rule table: find a known article container in a
 * saved page.
 *
 * This is what makes "save the page, import the file" produce a clean article
 * instead of Readability's best guess. A saved file has no URL to match on, so
 * the table is used the other way round: each rule's containers are *probed* in
 * order, and the first one with real text in it wins. That works because the
 * selectors are site-specific in the first place (`#js_content`,
 * `.Post-RichText`), and a page without them simply falls through to
 * Readability as before.
 *
 * The same rule as the server's: a match with too little text is the page's
 * skeleton, not its article, so it is ignored rather than returned empty.
 */

import {
  MIN_CONTAINER_TEXT,
  SITE_RULES,
  type SiteRule,
} from "../../../shared/site-rules.js";
import type { RawNode } from "./html-walk.js";

export interface SiteContainerHit {
  /** The container element, ready for the block walker. */
  root: RawNode;
  /** Title from the rule's own selectors, or "" when it offers none. */
  title: string;
  /** The rule that matched, for logs: its host. */
  rule: string;
}

/** Read a title from the page for one rule, aware of the `meta` shape. */
function titleFor(document: Document, rule: SiteRule): string {
  for (const selector of rule.titles ?? []) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const raw =
      selector.startsWith("meta") && el.hasAttribute("content")
        ? el.getAttribute("content")
        : el.textContent;
    const text = (raw ?? "").trim();
    if (text.length > 0) return text;
  }
  const og = document.querySelector('meta[property="og:title"]');
  const ogTitle = og?.getAttribute("content")?.trim();
  if (ogTitle !== undefined && ogTitle.length > 0) return ogTitle;
  return (document.title ?? "").trim();
}

/**
 * The first known article container in `document`, or `null` when the page is
 * not one of the sites the table covers.
 */
export function probeSiteContainer(document: Document): SiteContainerHit | null {
  for (const rule of SITE_RULES) {
    // Only the selectors distinctive enough to stand in for a host match. A
    // bare `article` (or `#content`) appears on half the web, and treating it
    // as evidence would skip Readability for pages this table knows nothing
    // about — see `probeContainers` in the shared table.
    for (const selector of rule.probeContainers ?? []) {
      const el = document.querySelector(selector);
      if (!el) continue;
      if (((el.textContent ?? "").trim().length) < MIN_CONTAINER_TEXT) continue;
      return {
        root: el as unknown as RawNode,
        title: titleFor(document, rule),
        rule: rule.host,
      };
    }
  }
  return null;
}
