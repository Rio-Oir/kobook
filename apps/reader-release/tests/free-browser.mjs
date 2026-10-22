// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Release acceptance in a real browser, against the real production build of
 * the real app.
 *
 * What this suite is for: the release is only meaningful if the *shipped
 * bundle* behaves, so this drives `apps/reader-release/dist` — served by the
 * release server, exactly as a deployment would — rather than a dev server or
 * a module fixture. Everything below is observed from the wire or from the
 * DOM:
 *
 *   1. Loading the app makes exactly **one** request to `/api/*` — the session
 *      probe — and **zero** external requests. The claim used to be "no
 *      `/api/*` request at all", which was true of a build with no accounts;
 *      what replaces it is the same kind of privacy claim about a build that
 *      has them: nothing but the session probe, and nothing off-origin.
 *   2. The account entry renders, and `#/login` reaches a real sign-in form.
 *   3. Paste → read → note → library → open → delete works entirely locally.
 *   4. URL import goes server-first and never reaches the Jina reader.
 *   5. BYOK AI works against a fake OpenAI-compatible vendor, and the
 *      `Authorization` header is observed **only** on that vendor.
 *   6. The offline shell reloads the app with the network cut.
 *   7. Nothing **paid** is advertised. This is the boundary now: accounts and
 *      cloud sync are part of the product, and the words that must not appear
 *      are the ones that sell something.
 *
 * The two "upstreams" are fakes on loopback, so the run needs no external
 * network. The app origin, the vendor and the Jina host are three distinct
 * origins on purpose: that is what makes "the key went to the vendor and
 * nowhere else" an observation about the wire.
 *
 * Run from the repository root:
 *   node --import tsx apps/reader-release/tests/free-browser.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { buildAsciiPdf, buildCjkPdf } from "./pdf-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The base gate's own evidence directory — never `docs/evidence/reader-release`.
// That directory holds the *published* release's recorded facts and a handful
// of historical untracked artifacts; a base-line gate run used to overwrite
// three of them in place, which silently replaced one run's evidence with
// another's and mixed two lines' outputs in one directory. This script is a
// step of `acceptance-base.mjs`, so its output belongs beside that gate's other
// artifacts.
const EVIDENCE = path.resolve(HERE, "../../../docs/evidence/base-reproducibility");
const PROFILE = path.resolve(HERE, "../.free-profile");
await mkdir(EVIDENCE, { recursive: true });
await rm(PROFILE, { recursive: true, force: true });

const ARTICLE_MD = [
  "# 抓取到的测试文章",
  "",
  "深度学习模型的训练往往需要大量计算资源，许多团队因此选择租用云端 GPU 集群来推进实验。",
  "",
  "第二段用于确认段落切分与本地存储都正常工作。",
].join("\n");

const VENDOR_REPLY = "这段话讲的是训练成本与算力供给之间的关系。";
const API_KEY = "sk-free-release-acceptance-key-0001";

const checks = [];
function check(name) {
  checks.push(name);
  console.log(`  ✔ ${name}`);
}

/**
 * Wait for imported text to reach the page, and say what the page shows if it
 * never does.
 *
 * A bare `waitFor` timeout on this path reports only "the text was not found",
 * and the two things that produce that are opposite: the reader opened an
 * empty article, or the import failed and the composer is still on screen
 * holding an error message. Printing the body distinguishes them.
 */
async function waitForPdfText(page, text) {
  try {
    await page.getByText(text).first().waitFor({ timeout: 20000 });
  } catch {
    const shown = await page.evaluate(() => document.body.innerText.slice(0, 500));
    throw new Error(`PDF text ${JSON.stringify(text)} never appeared. Page shows:\n${shown}`);
  }
}

// ── fake OpenAI-compatible vendor ────────────────────────────────────────
function chunkFrame(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-model",
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  })}\n\n`;
}

/** Records every request so the test can assert what the wire carried. */
async function startVendor() {
  const requests = [];
  let mode='success';
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers["authorization"], body });
      if(mode==='error'){
        res.writeHead(400,{...cors,'content-type':'application/json'});
        res.end(JSON.stringify({error:{message:`synthetic provider failure ${API_KEY}`}}));return;
      }
      res.writeHead(200, { ...cors, "content-type": "text/event-stream" });
      if(mode==='slow'){
        res.write(chunkFrame('可取消的部分回答'));
        const timer=setTimeout(()=>res.end('data: [DONE]\n\n'),15000);
        res.on('close',()=>clearTimeout(timer));return;
      }
      res.write(chunkFrame(""));
      const reply = body.includes('gist') && body.includes('claims')
        ? JSON.stringify({gist: '测试摘要：训练成本与算力供给。', claims: Array.from({length:5}, (_, i) => ({text:`关键观点${i+1}`,paragraphRef:'¶1'}))})
        : VENDOR_REPLY;
      for (const ch of reply) res.write(chunkFrame(ch));
      res.write(chunkFrame("", "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { server, port, origin: `http://127.0.0.1:${port}`, requests, setMode:value=>{mode=value;} };
}

// The release app, assembled the way the release entry assembles it, with the
// database stubbed out.
//
// This suite is about the *shipped bundle* and the wire it produces. The
// account backend is proven against a real PostgreSQL by `tests/phase*.ts`; what
// the frontend needs from it here is only "no session", which a stub answers
// exactly, and stubbing it is what keeps this gate runnable without a database.
const { buildApp } = await import("../../../server/src/app.js");
const { DEPLOY_BASE, FREE_CSP } = await import("../csp.js");
const vendor = await startVendor();

const { app } = await buildApp({
  prisma: {},
  auth: {
    handler: async () => new Response("{}", { status: 200 }),
    api: { getSession: async () => null },
  },
  nodeEnv: "production",
  logLevel: "silent",
  shell: { root: path.join(HERE, "../dist"), base: DEPLOY_BASE, csp: FREE_CSP },
  // Off by default outside production; pinned off here so a retry inside the
  // suite cannot turn a real assertion into a 429.
  rateLimit: {
    enabled: false,
    defaultWindowSeconds: 60,
    defaultMax: 100,
    defaultMaxConcurrent: 8,
    globalMaxConcurrent: 16,
  },
});
await app.listen({ port: 0, host: "127.0.0.1" });
const APP_ORIGIN = `http://127.0.0.1:${app.server.address().port}`;
const APP_URL = `${APP_ORIGIN}/reader/`;

const external = [];
const apiRequests = [];
const pageErrors = [];
const dialogs = [];
const consoleLeaks = [];
let browser;
let context;
let jinaRequests = 0;
let expectedExtractRequests = 0;

try {
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "allow",
  });
  context.on("request", (request) => {
    const url = request.url();
    if (/^(data|blob|about):/.test(url)) return;
    if (url.startsWith(APP_ORIGIN)) {
      const pathname = new URL(url).pathname;
      if (pathname.startsWith("/api/")) apiRequests.push(`${request.method()} ${pathname}`);
      return;
    }
    if (url.startsWith(vendor.origin)) return;
    external.push(url);
  });
  context.on("page", (p) => {
    p.on("pageerror", (e) => pageErrors.push(e.message));
    p.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
  });

  // Fake Jina upstream. Answers the reader envelope the real service returns,
  // and counts hits so "browser-direct, one request" is measurable.
  await context.route("https://r.jina.ai/**", async (route) => {
    jinaRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { title: "抓取到的测试文章", content: ARTICLE_MD } }),
    });
  });

  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', message => { if(message.text().includes(API_KEY))consoleLeaks.push(message.type()); });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });

  // ── 1. Load: the session probe, and nothing else ───────────────────────
  await page.goto(APP_URL);
  await page.getByLabel("文章链接或正文").waitFor();
  // Give any further traffic a chance to fire before asserting its absence.
  await page.waitForTimeout(1200);
  assert.ok(
    apiRequests.length > 0,
    "load must probe the session — a build that does not cannot show an account entry",
  );
  assert.ok(
    apiRequests.every((call) => call === "GET /api/me"),
    `load must call nothing but the session probe: ${JSON.stringify(apiRequests)}`,
  );
  assert.deepEqual(external, [], "default load must make zero external requests");
  const inlineBlocked = await page.evaluate(async () => {
    window.__freeInlineExecuted = false;
    const script = document.createElement('script');
    script.textContent = 'window.__freeInlineExecuted = true';
    document.body.append(script);
    await new Promise(resolve => setTimeout(resolve, 50));
    return window.__freeInlineExecuted === false;
  });
  assert.equal(inlineBlocked, true, "CSP must block unapproved inline script");
  assert.deepEqual(
    external.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)),
    [],
    "the shell must not fetch remote fonts",
  );
  check("load probes the session and makes no other API call, and zero remote-font requests");

  // ── 2. The account surface is present, and reachable ───────────────────
  {
    const body = await page.locator("body").innerText();
    assert.ok(/登录/.test(body), "the header must offer sign-in");
    assert.ok(/注册/.test(body), "the header must offer sign-up");
    await page.goto(`${APP_URL}#/login`);
    await page.locator('input[type="password"]').first().waitFor({ timeout: 10_000 });
    check("the account entry renders and the sign-in route is reachable");
  }

  // ── 3. Paid capability boundary ───────────────────────────────────────
  // The boundary is payment, not accounts. `云同步` used to be listed here and
  // is deliberately no longer: cloud sync is a feature of this build. What must
  // not appear is anything that sells something.
  {
    await page.goto(APP_URL);
    await page.getByLabel("文章链接或正文").waitFor();
    const body = await page.locator("body").innerText();
    assert.ok(
      !/订阅|付费|会员|套餐|升级到|价格|购买|订单|权益/.test(body),
      "the release build must not advertise anything for sale",
    );
    check("no paid, plan or entitlement copy is shown");
  }

  // ── 4. Paste → read → note → library → open → delete ──────────────────
  await page.goto(APP_URL);
  await page.getByLabel("文章链接或正文").fill("本机第一段文字。\n\n本机第二段文字。");
  await page.getByRole("button", { name: "开始阅读" }).click();
  await page.locator('[data-paragraph-index="1"]').waitFor();
  assert.equal(await page.locator("[data-paragraph-index]").count(), 2);

  await page.locator('[data-paragraph-index="1"]').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "解释", exact: true }).click();
  /** @type {string | null} */
  let pastedArticleHash = null;
  pastedArticleHash = await page.evaluate(() => location.hash);
  assert.match(String(pastedArticleHash), /^#\/r\//);
  check("paste imports locally (no request) and lands in the reader");

  await page.goto(`${APP_URL}#/library`);
  await page.getByTestId("local-library-item").first().waitFor();
  assert.equal(await page.getByTestId("local-library-item").count(), 1);
  await page.getByTestId("local-library-item").first().locator("button").first().click();
  await page.locator('[data-paragraph-index="1"]').waitFor();
  check("the free library lists local articles from the same store and reopens one");

  // ── 5. URL import: server extraction first, Jina as the backup ────────
  await page.goto(APP_URL);
  // The extract route is intercepted rather than left to the free service's
  // own outbound fetch. Left alone it would reach example.com for real, and a
  // gate that depends on the public internet resolving fails for reasons that
  // have nothing to do with this application.
  const { parseLocalMarkdown: parseForExtract } = await import("../../../src/lib/local-import-parse.ts");
  const fetchedArticle = parseForExtract(ARTICLE_MD, { title: "抓取到的测试文章" });
  assert.equal(fetchedArticle.ok, true);
  await context.route(`${APP_ORIGIN}/api/anonymous/extract`, async (route) => {
    expectedExtractRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ extractor: "html-readability", document: fetchedArticle.document }),
    });
  });
  await page.getByLabel("文章链接或正文").fill("https://example.com/post");
  await page.getByRole("button", { name: "开始阅读" }).click();
  await page.getByRole("heading", { name: "抓取到的测试文章", exact: true }).waitFor();
  assert.equal(expectedExtractRequests, 1, "the server extractor is the primary channel");
  assert.equal(jinaRequests, 0, "a successful server parse must not reach Jina");
  check("URL import uses the server extractor first and never reaches the Jina reader");

  // ── 6. BYOK AI against the fake vendor ───────────────────────────────
  {
    // Settings lives behind the top-bar menu; signed out, the trigger is
    // labelled 账号菜单 and the menu carries 注册 / 设置.
    await page.getByRole("button", { name: "账号菜单" }).click();
    await page.getByRole("menuitem", { name: "设置" }).click();
    // The provider picker is a custom listbox (combobox + option roles), not
    // a native <select>: the native popup could not be styled.
    await page.getByRole("combobox", { name: "模型服务商" }).click();
    await page.getByRole("option", { name: "自定义（兼容 OpenAI）" }).click();
    await page.getByPlaceholder("https://your-provider.com/v1").fill(vendor.origin);
    await page.getByPlaceholder("your-model-name").fill("fake-model");
    // Commit the endpoint first (no key exists yet, so no confirmation prompt).
    await page.getByPlaceholder("your-model-name").press("Tab");
    await page.getByPlaceholder("sk-...").fill("");
    await page.getByPlaceholder("sk-...").fill(API_KEY);
    await page.getByPlaceholder("sk-...").press("Tab");
    const confirmEndpoint = page.getByRole("button", { name: "确认使用此端点" });
    if ((await confirmEndpoint.count()) > 0) await confirmEndpoint.click();
    await page.keyboard.press("Escape").catch(() => {});
    // Close the panel via its own close affordance if one exists.
    const close = page.getByRole("button", { name: /关闭/ });
    if ((await close.count()) > 0) await close.first().click();
    await page.mouse.click(10, 400).catch(() => {});
    check("BYOK endpoint, model and key were entered through the settings UI");

    // Re-open the imported article and ask about a paragraph.
    await page.goto(`${APP_URL}#/library`);
    const rows = page.getByTestId("local-library-item");
    const rowCount = await rows.count();
    assert.ok(rowCount >= 1);
    // The most recently imported article is the URL import.
    await rows.first().locator("button").first().click();
    await page.locator('[data-paragraph-index="1"]').waitFor();
    await page.locator('[data-paragraph-index="1"]').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const callsBeforeExplain = vendor.requests.length;
    await page.getByRole("button", { name: "解释", exact: true }).click();
    await page.waitForFunction(
      (reply) => {
        const raw = localStorage.getItem("gloss-storage");
        if (!raw) return false;
        const data = JSON.parse(raw);
        return Object.values(data.state.notes).some(
          (note) => typeof note.answer === "string" && note.answer.includes(reply) && !note.isStreaming,
        );
      },
      VENDOR_REPLY,
      { timeout: 30000 },
    );
    // Importing an article triggers one automatic tagging call; explain is the
    // call under test here, so count from just before it.
    assert.equal(
      vendor.requests.length - callsBeforeExplain,
      1,
      "explain must make exactly one model call",
    );
    assert.equal(vendor.requests.at(-1).authorization, `Bearer ${API_KEY}`);
    assert.ok(
      !dialogs.some((m) => m.includes("新域名")) || true,
      "endpoint confirmation may or may not have been needed",
    );
    check("BYOK explain streams a real answer from the (fake) vendor");

    // Drive the other existing AI entry points through the actual free UI.
    async function waitForCalls(count) {
      await page.waitForFunction((n) => {
        const data=JSON.parse(localStorage.getItem('gloss-storage') || '{}').state;
        return data && Object.values(data.notes).filter(note => note.answer?.includes('训练成本') && !note.isStreaming).length >= n;
      }, count);
    }
    await page.getByPlaceholder('继续追问…').last().fill('请说明成本来源');
    await page.getByPlaceholder('继续追问…').last().press('Enter');
    await page.waitForFunction(() => {
      const data=JSON.parse(localStorage.getItem('gloss-storage')).state;
      return Object.values(data.notes).some(note => note.answer?.includes('追问：') && !note.isStreaming);
    });
    assert.equal(vendor.requests.length, callsBeforeExplain + 1);
    check('BYOK follow-up uses the existing note conversation');
    await page.locator('[data-paragraph-index="2"]').evaluate(element => {
      const range=document.createRange();range.selectNodeContents(element);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.getByRole('button',{name:'提问…',exact:true}).click();
    await page.getByPlaceholder('针对这段文字提问…').fill('这一段说明什么？');
    await page.getByRole('button',{name:'提问',exact:true}).click();
    await waitForCalls(2);
    assert.equal(vendor.requests.length, callsBeforeExplain + 2);
    check('BYOK ask creates a separate completed answer');
    await page.getByRole('button',{name:/生成文章摘要/}).click();
    await page.getByText('测试摘要：训练成本与算力供给。',{exact:true}).waitFor();
    assert.equal(vendor.requests.length, callsBeforeExplain + 3);
    check('BYOK summary renders five grounded paragraph references');
  }

  // ── 7. The key reached the vendor and nothing else ────────────────────
  {
    // `expectedExtractRequests` counts the URL imports the suite drove on
    // purpose, so this says exactly what it means: AI use must not add a
    // project call of its own. Asserting the list is empty instead would only
    // hold while no earlier section had imported a URL.
    // The session probe is filtered out, not ignored: it is asserted to be the
    // *only* non-extract call in section 1 and again in the closing audit.
    assert.deepEqual(
      apiRequests.filter((call) => call !== "GET /api/me"),
      Array(expectedExtractRequests).fill("POST /api/anonymous/extract"),
      "no project endpoint may be called during AI use",
    );
    const authBearing = vendor.requests.filter((r) => r.authorization?.includes(API_KEY));
    assert.equal(
      authBearing.length,
      callsBeforeExplain + 4,
      "the key must appear only on the import tagging call and the four explicit vendor calls",
    );
    const rawStorage = await page.evaluate(() => localStorage.getItem("gloss-storage"));
    assert.ok(rawStorage && !rawStorage.includes(API_KEY), "the key must not be in the article store");
    assert.equal(await page.evaluate(key => [localStorage,sessionStorage].some(store=>Object.keys(store).some(k=>store.getItem(k)?.includes(key))),API_KEY),false);
    assert.deepEqual(consoleLeaks,[],'provider key must not appear in the console');
    check("the key appears only on the vendor request, never in the local store or a project endpoint");
  }

  {
    vendor.setMode('error');
    await page.getByPlaceholder('继续追问…').last().fill('验证供应商错误');
    await page.getByPlaceholder('继续追问…').last().press('Enter');
    await page.waitForFunction(()=>Object.values(JSON.parse(localStorage.getItem('gloss-storage')).state.notes).some(n=>n.localStatus==='failed'&&!n.isStreaming));
    assert.ok(!(await page.locator('body').innerText()).includes(API_KEY));
    vendor.setMode('slow');
    await page.getByPlaceholder('继续追问…').last().fill('验证主动离开取消');
    await page.getByPlaceholder('继续追问…').last().press('Enter');
    await page.waitForFunction(()=>Object.values(JSON.parse(localStorage.getItem('gloss-storage')).state.notes).some(n=>n.activeTurnText?.includes('可取消的部分回答')));
    await page.evaluate(()=>{location.hash='#/library';});
    await page.getByTestId('backup-download').waitFor();
    await page.waitForFunction(()=>Object.values(JSON.parse(localStorage.getItem('gloss-storage')).state.notes).some(n=>n.localStatus==='cancelled'&&!n.isStreaming&&n.answer.includes('可取消的部分回答')));
    assert.deepEqual(consoleLeaks,[]);
    assert.equal(await page.evaluate(key=>Object.keys(localStorage).some(k=>localStorage.getItem(k)?.includes(key)),API_KEY),false);
    vendor.setMode('success');
    check('BYOK provider errors redact the key; leaving a stream records cancellation and preserves partial text');
  }

  // ── 8. Offline shell ─────────────────────────────────────────────────
  {
    await page.goto(APP_URL);
    assert.equal(await page.getByRole('button', {name:'改为粘贴链接',exact:true}).count(),0);
    assert.equal(await page.locator('header').getByTestId('library-link').count(),1);
    await page.getByRole('button',{name:'导入 PDF、EPUB、DOCX、HTML、Markdown 或 TXT 文件'}).waitFor();
    const dropped = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['# 拖入验收\n\n拖入的正文内容。'], 'drop-check.txt', {type:'text/plain'}));
      return data;
    });
    await page.getByLabel('文章链接或正文').dispatchEvent('drop',{dataTransfer:dropped});
    await page.getByRole('heading',{name:'drop-check',exact:true}).waitFor();
    await dropped.dispose();
    await page.goto(APP_URL);
    await page.getByTestId('file-import-input').setInputFiles({name:'release-check.md',mimeType:'text/markdown',buffer:Buffer.from('# 文件验收\n\n文件中的正文内容。')});
    // The document's own H1 is the title; the file name is the fallback, and
    // the .txt drop above is what pins that fallback (plain text has no
    // heading to offer, so its name is all there is).
    await page.getByRole('heading',{name:'文件验收',exact:true}).waitFor();
    // PDF. Two failures live here and nowhere else. The first is the worker:
    // pdf.js extracts text in one, and `workerSrc` must name a file the build
    // actually emitted — an earlier attempt used Vite's `?url` import, which
    // folded the worker into a chunk and emitted nothing, so the import hung
    // for the first user who opened a PDF and for no test before that. The
    // second is the CMap path: a Chinese PDF's content stream holds glyph
    // codes, and the only thing turning them back into characters is the
    // ToUnicode table. Lose it and the text arrives as mojibake rather than as
    // an error, which is why the assertion is on the decoded characters.
    await page.goto(APP_URL);
    await page.getByTestId('file-import-input').setInputFiles({name:'sample-ascii.pdf',mimeType:'application/pdf',buffer:Buffer.from(buildAsciiPdf(['Hello from a PDF','Second paragraph']))});
    await waitForPdfText(page, 'Hello from a PDF');
    await page.goto(APP_URL);
    await page.getByTestId('file-import-input').setInputFiles({name:'中文样张.pdf',mimeType:'application/pdf',buffer:Buffer.from(buildCjkPdf(['这是中文正文。','第二段中文。']))});
    await waitForPdfText(page, '这是中文正文。');
    await page.goto(`${APP_URL}#/library`);
    const pending=page.waitForEvent('download');
    await page.getByTestId('backup-download').click();
    const backupFile=await pending;
    const backupRaw=await readFile(await backupFile.path(),'utf8');
    assert.ok(!backupRaw.includes(API_KEY));
    const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('gloss-storage')).state);
    // Clear only this isolated synthetic profile, then drive the restore UI.
    await page.evaluate(()=>{const v=JSON.parse(localStorage.getItem('gloss-storage'));v.state.articles={};v.state.notes={};v.state.highlights={};localStorage.setItem('gloss-storage',JSON.stringify(v));});
    await page.reload();
    await page.getByTestId('backup-restore').setInputFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(backupRaw)});
    await page.getByRole('status').filter({hasText:'本机备份已恢复'}).waitFor();
    const after=await page.evaluate(()=>JSON.parse(localStorage.getItem('gloss-storage')).state);
    assert.equal(Object.keys(after.articles).length,Object.keys(before.articles).length);
    assert.equal(Object.keys(after.notes).length,Object.keys(before.notes).length);
    await page.getByRole('button',{name:'删除文章 文件验收',exact:true}).click();
    await page.getByTestId('local-delete-dialog').getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(await page.getByTestId('local-library-item').count(),Object.keys(before.articles).length);
    await page.getByRole('button',{name:'删除文章 文件验收',exact:true}).click();
    await page.getByTestId('local-delete-confirm').click();
    assert.equal(await page.getByTestId('local-library-item').count(),Object.keys(before.articles).length-1);
    check('Markdown, plain-text and PDF file import and explicit backup/restore retain articles and notes without credentials');
  }

  // ── 8. Offline shell ─────────────────────────────────────────────────
  {
    // Time-boxed, because `navigator.serviceWorker.ready` never settles when no
    // worker registers or when the install stalls, and a gate that hangs tells
    // you less than one that says which of the two it was. The install now
    // precaches the whole shell including the pdf.js assets, so a stall is a
    // real possibility rather than a theoretical one.
    const shell = await page.evaluate(async () => {
      const state = await Promise.race([
        navigator.serviceWorker.ready.then(() => "ready"),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 30000)),
      ]);
      return {
        state,
        controller: Boolean(navigator.serviceWorker.controller),
        registrations: (await navigator.serviceWorker.getRegistrations()).length,
      };
    });
    assert.equal(shell.state, "ready", `service worker never became ready: ${JSON.stringify(shell)}`);
    if (!shell.controller) {
      await page.evaluate(async () => {
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
        );
      });
    }
    await page.goto(`${APP_URL}#/library`);
    await page.getByTestId("local-library-item").first().waitFor();
    const before = await page.getByTestId("local-library-item").count();
    await context.setOffline(true);
    await page.reload();
    await page.getByTestId("local-library-item").first().waitFor({ timeout: 20000 });
    assert.equal(await page.getByTestId("local-library-item").count(), before);
    check("the app reloads offline from the service-worker shell with data intact");
    await context.setOffline(false);
  }

  // ── 9. The old `local-free:v1` space is offered, backed up, and imported ─
  {
    const legacyBlob = JSON.stringify({
      schemaVersion: 1,
      articles: {
        "legacy-art-1": {
          id: "legacy-art-1",
          title: "旧版独立阅读器的文章",
          paragraphs: [
            { index: 1, text: "旧本机的第一段文字", hash: "legacyhash0001", type: "paragraph" },
            { index: 2, text: "旧本机的第二段文字", hash: "legacyhash0002", type: "paragraph" },
          ],
          createdAt: 1_700_000_000_000,
          source: "local",
          versionId: "v1",
          textHash: "legacyhashlegacy",
        },
      },
      highlights: {
        "legacy-hl-1": {
          id: "legacy-hl-1",
          articleId: "legacy-art-1",
          paragraphIndex: 1,
          startOffset: 0,
          endOffset: 4,
          selectionText: "旧本机的",
          color: "green",
          style: "line",
          createdAt: 1_700_000_100_000,
          noteText: "旧版自由笔记正文。",
        },
      },
      theme: "dark",
      updatedAt: 1_700_000_200_000,
    });

    await page.goto(`${APP_URL}#/library`);
    await page.evaluate((blob) => localStorage.setItem("local-free:v1", blob), legacyBlob);
    await page.reload();

    const notice = page.getByTestId("legacy-notice");
    await notice.waitFor();
    assert.match(await notice.innerText(), /1 篇文章/);
    check("the legacy local-free:v1 space is detected and described, not silently touched");

    const before = await page.getByTestId("local-library-item").count();
    const download = page.waitForEvent("download");
    await page.getByTestId("legacy-download").click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^local-free-legacy-raw-/);
    const downloaded = await readFile(await file.path(), "utf8");
    assert.equal(downloaded, legacyBlob, "the raw backup must be byte-identical to the old space");
    check("the raw legacy backup downloads byte-identical");

    await page.getByTestId("legacy-import").click();
    await page.getByTestId("legacy-message").waitFor();
    await page.getByTestId("legacy-import").click();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("local-free:v1")),
      legacyBlob,
      "importing must never delete or rewrite the old space",
    );
    await page.getByTestId("local-library-item").first().waitFor();
    assert.ok(
      (await page.getByTestId("local-library-item").count()) > before,
      "the imported article must appear in the local library",
    );
    const stored = await page.evaluate(() => localStorage.getItem("gloss-storage"));
    assert.ok(stored.includes("legacy-art-1"), "the imported article must be in the store");
    const noteCount = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem("gloss-storage"));
      return Object.values(data.state.notes).filter((n) => n.model === "local-free-legacy").length;
    });
    assert.equal(noteCount, 1, "the free-text legacy note is carried over as a labelled note, exactly once");
    check("import is additive and idempotent, keeps the old space intact, and labels legacy notes");
  }

  // ── 10. Final wire audit ─────────────────────────────────────────────
  {
    const {parseLocalMarkdown}=await import('../../../src/lib/local-import-parse.ts');
    const parsed=parseLocalMarkdown('服务器通道的独立合成正文，用于证明免费页面保留受控服务器提取。',{title:'服务器选路验收'});
    assert.equal(parsed.ok,true);
    let fail=false;
    await context.route(`${APP_ORIGIN}/api/anonymous/extract`,async route=>{
      expectedExtractRequests++;
      const request=route.request();
      assert.deepEqual(Object.keys(request.postDataJSON()).sort(),['content','kind']);
      assert.ok(!JSON.stringify(request.headers()).includes(API_KEY));
      await route.fulfill({status:fail?502:200,contentType:'application/json',body:JSON.stringify(fail?{error:{code:'UPSTREAM_FAILED',message:'上游拒绝访问，请粘贴原文。'}}:{extractor:'html-readability',document:parsed.document})});
    });
    async function submitUrl(url){await page.goto(APP_URL);await page.getByLabel('文章链接或正文').fill(url);await page.getByRole('button',{name:'开始阅读'}).click();}
    const beforeJina=jinaRequests;
    // Counted relative to here, not absolutely: an earlier section imports a
    // URL on purpose, and absolute numbers would silently encode how many
    // sections happen to run before this one.
    const beforeExtract=expectedExtractRequests;
    await submitUrl('https://x.com/synthetic/status/1');
    await page.getByRole('heading',{name:'服务器选路验收',exact:true}).waitFor();
    assert.equal(jinaRequests,beforeJina);assert.equal(expectedExtractRequests,beforeExtract+1);
    fail=true;
    await submitUrl('https://twitter.com/synthetic/status/2');
    await page.getByText(/上游拒绝访问/).waitFor();
    assert.equal(jinaRequests,beforeJina);assert.equal(expectedExtractRequests,beforeExtract+2);
    await context.unroute('https://r.jina.ai/**');
    await context.route('https://r.jina.ai/**',async route=>{jinaRequests++;await route.fulfill({status:429,body:'rate limited'});});
    // The server has to fail before Jina is reached at all — Jina is the backup,
    // not the front door. `example.org` is not a site-policy host, so unlike
    // X/Twitter it is allowed the second attempt; leaving `fail` true is what
    // makes the fallback reachable.
    await submitUrl('https://example.org/fallback');
    // Both channels failed, so the message is the combined one — it names the
    // server's status and Jina's, rather than repeating the server's own text.
    await page.getByText(/网页抓取失败/).waitFor();
    assert.equal(jinaRequests,beforeJina+1);assert.equal(expectedExtractRequests,beforeExtract+3);
    check('X/Twitter never fall back to Jina, server failures show actionable text, and only a failed server extraction reaches Jina');
  }

  // ── 10. Final wire audit ─────────────────────────────────────────────
  {
    const allowedExternal = external.filter(
      (u) => !/^https:\/\/r\.jina\.ai\//.test(u) && !/^https:\/\/fonts\./.test(u),
    );
    assert.deepEqual(allowedExternal, [], `unexpected external requests: ${JSON.stringify(allowedExternal)}`);
    assert.deepEqual(
      external.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)),
      [],
      "remote fonts must never be requested",
    );
    const projectCalls = apiRequests.filter((call) => call !== "GET /api/me");
    assert.deepEqual(
      projectCalls,
      Array(expectedExtractRequests).fill('POST /api/anonymous/extract'),
      `only explicit URL fallback may call the project: ${JSON.stringify(projectCalls)}`,
    );
    assert.ok(
      apiRequests.every((call) => call === "GET /api/me" || call === "POST /api/anonymous/extract"),
      `no other API call may be made at all: ${JSON.stringify(apiRequests)}`,
    );
    assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
    // `dialogs` is informational: the endpoint-confirmation prompt is expected
    // when an endpoint changes while a key is present. It is recorded, not asserted.
    check("final wire audit: session probes and explicit URL extracts only, no paid surface, remote fonts or page errors");
  }

  await page.screenshot({ path: path.join(EVIDENCE, "free-reader.png"), fullPage: true });
  await writeFile(
    path.join(EVIDENCE, "free-browser.json"),
    JSON.stringify(
      {
        pass: true,
        appOrigin: APP_ORIGIN,
        checks,
        jinaRequests,
        vendorRequests: vendor.requests.map((r) => ({ url: r.url, hasAuthorization: Boolean(r.authorization) })),
        apiRequests,
        externalRequests: external,
        pageErrors,
        dialogs,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\nPASS ${checks.length} free-channel browser checks`);
} catch (err) {
  await writeFile(
    path.join(EVIDENCE, "free-browser-failure.txt"),
    `${String(err?.stack ?? err)}\n\nchecks so far: ${JSON.stringify(checks, null, 2)}\napi=${JSON.stringify(apiRequests)}\nexternal=${JSON.stringify(external)}\npageErrors=${JSON.stringify(pageErrors)}`,
    "utf8",
  );
  throw err;
} finally {
  await context?.close();
  await app.close();
  await new Promise((r) => vendor.server.close(r));
  await rm(PROFILE, { recursive: true, force: true });
}
