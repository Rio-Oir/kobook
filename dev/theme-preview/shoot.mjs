// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Screenshot every candidate palette on the **real app**, not on the mock.
 *
 *   node --import tsx dev/theme-preview/shoot.mjs
 *
 * How it stays off your data:
 *
 *   - it launches its own Chromium with a **fresh browser context**, so the
 *     localStorage it writes is a throwaway one, not your profile's;
 *   - the sample article is built by the app's own parser
 *     (`parseLocalMarkdown`) from a Markdown string in this file, so the
 *     block kinds, inline spans and hashes are the real thing;
 *   - the palette is applied by injecting one `<style>` block and setting
 *     `data-theme` on `<html>` — the same mechanism the app uses. No app
 *     source is touched, and `gloss-theme` is never written.
 *
 * Output lands in `docs/evidence/theme-20261019/`.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { parseLocalMarkdown } from "../../src/lib/local-import-parse.ts";
import { PALETTES, cssVars } from "./palettes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "docs/evidence/theme-20261019");
const BASE = process.env.PREVIEW_ORIGIN ?? "http://localhost:5183";

await mkdir(OUT, { recursive: true });

// ── the sample article ──────────────────────────────────────────────────
const MARKDOWN = `# 阅读、理解与留下想法

阅读不只是获取信息，也是把新的内容与已有经验联系起来。一个好的阅读器，应当让人能够专注于文字，在需要时获得解释，并留下自己的思考。这句话看起来平常，但它其实把阅读拆成了两件不同的事：接收，以及接进已有的理解里。

## 一、Markdown 的阅读体验

Markdown 用简单的标记表达重要观点、**强调**、*倾斜*、\`行内代码\`、~~已删除的内容~~与[参考链接](https://example.com)。阅读时，这些标记应当成为清晰的排版，而不是需要读者自行脑补的符号。

- 清晰的标题与目录
- 舒服的正文宽度和行距
- 可以回到原文的笔记

> 读到值得停下来的地方，就在原文旁留下一句话。批注不是读后感，它锚定在某一段上。

### 代码与引用

行内代码引用主题变量，整段代码保留缩进：

\`\`\`ts
export function resolveTheme(theme) {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}
\`\`\`

## 二、让 AI 帮助理解

遇到陌生概念时，选中文字并询问：它是什么意思？它与前文有什么关系？有没有更容易理解的例子？

1. 选中正文中的一句话
2. 选择「解释」或「提问」
3. 回答留在右侧，与原文一一对应

## 三、划线、选区与定位

下面一行用同一种颜色演示三种划线样式：水彩底纹、直线下划与波浪线。它们在阅读面上是否清晰，决定了划线能不能当记号用。

四种颜色并排出现：黄色、绿色、蓝色与红色。这里还有一处带笔记的段落标记，以及目录里的当前位置标记。

拖选这段文字即可看到选区颜色——它用的是「下一次划线」的颜色与透明度，所以拖动时看到的正是点击后的结果。
`;

const parsed = parseLocalMarkdown(MARKDOWN);
if (!parsed.ok) throw new Error(`sample markdown did not parse: ${parsed.code}`);
const blocks = parsed.document.blocks;

const ARTICLE_ID = "local-theme-preview";

/** Find a paragraph by a substring of its text. */
function blockOf(needle) {
  const block = blocks.find((b) => b.text.includes(needle));
  if (!block) throw new Error(`no block contains ${needle}`);
  return block;
}

/** Build a highlight anchored to the first occurrence of `needle`. */
function highlight(color, style, blockNeedle, span) {
  const block = blockOf(blockNeedle);
  const start = block.text.indexOf(span);
  if (start < 0) throw new Error(`"${span}" not in block ${block.index}`);
  return {
    id: `hl-${color}-${style}`,
    articleId: ARTICLE_ID,
    paragraphIndex: block.index,
    startOffset: start,
    endOffset: start + span.length,
    selectionText: span,
    color,
    style,
    createdAt: Date.now(),
  };
}

const highlights = [
  highlight("yellow", "watercolor", "下面一行用同一种颜色", "水彩底纹"),
  highlight("green", "line", "下面一行用同一种颜色", "直线下划"),
  highlight("blue", "curve", "下面一行用同一种颜色", "波浪线"),
  highlight("yellow", "watercolor", "四种颜色并排出现", "黄色"),
  highlight("green", "watercolor", "四种颜色并排出现", "绿色"),
  highlight("blue", "watercolor", "四种颜色并排出现", "蓝色"),
  highlight("red", "watercolor", "四种颜色并排出现", "红色"),
];

const askBlock = blockOf("批注不是读后感");
const notes = {
  "note-1": {
    id: "note-1",
    articleId: ARTICLE_ID,
    paragraphIndex: askBlock.index,
    type: "explain",
    selectionText: "批注不是读后感，它锚定在某一段上。",
    question: "解释这句话",
    answer:
      "锚定意味着笔记与段落绑定，而不是与整篇文章绑定。段落重新解析后，笔记会跟着新的版本走，而不是漂到别处——这是它和读后感最大的区别。",
    model: "preview",
    isStreaming: false,
    createdAt: Date.now() - 120000,
  },
};

const article = {
  id: ARTICLE_ID,
  title: parsed.document.title,
  paragraphs: blocks,
  createdAt: Date.now(),
  syncSource: "local",
};

const SEED = {
  state: {
    articles: { [ARTICLE_ID]: article },
    notes,
    highlights: Object.fromEntries(highlights.map((h) => [h.id, h])),
    ownerUserId: "anonymous",
    highlightColor: "yellow",
  },
  version: 2,
};

// ── palette CSS, same shape as the app's `[data-theme]` blocks ──────────
function blockFor(palette) {
  const vars = cssVars(palette);
  const body = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  const scheme = palette.mode === "day" ? "light" : "dark";
  return `[data-theme="${palette.id}"] {\n  color-scheme: ${scheme};\n${body}\n}`;
}
const PALETTE_CSS = PALETTES.map(blockFor).join("\n\n");

// ── drive it ────────────────────────────────────────────────────────────
const VIEWPORTS = [
  { tag: "desktop", width: 1440, height: 1000 },
  { tag: "narrow", width: 390, height: 844 },
];

/** Anything sticking out past the viewport, by selector. */
const OVERFLOW_PROBE = () => {
  const limit = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > limit + 1 || r.left < -1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 40),
        left: Math.round(r.left),
        right: Math.round(r.right),
      });
    }
  }
  return {
    clientWidth: limit,
    scrollWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > limit + 1,
    offenders: offenders.slice(0, 8),
  };
};

const browser = await chromium.launch();
const shots = [];
const overflow = [];

for (const palette of PALETTES) {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    await context.addInitScript((seed) => {
      localStorage.setItem("gloss-storage", JSON.stringify(seed));
    }, SEED);

    const page = await context.newPage();
    await page.goto(`${BASE}/#/r/${ARTICLE_ID}`, { waitUntil: "load" });
    await page.waitForSelector(".gloss-prose", { timeout: 15000 });
    await page.addStyleTag({ content: PALETTE_CSS });
    await page.evaluate((id) => {
      document.documentElement.setAttribute("data-theme", id);
      document.documentElement.style.colorScheme = id.endsWith("day") ? "light" : "dark";
    }, palette.id);
    // Let the 200ms background/colour transition in `index.css` settle, so
    // a shot never catches the previous palette mid-fade.
    await page.waitForTimeout(450);

    const file = path.join(OUT, `reader-${palette.id}-${viewport.tag}.png`);
    await page.screenshot({ path: file });
    shots.push(path.relative(ROOT, file));

    if (viewport.tag === "narrow") {
      overflow.push({ where: `reader:${palette.id}`, ...(await page.evaluate(OVERFLOW_PROBE)) });
    }
    console.log(`  ✔ ${path.relative(ROOT, file)}`);

    await context.close();
  }
}

// ── the review page itself, at both widths ─────────────────────────────
for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/dev/theme-preview/index.html`, { waitUntil: "load" });
  await page.waitForSelector(".rv-chip");
  await page.waitForTimeout(300);
  const file = path.join(OUT, `preview-page-${viewport.tag}.png`);
  await page.screenshot({ path: file, fullPage: viewport.tag === "desktop" });
  shots.push(path.relative(ROOT, file));
  overflow.push({
    where: `preview-page:${viewport.tag}`,
    ...(await page.evaluate(OVERFLOW_PROBE)),
  });
  console.log(`  ✔ ${path.relative(ROOT, file)}`);
  await context.close();
}

await browser.close();

const { writeFile } = await import("node:fs/promises");
await writeFile(
  path.join(OUT, "layout-overflow.json"),
  JSON.stringify(overflow, null, 2) + "\n",
);

const bad = overflow.filter((o) => o.horizontalOverflow);
console.log(`\n${shots.length} 张截图写入 docs/evidence/theme-20261019/`);
console.log(
  bad.length
    ? `横向溢出：${bad.map((b) => b.where).join("、")}`
    : `横向溢出检查：${overflow.length} 次测量全部通过（scrollWidth ≤ clientWidth）`,
);
