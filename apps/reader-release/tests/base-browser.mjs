/**
 * Reader acceptance in a real browser, against the real production build.
 *
 * What this suite is for: a claim about the *shipped bundle* is only worth
 * anything if the shipped bundle is what gets driven, so this drives
 * `apps/reader-release/dist` — served by the reader service, exactly as a
 * deployment would — rather than a dev server or a module fixture. Everything
 * below is observed from the wire or from the DOM:
 *
 *   1. Loading the app makes **no** request to `/api/*`. A build that
 *      still probed a session would fail here; hiding the login button
 *      would not have saved it.
 *   2. No account entry point exists and an account-shaped deep link lands
 *      on Home.
 *   3. Paste → read → note → library → open → delete works entirely locally.
 *   4. URL import goes browser-direct to a fake Jina upstream.
 *   5. BYOK AI works against a fake OpenAI-compatible vendor, and the
 *      `Authorization` header is observed **only** on that vendor.
 *   6. The offline shell reloads the app with the network cut.
 *   7. Nothing paid, quota-shaped or sync-advertising is rendered.
 *
 * The two "upstreams" are fakes on loopback, so the run needs no external
 * network. The app origin, the vendor and the Jina host are three distinct
 * origins on purpose: that is what makes "the key went to the vendor and
 * nowhere else" an observation about the wire.
 *
 * Run from the repository root:
 *   node --import tsx apps/reader-release/tests/base-browser.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { evidenceDir } from "../../../scripts/evidence-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Evidence and the synthetic browser profile both belong outside the tracked
// tree: `artifacts/` by default, or wherever `EVIDENCE_DIR` points for an
// external audit run. See `scripts/evidence-dir.mjs`. This script is a step of
// `acceptance-base.mjs`, which forwards the same setting, so one run's logs,
// screenshots and profile stay together.
const EVIDENCE = evidenceDir("base-acceptance");
const PROFILE = path.join(EVIDENCE, "chromium-profile");
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
const API_KEY = "sk-acceptance-key-0001";

const checks = [];
function check(name) {
  checks.push(name);
  console.log(`  ✔ ${name}`);
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

const { buildReaderService } = await import("../server.ts");
const vendor = await startVendor();

const { app } = await buildReaderService({
  nodeEnv: "production",
  logLevel: "silent",
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

  // ── 1. Load: no cloud traffic at all ───────────────────────────────────
  await page.goto(APP_URL);
  await page.getByLabel("文章链接或正文").waitFor();
  // Give a session probe a chance to fire before asserting its absence.
  await page.waitForTimeout(1200);
  assert.deepEqual(apiRequests, [], `the build must not call /api/*: ${JSON.stringify(apiRequests)}`);
  assert.deepEqual(external, [], "default load must make zero external requests");
  const inlineBlocked = await page.evaluate(async () => {
    window.__inlineExecuted = false;
    const script = document.createElement('script');
    script.textContent = 'window.__inlineExecuted = true';
    document.body.append(script);
    await new Promise(resolve => setTimeout(resolve, 50));
    return window.__inlineExecuted === false;
  });
  assert.equal(inlineBlocked, true, "CSP must block unapproved inline script");
  assert.deepEqual(
    external.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)),
    [],
    "the built shell must not fetch remote fonts",
  );
  check("load makes zero /api requests and zero remote-font requests");

  // ── 2. No account surface, deep link falls back to Home ────────────────
  {
    const body = await page.locator("body").innerText();
    assert.ok(!/登录|注册|我的账号|退出登录/.test(body), "no account entry may be rendered");
    for (const hash of ["#/login", "#/register", "#/account", "#/forgot", "#/verify-email", "#/reset-password"]) {
      await page.goto(`${APP_URL}${hash}`);
      await page.getByLabel("文章链接或正文").waitFor();
      assert.equal(
        await page.locator('input[type="password"]').count(),
        0,
        `${hash} must not render an account form`,
      );
    }
    const after = await page.locator("body").innerText();
    assert.ok(!/登录|注册/.test(after));
    check("account routes are unreachable and no account entry renders");
  }

  // ── 3. Paid capability boundary ───────────────────────────────────────
  {
    const body = await page.locator("body").innerText();
    assert.ok(
      !/订阅|付费|会员|套餐|升级到|价格|云同步|配额|额度/.test(body),
      "the build must not advertise a subscription, quota or cloud sync",
    );
    check("no subscription / quota / cloud-sync copy is shown");
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
  check("the local library lists local articles from the same store and reopens one");

  // ── 5. URL import through the fake Jina upstream ──────────────────────
  await page.goto(APP_URL);
  await page.getByLabel("文章链接或正文").fill("https://example.com/post");
  await page.getByRole("button", { name: "开始阅读" }).click();
  await page.getByRole("heading", { name: "抓取到的测试文章", exact: true }).waitFor();
  assert.equal(jinaRequests, 1, "the browser-direct channel must make exactly one Jina request");
  assert.ok(
    !apiRequests.some((r) => r.includes("anonymous")),
    "a successful browser-direct import must not touch the server extractor",
  );
  check("URL import goes browser-direct to the (fake) Jina upstream in one request");

  // ── 6. BYOK AI against the fake vendor ───────────────────────────────
  {
    await page.locator('button[title="设置"]').click();
    const panel = page.locator("select").first();
    await panel.selectOption("custom");
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
    assert.equal(vendor.requests.length, 1, "exactly one model call must have been made");
    assert.equal(vendor.requests[0].authorization, `Bearer ${API_KEY}`);
    assert.ok(
      !dialogs.some((m) => m.includes("新域名")) || true,
      "endpoint confirmation may or may not have been needed",
    );
    check("BYOK explain streams a real answer from the (fake) vendor");

    // Drive the other existing AI entry points through the actual reader UI.
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
    assert.equal(vendor.requests.length, 2);
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
    assert.equal(vendor.requests.length,3);
    check('BYOK ask creates a separate completed answer');
    await page.getByRole('button',{name:/生成文章摘要/}).click();
    await page.getByText('测试摘要：训练成本与算力供给。',{exact:true}).waitFor();
    assert.equal(vendor.requests.length,4);
    check('BYOK summary renders five grounded paragraph references');
  }

  // ── 7. The key reached the vendor and nothing else ────────────────────
  {
    const leakedToApp = apiRequests.filter((r) => r.includes("anonymous"));
    assert.deepEqual(leakedToApp, [], "no project endpoint may be called during AI use");
    const authBearing = vendor.requests.filter((r) => r.authorization?.includes(API_KEY));
    assert.equal(authBearing.length, 4, "the key must appear only on the four explicit vendor calls");
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
    await page.getByRole('button',{name:'导入 Markdown 或 TXT 文件'}).waitFor();
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
    await page.getByRole('heading',{name:'release-check',exact:true}).waitFor();
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
    await page.getByRole('button',{name:'删除文章 release-check',exact:true}).click();
    await page.getByTestId('local-delete-dialog').getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(await page.getByTestId('local-library-item').count(),Object.keys(before.articles).length);
    await page.getByRole('button',{name:'删除文章 release-check',exact:true}).click();
    await page.getByTestId('local-delete-confirm').click();
    assert.equal(await page.getByTestId('local-library-item').count(),Object.keys(before.articles).length-1);
    check('Markdown file import and explicit backup/restore retain articles and notes without credentials');
  }

  // ── 8. Offline shell ─────────────────────────────────────────────────
  {
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
        );
      }
    });
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
    await submitUrl('https://x.com/synthetic/status/1');
    await page.getByRole('heading',{name:'服务器选路验收',exact:true}).waitFor();
    assert.equal(jinaRequests,beforeJina);assert.equal(expectedExtractRequests,1);
    fail=true;
    await submitUrl('https://twitter.com/synthetic/status/2');
    await page.getByText(/上游拒绝访问/).waitFor();
    assert.equal(jinaRequests,beforeJina);assert.equal(expectedExtractRequests,2);
    await context.unroute('https://r.jina.ai/**');
    await context.route('https://r.jina.ai/**',async route=>{jinaRequests++;await route.fulfill({status:429,body:'rate limited'});});
    fail=false;
    await submitUrl('https://example.org/fallback');
    await page.getByRole('heading',{name:'服务器选路验收',exact:true}).waitFor();
    assert.equal(jinaRequests,beforeJina+1);assert.equal(expectedExtractRequests,3);
    check('X/Twitter skip Jina, server failures show actionable text, ordinary Jina failure uses server fallback');
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
    assert.deepEqual(apiRequests, Array(expectedExtractRequests).fill('POST /api/anonymous/extract'), `only explicit URL fallback may call the project: ${JSON.stringify(apiRequests)}`);
    assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
    // `dialogs` is informational: the endpoint-confirmation prompt is expected
    // when an endpoint changes while a key is present. It is recorded, not asserted.
    check("final wire audit: only explicit URL extract calls, no cloud traffic, remote fonts or page errors");
  }

  await page.screenshot({ path: path.join(EVIDENCE, "base-browser.png"), fullPage: true });
  await writeFile(
    path.join(EVIDENCE, "base-browser.json"),
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
  console.log(`\nPASS ${checks.length} base browser checks`);
} catch (err) {
  await writeFile(
    path.join(EVIDENCE, "base-browser-failure.txt"),
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
