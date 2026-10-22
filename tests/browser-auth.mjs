// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phase 2 browser regression.
 *
 * Boots a real Fastify server and a real Caddy proxy serving `dist/` and
 * `/api` from the same origin, then drives the new auth screens with
 * Playwright. The same-origin shape is what the production deployment looks
 * like, and is also the only configuration in which `credentials:
 * "same-origin"` actually sends the session cookie.
 *
 * What this test asserts end to end:
 *   1. Anonymous reader still works (decision #4: phase 2 does not gate the
 *      local AI entry; the existing local reader must not break).
 *   2. Register → verify → login flow round-trips through the SPA.
 *   3. The Account page shows the verified state.
 *   4. Logout clears `gloss-storage`, `gloss-settings`, and the API key.
 *   5. A second account, signed in after a stale cache from a previous
 *      account, does not see the previous account's data.
 *
 * Out of scope here (covered elsewhere):
 *   - The pure "is the cache cleared?" decision is exercised in
 *     `tests/unit/auth-config.test.ts` via `reconcileOwner`; the browser
 *     test is the wiring proof.
 *   - The verification round trip's token shape and lifetime are
 *     exercised in `tests/phase2.ts` (G2 / G7).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium } from 'playwright';

const serverPort = '18793';
const caddyPort = '18083';
const dbName = `gloss_browserauth_test_${Date.now()}`;
const baseDatabaseUrl = 'postgresql://gloss_test:local_test_only@127.0.0.1:55433/gloss_phase2_test';
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.pathname = `/${dbName}`;
const origin = `http://127.0.0.1:${caddyPort}`;

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

  // The fresh database is empty; apply all four migrations before
  // starting the server. The phase-2/3 run applies them, but a
  // browser-auth run on a brand-new DB has to do it itself.
  const prismaBin = 'node_modules/prisma/build/index.js';
  const migrate = spawn(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl.href,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  assert.equal((await once(migrate, 'exit'))[0], 0, 'migrate deploy failed for browser-auth DB');

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl.href,
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: serverPort,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'phase2-browser-test-secret-00000000000000000000',
    SERVER_LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_ENABLED: '0',
  };
  server = spawn(
    process.execPath,
    ['--import', 'tsx', 'server/src/index.ts'],
    { stdio: 'ignore', env, windowsHide: true },
  );
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`http://127.0.0.1:${serverPort}/api/health/ready`)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'server did not start');

  // Same-origin Caddy: SPA from `dist/`, /api/* to the Fastify server.
  // The verify / reset links will land on this origin's hash routes.
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
  await writeFile('artifacts/Caddyfile-browser-auth', caddyfile);
  proxy = spawn('.tools/caddy/caddy.exe', ['run', '--config', 'artifacts/Caddyfile-browser-auth', '--adapter', 'caddyfile'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'Caddy did not start');

  browser = await chromium.launch({
    headless: true,
    ...(process.env.GLOSS_CHROME_PATH ? { executablePath: process.env.GLOSS_CHROME_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));

  // Seed a local "previous account" data set so the post-switch claim is
  // observable. The store is `gloss-storage` (the article store); the
  // settings store holds the (fake) API key.
  const previousArticle = {
    id: 'prev-account-article',
    title: '上一个账号的文章',
    paragraphs: [
      { index: 1, text: '上一段正文', hash: 'x' },
    ],
    createdAt: Date.now(),
  };
  await page.addInitScript(({ article }) => {
    localStorage.setItem(
      'gloss-storage',
      JSON.stringify({
        state: {
          ownerUserId: 'previously-signed-in-user',
          currentArticleId: article.id,
          articles: { [article.id]: article },
          notes: {},
        },
        version: 2,
      }),
    );
    localStorage.setItem(
      'gloss-settings',
      JSON.stringify({
        state: {
          ownerUserId: 'previously-signed-in-user',
          provider: 'deepseek',
          apiKey: 'previous-account-api-key',
          baseURL: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        version: 2,
      }),
    );
  }, { article: previousArticle });

  // 1. Anonymous reader still works.
  await page.goto(origin);
  await page.getByText('选中一段文字', { exact: false }).first().waitFor();
  assert.deepEqual(errors, [], 'no page errors on the anonymous home page');

  // 2. Register. The header carries no 注册 entry any more (a phone number
  // registers itself on its first code login), so go straight to the email
  // form.
  const userAEmail = `auth-A-${randomUUID()}@example.test`;
  const passwordA = 'browser-auth-A-2026';
  await page.goto(`${origin}/#/register`);
  await page.getByRole('textbox', { name: '昵称' }).fill('账号A');
  await page.getByRole('textbox', { name: '邮箱' }).fill(userAEmail);
  // The password field is labelled 密码; the hint sits outside the label,
  // so a prefix match keeps this working if the hint copy changes.
  await page.getByRole('textbox', { name: /^密码/ }).fill(passwordA);
  await page.getByRole('textbox', { name: /再次输入密码/ }).fill(passwordA);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByText('注册成功').waitFor();

  // 3. Verify email. Read the link via the same-origin dev mail endpoint
  // and navigate to it.
  const verifyMail = await page.request.get(`${origin}/api/dev/mail/latest?to=${encodeURIComponent(userAEmail)}`);
  assert.equal(verifyMail.status(), 200);
  const verifyMailBody = await verifyMail.json();
  assert.ok(verifyMailBody.message, 'verification mail was not queued');
  await page.goto(verifyMailBody.message.url);
  await page.getByText('邮箱已验证').waitFor();

  // 4. Log in and confirm the Account page shows verified.
  await page.getByRole('link', { name: '去登录' }).click();
  await page.getByRole('textbox', { name: '邮箱' }).fill(userAEmail);
  await page.getByRole('textbox', { name: /^密码/ }).fill(passwordA);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('选中一段文字', { exact: false }).first().waitFor();
  await page.goto(`${origin}/#/account`);
  await page.getByText('已验证').first().waitFor();

  // 5. Logout clears the cache.
  await page.locator('header button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await page.getByText('选中一段文字', { exact: false }).first().waitFor();
  // After sign-out the session store flips to "anon" and AccountLink
  // re-renders the "登录" link; wait for it before continuing so the
  // second register step does not race the React commit.
  await page.getByRole('link', { name: '登录' }).first().waitFor();
  const afterLogout = await page.evaluate(() => {
    const storage = JSON.parse(localStorage.getItem('gloss-storage') ?? '{"state":{}}');
    const settings = JSON.parse(localStorage.getItem('gloss-settings') ?? '{"state":{}}');
    return {
      storage: storage.state,
      settings: settings.state,
    };
  });
  assert.equal(afterLogout.storage.ownerUserId, 'anonymous');
  assert.deepEqual(afterLogout.storage.articles, {});
  assert.deepEqual(afterLogout.storage.notes, {});
  assert.equal(afterLogout.settings.apiKey, '');
  // The previous account's article content must not appear anywhere in
  // the rendered document.
  const bodyText = await page.evaluate(() => document.body.innerText);
  assert.ok(!bodyText.includes(previousArticle.title), 'previous-account article title should not be visible');
  assert.ok(!bodyText.includes('上一段正文'), 'previous-account article text should not be visible');

  // 6. Sign in as a second account — owner was the previous-account user,
  // `reconcileOwner` decides "clear" and the previous articles are gone.
  // First, plant a fresh previous-account cache.
  const previousArticle2 = {
    id: 'prev-account-2',
    title: '第二个上一个账号',
    paragraphs: [{ index: 1, text: '第二段上一个', hash: 'y' }],
    createdAt: Date.now(),
  };
  await page.evaluate((article) => {
    localStorage.setItem(
      'gloss-storage',
      JSON.stringify({
        state: {
          ownerUserId: 'still-previous-user',
          currentArticleId: article.id,
          articles: { [article.id]: article },
          notes: {},
        },
        version: 2,
      }),
    );
  }, previousArticle2);

  const userBEmail = `auth-B-${randomUUID()}@example.test`;
  const passwordB = 'browser-auth-B-2026';
  await page.goto(`${origin}/#/register`);
  await page.getByRole('textbox', { name: '昵称' }).fill('账号B');
  await page.getByRole('textbox', { name: '邮箱' }).fill(userBEmail);
  await page.getByRole('textbox', { name: /^密码/ }).fill(passwordB);
  await page.getByRole('textbox', { name: /再次输入密码/ }).fill(passwordB);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByText('注册成功').waitFor();

  const verifyB = await page.request.get(`${origin}/api/dev/mail/latest?to=${encodeURIComponent(userBEmail)}`);
  const verifyBBody = await verifyB.json();
  await page.goto(verifyBBody.message.url);
  await page.getByText('邮箱已验证').waitFor();
  await page.getByRole('link', { name: '去登录' }).click();
  await page.getByRole('textbox', { name: '邮箱' }).fill(userBEmail);
  await page.getByRole('textbox', { name: /^密码/ }).fill(passwordB);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('选中一段文字', { exact: false }).first().waitFor();

  const afterB = await page.evaluate(() => {
    const storage = JSON.parse(localStorage.getItem('gloss-storage') ?? '{"state":{}}');
    return { owner: storage.state.ownerUserId, articles: storage.state.articles };
  });
  assert.notEqual(afterB.owner, 'still-previous-user');
  assert.deepEqual(afterB.articles, {});
  const bodyTextB = await page.evaluate(() => document.body.innerText);
  assert.ok(!bodyTextB.includes(previousArticle2.title), 'previous-account-2 article should not be visible');

  // 7. Sign out, then sign back in with a six-digit email code instead of
  // the password. The code is read from the same-origin dev mailbox, which is
  // the only place it exists outside the real SMTP path. The code form is the
  // second step of the same card: the black button sends, the code screen
  // signs in.
  await page.goto(`${origin}/#/account`);
  await page.locator('header button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await page.getByRole('link', { name: '登录' }).first().waitFor();

  await page.goto(`${origin}/#/login`);
  await page.getByRole('button', { name: '改用验证码登录' }).click();
  await page.getByRole('textbox', { name: '邮箱' }).fill(userBEmail);
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByRole('textbox', { name: /验证码/ }).waitFor();

  const codeMail = await page.request.get(
    `${origin}/api/dev/mail/latest?to=${encodeURIComponent(userBEmail)}&purpose=sign-in-otp`,
  );
  assert.equal(codeMail.status(), 200);
  const codeMailBody = await codeMail.json();
  assert.ok(codeMailBody.message, 'sign-in code was not queued');
  assert.match(codeMailBody.message.code, /^\d{6}$/);
  assert.equal(codeMailBody.message.url, '', 'a login code carries no link');

  // The sixth digit verifies on its own; there is no button to press.
  await page.getByRole('textbox', { name: /验证码/ }).fill(codeMailBody.message.code);
  await page.getByText('选中一段文字', { exact: false }).first().waitFor();
  await page.goto(`${origin}/#/account`);
  await page.getByText('已验证').first().waitFor();

  // 8. Phone login on a brand-new number. One code, no password: the server
  // signs the number in or registers it, so this is the whole registration
  // path for a phone account. The code is read from the same-origin dev SMS
  // inbox, which is the only place it exists outside the real provider path.
  await page.locator('header button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await page.getByRole('link', { name: '登录' }).first().waitFor();

  await page.goto(`${origin}/#/login`);
  await page.getByRole('button', { name: '用手机号登录' }).click();
  const phone = `139${String(Date.now()).slice(-8)}`;
  await page.getByRole('textbox', { name: '手机号' }).fill(phone);
  // A phone login must not offer a password at all.
  assert.equal(
    await page.getByRole('textbox', { name: /^密码/ }).count(),
    0,
    'phone sign-in must not ask for a password',
  );
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByRole('textbox', { name: /验证码/ }).waitFor();

  const smsResponse = await page.request.get(
    `${origin}/api/dev/sms/latest?to=${encodeURIComponent(`+86${phone}`)}&purpose=sign-in-or-up`,
  );
  assert.equal(smsResponse.status(), 200);
  const smsBody = await smsResponse.json();
  assert.ok(smsBody.message, 'phone sign-in-or-up code was not queued');
  assert.match(smsBody.message.code, /^\d{6}$/);

  // Filling the last slot submits the code by itself.
  await page.getByRole('textbox', { name: /验证码/ }).fill(smsBody.message.code);
  await page.getByText('选中一段文字', { exact: false }).first().waitFor();
  await page.goto(`${origin}/#/account`);
  await page.getByText(`+86${phone}`).first().waitFor();
  await page.getByText('手机验证').first().waitFor();
  await page.getByText('已验证').first().waitFor();

  // 9. The same number on the login screen is now an existing account, and the
  // register page is an email-only surface: the phone switch is gone and the
  // password method switch stays on the email channel.
  await page.locator('header button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await page.getByRole('link', { name: '登录' }).first().waitFor();
  await page.goto(`${origin}/#/register`);
  assert.equal(
    await page.getByRole('button', { name: '用手机号注册' }).count(),
    0,
    'register page must not offer a phone channel',
  );
  await page.goto(`${origin}/#/login`);
  await page.getByRole('button', { name: '用手机号登录' }).click();
  assert.equal(
    await page.getByRole('button', { name: '改用密码登录' }).count(),
    0,
    'phone sign-in must not offer the password method',
  );

  assert.deepEqual(errors, [], 'no page errors throughout the auth flow');
  await mkdir('artifacts', { recursive: true });
  const checks = [
    'anonymous reader still works',
    'register → verify → login round trip',
    'account page shows verified state',
    'logout clears gloss-storage, gloss-settings, apiKey',
    'switch account clears the previous cache',
    'verification-code login round trip',
    'a filled code verifies without pressing the button',
    'phone code login registers a new number',
    'phone sign-in asks for no password',
    'register page offers no phone channel',
    'account page shows the verified phone number',
  ];
  await writeFile(
    'artifacts/browser-auth.json',
    JSON.stringify(
      {
        pass: true,
        checks,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(`Browser account-isolation regression: passed (${checks.length} checks, 0 page errors).`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/browser-auth.json', JSON.stringify({ pass: false, failure: error instanceof Error ? error.message : String(error) }, null, 2));
} finally {
  await browser?.close();
  if (proxy?.exitCode === null) { const done = once(proxy, 'exit'); proxy.kill(); await done; }
  if (server?.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done; }
}
