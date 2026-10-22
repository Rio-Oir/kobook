// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What the import box actually received: a link to fetch, or article text to
 * parse locally.
 *
 * The box accepts both, and the two paths are not interchangeable — one opens a
 * network request and the other deliberately has no network path at all (see
 * `local-import.ts`). Choosing between them is a product rule, not string
 * plumbing, so it lives here as a pure function: no `fetch`, no DOM, no
 * imports. It can be tested exhaustively without driving the page.
 *
 * ## What counts as a link
 *
 * Three shapes, tried in this order:
 *
 *   1. **explicit** — `https://example.com/a`. The user typed the scheme.
 *      `http` and `https` in any case: `HTTP://example.com` used to be rejected
 *      by a case-sensitive prefix test, so a valid link failed with
 *      "请输入 http(s) 链接。".
 *   2. **protocol-relative** — `//example.com/a`, defaulted to `https:`. A
 *      browser would inherit the current page's scheme; there is no current
 *      page here, and `https` is the only sane default.
 *   3. **bare domain** — `example.com/a`, defaulted to `https://`. This is the
 *      affordance the box has always advertised, and until now the classifier
 *      required a scheme: a pasted bare link was silently parsed as *text*, so
 *      the reader got a one-line article containing the link instead of the
 *      page. `www.` is just another label and needs no special case; a port,
 *      path, query and fragment are all preserved verbatim.
 *
 * ## Only the third shape is a guess, so only it is guarded
 *
 * A bare token has no marker saying "this is a host". `notes.txt` is a file
 * name, `user@example.com` is an email, `example.c` is a typo, `example..com`
 * is malformed — and every one of them would become a request if the guess
 * were simply "contains a dot". The rule is therefore: the token must be a
 * structurally valid host with a letters-only TLD, and that TLD must not be a
 * file extension people paste. Failing either check keeps the token as text.
 *
 * The asymmetry is deliberate. A wrong "text" costs the reader a confusing
 * article they can delete; a wrong "link" sends their paste to a third-party
 * reader service. When the two are not distinguishable, this errs toward text,
 * and the escape hatch is explicit: typing `https://` in front always works,
 * because shape 1 is not a guess.
 *
 * ## What deliberately stays text
 *
 *   - ordinary prose, and prose that merely *mentions* a bare domain
 *     (`我在 example.com 上看到的`) — only a whole-input token can be shape 3;
 *   - emails and bare credentials (`user@example.com`, `user:pass@example.com`);
 *   - relative and absolute paths (`./a.md`, `../x`, `/etc/hosts`,
 *     `src/lib/foo.ts`) — the first label must be a valid host label, and
 *     `src`/`docs` are not;
 *   - file names with non-TLD extensions (`notes.txt`, `report.json`);
 *   - dangerous or unsupported schemes (`javascript:…`, `data:…`, `file:///…`);
 *     they are not `http(s)`, so no branch here produces a fetchable link;
 *   - malformed domains and IP literals (`example..com`, `-example.com`,
 *     `example.c`, `192.168.1.1`);
 *   - anything multi-line or multi-token, which is a document, not a link.
 *
 * ## Embedded links are still extracted (unchanged)
 *
 * A share message is not a link *shape* — it is prose with a link inside it
 * ("看看这篇 https://example.com/a。 写得不错"). That case keeps the behaviour it
 * has always had: the first explicit `http(s)` link is extracted and its
 * trailing sentence punctuation trimmed, while a bare domain inside prose is
 * left alone. Only the *whole* input can be classified as a bare domain, which
 * is what keeps "ordinary prose with a bare domain" local.
 *
 * ## Validation is not duplicated here
 *
 * These branches decide *which path* a paste takes. The rules that decide
 * whether a link may actually be fetched — http(s) only, no embedded
 * credentials — stay in `normalizeArticleUrl` (`browser-extract-jina.ts`), the
 * single gate the extractor calls before it builds a request. This module
 * guarantees only that a shape-2/3 decision is one that gate will accept.
 */

/**
 * Trailing punctuation a shared link picks up from the sentence around it.
 *
 * Byte-for-byte the rule `Home.handleSubmit` has always applied, kept here so
 * there is one copy of it and the unit tests can pin it.
 *
 * Note what is deliberately *not* in the set: an ASCII `.` or `,`. Widening it
 * would change what an explicit link does (`https://example.com/a.` keeps its
 * dot today), and this module's job is to stop guessing about bare domains,
 * not to revise the rules that already shipped. The cost is narrow and is
 * recorded in the handoff doc: a bare link typed with a sentence period after
 * a *path* (`example.com/a.`) fetches that path with the dot in it. A
 * whole-input `example.com.` is unaffected — there the dot is a valid FQDN and
 * resolves.
 */
const TRAILING_LINK_PUNCTUATION = /[，。；！？、）\])]+$/u;

/**
 * The whole box is one explicit `http(s)` link.
 *
 * The character class is the extractor's own link token: no whitespace, no
 * angle brackets, no quotes (including the curly ones a Chinese article uses).
 * The `i` flag is the fix for `HTTP://…`; it is applied at the *front* of the
 * token, where a scheme can actually appear.
 */
const WHOLE_EXPLICIT_HTTP = /^https?:\/\/[^\s<>"“”]+$/i;

/** The whole box is one protocol-relative link (`//example.com/a`). */
const WHOLE_PROTOCOL_RELATIVE = /^\/\/[^\s<>"“”]+$/;

/**
 * The first explicit `http(s)` link anywhere in a longer paste.
 *
 * Unanchored and the same token class as above, so extraction from share text
 * behaves exactly as it did before this module existed.
 */
const ANY_EXPLICIT_HTTP = /https?:\/\/[^\s<>"“”]+/i;

/**
 * A scheme-less host: one or more dot-separated labels, a letters-only TLD of
 * 2–24 characters, an optional trailing dot (an FQDN), an optional port, then
 * an optional path/query/fragment.
 *
 * Written as a shape check rather than by trying `new URL` first, because
 * `new URL("https://article.md")` succeeds — the string *is* a valid URL, it
 * is just not a link anybody meant to paste. The letters-only TLD is what
 * rejects `example.123` and the IPv4 literal `192.168.1.1`; the label rule
 * (start and end alphanumeric, `-` allowed inside, nothing else) is what
 * rejects `example..com`, `-example.com`, `example-.com`, `exa_mple.com` and
 * every `user@…` form.
 *
 * IDN hosts (`例子.中国`) are not matched. They are reachable by typing the
 * scheme, which is shape 1 and never a guess.
 */
const BARE_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\.?(?::\d{1,5})?(?:[/?#][^\s<>"“”]*)?$/i;

/**
 * TLDs that are far more likely to be a file extension than a host.
 *
 * Only suffixes that are not usable top-level domains belong here. Real TLDs
 * are deliberately not blocked, even when the same suffix is also used by
 * files: the input box is primarily for importing URLs, so `example.md` and
 * `example.py` should work. File names with non-TLD extensions stay text.
 *
 * Real top-level domains are deliberately not blocked, even if the same suffix
 * is also used by files (for example `.md`, `.py` or `.sh`). The input box is
 * primarily for importing URLs, so a structurally valid whole-domain token
 * should remain usable. File names with extensions that are not TLDs stay text.
 *
 * This is a guard against the obvious file names, not a registry.
 */
const FILE_EXTENSION_GUARD: ReadonlySet<string> = new Set([
  // The formats this app itself imports, plus neighbouring text formats.
  "markdown", "mdx", "txt", "text", "rst", "adoc", "tex", "bib", "ipynb",
  // Documents and spreadsheets.
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  "epub", "azw3", "djvu",
  // Data, config and logs.
  "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "properties", "env", "xml", "html", "htm", "xhtml", "sql", "db", "sqlite",
  "sqlite3", "log", "out", "lock", "bak", "tmp", "orig", "rej", "patch", "diff",
  "swp", "swo",
  // Web and styles.
  "css", "scss", "sass", "less", "vue", "svelte",
  // Source code.
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "pyc", "rb",
  "php", "java", "kt", "kts", "scala", "go", "cpp", "cxx", "hpp", "hh",
  "cs", "swift", "lua", "jl", "dart", "bash", "zsh", "fish", "bat",
  "cmd", "ps1", "psm1",
  // Images, audio, video, subtitles.
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "svg",
  "heic", "avif", "psd", "mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4",
  "mov", "avi", "mkv", "webm", "wmv", "srt", "vtt",
  // Archives, installers and binaries.
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "exe", "msi",
  "dmg", "pkg", "deb", "rpm", "apk", "jar", "class", "dll", "dylib", "bin",
  "iso", "img",
]);

/** How a link was written, before any defaulting. */
export type ImportUrlShape =
  /** The user typed `http://` or `https://` (any case). */
  | "explicit-http"
  /** `//example.com/a` — scheme inherited from nowhere, so `https:`. */
  | "protocol-relative"
  /** `example.com/a` — scheme guessed, so `https://`. */
  | "bare-domain";

/** Where the link came from, which is also how much of the paste it is. */
export type ImportUrlOrigin =
  /** The entire (trimmed) input was one link. */
  | "whole-input"
  /** The input was prose, and one explicit `http(s)` link was extracted. */
  | "embedded";

/**
 * The verdict for one paste.
 *
 * `url` carries the URL to hand to the extractor: absolute in every case, with
 * the default scheme already applied where one was missing, and with the
 * sentence punctuation already trimmed. The explicit shape is passed through
 * as typed (that is what the stored `article.url` has always held) and is
 * canonicalised by `normalizeArticleUrl` at fetch time.
 */
export type ImportInputDecision =
  | { kind: "url"; url: string; shape: ImportUrlShape; origin: ImportUrlOrigin }
  | { kind: "text"; text: string };

/**
 * Drop the sentence punctuation a shared link collected.
 *
 * Exported because it is a rule with its own edge cases, and the unit test
 * pins it directly rather than only through `classifyImportInput`.
 */
export function stripTrailingLinkPunctuation(token: string): string {
  return token.replace(TRAILING_LINK_PUNCTUATION, "");
}

/**
 * Whether a scheme-less token is a host we are willing to default to `https://`
 * and fetch.
 *
 * Two gates: the structural shape above, and then a real parse. The parse is
 * not redundant — `example.com:99999` matches the shape (five digits) and
 * `new URL` refuses it, and the port range is one of the rules a regular
 * expression should not be re-implementing. A token that fails either gate is
 * text, never a link.
 */
export function looksLikeBareDomainUrl(candidate: string): boolean {
  if (!BARE_HOST.test(candidate)) return false;
  let hostname: string;
  try {
    hostname = new URL(`https://${candidate}`).hostname;
  } catch {
    return false;
  }
  // The hostname is already lowercased and punycoded by the parser; the
  // trailing dot of an FQDN has to go before the last label is the TLD.
  const tld = hostname.replace(/\.$/, "").split(".").pop() ?? "";
  return !FILE_EXTENSION_GUARD.has(tld.toLowerCase());
}

/**
 * Decide which path a paste takes.
 *
 * Order matters. The three whole-input shapes come first, so a paste that is
 * exactly one link is never mistaken for text; embedded extraction comes
 * after, so a bare domain mentioned inside prose is left in the prose; and
 * everything left over is article text.
 *
 * The returned text is trimmed, because that is what `importFromText` was
 * always given.
 */
export function classifyImportInput(raw: string): ImportInputDecision {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "text", text: "" };

  const token = stripTrailingLinkPunctuation(trimmed);

  // 1. One explicit http(s) link, on its own.
  if (WHOLE_EXPLICIT_HTTP.test(token)) {
    return { kind: "url", url: token, shape: "explicit-http", origin: "whole-input" };
  }

  // 2. One protocol-relative link, on its own. The host still has to be a
  //    host: `//etc/hosts` is a path with a doubled slash, not a link.
  if (WHOLE_PROTOCOL_RELATIVE.test(token) && looksLikeBareDomainUrl(token.slice(2))) {
    return { kind: "url", url: `https:${token}`, shape: "protocol-relative", origin: "whole-input" };
  }

  // 3. One bare domain, on its own.
  if (looksLikeBareDomainUrl(token)) {
    return { kind: "url", url: `https://${token}`, shape: "bare-domain", origin: "whole-input" };
  }

  // 4. An explicit http(s) link inside a longer paste. Unchanged from the
  //    behaviour this module replaces: first match wins, and the trailing
  //    punctuation trim is applied to the extracted token, not to the prose.
  const embedded = raw.match(ANY_EXPLICIT_HTTP)?.[0];
  if (embedded !== undefined) {
    return {
      kind: "url",
      url: stripTrailingLinkPunctuation(embedded),
      shape: "explicit-http",
      origin: "embedded",
    };
  }

  // 5. Everything else is article text — including prose that mentions a bare
  //    domain, which is exactly the case the whole-input rule protects.
  return { kind: "text", text: trimmed };
}
