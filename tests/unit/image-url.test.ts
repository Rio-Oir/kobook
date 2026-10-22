// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 图片地址归一化与分享图。
 *
 * 这个模块的唯一职责是回答「这个地址能不能放进 <img>」，而它答错的两种
 * 方式都会在界面上变成坏事，而不是错误：
 *
 *   - 放过相对地址 → 那个 `/uploads/hero.jpg` 会被请求到我们自己的域名下，
 *     404，或者更糟：显示成我们自己的某张图；
 *   - 放过 `data:` → 一张内联图被写进正文存储，几万字一篇文章带着几百 KB
 *     的 base64，再经同步上传到账号。
 *
 * 所以这里钉的是边界，而不是“能解析”这件事本身。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  CHROME_IMAGE_PATTERN,
  IMAGE_URL_MAX,
  absolutizeImageUrl,
  isContentImageUrl,
  shareImageFromDocument,
} from "../../src/lib/import/image-url.js";

const PAGE = "https://example.test/posts/2026/why.html";

test("绝对 http(s) 地址原样通过（不重写、不规范化）", () => {
  assert.equal(
    absolutizeImageUrl("https://cdn.example.test/a.jpg?x=1#frag", PAGE),
    "https://cdn.example.test/a.jpg?x=1#frag",
  );
  assert.equal(absolutizeImageUrl("  http://a.test/b.png  ", PAGE), "http://a.test/b.png");
});

test("相对地址按源页面解析，绝对路径补上源站 origin", () => {
  assert.equal(absolutizeImageUrl("/uploads/hero.jpg", PAGE), "https://example.test/uploads/hero.jpg");
  assert.equal(absolutizeImageUrl("img/hero.jpg", PAGE), "https://example.test/posts/2026/img/hero.jpg");
  assert.equal(absolutizeImageUrl("../img/hero.jpg", PAGE), "https://example.test/posts/img/hero.jpg");
  assert.equal(absolutizeImageUrl("//cdn.other.test/x.png", PAGE), "https://cdn.other.test/x.png");
});

test("没有源地址时相对路径被丢弃，而不是猜一个 origin", () => {
  assert.equal(absolutizeImageUrl("/uploads/hero.jpg"), undefined);
  assert.equal(absolutizeImageUrl("img/hero.jpg", null), undefined);
  assert.equal(absolutizeImageUrl("img/hero.jpg", "   "), undefined);
  // 浏览器里的 `about:blank` 不是可用的源。
  assert.equal(absolutizeImageUrl("img/hero.jpg", "about:blank"), undefined);
});

test("内联与脚本地址一律拒绝", () => {
  assert.equal(absolutizeImageUrl("data:image/png;base64,AAAA", PAGE), undefined);
  assert.equal(absolutizeImageUrl("blob:https://example.test/1234", PAGE), undefined);
  assert.equal(absolutizeImageUrl("javascript:alert(1)", PAGE), undefined);
  assert.equal(absolutizeImageUrl("file:///c:/cover.png", PAGE), undefined);
});

test("空值与超长值直接拒绝", () => {
  assert.equal(absolutizeImageUrl("", PAGE), undefined);
  assert.equal(absolutizeImageUrl("   ", PAGE), undefined);
  assert.equal(absolutizeImageUrl(null, PAGE), undefined);
  assert.equal(absolutizeImageUrl(undefined, PAGE), undefined);
  const long = `https://cdn.example.test/${"a".repeat(IMAGE_URL_MAX)}.jpg`;
  assert.equal(absolutizeImageUrl(long, PAGE), undefined);
});

test("chrome 图（logo/icon/头像/精灵图/追踪像素）不算内容图", () => {
  for (const url of [
    "https://example.test/logo.svg",
    "https://example.test/assets/icon-32.png",
    "https://example.test/assets/icons/arrow.svg",
    "https://example.test/u/avatar.png",
    "https://example.test/sprite.png",
    "https://example.test/sprites.png",
    "https://example.test/pixel.gif",
    "https://example.test/blank.png",
    "https://example.test/img/1x1.png",
  ]) {
    assert.equal(isContentImageUrl(url), false, url);
    assert.ok(CHROME_IMAGE_PATTERN.test(url), url);
  }
  for (const url of [
    "https://example.test/photos/hero.jpg",
    "https://example.test/2026/uncertainty-hero.webp",
    // 分段里带 chrome 词但整体是别的词：不该被误杀。
    "https://example.test/img/catalog.png",
  ]) {
    assert.equal(isContentImageUrl(url), true, url);
  }
  assert.equal(isContentImageUrl(""), false);
  assert.equal(isContentImageUrl(null), false);
});

test("分享图按 og:image → twitter:image → image_src 的顺序取第一个可用的", () => {
  const withAll = new JSDOM(`<head>
    <link rel="image_src" href="/link.png">
    <meta name="twitter:image" content="/twitter.png">
    <meta property="og:image" content="/og.png">
  </head>`).window.document;
  assert.equal(shareImageFromDocument(withAll, PAGE), "https://example.test/og.png");

  const twitterOnly = new JSDOM(
    `<head><meta name="twitter:image" content="https://cdn.test/tw.png"></head>`,
  ).window.document;
  assert.equal(shareImageFromDocument(twitterOnly, PAGE), "https://cdn.test/tw.png");

  const linkOnly = new JSDOM(`<head><link rel="image_src" href="/link.png"></head>`).window
    .document;
  assert.equal(shareImageFromDocument(linkOnly, PAGE), "https://example.test/link.png");

  // 声明了但解析不出来（内联图、没有源地址）：当作没有，调用方退回正文首图。
  const unusable = new JSDOM(
    `<head><meta property="og:image" content="data:image/png;base64,AA"></head>`,
  ).window.document;
  assert.equal(shareImageFromDocument(unusable, PAGE), undefined);
  assert.equal(shareImageFromDocument(withAll, null), undefined);
  assert.equal(shareImageFromDocument(new JSDOM(`<head></head>`).window.document, PAGE), undefined);
});
