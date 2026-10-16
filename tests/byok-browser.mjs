// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * BYOK browser gate: the real modules, in a real browser, against a fake
 * vendor on a dynamic port.
 *
 * What only a browser can prove, and why this suite exists:
 *
 *   - the request is a genuine cross-origin `fetch` from the page, so the
 *     Authorization header, the CORS preflight and the "the vendor does not
 *     allow direct browser access" error are the real ones, not a Node
 *     simulation;
 *   - `page.evaluate` imports `src/lib/ai.ts` and `src/lib/settings.ts`
 *     through Vite — the same transformed modules the app ships, with the
 *     same aliases — instead of a copy of their logic;
 *   - two fake vendors plus a request log make "the key is only ever sent to
 *     the confirmed endpoint" an observation about what the wire carried,
 *     not a claim about what the client intended.
 *
 * The app itself is never started (its entry module is stubbed out), no
 * database, no backend, no existing service, no fixed port: Vite is spawned
 * on a free port and torn down at the end. No network access.
 *
 * Run: node tests/byok-browser.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { evidenceDir, repoRoot } from '../scripts/evidence-dir.mjs';

const REPLY = '浏览器直连你好';

// Evidence goes to `artifacts/byok-browser/` (gitignored) by default, or to
// `EVIDENCE_DIR` when set — see `scripts/evidence-dir.mjs`.
const EVIDENCE = evidenceDir('byok-browser');

// The blank page has to be served *by Vite* so the suite shares Vite's origin
// and can import the app's real modules. That makes it a fixture rather than
// evidence, so it lives under the gitignored `artifacts/` directory inside the
// repository root — a directory outside the Vite root could not be served.
const FIXTURE_DIR = path.join(repoRoot, 'artifacts', 'byok');
const BLANK_FIXTURE_URL = 'artifacts/byok/blank.html';

// ── fake OpenAI-compatible vendors ───────────────────────────────────────
// Kept inline (plain JS) rather than reusing tests/unit/byok-fake-provider.ts
// so this file stays runnable with a bare `node tests/byok-browser.mjs`, like
// the other browser suites. Only what the browser scenarios need is here.

function chunkFrame(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  })}\n\n`;
}

function usageFrame() {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
  })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function defaultFrames() {
  return [chunkFrame(''), ...[...REPLY].map((c) => chunkFrame(c)), usageFrame(), DONE];
}

/**
 * @param {{
 *   cors?: 'full' | 'none' | 'preflight-only',
 *   frameDelayMs?: number,
 *   frames?: string[],
 * }} opts
 *
 * `cors: 'none'` refuses the preflight, so the browser never sends the POST.
 * `cors: 'preflight-only'` is its nastier sibling: the preflight passes, so
 * the credential *does* leave the browser, and only the response is blocked.
 * Both are things a real vendor "without browser support" does, and the
 * difference matters for what can honestly be claimed about the key.
 */
async function startVendor(opts = {}) {
  const corsMode = opts.cors ?? 'full';
  const requests = [];
  const preflights = [];
  const server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      preflights.push(req.url ?? '');
      res.writeHead(204, corsMode === 'none' ? {} : cors);
      res.end();
      return;
    }
    const raw = await readBody(req);
    requests.push({
      authorization: req.headers.authorization ?? null,
      body: raw,
      contentType: req.headers['content-type'] ?? null,
    });

    const headers = {};
    if (corsMode === 'full') Object.assign(headers, cors);
    if (opts.json !== undefined) {
      res.writeHead(opts.status ?? 200, { ...headers, 'content-type': 'application/json' });
      res.end(opts.json);
      return;
    }
    headers['content-type'] = 'text/event-stream';
    res.writeHead(200, headers);
    const frames = opts.frames ?? defaultFrames();
    for (const frame of frames) {
      if (opts.frameDelayMs) await delay(opts.frameDelayMs);
      if (res.destroyed || res.writableEnded) return;
      res.write(frame);
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    requests,
    preflights,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

// ── the scenarios, all driven from inside the page ────────────────────────

/**
 * Shared page-side helpers. Returned as source so `page.evaluate` can build
 * a fresh helper per call without importing the test file into the page.
 */
const PAGE_BOOTSTRAP = `
  const settings = await import('/src/lib/settings.ts');
  const ai = await import('/src/lib/ai.ts');
  // Reading through \`now()\` matters: zustand hands back a fresh state object
  // on every write, so a captured snapshot would report stale values even
  // though the action closures keep working.
  const now = () => settings.useSettings.getState();
  const store = now();
  function configure(baseURL, key, owner) {
    store.reset();
    if (owner) store.setOwner(owner);
    store.setApiKey(key);
    store.setModel('fake-model');
    store.setBaseURL(baseURL);
    store.confirmEndpoint();
  }
  async function run(opts = {}) {
    const out = { chunks: '', done: 0, errors: [], errorObjects: [], cancelled: 0, interrupted: 0, partial: null };
    const controller = new AbortController();
    const promise = ai.streamChat({
      messages: [{ role: 'user', content: '你好' }],
      signal: controller.signal,
      timeoutMs: opts.timeoutMs,
      onChunk: (t) => { out.chunks += t; },
      onDone: () => { out.done += 1; },
      onError: (e) => {
        out.errors.push(e.message);
        // What the caller is *handed*, not just what it says: a raw SDK
        // error would show its payload-carrying properties here.
        out.errorObjects.push({ ctor: e.constructor.name, props: Object.keys(e) });
      },
      onCancelled: (p) => { out.cancelled += 1; out.partial = p; },
      onInterrupted: () => { out.interrupted += 1; },
    });
    if (opts.abortAfterChunks !== undefined) {
      while (out.chunks.length < opts.abortAfterChunks) await new Promise((r) => setTimeout(r, 5));
      ai.abortAllStreams();
    }
    await promise;
    return out;
  }
  function storedSettings() {
    return JSON.parse(localStorage.getItem('gloss-settings') ?? '{"state":{}}');
  }
`;

let vite;
let browser;
const vendors = [];

try {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // Vite's root is a positional argument, and both it and the binary are
  // resolved from the repository root rather than from `cwd`, so the blank
  // fixture above is reachable at `BLANK_FIXTURE_URL` no matter where the
  // suite was launched from.
  vite = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules/vite/bin/vite.js'),
      repoRoot,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--strictPort',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url)).ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, `Vite did not start on the dynamic port ${port}`);

  const selected = await startVendor({});
  const decoy = await startVendor({});
  const noCors = await startVendor({ cors: 'none' });
  const blockedReply = await startVendor({ cors: 'preflight-only' });
  // A vendor that quotes the key back in its 401 body — the realistic way a
  // credential would otherwise ride out of this module inside an error.
  const echoKey = 'sk-echoed-by-vendor-in-browser';
  const echo = await startVendor({
    status: 401,
    json: JSON.stringify({ error: { message: `Incorrect API key provided: ${echoKey}. See docs.` } }),
  });
  const slow = await startVendor({ frameDelayMs: 60 });
  vendors.push(selected, decoy, noCors, blockedReply, slow, echo);

  browser = await chromium.launch({
    headless: true,
    ...(process.env.READER_CHROME_PATH ? { executablePath: process.env.READER_CHROME_PATH } : {}),
  });
  // A blank page served *by Vite*, so the suite shares Vite's origin without
  // booting the reader. It is generated here rather than checked in, and it
  // deliberately carries no script: navigating to the app's `index.html`
  // would mount React and start unrelated boot traffic.
  //
  // No `context.route()` is registered, and that is load-bearing: with any
  // route interception installed, Playwright's Chromium stops issuing CORS
  // preflights, which would quietly turn the cross-origin assertions below
  // into fictions. (Verified against a bare probe server: a route makes the
  // browser send the POST alone; without it, OPTIONS then POST.)
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(
    path.join(FIXTURE_DIR, 'blank.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>byok-blank</title></head><body></body></html>',
  );
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${url}/${BLANK_FIXTURE_URL}`);
  await page.waitForFunction(() => document.title === 'byok-blank');

  const results = {};

  // 1. anonymous owner, real request, memory-only key by default
  results.anonymous = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(selected.baseURL)}, 'sk-browser-anon', 'anonymous');
      const out = await run();
      out.storedKey = storedSettings().state.apiKey;
      out.liveKey = now().apiKey;
      out.origin = now().confirmedOrigin;
      return out;
    })()`,
  );
  assert.equal(results.anonymous.chunks, REPLY, 'the browser must receive the streamed answer');
  assert.equal(results.anonymous.done, 1, 'exactly one onDone');
  assert.deepEqual(results.anonymous.errors, []);
  assert.equal(results.anonymous.cancelled, 0);
  assert.equal(
    results.anonymous.storedKey,
    '',
    'the key must not be written to localStorage without an explicit opt-in',
  );
  assert.equal(results.anonymous.liveKey, 'sk-browser-anon', 'but it stays usable this session');
  assert.equal(results.anonymous.origin, selected.origin);

  const anonRequest = selected.requests.at(-1);
  assert.equal(
    anonRequest.authorization,
    'Bearer sk-browser-anon',
    'the vendor receives the key as a bearer token',
  );
  assert.equal(decoy.requests.length, 0, 'the decoy vendor must never be contacted');
  assert.equal(decoy.preflights.length, 0);

  // 2. the same thing while an account owns the session
  results.signedIn = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(selected.baseURL)}, 'sk-browser-account', 'user-1');
      const out = await run();
      out.owner = now().ownerUserId;
      return out;
    })()`,
  );
  assert.equal(results.signedIn.owner, 'user-1');
  assert.equal(results.signedIn.done, 1, 'a signed-in owner has BYOK too — no extra gate');
  assert.deepEqual(results.signedIn.errors, []);
  assert.equal(selected.requests.at(-1).authorization, 'Bearer sk-browser-account');

  // 3. moving the endpoint without confirming it holds the key back
  const decoyBefore = decoy.requests.length;
  results.unconfirmed = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      store.reset();
      store.setApiKey('sk-browser-anon');
      store.setModel('fake-model');
      store.setBaseURL(${JSON.stringify(selected.baseURL)});
      store.confirmEndpoint();
      // A new endpoint, no confirmation: exactly what a link, a preset swap
      // or a devtools edit would produce.
      store.setBaseURL(${JSON.stringify(decoy.baseURL)});
      const out = await run();
      out.confirmedOrigin = now().confirmedOrigin;
      return out;
    })()`,
  );
  assert.equal(results.unconfirmed.done, 0, 'an unconfirmed endpoint must not produce an answer');
  assert.equal(results.unconfirmed.errors.length, 1);
  assert.match(results.unconfirmed.errors[0], /确认/);
  assert.equal(decoy.requests.length, decoyBefore, 'the key must not reach the new origin');

  // 4. a vendor that does not allow direct browser access
  results.cors = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(noCors.baseURL)}, 'sk-browser-anon', 'anonymous');
      return await run();
    })()`,
  );
  assert.equal(results.cors.done, 0, 'a blocked cross-origin call is not a success');
  assert.equal(results.cors.errors.length, 1);
  assert.match(
    results.cors.errors[0],
    /CORS|浏览器无法连接|Failed to fetch|NetworkError/,
    'the failure must name browser-direct connectivity, not look like a model error',
  );
  assert.doesNotMatch(
    results.cors.errors[0],
    /密钥未发送|密钥没有发出|密钥未送达/,
    'the browser cannot know whether it went out — it must not claim the key was withheld',
  );
  assert.match(
    results.cors.errors[0],
    /无法确认/,
    'it must say instead that delivery cannot be confirmed from here',
  );
  assert.equal(noCors.preflights.length, 1, 'the browser did ask the vendor first');
  assert.equal(
    noCors.requests.length,
    0,
    'a refused preflight means the credential never leaves the browser at all',
  );

  // 4b. the same vendor misconfiguration that *does* leak the request: the
  // preflight passes and only the reply is blocked. Worth pinning down,
  // because it is the reason an unconfirmed endpoint is refused outright
  // rather than "tried and reported".
  results.corsReplyBlocked = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(blockedReply.baseURL)}, 'sk-browser-anon', 'anonymous');
      return await run();
    })()`,
  );
  assert.equal(results.corsReplyBlocked.done, 0);
  assert.equal(results.corsReplyBlocked.errors.length, 1);
  assert.match(results.corsReplyBlocked.errors[0], /CORS|浏览器无法连接|Failed to fetch|NetworkError/);
  assert.equal(
    blockedReply.requests.length,
    1,
    'the request reached the vendor — the browser only withheld the reply',
  );
  assert.equal(blockedReply.requests[0].authorization, 'Bearer sk-browser-anon');
  assert.doesNotMatch(
    results.corsReplyBlocked.errors[0],
    /密钥未发送|密钥没有发出|密钥未送达/,
    'the request demonstrably reached the vendor, so the message must not deny it',
  );
  assert.match(results.corsReplyBlocked.errors[0], /无法确认/);

  // 5. cancel mid-stream in the browser
  results.cancel = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(slow.baseURL)}, 'sk-browser-anon', 'anonymous');
      return await run({ abortAfterChunks: 1 });
    })()`,
  );
  assert.equal(results.cancel.done, 0, 'a cancelled stream must not reach onDone');
  assert.equal(results.cancel.cancelled, 1);
  assert.deepEqual(results.cancel.errors, []);
  assert.ok(results.cancel.chunks.length > 0, 'the partial answer is kept');

  // 6. the default deadline is a failure, not a stop
  results.timeout = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(slow.baseURL)}, 'sk-browser-anon', 'anonymous');
      return await run({ timeoutMs: 350 });
    })()`,
  );
  assert.equal(results.timeout.cancelled, 0, 'a timeout must not look like a user cancel');
  assert.equal(results.timeout.done, 0);
  assert.equal(results.timeout.errors.length, 1);
  assert.match(results.timeout.errors[0], /秒|超时/);

  // 7. no key ⇒ demo mode, and no vendor is touched
  const beforeDemo = selected.requests.length;
  results.demo = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      store.reset();
      store.setModel('fake-model');
      return await run();
    })()`,
  );
  assert.equal(results.demo.done, 1);
  assert.match(results.demo.chunks, /演示模式/, 'demo mode must be visible in the text itself');
  assert.equal(selected.requests.length, beforeDemo, 'demo mode must make no request');


  // 7b. a vendor quoting the key back must not put it in the error
  results.echo = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(echo.baseURL)}, ${JSON.stringify(echoKey)}, 'anonymous');
      return await run();
    })()`,
  );
  assert.equal(results.echo.done, 0);
  assert.equal(results.echo.errors.length, 1);
  assert.equal(
    echo.requests[0]?.authorization,
    `Bearer ${echoKey}`,
    'the vendor received the credential — which is exactly why the echo has to be scrubbed',
  );
  assert.equal(results.echo.errors[0].includes(echoKey), false, 'the key must not survive');
  assert.match(results.echo.errors[0], /密钥已隐藏/);
  assert.match(results.echo.errors[0], /Incorrect API key provided/, 'the useful part is kept');
  assert.equal(
    results.echo.errorObjects[0].ctor,
    'Error',
    'and it is a plain Error, not the SDK APICallError that carried the payload',
  );
  assert.deepEqual(
    results.echo.errorObjects[0].props,
    [],
    'no requestBodyValues / responseHeaders / responseBody / data / url / cause on what the caller keeps',
  );

  // 7c. a fetch the *browser* aborted (navigation/reload) is an interruption.
  // In Chromium a DOMException is not an `Error`, which is the branch that a
  // Node-only unit test cannot reach.
  results.interrupted = await page.evaluate(
    `(async () => { ${PAGE_BOOTSTRAP}
      configure(${JSON.stringify(selected.baseURL)}, 'sk-browser-anon', 'anonymous');
      const realFetch = window.fetch;
      window.fetch = () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      try {
        return await run();
      } finally {
        window.fetch = realFetch;
      }
    })()`,
  );
  assert.equal(results.interrupted.interrupted, 1, 'a torn-down page is an interruption');
  assert.equal(results.interrupted.done, 0);
  assert.deepEqual(results.interrupted.errors, [], 'and it is not reported as a failure');
  assert.equal(results.interrupted.cancelled, 0);

  // ── the settings panel, rendered for real ─────────────────────────────
  // The gate that protects the key lives in the send path (scenarios 3/4),
  // but the panel is where a user is asked. The defect being pinned here is
  // the old `onChange` prompt: one `confirm()` per keystroke, which a user
  // learns to dismiss — and a dismissed dialog accepted the new origin. The
  // provider `<select>` was the same bypass with one click and no prompt at
  // all.

  const dialogs = { count: 0, mode: 'dismiss' };
  page.on('dialog', async (dialog) => {
    dialogs.count += 1;
    if (dialogs.mode === 'accept') await dialog.accept();
    else await dialog.dismiss();
  });

  await page.evaluate(`(async () => {
    const mount = await import('/tests/byok-panel-mount.tsx');
    window.__byokPanel = mount.mountSettingsPanel();
    const settings = await import('/src/lib/settings.ts');
    const s = settings.useSettings.getState();
    s.reset();
    s.setModel('fake-model');
    s.setBaseURL(${JSON.stringify(selected.baseURL)});
    s.setApiKey('sk-panel-key');
    s.confirmEndpoint();
    return true;
  })()`);

  const host = page.locator('#byok-settings-host');
  await host.waitFor();
  const urlInput = host.locator('input[type="text"]').first();
  const modelInput = host.locator('input[type="text"]').nth(1);
  const keyInput = host.locator('input[type="password"]');
  const rememberBox = host.locator('input[type="checkbox"]');
  const providerSelect = host.locator('select');
  assert.equal(await modelInput.count(), 1, 'the address and model fields are both present');

  const panelState = () =>
    page.evaluate(`(async () => {
      const s = (await import('/src/lib/settings.ts')).useSettings.getState();
      return {
        baseURL: s.baseURL, confirmedOrigin: s.confirmedOrigin,
        provider: s.provider, rememberKey: s.rememberKey, apiKey: s.apiKey,
        stored: JSON.parse(localStorage.getItem('gloss-settings') ?? '{"state":{}}').state,
      };
    })()`);

  // 8. typing an address must not prompt; committing it must — once
  dialogs.mode = 'dismiss';
  dialogs.count = 0;
  await urlInput.click();
  await urlInput.selectText();
  await urlInput.pressSequentially(decoy.baseURL, { delay: 5 });
  assert.equal(
    dialogs.count,
    0,
    'typing must not raise a dialog per keystroke — that is what taught users to dismiss it',
  );
  await urlInput.blur();
  assert.equal(dialogs.count, 1, 'committing a new origin asks exactly once');
  const afterDismiss = await panelState();
  assert.equal(afterDismiss.baseURL, selected.baseURL, 'declining keeps the old endpoint');
  assert.equal(afterDismiss.confirmedOrigin, selected.origin);
  assert.equal(await urlInput.inputValue(), selected.baseURL, 'and the field reverts');

  dialogs.mode = 'accept';
  dialogs.count = 0;
  await urlInput.click();
  await urlInput.selectText();
  await urlInput.pressSequentially(decoy.baseURL, { delay: 5 });
  await urlInput.blur();
  assert.equal(dialogs.count, 1);
  const afterAccept = await panelState();
  assert.equal(afterAccept.baseURL, decoy.baseURL, 'accepting moves the endpoint');
  assert.equal(
    afterAccept.confirmedOrigin,
    decoy.origin,
    'and binds the key to the origin the user was just shown',
  );

  // 9. switching the provider preset asks too
  dialogs.mode = 'dismiss';
  dialogs.count = 0;
  await providerSelect.selectOption('openai');
  assert.equal(dialogs.count, 1, 'a preset swap moves the endpoint, so it must ask');
  assert.equal((await panelState()).provider, 'deepseek', 'declined ⇒ nothing changed');

  dialogs.mode = 'accept';
  dialogs.count = 0;
  await providerSelect.selectOption('openai');
  assert.equal(dialogs.count, 1);
  const afterProvider = await panelState();
  assert.equal(afterProvider.provider, 'openai');
  assert.equal(
    afterProvider.confirmedOrigin,
    new URL(afterProvider.baseURL).origin,
    'the accepted preset is the confirmed origin',
  );

  // 10. the unconfirmed state is shown, and its button re-binds
  await page.evaluate(`(async () => {
    const s = (await import('/src/lib/settings.ts')).useSettings.getState();
    s.setBaseURL('https://unconfirmed.example/v1');
    return true;
  })()`);
  const banner = host.getByText('端点未确认');
  assert.equal(await banner.count(), 1, 'a key with an unconfirmed endpoint is called out');
  await host.getByRole('button', { name: '确认使用此端点' }).click();
  assert.equal(
    (await panelState()).confirmedOrigin,
    'https://unconfirmed.example',
    'the explicit button is what re-binds the key',
  );
  assert.equal(await banner.count(), 0);

  // 11. remembering the key is opt-in, and unticking removes the stored copy
  dialogs.mode = 'dismiss';
  dialogs.count = 0;
  // `click()`, not `check()`: the declined case deliberately leaves the box
  // unchecked, and `check()` would wait for a state that never arrives.
  await rememberBox.click();
  assert.equal(dialogs.count, 1, 'storing a key on this machine needs an explicit yes');
  assert.equal((await panelState()).rememberKey, false, 'declined ⇒ nothing stored');

  dialogs.mode = 'accept';
  dialogs.count = 0;
  await rememberBox.click();
  assert.equal(dialogs.count, 1);
  const remembered = await panelState();
  assert.equal(remembered.rememberKey, true);
  assert.equal(remembered.stored.apiKey, 'sk-panel-key', 'accepted ⇒ the key is on this machine');

  await rememberBox.click();
  const unremembered = await panelState();
  assert.equal(unremembered.rememberKey, false);
  assert.equal(unremembered.stored.apiKey, '', 'unticking removes the stored copy');
  assert.equal(unremembered.apiKey, 'sk-panel-key', 'while the session keeps using it');

  // 12. the legacy-key notice is the honest half of the in-memory migration
  await page.evaluate(`(async () => {
    (await import('/src/lib/settings.ts')).useSettings.setState({ legacyKeyMigrated: true });
    return true;
  })()`);
  assert.equal(await host.getByText('旧版保存的密钥已做安全迁移').count(), 1);
  await host.getByRole('button', { name: '知道了' }).click();
  assert.equal(await host.getByText('旧版保存的密钥已做安全迁移').count(), 0);

  await page.evaluate('window.__byokPanel.unmount()');

  assert.deepEqual(pageErrors, [], 'the page must not raise uncaught errors');

  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(
    path.join(EVIDENCE, 'browser.json'),
    JSON.stringify(
      {
        pass: true,
        vitePort: port,
        checks: [
          'anonymous owner: streamed answer, exactly one onDone, key not persisted',
          'signed-in owner: BYOK works without an extra gate',
          'key travels only to the configured vendor (decoy untouched, including preflights)',
          'unconfirmed endpoint: call refused, key never sent',
          'no-CORS vendor: explicit browser-direct failure, credential never delivered',
          'reply-blocked vendor: failure reported, and the request genuinely left the browser',
          'cancel: partial text kept, no onDone',
          'timeout: failure, not cancellation',
          'no key: labelled demo mode, no request',
          'panel: no prompt while typing, one prompt on commit, decline reverts',
          'panel: provider preset asks and re-binds the confirmed origin',
          'panel: unconfirmed banner + explicit confirm button',
          'panel: remembering the key is opt-in and unticking scrubs it',
          'panel: legacy-key migration notice is shown and dismissible',
          'vendor 401 echoing the key: redacted, useful part kept, credential really was sent',
          'browser-aborted fetch (DOMException, not an Error in Chromium): interrupted, not failed',
          'CORS failures never claim the key was withheld — they say delivery is unconfirmed',
        ],
        pageErrors,
        vendors: {
          selected: selected.requests.length,
          decoy: decoy.requests.length,
          noCors: noCors.requests.length,
          blockedReply: blockedReply.requests.length,
          slow: slow.requests.length,
          echo: echo.requests.length,
        },
        scenarios: results,
        panelDialogs: dialogs.count,
      },
      null,
      2,
    ),
  );
  console.log('BYOK browser gate: passed (17 checks, 0 page errors).');
} finally {
  await browser?.close();
  await Promise.all(vendors.map((v) => v.close()));
  if (vite && vite.exitCode === null) {
    const done = once(vite, 'exit');
    vite.kill();
    await done;
  }
}
