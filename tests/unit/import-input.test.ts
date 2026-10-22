// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract gate: what the import box does with a paste.
 *
 * This is the decision that stood between "paste a link" and "paste an
 * article", and it used to be one regex inside `Home.handleSubmit`. Two
 * things went wrong there and both are pinned below:
 *
 *   1. **A bare domain was not a link.** `/https?:\/\//` was required, so
 *      `example.com/a` — the affordance the box advertises — fell through to
 *      the text path and became a one-line article containing the link.
 *   2. **`HTTP://example.com` was rejected.** The extractor's match was
 *      case-insensitive but the follow-up prefix test was not, so an
 *      uppercase scheme threw "请输入 http(s) 链接。" for a perfectly good URL.
 *
 * The rest of the file is the *conservative* half: every shape that must keep
 * going down the local path, because guessing "link" wrongly sends the user's
 * paste to a third-party reader service while guessing "text" wrongly costs
 * them one deletable article.
 *
 * The last test ties the classifier to `normalizeArticleUrl`, the gate that
 * actually decides whether a request may be built: a bare-domain verdict is
 * only useful if the gate accepts it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyImportInput,
  looksLikeBareDomainUrl,
  stripTrailingLinkPunctuation,
  type ImportInputDecision,
} from "../../src/lib/import-input.js";
import { normalizeArticleUrl } from "../../src/lib/browser-extract-jina.js";

/** Narrow a decision to its URL arm, failing the test with the actual shape. */
function asUrl(decision: ImportInputDecision): Extract<ImportInputDecision, { kind: "url" }> {
  assert.equal(decision.kind, "url", `expected a url decision, got ${JSON.stringify(decision)}`);
  if (decision.kind !== "url") throw new Error("unreachable");
  return decision;
}

/** Narrow a decision to its text arm. */
function asText(decision: ImportInputDecision): string {
  assert.equal(decision.kind, "text", `expected a text decision, got ${JSON.stringify(decision)}`);
  return decision.kind === "text" ? decision.text : "";
}

test("a bare domain on its own is a link, defaulted to https", () => {
  for (const input of [
    "example.com",
    "example.com/",
    "www.example.com",
    "example.com/some/article",
    "sub.domain.example.co.uk",
    "EXAMPLE.COM",
    "WWW.Example.Com/Path",
  ]) {
    const decision = asUrl(classifyImportInput(input));
    assert.equal(decision.shape, "bare-domain", input);
    assert.equal(decision.origin, "whole-input", input);
    assert.match(decision.url, /^https:\/\//, input);
    assert.equal(normalizeArticleUrl(decision.url).ok, true, input);
  }
});

test("real TLDs are not blocked just because they are also file extensions", () => {
  for (const input of ["example.md", "example.py", "example.sh", "example.rs", "example.so"]) {
    assert.equal(asUrl(classifyImportInput(input)).url, `https://${input}`, input);
  }
});

test("bare-domain: port, path, query and fragment survive verbatim", () => {
  const decision = asUrl(classifyImportInput("example.com:8080/a/b?x=1&y=2#section-3"));
  assert.equal(decision.url, "https://example.com:8080/a/b?x=1&y=2#section-3");
  assert.equal(decision.shape, "bare-domain");

  // Query-only and fragment-only forms are still the whole input.
  assert.equal(asUrl(classifyImportInput("example.com?q=1")).url, "https://example.com?q=1");
  assert.equal(asUrl(classifyImportInput("example.com#top")).url, "https://example.com#top");

  // A path may contain dots and a file extension: the guard is about the
  // *host's* last label, not about the path.
  assert.equal(asUrl(classifyImportInput("example.com/docs/a.md")).url, "https://example.com/docs/a.md");
});

test("a protocol-relative link defaults to https", () => {
  const decision = asUrl(classifyImportInput("//example.com/a?q=1"));
  assert.equal(decision.shape, "protocol-relative");
  assert.equal(decision.url, "https://example.com/a?q=1");
  assert.equal(normalizeArticleUrl(decision.url).ok, true);
});

test("an explicit http(s) link is passed through as typed, in any case", () => {
  for (const input of [
    "https://example.com/a",
    "http://example.com/a",
    "HTTP://example.com/a",
    "HtTpS://Example.COM/Path?Q=1",
  ]) {
    const decision = asUrl(classifyImportInput(input));
    assert.equal(decision.shape, "explicit-http", input);
    assert.equal(decision.origin, "whole-input", input);
    // Passed through unchanged — the stored `article.url` has always been the
    // string the user typed, and the gate canonicalises it at fetch time.
    assert.equal(decision.url, input);
    assert.equal(normalizeArticleUrl(decision.url).ok, true, input);
  }
  // The uppercase case is the regression: it used to throw
  // "请输入 http(s) 链接。" before any request was attempted.
  const upper = asUrl(classifyImportInput("HTTPS://Example.COM/A"));
  const normalized = normalizeArticleUrl(upper.url);
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.equal(normalized.url, "https://example.com/A");
});

test("trailing sentence punctuation is trimmed off a link", () => {
  assert.equal(asUrl(classifyImportInput("https://example.com/a。")).url, "https://example.com/a");
  assert.equal(asUrl(classifyImportInput("example.com/a，")).url, "https://example.com/a");
  assert.equal(asUrl(classifyImportInput("example.com/a）")).url, "https://example.com/a");
  assert.equal(asUrl(classifyImportInput("example.com/a）。")).url, "https://example.com/a");
  // Only *trailing* punctuation, and only from the link, never from prose.
  assert.equal(
    asText(classifyImportInput("（见 example.com/a 一文）")),
    "（见 example.com/a 一文）",
  );
});

test("share text: the first explicit link is extracted, punctuation and all", () => {
  const decision = asUrl(classifyImportInput("看看这篇 https://example.com/a。 写得不错"));
  assert.equal(decision.origin, "embedded");
  assert.equal(decision.shape, "explicit-http");
  assert.equal(decision.url, "https://example.com/a");

  // First match wins, as before.
  assert.equal(
    asUrl(classifyImportInput("https://example.com/a 和 https://example.com/b")).url,
    "https://example.com/a",
  );

  // Prose that only *mentions* a bare domain is not a link: only the whole
  // input can be the bare-domain shape.
  const prose = "我在 example.com 上看到一篇文章，讲的是浏览器怎么解析正文。";
  assert.equal(asText(classifyImportInput(prose)), prose);
  assert.equal(asText(classifyImportInput("见 example.com/a 这篇")), "见 example.com/a 这篇");
});

test("ordinary prose stays text", () => {
  for (const input of [
    "这是一段正文，里面有中文标点。",
    "hello world",
    "第一段\n\n第二段",
    "example.com 上有更多内容",
    "README",
  ]) {
    assert.equal(asText(classifyImportInput(input)), input.trim(), JSON.stringify(input));
  }
});

test("file names stay text", () => {
  for (const input of [
    "notes.txt",
    "README.markdown",
    "data.json",
    "logo.png",
    "paper.pdf",
    "app.ts",
    "index.html",
    "package.lock",
    "backup.zip",
  ]) {
    assert.equal(asText(classifyImportInput(input)), input, `${input} must not be fetched`);
  }
});

test("paths stay text", () => {
  for (const input of [
    "./docs/a.md",
    "../x",
    "/etc/hosts",
    "src/lib/foo.ts",
    "docs/article.md",
    "C:\\Users\\me\\notes.txt",
    "//etc/hosts",
  ]) {
    assert.equal(asText(classifyImportInput(input)), input, `${input} must not be fetched`);
  }
});

test("emails and bare credentials stay text", () => {
  for (const input of ["user@example.com", "user:pass@example.com", "first.last@mail.example.co.uk"]) {
    assert.equal(asText(classifyImportInput(input)), input, `${input} must not be fetched`);
  }
});

test("dangerous schemes never produce a fetchable link", () => {
  for (const input of [
    "javascript:alert(1)",
    "data:text/plain,hello",
    "file:///etc/passwd",
    "file:///C:/notes.txt",
    "ftp://example.com/f",
    "mailto:someone@example.com",
    "vbscript:msgbox(1)",
  ]) {
    const decision = classifyImportInput(input);
    if (decision.kind === "url") {
      // If a future rule ever routes one of these to the URL path, the gate
      // must still refuse it — that is the only thing that makes it safe.
      assert.equal(normalizeArticleUrl(decision.url).ok, false, input);
    } else {
      assert.equal(decision.text, input, input);
    }
  }
});

test("malformed domains and IP literals stay text", () => {
  for (const input of [
    "example..com",
    "-example.com",
    "example-.com",
    "example.com-",
    "exa_mple.com",
    "foo_bar.example.com",
    "example.c",
    "example.123",
    "192.168.1.1",
    "localhost:5173",
    "exa mple.com",
    "example.com:99999",
  ]) {
    assert.equal(asText(classifyImportInput(input)), input, `${input} must not be fetched`);
  }
});

test("empty input is text, and the trimmed text is what the local path gets", () => {
  assert.equal(asText(classifyImportInput("")), "");
  assert.equal(asText(classifyImportInput("   \n\t ")), "");
  assert.equal(asText(classifyImportInput("  正文  ")), "正文");
});

test("looksLikeBareDomainUrl: the structural gate on its own", () => {
  assert.equal(looksLikeBareDomainUrl("example.com"), true);
  assert.equal(looksLikeBareDomainUrl("example.com:8080/a?b=1#c"), true);
  assert.equal(looksLikeBareDomainUrl("example.com."), true);
  assert.equal(looksLikeBareDomainUrl("article.md"), true);
  assert.equal(looksLikeBareDomainUrl("example.com:99999"), false);
  assert.equal(looksLikeBareDomainUrl("example..com"), false);
  assert.equal(looksLikeBareDomainUrl("example"), false);
  assert.equal(looksLikeBareDomainUrl(""), false);
  assert.equal(looksLikeBareDomainUrl("https://example.com"), false);
});

test("stripTrailingLinkPunctuation: only the sentence punctuation a share adds", () => {
  assert.equal(stripTrailingLinkPunctuation("https://example.com/a。"), "https://example.com/a");
  assert.equal(stripTrailingLinkPunctuation("https://example.com/a"), "https://example.com/a");
  // A slash, a bracket that belongs to the path, and a query are untouched.
  assert.equal(stripTrailingLinkPunctuation("https://example.com/a/"), "https://example.com/a/");
  assert.equal(stripTrailingLinkPunctuation("https://example.com/a?q=1"), "https://example.com/a?q=1");
});

test("every bare-domain verdict is one the extractor's gate will fetch", () => {
  // The classifier does not re-implement the gate; it promises only that the
  // scheme-defaulted shapes it produces are acceptable to it.
  const inputs = [
    "example.com",
    "www.example.com/a?q=1#h",
    "sub.example.co.uk:8443/x",
    "EXAMPLE.COM/A",
    "example.com.",
  ];
  for (const input of inputs) {
    const decision = asUrl(classifyImportInput(input));
    const normalized = normalizeArticleUrl(decision.url);
    assert.equal(normalized.ok, true, `${input} -> ${decision.url}`);
    if (normalized.ok) {
      assert.equal(new URL(normalized.url).protocol, "https:", input);
    }
  }
});
