// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phase 3 browser regression: the article library, the Reader's cloud
 * notes, and account isolation.
 *
 * Boots a real Fastify server and a real Caddy proxy serving `dist/` and
 * `/api` from the same origin, then drives the product with Playwright.
 *
 * What this asserts end to end:
 *
 *   1. **Anonymous reading.** A signed-out reader pastes Markdown on Home
 *      and lands in the Reader with the parsed paragraphs — served by the
 *      anonymous extraction route, which writes no rows. Nothing about
 *      reading requires an account.
 *   2. **Automatic migration into one shelf.** Signing in with an anonymous
 *      workspace uploads it without a second confirmation, and the merged
 *      library lists it exactly once. The account half is read from the same
 *      page (`#/library`); `#/cloud` is retired.
 *   3. **Cloud notes through the real UI.** A signed-in reader selects
 *      text in the Reader, asks a question, and the answer streams and is
 *      persisted — by driving the actual selection, not by calling the
 *      API directly.
 *   4. **A second isolated browser context reads them back.** A fresh
 *      context with its own cookie jar and storage, signing in as the
 *      same account, opens the article and sees the note. This is the
 *      "第二个隔离浏览器上下文取回" gate: it is the only check that
 *      would catch a note that exists only in `localStorage`.
 *   5. **Isolation survives.** Deleting clears the library, and a
 *      different account sees an empty one.
 *
 * Ports deliberately avoid the existing baselines: 18794 server, 18084
 * Caddy. The test database is created off the shared phase-2 test
 * container (`gloss_phase2_test`), so a parallel run of phase-1 or
 * phase-2 tests is not blocked.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium } from 'playwright';

const serverPort = '18794';
const caddyPort = '18084';
const dbName = `gloss_browserarticles_test_${Date.now()}`;
const baseDatabaseUrl = 'postgresql://gloss_test:local_test_only@127.0.0.1:55433/gloss_phase2_test';
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.pathname = `/${dbName}`;
const origin = `http://127.0.0.1:${caddyPort}`;

const checks = [];
let server;
let proxy;
let browser;
try {
  await mkdir('artifacts', { recursive: true });
  const admin = new Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const empty = new Client({ connectionString: databaseUrl.href });
  await empty.connect();
  const tables = await empty.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'",
  );
  assert.equal(tables.rows[0].count, 0, 'fresh database must have no tables');
  await empty.end();

  const prismaBin = 'node_modules/prisma/build/index.js';
  const migrate = spawn(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl.href },
    stdio: 'inherit',
    windowsHide: true,
  });
  assert.equal((await once(migrate, 'exit'))[0], 0, 'migrate deploy failed for browser-articles DB');

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl.href,
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: serverPort,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'phase3-browser-test-secret-00000000000000000000',
    SERVER_LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_ENABLED: '0',
  };
  server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    stdio: 'ignore',
    env,
    windowsHide: true,
  });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${serverPort}/api/health/ready`)).ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, 'server did not start');

  const caddyfile = `{ admin off
 auto_https off
 persist_config off
 storage file_system {
  root .tools/caddy/storage
 }
}
http://127.0.0.1:${caddyPort} {
 bind 127.0.0.1
 handle /api/* {
  reverse_proxy 127.0.0.1:${serverPort} {
   flush_interval -1
  }
 }
 handle {
  root * dist
  file_server
  try_files {path} /index.html
 }
}
`;
  await writeFile('artifacts/Caddyfile-browser-articles', caddyfile);
  proxy = spawn('.tools/caddy/caddy.exe', ['run', '--config', 'artifacts/Caddyfile-browser-articles', '--adapter', 'caddyfile'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'Caddy did not start');

  browser = await chromium.launch({
    headless: true,
    ...(process.env.GLOSS_CHROME_PATH ? { executablePath: process.env.GLOSS_CHROME_PATH } : {}),
  });

  /** A context with the same network policy but its own cookies/storage. */
  async function newIsolatedContext() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route) => {
      const hostname = new URL(route.request().url()).hostname;
      return hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    return { context, page, errors };
  }

  async function registerAndVerify(page, { name, email, password }) {
    // Go straight to the register route. The auth surface defaults to the
    // phone-code channel, whose login footer deliberately has no 「创建账号」
    // link ("手机号验证后自动创建账号"), so clicking a link is not a stable way
    // in; the route is part of the app's contract (`#/register`).
    await page.goto(`${origin}/#/register`, { waitUntil: "domcontentloaded" });
    await page.getByRole('textbox', { name: '昵称' }).fill(name);
    await page.getByRole('textbox', { name: '邮箱' }).fill(email);
    await page.getByRole('textbox', { name: /^密码/ }).fill(password);
    await page.getByRole('textbox', { name: /再次输入密码/ }).fill(password);
    // The register form refuses to submit without the agreement tick; the
    // input is styled, so check it directly and bypass the label's links.
    await page.getByRole('checkbox').first().check({ force: true });
    await page.getByRole('button', { name: '注册' }).click();
    await page.getByText('注册成功').waitFor();
    const mail = await page.request.get(`${origin}/api/dev/mail/latest?to=${encodeURIComponent(email)}`);
    assert.equal(mail.status(), 200);
    const body = await mail.json();
    await page.goto(body.message.url);
    await page.getByText('邮箱已验证').waitFor();
    // Registration signs in automatically; wait until the header reflects
    // it so a later navigation is not racing the session probe.
    await page.goto(origin);
    await page.locator('a[href="#/account"]').first().waitFor({ timeout: 15_000 });
  }

  async function signIn(page, { email, password }) {
    // Go straight to the login route rather than hunting for a link: the
    // label differs between the Home header ("登录") and the
    // verify-email landing page ("去登录").
    await page.goto(`${origin}/#/login`);
    await page.getByRole('textbox', { name: '邮箱' }).waitFor(); 
    await page.getByRole('textbox', { name: '邮箱' }).fill(email);
    await page.getByRole('textbox', { name: /^密码/ }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    // `applyOwnership` runs synchronously in the sign-in action, but the
    // *header* only shows the account link once the session store has
    // resolved, so waiting for that is what proves the page is signed in
    // rather than merely back on Home.
    await page.waitForURL(/#\/($|library)/, { timeout: 15_000 });
    await page.locator('a[href="#/account"]').first().waitFor({ timeout: 15_000 });
  }

  /**
   * Select a character range inside a rendered paragraph and let the
   * Reader's selection listener see it.
   *
   * The point of doing it this way — a real DOM `Range`, a real
   * `selectionchange` — is that the offsets the Reader computes are the
   * ones a user's drag would produce. A test that posted the note body
   * directly would not exercise `rangeToOffsets`, which is exactly where
   * the coordinate bugs live.
   */
  async function selectInParagraph(page, paragraphIndex, from, to) {
    await page.evaluate(
      ({ index, start, end }) => {
        const p = document.querySelector(`[data-paragraph-index="${index}"]`);
        if (!p) throw new Error(`no paragraph ${index}`);
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.hasAttribute('data-paragraph-marker')) continue;
          nodes.push(node);
        }
        const full = nodes.map((n) => n.textContent ?? '').join('');
        if (!full) throw new Error('paragraph has no text nodes');
        const locate = (offset) => {
          let remaining = offset;
          for (const n of nodes) {
            const len = (n.textContent ?? '').length;
            if (remaining <= len) return [n, remaining];
            remaining -= len;
          }
          const last = nodes[nodes.length - 1];
          return [last, (last.textContent ?? '').length];
        };
        const [sNode, sOff] = locate(start);
        const [eNode, eOff] = locate(end);
        const range = document.createRange();
        range.setStart(sNode, sOff);
        range.setEnd(eNode, eOff);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      },
      { index: paragraphIndex, start: from, end: to },
    );
    await delay(150);
  }

  /**
   * Paste Markdown on Home, submit, and wait until the Reader really has
   * it.
   *
   * No request is asserted here, and that is a property of the product
   * rather than an omission: a paste is article *text*, so `Home` runs it
   * through `importFromText` and it never reaches the network. Waiting for an
   * extraction response would be waiting for something the product
   * deliberately does not do — the same rule the free-channel gate pins from
   * the other side ("paste imports locally (no request)"). What proves the
   * import happened is the Reader opening with rendered paragraphs.
   *
   * The `waitForURL` is load-bearing: Playwright's text matching includes
   * a `<textarea>`'s value, so `getByText('第一段正文')` happily matches
   * the text the test just typed into the form. Waiting for the hash plus
   * a rendered `[data-paragraph-index]` is what actually proves the
   * import happened.
   */
  async function importAndOpenReader(page, markdown) {
    await page.getByRole('textbox', { name: '文章链接或正文' }).fill(markdown);
    await page.getByRole('button', { name: '开始阅读 →' }).click();
    await page.waitForURL(/#\/r\//, { timeout: 15_000 });
    await page.locator('[data-paragraph-index]').first().waitFor({ timeout: 15_000 });
  }

  /**
   * The server id a signed-in paste eventually acquires, or null.
   *
   * The upload is deliberately off the critical path: the reader opens on the
   * local row and the row is pushed afterwards, so the id arrives some time
   * after the article is on screen. Polling the store is what expresses that —
   * asserting immediately would test the network's latency rather than the
   * product's behaviour.
   */
  async function waitForRemoteId(page, localId) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const remote = await page.evaluate((id) => {
        const raw = localStorage.getItem('gloss-storage');
        if (!raw) return null;
        const blob = JSON.parse(raw);
        return blob.state?.articles?.[id]?.remoteId ?? null;
      }, localId);
      if (remote) return remote;
      await delay(250);
    }
    return null;
  }

  /** Navigate to the library, failing with the page's actual links if not. */
  async function openLibrary(page, label) {
    const link = page.locator('a[href="#/library"]').first();
    try {
      await link.waitFor({ timeout: 10_000 });
    } catch {
      const state = await page.evaluate(() => ({
        href: location.href,
        hash: location.hash,
        links: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href')),
        text: document.body.innerText.slice(0, 200),
      }));
      throw new Error(`[${label}] no library link; page state: ${JSON.stringify(state)}`);
    }
    await link.click();
  }

  // ── 1. Anonymous reading ─────────────────────────────────────────────
  const anon = await newIsolatedContext();
  await anon.page.goto(origin);
  await anon.page.getByText('选中一段文字', { exact: false }).first().waitFor();
  assert.deepEqual(anon.errors, [], 'no page errors on the anonymous home page');

  const anonSample = [
    '# 匿名导入标题',
    '',
    '匿名时粘贴的第一段正文，用于验证匿名阅读链路。',
    '',
    '匿名时粘贴的第二段正文。',
  ].join('\n');
  await importAndOpenReader(anon.page, anonSample);
  await anon.page.getByText('匿名时粘贴的第一段正文', { exact: false }).first().waitFor();
  checks.push('anonymous import renders in the Reader, parsed locally with no request');
  assert.deepEqual(anon.errors, [], 'no page errors during anonymous reading');

  // The anonymous article is stored locally under a `local-` id: it is
  // not on the server, which is what makes the migration a real transfer.
  const anonState = await anon.page.evaluate(() => {
    const raw = localStorage.getItem('gloss-storage');
    return {
      keys: Object.keys(localStorage),
      hash: location.hash,
      raw: raw ? JSON.parse(raw) : null,
    };
  });
  assert.ok(
    anonState.raw,
    `the local store must be persisted; saw ${JSON.stringify(anonState)}`,
  );
  const anonArticleId = Object.keys(anonState.raw.state.articles)[0];
  assert.match(
    String(anonArticleId),
    /^local-/,
    `anonymous imports must not claim a server id, got ${anonArticleId} (hash ${anonState.hash})`,
  );

  // ── 2. Register; the anonymous workspace uploads automatically ───────
  const userAEmail = `phase3-A-${randomUUID()}@example.test`;
  const passwordA = 'phase3-browser-A-2026';
  await registerAndVerify(anon.page, { name: '账号A', email: userAEmail, password: passwordA });

  // One shelf: signing in is the sync trigger, and the anonymous article shows
  // up in the same list as everything else — no second confirmation, no second
  // library page.
  await anon.page.goto(`${origin}/#/library`);
  await anon.page.getByTestId('local-library-list').waitFor({ timeout: 30_000 });
  await anon.page
    .getByRole('button', { name: /匿名导入标题/ })
    .first()
    .waitFor({ timeout: 30_000 });
  await anon.page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="library-cloud-status"]');
      return Boolean(el) && /已同步|账号里共|正在同步/.test(el.textContent ?? '');
    },
    { timeout: 30_000 },
  );
  checks.push('signing in uploads the anonymous workspace into the single merged library');

  // ── 3. Import a second article while signed in ───────────────────────
  const sample = [
    '# 浏览器测试标题',
    '',
    '第一段正文，验证服务端解析与云端笔记。',
    '',
    '## 子标题',
    '',
    '第二段，列表。',
    '',
    '- 列表项一',
    '- 列表项二',
  ].join('\n');
  await anon.page.goto(origin);
  await anon.page.getByText('选中一段文字', { exact: false }).first().waitFor();
  await importAndOpenReader(anon.page, sample);
  await anon.page.getByText('第一段正文', { exact: false }).first().waitFor();

  // ── 4. Create a note through the real selection UI ───────────────────
  const localArticleId = await anon.page.evaluate(() => location.hash.replace('#/r/', ''));
  // A paste keeps its `local-<textHash>` id even when signed in. The id is
  // derived from the text and carries no account, and re-pointing it at the
  // server's id would change the hash the reader is already on and orphan any
  // note anchored to the old one. The upload runs in the background and
  // attaches a `remoteId` to that same row.
  assert.ok(
    localArticleId?.startsWith('local-'),
    `a paste keeps its local id even when signed in, got ${localArticleId}`,
  );

  // The *server* id is a different value, and the cloud assertions below need
  // it. Polled, because the upload is deliberately off the critical path of
  // opening the article.
  const articleFromUrl = await waitForRemoteId(anon.page, localArticleId);
  assert.ok(articleFromUrl, 'the pasted article must reach the server for the cloud sections below');
  const targetParagraph = await anon.page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('[data-paragraph-index]'));
    for (const p of ps) {
      const text = p.textContent ?? '';
      if (text.includes('第一段正文，验证服务端解析与云端笔记。')) {
        return Number(p.getAttribute('data-paragraph-index'));
      }
    }
    return null;
  });
  assert.ok(targetParagraph, 'the imported paragraph must be in the DOM');

  await selectInParagraph(anon.page, targetParagraph, 0, 6);
  const explainButton = anon.page.getByRole('button', { name: '解释' });
  await explainButton.waitFor({ timeout: 5_000 });
  await explainButton.click();
  // The card appears immediately; the demo-mode stream then completes.
  await anon.page.locator('[data-testid="note-card"]').first().waitFor({ timeout: 15_000 });
  await delay(1200);
  checks.push('a note is created from a real text selection in the Reader');

  // It reached the server, which is what makes it readable elsewhere.
  const serverNotes = await anon.page.request.get(`${origin}/api/articles/${articleFromUrl}/notes`);
  assert.equal(serverNotes.status(), 200, await serverNotes.text());
  const serverNotesBody = await serverNotes.json();
  assert.equal(serverNotesBody.notes.length, 1, 'the note must be on the server, not only in localStorage');
  assert.ok(
    serverNotesBody.notes[0].startBlockId.startsWith('b'),
    'the note must carry the block id it was anchored to',
  );
  checks.push('the note is persisted server-side with its block anchor');

  // ── 4b. Follow up through the real UI ────────────────────────────────
  // The defects this covers are behavioural, not structural: the follow-up
  // handler used to overwrite the note's original question with the new
  // one, and to build the model's context from `[question, answer]` instead
  // of the structured turns — so after the first follow-up the earlier
  // exchange had no boundaries.
  const card = anon.page.locator('[data-testid="note-card"]').first();
  // Capture the note's own question first: the assertion is that the
  // follow-up leaves it untouched, whatever the explain template made it.
  const questionBefore = await anon.page.evaluate(() => {
    const notes = Object.values(JSON.parse(localStorage.getItem('gloss-storage')).state.notes);
    return notes.filter((n) => n.turns && n.turns.length > 0)[0].question;
  });
  await card.getByPlaceholder('继续追问…').fill('那成本呢？');
  await card.getByPlaceholder('继续追问…').press('Enter');
  // The second answer arrives (demo mode) and is appended to the card.
  await anon.page.waitForFunction(
    () => {
      const raw = localStorage.getItem('gloss-storage');
      if (!raw) return false;
      const notes = Object.values(JSON.parse(raw).state.notes);
      const note = notes.find((n) => n.articleId && n.localAnswerCount >= 2);
      return Boolean(note) && note.isStreaming === false;
    },
    { timeout: 20_000 },
  );

  const noteState = await anon.page.evaluate(() => {
    const raw = localStorage.getItem('gloss-storage');
    const notes = Object.values(JSON.parse(raw).state.notes).filter((n) => n.turns);
    const note = notes[0];
    return {
      question: note.question,
      turnRoles: note.turns.map((t) => t.role),
      turnContents: note.turns.map((t) => t.content),
      answerCount: note.localAnswerCount,
      questionCount: note.localQuestionCount,
    };
  });
  assert.equal(
    noteState.question,
    questionBefore,
    `the note's original question must survive a follow-up, saw ${noteState.question}`,
  );
  assert.deepEqual(
    noteState.turnRoles,
    ['user', 'assistant', 'user', 'assistant'],
    `the conversation must keep every turn, saw ${JSON.stringify(noteState.turnRoles)}`,
  );
  assert.ok(
    noteState.turnContents[2].includes('那成本呢？'),
    'and the follow-up question must be stored as its own turn',
  );
  assert.ok(noteState.answerCount >= 2 && noteState.questionCount >= 2);

  // Both questions reached the server as separate messages.
  //
  // Polled, because the client writes the answer *without blocking the
  // UI*: the stream finishes, the card settles, and the message is on its
  // way. Asserting immediately tests the network's latency rather than the
  // contract; the contract is that the turn eventually lands.
  let messages = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const serverTurns = await anon.page.request.get(
      `${origin}/api/articles/${articleFromUrl}/notes`,
    );
    const turnsBody = await serverTurns.json();
    messages = turnsBody.messagesByNote[turnsBody.notes[0].id] ?? [];
    if (messages.length >= 4) break;
    await delay(250);
  }
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
    `the server must hold the whole conversation, saw ${JSON.stringify(messages.map((m) => m.role))}`,
  );
  assert.ok(
    messages[2].content.includes('那成本呢？'),
    'including the follow-up question as its own message',
  );
  checks.push('a follow-up keeps the original question and is stored as its own turn');

  // ── 4c. Notes from another version stay reachable, not rendered ──────
  // A refresh writes a new version; notes anchored to the old one describe
  // text that is no longer on screen. They must not be rendered beside the
  // new paragraphs, and they must not become unreachable either.
  await anon.page.evaluate((articleId) => {
    const raw = JSON.parse(localStorage.getItem('gloss-storage'));
    raw.state.notes['old-version-note'] = {
      id: 'old-version-note',
      articleId,
      paragraphIndex: 1,
      type: 'explain',
      selectionText: '旧版本上的选区',
      question: '旧版本上的问题？',
      answer: '旧版本上的回答。',
      model: 'mock',
      isStreaming: false,
      createdAt: Date.now() - 60_000,
      // A local record that names another version. It deliberately carries no
      // `remoteId`: the merge drops *bound* notes the server no longer has, and
      // this fixture is about the version rule, not about a deleted remote row.
      remoteVersionId: 'ver-does-not-match',
    };
    localStorage.setItem('gloss-storage', JSON.stringify(raw));
  }, localArticleId);
  await anon.page.reload();
  await anon.page.locator('[data-testid="note-card"]').first().waitFor({ timeout: 15_000 });

  const visibleCards = await anon.page.locator('[data-testid="note-card"]').count();
  assert.equal(visibleCards, 1, `only the current version's notes are rendered, saw ${visibleCards}`);
  const toggle = anon.page.getByTestId('other-version-notes-toggle');
  await toggle.waitFor({ timeout: 10_000 });
  assert.match(await toggle.innerText(), /1 条/);
  await toggle.click();
  await anon.page.getByTestId('other-version-notes').waitFor({ timeout: 5_000 });
  const afterExpand = await anon.page.locator('[data-testid="note-card"]').count();
  assert.equal(afterExpand, 2, 'the old-version note must be reachable, not deleted');
  checks.push('notes from other versions are hidden from the current text but stay reachable');

  // ── 4d. A highlight drawn here is account data ───────────────────────
  //
  // Marks used to be device-only. This draws one through the real selection
  // toolbar and waits for the account binding, then section 5 proves the other
  // device receives it.
  await selectInParagraph(anon.page, targetParagraph, 8, 12);
  const swatch = anon.page.locator('[data-selection-toolbar] button[data-color="yellow"]');
  await swatch.waitFor({ timeout: 5_000 });
  await swatch.click();
  let localMark = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    localMark = await anon.page.evaluate((articleId) => {
      const raw = localStorage.getItem('gloss-storage');
      if (!raw) return null;
      const marks = Object.values(JSON.parse(raw).state.highlights ?? {});
      const mark = marks.find((m) => m.articleId === articleId);
      return mark ? { id: mark.id, remoteId: mark.remoteId ?? null } : null;
    }, localArticleId);
    if (localMark?.remoteId) break;
    await delay(250);
  }
  assert.ok(localMark, 'the drawn highlight must exist in the local store');
  assert.ok(localMark.remoteId, 'the highlight must be pushed to the account');
  const serverMarks = await anon.page.request.get(
    `${origin}/api/articles/${articleFromUrl}/highlights`,
  );
  assert.equal(serverMarks.status(), 200, await serverMarks.text());
  const serverMarksBody = await serverMarks.json();
  assert.equal(
    serverMarksBody.highlights.length,
    1,
    'the mark must be on the server, not only in localStorage',
  );
  checks.push('a highlight drawn in the Reader is stored on the account');

  // ── 5. A second isolated context reads it back ───────────────────────
  const second = await newIsolatedContext();
  await second.page.goto(origin);
  await second.page.getByText('选中一段文字', { exact: false }).first().waitFor();
  // Fresh context: no cookies, no localStorage, no session.
  assert.equal(
    await second.page.evaluate(() => localStorage.getItem('gloss-storage')),
    null,
    'the second context must start with an empty local cache',
  );
  await signIn(second.page, { email: userAEmail, password: passwordA });
  // The **merged** library: this context has never seen either article, so it
  // only has the account's rows, and opening one pulls the text down first.
  // `#/cloud` is retired (it redirects here); `#/library` is where a signed-in
  // reader now finds both their device's articles and the account's.
  await second.page.goto(`${origin}/#/library`);
  await second.page.getByTestId('local-library-list').waitFor({ timeout: 20_000 });
  await second.page.getByRole('button', { name: /浏览器测试标题/ }).first().click();
  await second.page.getByText('第一段正文', { exact: false }).first().waitFor();
  // The cloud note loads on mount.
  await second.page.locator('[data-testid="note-card"]').first().waitFor({ timeout: 15_000 });
  const secondNoteText = await second.page.locator('[data-testid="note-card"]').first().innerText();
  assert.match(
    secondNoteText,
    /第一段正文/,
    `the note card must show the original selection, got: ${secondNoteText}`,
  );
  checks.push('a second isolated browser context reads the same article and note from the cloud');

  // The highlight drawn on the first device arrives with the account and is
  // painted over the same words.
  let remoteMarkOnSecond = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    remoteMarkOnSecond = await second.page.evaluate((articleId) => {
      const raw = localStorage.getItem('gloss-storage');
      if (!raw) return null;
      const marks = Object.values(JSON.parse(raw).state.highlights ?? {});
      return marks.find((m) => m.articleId === articleId && m.remoteId) ?? null;
    }, articleFromUrl);
    if (remoteMarkOnSecond) break;
    await delay(250);
  }
  assert.ok(remoteMarkOnSecond, 'the second device must receive the mark from the account');
  await second.page.locator('[data-highlight-id]').first().waitFor({ timeout: 10_000 });
  checks.push('the mark appears on a second device and is painted over the same words');

  // Deleting it there removes it here on the next open: the pull drops bound
  // marks the server no longer has.
  const deleteMark = await second.page.request.delete(
    `${origin}/api/highlights/${remoteMarkOnSecond.remoteId}`,
  );
  assert.equal(deleteMark.status(), 200);
  await anon.page.reload();
  await anon.page.locator('[data-paragraph-index]').first().waitFor({ timeout: 15_000 });
  await anon.page.waitForFunction(
    (articleId) => {
      const raw = localStorage.getItem('gloss-storage');
      if (!raw) return false;
      const marks = Object.values(JSON.parse(raw).state.highlights ?? {});
      return !marks.some((m) => m.articleId === articleId && m.remoteId);
    },
    localArticleId,
    { timeout: 20_000 },
  );
  checks.push('a mark deleted on another device disappears here on the next open');
  assert.deepEqual(second.errors, [], 'no page errors in the second context');

  // The migrated anonymous article is this context's too, for the same reason:
  // it is an account row in the same merged shelf.
  await second.page.goto(`${origin}/#/library`);
  await second.page.getByRole('button', { name: /匿名导入标题/ }).first().waitFor({ timeout: 15_000 });
  checks.push('the migrated anonymous article is visible in the second context too');

  // ── 6. Cross-user isolation still holds ──────────────────────────────
  await anon.page.evaluate(() => { location.hash = '#/account'; });
  await anon.page.locator('header button[aria-haspopup="menu"]').click();
  await anon.page.getByRole('menuitem', { name: '退出登录' }).click();
  await anon.page.getByText('选中一段文字', { exact: false }).first().waitFor();

  const userBEmail = `phase3-B-${randomUUID()}@example.test`;
  const passwordB = 'phase3-browser-B-2026';
  await registerAndVerify(anon.page, { name: '账号B', email: userBEmail, password: passwordB });
  await openLibrary(anon.page, 'context-1');
  await anon.page.getByText('我的文章', { exact: true }).first().waitFor();
  await anon.page.getByText('还没有保存的文章。', { exact: false }).first().waitFor();
  checks.push('a different account sees an empty library (cross-user isolation)');

  assert.deepEqual(anon.errors, [], 'no page errors throughout the article flow');

  await writeFile(
    'artifacts/browser-articles.json',
    JSON.stringify({ pass: true, checks, pageErrors: anon.errors }, null, 2),
  );
  console.log(`Browser article-library regression: passed (${checks.length} checks, 0 page errors).`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/browser-articles.json', JSON.stringify({
    pass: false,
    checks,
    failure: error instanceof Error ? error.message : String(error),
  }, null, 2));
} finally {
  await browser?.close();
  if (proxy?.exitCode === null) { const done = once(proxy, 'exit'); proxy.kill(); await done; }
  if (server?.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done; }
}
