// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { importFromUrlDual, prefersServerExtraction, importFromText } from '../../src/lib/browser-extract.js';
import { parseLocalMarkdown } from '../../src/lib/local-import-parse.js';

const parsed = parseLocalMarkdown('短中文正文。');
if (!parsed.ok) throw new Error('fixture');
const document = parsed.document;
test('exact X/Twitter hosts and DNS subdomains bypass Jina; similar hosts do not', () => {
  for (const host of ['x.com', 'www.x.com', 'mobile.twitter.com', 'X.COM.']) assert.equal(prefersServerExtraction(`https://${host}/a`), true);
  for (const host of ['evilx.com', 'x.com.evil.test', 'twitter.com.evil.test', 't.co', 'example.com']) assert.equal(prefersServerExtraction(`https://${host}/x.com`), false);
});

test('the host rule matches on the parsed hostname, so a path or query mentioning x.com does not route', () => {
  // A substring implementation (`url.includes('x.com')`) would route
  // every one of these to the server.
  assert.equal(prefersServerExtraction('https://example.com/x.com'), false);
  assert.equal(prefersServerExtraction('https://example.com/?next=https://x.com/a'), false);
  assert.equal(prefersServerExtraction('https://evil.test/twitter.com'), false);
  // …and the legitimate subdomain forms still work.
  assert.equal(prefersServerExtraction('https://x.com/'), true);
  assert.equal(prefersServerExtraction('https://dash.x.com/i/status/1'), true);
});

test('prefersServerExtraction is total: unparseable input is simply not a site-policy host', () => {
  for (const bad of ['', 'not a url', 'javascript:alert(1)', 'x.com']) {
    // 'x.com' is a *bare host*; `new URL` rejects it, and the ordinary
    // path's normalizer is the thing that adds the scheme. The routing
    // helper must not throw while deciding.
    assert.equal(typeof prefersServerExtraction(bad), 'boolean');
  }
});

test('X uses server only, with truthful progress; cancellation sends nothing', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify({ extractor: 'html-readability', document })); };
  let progress = '';
  const r = await importFromUrlDual('https://x.com/a', { fetchImpl, onFallback: n => { progress = n.message; } });
  assert.equal(r.ok, true); assert.deepEqual(calls, ['/api/anonymous/extract']); assert.equal(progress, '正在通过服务器提取正文');
  // The load-bearing negative: no Jina request was *attempted*. The
  // call list is the evidence — a `r.jina.ai` entry here would mean the
  // policy host was tried against Jina first.
  assert.equal(calls.some(c => c.includes('r.jina.ai')), false);
  calls.length = 0;
  await importFromUrlDual('https://twitter.com/a', { fetchImpl, signal: AbortSignal.abort() });
  assert.equal(calls.length, 0);
});

test('an X failure reports the server reason, never a fabricated Jina failure', async () => {
  // Server said "needs login / paste it yourself"; the client must
  // repeat that, not invent a Jina-first story it never ran.
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async url => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: { code: 'UPSTREAM_FAILED', message: '网页需要登录、验证或浏览器脚本，无法直接提取，请粘贴正文。' } }), { status: 502 });
  };
  const r = await importFromUrlDual('https://x.com/a', { fetchImpl });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(calls.some(c => c.includes('r.jina.ai')), false, 'an X URL must never reach Jina');
  assert.match(r.failure.message, /粘贴正文/);
  assert.doesNotMatch(r.failure.message, /直连方式|Jina/i, 'must not narrate a Jina attempt that never happened');
});

test('ordinary browser success has no server request; failed browser uses direct server response', async () => {
  const calls: string[] = [];
  let fail = false;
  const fetchImpl: typeof fetch = async url => {
    calls.push(String(url));
    return String(url).startsWith('https://r.jina.ai/')
      ? new Response(fail ? '' : JSON.stringify({ data: { content: '短正文。' } }), { status: fail ? 500 : 200 })
      : new Response(JSON.stringify({ extractor: 'html-readability', document }));
  };
  assert.equal((await importFromUrlDual('https://example.com/a', { fetchImpl })).ok, true);
  assert.equal(calls.length, 1);
  calls.length = 0; fail = true;
  const r = await importFromUrlDual('https://example.com/a', { fetchImpl });
  assert.equal(r.ok && r.source, 'server-readability'); assert.equal(calls.length, 2);
  // Only the server's *direct* extractor is reachable: the response
  // label is `html-readability`, never `jina`.
  assert.equal(calls.filter(c => c.startsWith('https://r.jina.ai/')).length, 1, 'exactly one Jina attempt, on the browser');
  assert.equal(importFromText('短中文。').ok, true); assert.equal(calls.length, 2);
});

test('base server importer and anonymous route contain no outbound Jina configuration', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../server/src/lib/url-import.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /function jinaFetch|await jinaFetch|authorization:.*Bearer/);
  // The vestigial constants/types must be gone, not merely unused.
  assert.doesNotMatch(source, /JINA_TIMEOUT_MS/);
  assert.doesNotMatch(source, /interface JinaEnvelope/);
  assert.doesNotMatch(source, /r\.jina\.ai/);
  // The base anonymous route must not read the environment either — a
  // deployment key must not look like it can re-enable the egress.
  // The pattern is the *read*, not the word: the files mention JINA_
  // in prose explaining why they no longer read it.
  for (const rel of ['../../server/src/routes/anonymous.ts']) {
    const routeSource = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(routeSource, /process\.env\[["']JINA_/, `${rel} must not read Jina env`);
    assert.doesNotMatch(routeSource, /jinaApiKey|jinaBaseUrl/, `${rel} must not forward Jina options`);
  }
});

test('interstitial detection rejects login / JS / captcha shells and keeps short Chinese prose', async () => {
  const { detectInterstitial } = await import('../../server/src/lib/url-import.js');
  // Challenge titles are decisive on their own.
  assert.ok(detectInterstitial('<html><head><title>Just a moment…</title></head><body><div id="cf"></div></body></html>'));
  assert.ok(detectInterstitial('<html><head><title>Sign in to X</title></head><body>x</body></html>'));
  assert.ok(detectInterstitial('<html><head><title>验证码</title></head><body>完成验证码</body></html>'));
  // JS-only shell: short body plus a recognizable phrase.
  assert.ok(detectInterstitial('<html><head><title>x</title></head><body><p>JavaScript is not available.</p></body></html>'));
  assert.ok(detectInterstitial('<html><head><title>x</title></head><body><p>请启用 JavaScript 以继续。</p></body></html>'));
  // A body whose visible text is empty is not an article.
  assert.ok(detectInterstitial('<html><head><title></title></head><body><script>1</script></body></html>'));
  // …and the rule that must NOT fire: a genuinely short Chinese article.
  // There is no word-count or language floor — this is 8 characters and
  // is real content.
  assert.equal(detectInterstitial('<html><head><title>标题</title></head><body><p>短中文正文。</p></body></html>'), null);
  assert.equal(detectInterstitial('<html><head><title>t</title></head><body><article><p>深度学习模型的训练需要大量计算资源。</p></article></body></html>'), null);
});
