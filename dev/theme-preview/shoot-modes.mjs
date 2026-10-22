// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Verify the two modes in the real app and capture them.
 *
 *   node --import tsx dev/theme-preview/shoot-modes.mjs
 *
 * Unlike `shoot.mjs` this injects nothing: it drives the app's own
 * top-bar button and reads what the app did, so what it asserts is the
 * shipped behaviour rather than a palette pasted on top of it.
 *
 * Isolation is the same: a fresh browser context per run, so the
 * localStorage it writes is a throwaway one.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { parseLocalMarkdown } from "../../src/lib/local-import-parse.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(ROOT, "docs/evidence/theme-modes-20261019");
const BASE = process.env.PREVIEW_ORIGIN ?? "http://localhost:5183";
const ID = "local-theme-modes";

await mkdir(OUT, { recursive: true });

const MARKDOWN = `# 阅读、理解与留下想法

阅读不只是获取信息，也是把新的内容与已有经验联系起来。一个好的阅读器，应当让人能够专注于文字，在需要时获得解释，并留下自己的思考。这句话看起来平常，但它其实把阅读拆成了两件不同的事：接收，以及接进已有的理解里。

## 一、Markdown 的阅读体验

Markdown 用简单的标记表达重要观点、**强调**、*倾斜*、\`行内代码\`、~~已删除的内容~~与[参考链接](https://example.com)。阅读时，这些标记应当成为清晰的排版。

- 清晰的标题与目录
- 舒服的正文宽度和行距
- 可以回到原文的笔记

> 读到值得停下来的地方，就在原文旁留下一句话。批注不是读后感，它锚定在某一段上。

\`\`\`ts
export function resolveTheme(theme) {
  return theme === "system" ? systemPrefers() : theme;
}
\`\`\`

## 二、划线、选区与定位

下面一行用同一种颜色演示三种划线样式：水彩底纹、直线下划与波浪线。

四种颜色并排出现：黄色、绿色、蓝色与红色。拖选这段文字即可看到选区颜色。
`;

const parsed = parseLocalMarkdown(MARKDOWN);
if (!parsed.ok) throw new Error(`sample markdown did not parse: ${parsed.code}`);
const blocks = parsed.document.blocks;

function highlight(color, style, needle, span) {
  const block = blocks.find((b) => b.text.includes(needle));
  const start = block.text.indexOf(span);
  return {
    id: `hl-${color}-${style}`,
    articleId: ID,
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
  highlight("yellow", "watercolor", "下面一行", "水彩底纹"),
  highlight("green", "line", "下面一行", "直线下划"),
  highlight("blue", "curve", "下面一行", "波浪线"),
  highlight("yellow", "watercolor", "四种颜色并排出现", "黄色"),
  highlight("green", "watercolor", "四种颜色并排出现", "绿色"),
  highlight("blue", "watercolor", "四种颜色并排出现", "蓝色"),
  highlight("red", "watercolor", "四种颜色并排出现", "红色"),
];

const SEED = {
  state: {
    articles: {
      [ID]: {
        id: ID,
        title: parsed.document.title,
        paragraphs: blocks,
        createdAt: Date.now(),
        syncSource: "local",
      },
    },
    notes: {},
    highlights: Object.fromEntries(highlights.map((h) => [h.id, h])),
    ownerUserId: "anonymous",
    highlightColor: "yellow",
  },
  version: 2,
};

const browser = await chromium.launch();
const results = [];

for (const viewport of [
  { tag: "desktop", width: 1440, height: 1000 },
  { tag: "narrow", width: 390, height: 844 },
]) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  await context.addInitScript((seed) => {
    localStorage.setItem("gloss-storage", JSON.stringify(seed));
    localStorage.removeItem("gloss-theme");
  }, SEED);

  const page = await context.newPage();
  await page.goto(`${BASE}/#/r/${ID}`, { waitUntil: "load" });
  await page.waitForSelector(".gloss-prose");
  await page.waitForTimeout(400);

  const read = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const btn = document.querySelector("[aria-label^='切换到']");
      return {
        attr: document.documentElement.getAttribute("data-theme"),
        colorScheme: document.documentElement.style.colorScheme,
        bg: cs.getPropertyValue("--bg").trim(),
        text: cs.getPropertyValue("--text").trim(),
        surface: cs.getPropertyValue("--surface").trim(),
        accent: cs.getPropertyValue("--accent").trim(),
        buttonLabel: btn ? btn.getAttribute("aria-label") : null,
        stored: localStorage.getItem("gloss-theme"),
      };
    });

  const first = await read();
  results.push({ where: `reader:${viewport.tag}:initial`, ...first });

  await page.screenshot({ path: path.join(OUT, `reader-${first.attr}-${viewport.tag}.png`) });

  // One click must flip the mode, and only the mode.
  await page.click("[aria-label^='切换到']");
  await page.waitForTimeout(400);
  const second = await read();
  results.push({ where: `reader:${viewport.tag}:after-one-click`, ...second });

  await page.screenshot({ path: path.join(OUT, `reader-${second.attr}-${viewport.tag}.png`) });

  await context.close();
}

await browser.close();

for (const r of results) {
  console.log(
    `${r.where.padEnd(36)} data-theme=${String(r.attr).padEnd(6)} bg=${r.bg.padEnd(11)} text=${r.text.padEnd(11)} colorScheme=${r.colorScheme} 按钮="${r.buttonLabel}"`,
  );
}

const { writeFile } = await import("node:fs/promises");
await writeFile(
  path.join(OUT, "modes.json"),
  JSON.stringify(results, null, 2) + "\n",
);

// The two assertions the change is actually about.
const initial = results.find((r) => r.where === "reader:desktop:initial");
const afterClick = results.find((r) => r.where === "reader:desktop:after-one-click");
if (initial.attr !== "night") throw new Error(`expected the default mode to be night, got ${initial.attr}`);
if (afterClick.attr !== "day") throw new Error(`expected one click to reach day, got ${afterClick.attr}`);
if (!afterClick.stored.includes('"day"')) throw new Error(`the flip did not persist: ${afterClick.stored}`);
console.log("\n✔ 默认 night，一次点击到 day，且已持久化");
