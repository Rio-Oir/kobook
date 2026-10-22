// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** 实测应用里每个平面实际用了哪个 token，以及它相对阅读面的方向。 */
import { chromium } from "playwright";
import { parseLocalMarkdown } from "../../src/lib/local-import-parse.ts";

const BASE = "http://localhost:5183";
const ID = "local-planes";
const md = "# 阅读、理解与留下想法\n\n阅读不只是获取信息，也是把新的内容与已有经验联系起来。\n\n## 一、Markdown 的阅读体验\n\nMarkdown 用简单的标记表达重要观点、**强调**、*倾斜*、`行内代码`。\n";
const blocks = parseLocalMarkdown(md).document.blocks;
const SEED = { state: { articles: { [ID]: { id: ID, title: "阅读、理解与留下想法", paragraphs: blocks, createdAt: Date.now(), syncSource: "local" } }, notes: {}, highlights: {}, ownerUserId: "anonymous", highlightColor: "yellow" }, version: 2 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((s) => { localStorage.setItem("gloss-storage", JSON.stringify(s)); localStorage.setItem("gloss-theme", JSON.stringify({ state: { theme: "light", ownerUserId: "anonymous" }, version: 2 })); }, SEED);
const page = await ctx.newPage();
await page.goto(`${BASE}/#/r/${ID}`, { waitUntil: "load" });
await page.waitForSelector(".gloss-prose");
await page.waitForTimeout(300);

const probe = await page.evaluate(() => {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const out = [];
  const named = [
    ["顶栏", "header"],
    ["正文区", ".gloss-prose"],
    ["摘要卡", ".gloss-prose ~ * , [class*='border-dashed']"],
  ];
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { sel, bg: cs.backgroundColor, shadow: cs.boxShadow.slice(0, 30), z: cs.zIndex, pos: cs.position };
  };
  for (const s of ["header", ".gloss-prose", "aside[data-testid='notes-panel']", "main"]) {
    const r = pick(s);
    if (r) out.push(r);
  }
  return { bgVar: bg, planes: out };
});

console.log("阅读面 --bg =", probe.bgVar);
console.log();
for (const p of probe.planes) {
  console.log(`${p.sel.padEnd(38)} background=${p.bg.padEnd(22)} position=${p.pos} z=${p.z}`);
}

// 打开设置面板，看一个明确的浮层
await page.click("button[aria-label='设置']").catch(() => {});
await page.waitForTimeout(500);
const panel = await page.evaluate(() => {
  const el = document.querySelector("[class*='gloss-surface2']");
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { cls: el.className.slice(0, 60), bg: cs.backgroundColor };
});
console.log("\n设置面板背景 =", JSON.stringify(panel));
await page.screenshot({ path: "docs/evidence/theme-20261019/_planes-settings.png" });
await browser.close();
