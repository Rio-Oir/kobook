// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The per-host rule table (`server/src/lib/site-rules.ts`).
 *
 * The table exists so a known host is read from a reviewed container instead of
 * whatever Readability decides, and so a host that only answers a particular
 * client gets that client's identity. What is pinned here is the part that must
 * not drift: which host a rule owns, the requirement that a selector match with
 * no article in it falls through rather than yielding an empty document, and the
 * request profile WeChat needs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractWithRule,
  extractWithSiteRule,
  findSiteRule,
  requestHeadersFor,
  type SiteRule,
} from "../../server/src/lib/site-rules.js";
import { parseHtml } from "../../server/src/lib/parse/html.js";

const WECHAT_ARTICLE = `<!doctype html><html><head><title>标题 - 微信公众平台</title>
<meta property="og:title" content="分享标题"></head><body>
<h1 id="activity-name"> 一篇值得读的文章 </h1>
<div class="rich_media_content" id="js_content">
  <p>第一段正文，足够长，用来确认容器抽取真的拿到了内容。</p>
  <p>第二段正文，带一个<a href="/relative">相对链接</a>。</p>
</div>
<div id="js_pc_qr_code">扫码关注</div>
</body></html>`;

test("the rule table matches a host and its subdomains, but not a lookalike", () => {
  assert.equal(findSiteRule("https://mp.weixin.qq.com/s/abc")?.host, "mp.weixin.qq.com");
  // Most-specific host wins over its parent.
  assert.equal(findSiteRule("https://zhuanlan.zhihu.com/p/1")?.host, "zhuanlan.zhihu.com");
  assert.equal(findSiteRule("https://www.zhihu.com/question/1")?.host, "zhihu.com");
  assert.equal(findSiteRule("https://news.163.com/26/0101/00/abc.html")?.host, "163.com");
  assert.equal(findSiteRule("https://github.com/o/r")?.host, "github.com");
  // A suffix that is not on a label boundary must not inherit a rule.
  assert.equal(findSiteRule("https://evilzhihu.com/p/1"), null);
  assert.equal(findSiteRule("https://example.com/post"), null);
  assert.equal(findSiteRule("not a url"), null);
});

test("WeChat gets the WebView identity; hosts without a header rule get none", () => {
  const wechat = requestHeadersFor("https://mp.weixin.qq.com/s/abc");
  assert.match(wechat["User-Agent"] ?? "", /MicroMessenger/);
  assert.equal(wechat["Referer"], "https://mp.weixin.qq.com/");
  assert.deepEqual(requestHeadersFor("https://github.com/o/r"), {});
});

test("a matched container is returned as the article, with the page's title", () => {
  const extraction = extractWithSiteRule(WECHAT_ARTICLE, "https://mp.weixin.qq.com/s/abc");
  assert.ok(extraction);
  assert.equal(extraction.kind, "html");
  assert.equal(extraction.via, "container");
  assert.equal(extraction.title, "一篇值得读的文章");
  assert.match(extraction.content, /第一段正文/);
  // The chrome around the container is gone — that is the whole point.
  assert.doesNotMatch(extraction.content, /扫码关注/);

  // And the extracted fragment is what the parser consumes: one call, blocks.
  const parsed = parseHtml(extraction.content, {
    remoteArticle: true,
    baseUrl: "https://mp.weixin.qq.com/s/abc",
    ...(extraction.title === undefined ? {} : { title: extraction.title }),
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.ok(parsed.document.blocks.length >= 2);
    assert.equal(parsed.document.title, "一篇值得读的文章");
  }
});

test("a selector that matches an empty shell falls through instead of producing an empty article", () => {
  const emptyShell = `<html><body><div id="js_content">   </div></body></html>`;
  assert.equal(extractWithSiteRule(emptyShell, "https://mp.weixin.qq.com/s/abc"), null);

  // No container at all (the verification page): also falls through.
  const verification = `<html><body><div class="weui-msg"><div class="weui-msg__title warn">环境异常</div></div></body></html>`;
  assert.equal(extractWithSiteRule(verification, "https://mp.weixin.qq.com/s/abc"), null);
});

test("the embedded-state hook reads a JSON blob before it looks at the DOM", () => {
  const rule: SiteRule = {
    host: "example.test",
    containers: ["article"],
    state: {
      pattern: /window\.__INITIAL_STATE__\s*=\s*(\{.*?\});?\s*<\/script>/s,
      path: ["noteData", "desc"],
      format: "html",
    },
  };
  const page = `<html><body><article><p>这是壳，不该被选中。</p></article>
<script>window.__INITIAL_STATE__ = {"noteData":{"desc":"<p>真正的正文来自 SSR 状态，长度足够。</p>"}};</script>
</body></html>`;
  const extraction = extractWithRule(page, rule);
  assert.ok(extraction);
  assert.equal(extraction.via, "state");
  assert.equal(extraction.kind, "html");
  assert.match(extraction.content, /真正的正文来自 SSR 状态/);

  // A broken/too-short state blob must not fail the import: it falls through to
  // the DOM container, which is exactly when the container still works.
  const fallbackPage = `<html><body><article><p>这是页面壳里的正文，长度足够触发容器兜底，所以它应该被选中。</p></article>
<script>window.__INITIAL_STATE__ = {"noteData":{"desc":"oops"}};</script>
</body></html>`;
  const fallback = extractWithRule(fallbackPage, rule);
  assert.ok(fallback);
  assert.equal(fallback.via, "container");
  assert.match(fallback.content, /页面壳里的正文/);
});

test("a page the source marks as a verification challenge is not an unavailable article", async () => {
  const { detectInterstitial, detectUnavailableContent } = await import("../../server/src/lib/url-import.js");
  const challenge = `<html><body><div class="weui-msg"><div class="weui-msg__title warn">环境异常</div>
<div>完成验证后即可继续访问</div></div></body></html>`;
  // "环境异常" means "come back after the captcha", not "this article is gone".
  assert.ok(detectInterstitial(challenge));
  assert.equal(detectUnavailableContent(challenge), null);
  // A genuinely dead link is still reported as unavailable.
  const deadLink = `<html><body><div class="weui-msg"><div class="weui-msg__title warn">参数错误</div></div></body></html>`;
  assert.equal(detectInterstitial(deadLink), null);
  assert.ok(detectUnavailableContent(deadLink));
});

test("a redirect to a verification endpoint is detected by URL, not by guessing at the body", async () => {
  const { isVerificationEndpoint } = await import("../../server/src/lib/url-import.js");
  // The endpoint WeChat actually redirects an automated client to. Its body is
  // captcha chrome ("视频", "小程序", "赞", "在看") — none of it a challenge
  // phrase, all of it parseable as "content", which is why the URL decides.
  assert.equal(
    isVerificationEndpoint(
      new URL("https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=HEZT2Wqj&target_url=https%3A%2F%2Fmp.weixin.qq.com%2Fs%3F__biz%3Dx"),
    ),
    true,
  );
  // A poc_token on the article path means the same thing.
  assert.equal(isVerificationEndpoint(new URL("https://mp.weixin.qq.com/s?__biz=x&poc_token=abc")), true);
  // The article URL itself is not a challenge, and neither is another host.
  assert.equal(isVerificationEndpoint(new URL("https://mp.weixin.qq.com/s?__biz=x&mid=1&idx=1&sn=abc")), false);
  assert.equal(isVerificationEndpoint(new URL("https://github.com/mp/wappoc_appmsgcaptcha")), false);
});
