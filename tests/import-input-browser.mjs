// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Focused browser gate: what the import box on the real Home page does.
 *
 * The unit test (`tests/unit/import-input.test.ts`) proves the classification
 * rule. It cannot prove the two things this file exists for, because both are
 * properties of the assembled page:
 *
 *   1. **A bare URL really reaches the extractor, normalised.** The box takes
 *      `example.com/post-1?from=share`, and what must appear on the wire is
 *      `https://r.jina.ai/https://example.com/post-1?from=share` — scheme
 *      defaulted, query intact, and *that* request and nothing else. A
 *      classification that never reached `importFromUrlDual`, or that dropped
 *      the query on the way, would pass a pure-function test and still fail
 *      the user.
 *   2. **Prose stays local.** The same box, given a paragraph that merely
 *      mentions `example.com`, must add no request at all — the local parser
 *      has no network path, and the page must not acquire one.
 *
 * The network is fully mocked and nothing leaves the machine: every request
 * off `127.0.0.1` is either answered by a stub Jina envelope or aborted, and
 * the backend fallback route is counted separately so an accidental fallback
 * shows up as a failed assertion rather than a served HTML page.
 *
 * The app is started from source on a free loopback port of its own. No
 * existing server, port or process is touched. Run:
 *   node tests/import-input-browser.mjs
 *
 * Page errors are asserted only while the Home box is on screen. A submit
 * navigates to the reader, and the reader's own health is the business of its
 * own gates (`browser-note-anchors.mjs`, `reading-layout-browser.mjs`) — a
 * crash there would say nothing about this classification. Reader-route
 * errors are still recorded and printed, so they stay visible rather than
 * being silently dropped.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STORAGE_KEY = "gloss-storage";
const EXTRACT_ROUTE = "/api/anonymous/extract";

/** What the stub Jina returns, in the envelope shape `fetchViaJinaDirect` reads. */
const STUB_TITLE = "被导入的文章";
const STUB_MARKDOWN = "第一段正文。\n\n第二段正文，足够解析成块。\n";
const JINA_PREFIX = "https://r.jina.ai/";

/**
 * One stub envelope per requested target.
 *
 * The target is echoed into the body so two different links do not produce the
 * same text: `localArticleKeyFor` keys an article by its text hash, so
 * identical bodies would collapse two imports into one row and hide a
 * classification mistake behind an idempotency rule.
 */
function jinaEnvelope(requestUrl) {
  const target = requestUrl.startsWith(JINA_PREFIX) ? requestUrl.slice(JINA_PREFIX.length) : requestUrl;
  return JSON.stringify({
    data: { title: STUB_TITLE, content: `${STUB_MARKDOWN}\n来源：${target}\n` },
  });
}

const TEXTAREA = 'textarea[aria-label="文章链接或正文"]';
const SUBMIT = 'button[type="submit"]';

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

/** Every article the page has saved, keyed by local id. */
async function storedArticles(page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    return JSON.parse(raw).state?.articles ?? {};
  }, STORAGE_KEY);
}

/** Load the import box at the home route and start charging errors to it. */
async function openHome(page, origin) {
  await page.goto(origin);
  await page.locator(TEXTAREA).waitFor();
  onHome = true;
}

/** Type one paste into the box, submit, and wait for the reader route. */
async function submitPaste(page, text) {
  await page.fill(TEXTAREA, text);
  await page.click(SUBMIT);
  // From here the reader is mounting; see the note on page errors in the
  // header. Flipped before the wait so an error thrown by the reader's own
  // render is not charged to this test.
  onHome = false;
  await page.waitForFunction(() => location.hash.startsWith("#/r/"), null, { timeout: 20_000 });
  return page.evaluate(() => location.hash.slice(4));
}

const results = {
  checks: [],
  jinaRequests: [],
  backendFallbacks: [],
  otherOffHost: [],
  pageErrors: [],
  articles: {},
  pass: false,
};

/** Whether the Home box is the current route; see the header note. */
let onHome = true;

let vite;
let browser;

try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;

  vite = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
      // `vite.config.ts` sets `server.open: true`. Without this the dev
      // server would launch the user's default browser as a side effect of
      // running a test.
      env: { ...process.env, BROWSER: "none" },
    },
  );

  let ready = false;
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await delay(100);
  }
  assert.ok(ready, `Vite did not start on the dynamic port ${port}`);

  browser = await chromium.launch({
    headless: true,
    ...(process.env.GLOSS_CHROME_PATH ? { executablePath: process.env.GLOSS_CHROME_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };

  await context.route("**/*", (route) => {
    const request = route.request();
    const url = request.url();

    // The controlled backend fallback. It is checked first and recorded
    // separately: it is same-origin, so the ordinary "let 127.0.0.1 through"
    // branch would serve it Vite's index.html and turn a real fallback into
    // an unreadable downstream failure.
    if (url.includes(EXTRACT_ROUTE)) {
      results.backendFallbacks.push({ method: request.method(), url });
      return route.abort();
    }

    const host = new URL(url).hostname;
    if (host === "127.0.0.1") return route.continue();

    // Channel 1. The stub answers both a CORS preflight and the GET, so the
    // browser-direct path succeeds and the fallback is never reached.
    if (host === "r.jina.ai") {
      results.jinaRequests.push(url);
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: corsHeaders, body: "" });
      }
      return route.fulfill({
        status: 200,
        headers: { ...corsHeaders, "content-type": "application/json" },
        body: jinaEnvelope(url),
      });
    }

    // Webfonts and anything else: nothing leaves this machine.
    results.otherOffHost.push({ url, host });
    return route.abort();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) =>
    results.pageErrors.push({ message: String(error.message), onHome }),
  );

  await openHome(page, origin);

  // ── 1. A bare URL, with a query, is fetched — normalised ────────────
  const BARE = "example.com/post-1?from=share";
  const id = await submitPaste(page, BARE);
  assert.equal(results.jinaRequests.length, 1, `expected one extraction request, got ${JSON.stringify(results.jinaRequests)}`);
  assert.equal(
    results.jinaRequests[0],
    "https://r.jina.ai/https://example.com/post-1?from=share",
    "the bare URL must be sent with https:// and its query intact",
  );
  assert.deepEqual(results.backendFallbacks, [], "a successful direct channel must not touch the backend");

  const afterBare = await storedArticles(page);
  const article = afterBare[id];
  assert.ok(article, `article ${id} was not saved`);
  assert.equal(article.url, "https://example.com/post-1?from=share");
  assert.equal(article.syncSource, "browser-jina");
  assert.equal(article.title, STUB_TITLE);
  assert.ok(article.paragraphs.length > 0, "the fetched article must have paragraphs");
  results.checks.push(`bare URL fetched as ${results.jinaRequests[0]}`);
  results.checks.push("the stored article carries the absolute URL and source browser-jina");

  // ── 2. An uppercase protocol is accepted (it used to be rejected) ───
  await openHome(page, origin);
  const upperId = await submitPaste(page, "HTTPS://Example.COM/UPPER?q=1");
  assert.equal(results.jinaRequests.length, 2, "the uppercase link must reach the extractor");
  assert.equal(
    results.jinaRequests[1],
    "https://r.jina.ai/https://example.com/UPPER?q=1",
    "the gate must canonicalise an uppercase scheme rather than refuse it",
  );
  const upperArticle = (await storedArticles(page))[upperId];
  assert.equal(upperArticle.syncSource, "browser-jina");
  assert.equal(
    upperArticle.url,
    "HTTPS://Example.COM/UPPER?q=1",
    "an explicit link is stored as typed, which is the behaviour it already had",
  );
  results.checks.push("uppercase HTTPS:// is fetched, not rejected");

  // ── 3. Prose that mentions a bare domain stays local ───────────────
  await openHome(page, origin);
  const PROSE =
    "浏览器怎么解析正文\n\n我昨天在 example.com 上读到一篇文章，讲的是先取回 HTML，" +
    "再挑出正文块，最后按段落切分。作者说，识别标题和列表比想象中难。";
  const proseId = await submitPaste(page, PROSE);
  assert.equal(
    results.jinaRequests.length,
    2,
    `prose must not be fetched; extraction requests: ${JSON.stringify(results.jinaRequests)}`,
  );
  assert.deepEqual(results.backendFallbacks, [], "prose must not reach the backend either");

  const proseArticle = (await storedArticles(page))[proseId];
  assert.equal(proseArticle.syncSource, "local");
  assert.equal(proseArticle.url, undefined, "a local article has no source URL");
  assert.ok(proseArticle.paragraphs.length > 0, "the prose must have been parsed locally");
  results.checks.push("prose mentioning a bare domain adds no request at all");

  // ── 4. The home box raised nothing, and nothing left this machine ───
  assert.deepEqual(
    results.pageErrors.filter((e) => e.onHome),
    [],
    "the import box must raise no errors while it is on screen",
  );
  assert.deepEqual(
    results.otherOffHost.map((r) => r.host).filter((h) => h !== "fonts.googleapis.com" && h !== "fonts.gstatic.com"),
    [],
    "only the app's own webfonts may leave 127.0.0.1",
  );
  results.checks.push(
    `no extraction, backend or other off-host traffic beyond webfonts (${results.otherOffHost.length} off-host request(s))`,
  );

  results.articles = Object.fromEntries(
    Object.entries(await storedArticles(page)).map(([key, value]) => [
      key,
      { url: value.url ?? null, syncSource: value.syncSource, title: value.title },
    ]),
  );
  assert.equal(
    Object.keys(results.articles).length,
    3,
    `three pastes must leave three articles: ${JSON.stringify(results.articles)}`,
  );
  results.pass = true;
  console.log(JSON.stringify(results, null, 2));
  const readerErrors = results.pageErrors.filter((e) => !e.onHome);
  console.log(
    `Import input browser gate: passed (${results.checks.length} checks, 0 home page errors` +
      `${readerErrors.length > 0 ? `, ${readerErrors.length} reader-route error(s) recorded but out of scope` : ""}).`,
  );
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) {
    const done = once(vite, "exit");
    vite.kill();
    await done;
  }
}
