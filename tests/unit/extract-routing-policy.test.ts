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

test('X uses the server HTML path only; cancellation sends nothing', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify({ extractor: 'html-readability', document })); };
  let progress = '';
  const r = await importFromUrlDual('https://x.com/a', { fetchImpl, onFallback: n => { progress = n.message; } });
  assert.equal(r.ok, true); assert.deepEqual(calls, ['/api/anonymous/extract']); assert.equal(progress, '正在通过服务器读取网页正文');
  // The load-bearing negative: no Jina request was *attempted*. The
  // call list is the evidence — a `r.jina.ai` entry here would mean the
  // policy host was tried against Jina first.
  assert.equal(calls.some(c => c.includes('r.jina.ai')), false);
  calls.length = 0;
  await importFromUrlDual('https://twitter.com/a', { fetchImpl, signal: AbortSignal.abort() });
  assert.equal(calls.length, 0);
});

test('an X failure does not bypass its server-only policy with Jina', async () => {
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

test('HTML + Readability is primary; Jina runs only when the caller opts in', async () => {
  const calls: string[] = [];
  let serverFail = false;
  let jinaFail = false;
  const fetchImpl: typeof fetch = async url => {
    calls.push(String(url));
    if (String(url).startsWith('https://r.jina.ai/')) {
      return new Response(jinaFail ? '' : JSON.stringify({ data: { content: '短正文。' } }), { status: jinaFail ? 500 : 200 });
    }
    return serverFail
      ? new Response(JSON.stringify({ error: { message: 'Readability failed' } }), { status: 502 })
      : new Response(JSON.stringify({ extractor: 'html-readability', document }));
  };
  const primary = await importFromUrlDual('https://example.com/a', { fetchImpl });
  assert.equal(primary.ok, true);
  assert.equal(primary.ok && primary.source, 'server-readability');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls, ['/api/anonymous/extract'], 'the successful primary path does not contact Jina');

  // The channel is opt-in: a server failure reports the failure instead of
  // spending another 7–10 s on a third-party attempt (see the module header).
  calls.length = 0;
  serverFail = true;
  const off = await importFromUrlDual('https://example.com/a', { fetchImpl });
  assert.equal(off.ok, false);
  assert.deepEqual(calls, ['/api/anonymous/extract'], 'by default a server failure never reaches Jina');

  calls.length = 0;
  const r = await importFromUrlDual('https://example.com/a', { fetchImpl, jinaFallback: true });
  assert.equal(r.ok && r.source, 'browser-jina');
  assert.deepEqual(calls, ['/api/anonymous/extract', 'https://r.jina.ai/https://example.com/a']);
  assert.equal(importFromText('短中文。').ok, true); assert.equal(calls.length, 2);

  calls.length = 0;
  jinaFail = true;
  const bothFail = await importFromUrlDual('https://example.com/a', { fetchImpl, jinaFallback: true });
  assert.equal(bothFail.ok, false);
  if (!bothFail.ok) assert.match(bothFail.failure.message, /服务器 HTML\/Readability.*Jina 备用方式/);
  assert.deepEqual(calls, ['/api/anonymous/extract', 'https://r.jina.ai/https://example.com/a']);
});

test('an SSRF rejection or server rate limit never falls through to Jina', async () => {
  for (const status of [422, 429]) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async url => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { message: 'blocked' } }), { status });
    };
    const result = await importFromUrlDual('https://example.com/a', { fetchImpl });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['/api/anonymous/extract'], `HTTP ${status} must not bypass the server gate`);
  }
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

test('a "content unavailable" page is refused instead of becoming a one-paragraph article', async () => {
  const { detectInterstitial, detectUnavailableContent } = await import('../../server/src/lib/url-import.js');

  // The real shape of the WeChat error page, banner and app chrome included.
  const wechatErrorPage =
    '<html><head></head><body><div class="weui-msg"><div class="weui-msg__icon-area">' +
    '<i class="weui-icon-warn weui-icon_msg"></i></div><div class="weui-msg__text-area">' +
    '<div class="weui-msg__title warn">参数错误</div></div></div>' +
    '<script>window.logs = { page_begin: Date.now() };</script>' +
    '<div>视频 小程序 赞 在看 分享 留言 收藏</div></body></html>';
  assert.match(detectUnavailableContent(wechatErrorPage) ?? '', /参数错误/);
  // It is a *status* page, not a challenge page: the two rules stay separate
  // because only one of them is terminal.
  assert.equal(detectInterstitial(wechatErrorPage), null);

  // The same page without its component: the stripped visible text still
  // starts with the status phrase, which is what the fallback rule keys on.
  assert.match(
    detectUnavailableContent('<html><body>参数错误 ： ， ， 视频 小程序 赞 分享 留言</body></html>') ?? '',
    /参数错误/,
  );

  // A title-only status page (no banner, no leading phrase in the body).
  assert.match(
    detectUnavailableContent('<html><head><title>该内容已被发布者删除</title></head><body><p>x</p></body></html>') ?? '',
    /该内容已被发布者删除/,
  );

  // Rules that must NOT fire — each is a real page with a legitimate reason
  // to contain the same characters.
  const technicalNote =
    '<html><head><title>内容不存在时的用户体验</title></head><body><article>' +
    '<p>当接口返回参数错误时，前端应该提示用户而不是静默失败。</p></article></body></html>';
  assert.equal(detectUnavailableContent(technicalNote), null);
  // …a phrase that merely *begins* a sentence is not a status line…
  assert.equal(detectUnavailableContent('<html><body><p>参数错误率是本次故障的核心指标。</p></body></html>'), null);
  // …and long real prose that quotes the phrase mid-article is untouched.
  const longArticle = `<html><head><title>调试笔记</title></head><body><article><p>${'排查过程中，日志里频繁出现'.repeat(30)}参数错误${'，最终定位到请求体校验。'.repeat(30)}</p></article></body></html>`;
  assert.equal(detectUnavailableContent(longArticle), null);
  // An ordinary short Chinese article is still an article.
  assert.equal(detectUnavailableContent('<html><head><title>标题</title></head><body><p>短中文正文。</p></body></html>'), null);
});

test('an unavailable-source 422 stops the fallback and repeats the server’s reason', async () => {
  // The user-visible promise: when the source says the page is gone, the client
  // neither retries through Jina nor narrates a retry — it shows our sentence.
  const calls: string[] = [];
  const message = '原文不可用：源站返回「参数错误」，这篇内容可能已被删除、过期，或不允许网页直接访问。请确认链接是否有效，或粘贴正文导入。';
  const fetchImpl: typeof fetch = async url => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: { code: 'EMPTY_ARTICLE', message } }), { status: 422 });
  };
  const result = await importFromUrlDual('https://mp.weixin.qq.com/s/nwG769DlblncKxOyZvSNqg', { fetchImpl });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(calls, ['/api/anonymous/extract'], 'a dead page must not be re-requested from Jina');
  assert.equal(result.failure.status, 422);
  assert.equal(result.failure.message, message);
});
