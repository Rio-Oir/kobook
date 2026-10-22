// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading-layout browser gate.
 *
 * What only a browser can prove, and why this suite exists:
 *
 *   - the *rendered* font size, line height, column width and paragraph gap,
 *     after CSS custom properties, a Tailwind Typography plugin scope and a
 *     media query have all had their say. A unit test can assert the numbers
 *     the store hands to CSS; only the browser can say what the browser did
 *     with them;
 *   - that nothing on the page scrolls sideways at 390px, which is a claim
 *     about the whole document, not about any one rule;
 *   - that a text selection still maps back to the same character offsets
 *     the highlight was stored with. This is the reader's one hard
 *     invariant, and the Typography plugin is exactly the kind of change
 *     that can break it: its default styles render literal backticks around
 *     inline code as generated content, which `Range.toString()` counts in
 *     Chromium. The check here builds a real `Range` over real rendered
 *     text and runs the app's own `rangeToOffsets` over it;
 *   - that changing the font size leaves the reader on the paragraph they
 *     were reading rather than on whatever pixel used to hold it.
 *
 * The app is started from source through Vite on a dynamic port and torn
 * down at the end. No backend, no database, no network access: the article
 * is seeded into the real store through the same module the app uses.
 *
 * Run: node tests/reading-layout-browser.mjs
 *      node tests/reading-layout-browser.mjs --only 4      # 只跑第 4 节
 *      node tests/reading-layout-browser.mjs --only 4,6
 *      node tests/reading-layout-browser.mjs --only 4-6
 *      node tests/reading-layout-browser.mjs --list
 *
 * ## Sections
 *
 * About 45 seconds when it passes — most of that is Vite and Chromium
 * starting, and one section alone is 26 of those seconds — and longer when
 * it does not: a section that hangs spends 30 seconds in
 * `waitForSelector` before it fails. So a change to one behaviour needs
 * one section, and every section can be selected on its own. Two reasons,
 * and the second is the bigger one:
 *
 *   - 20 seconds a run, on a suite that gets run many times an hour;
 *   - a section nobody touched cannot fail the run. This file lives in a
 *     worktree that another agent edits, so an unrelated section hanging
 *     on their half-saved file used to cost minutes and say nothing about
 *     the change under test.
 *
 * A partial run is deliberately a different thing from the acceptance run:
 *
 *   - it writes to `reading-layout-v1-partial/`, never to the canonical
 *     evidence directory, so it cannot overwrite or be mistaken for what a
 *     full run produced;
 *   - `result.json` records which sections ran;
 *   - the closing line says so instead of printing "passed".
 *
 * Each section stands on its own: it sets its own viewport, opens the
 * article and resets the rail state, so it cannot depend on the section
 * before it having run. The guards are written `if (wanted(n))` followed by
 * the section's own statement — the sections were already bare blocks and
 * loops, and re-indenting a thousand lines to put each in a function would
 * have been a much larger diff than the convenience is worth.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Section number → what it proves. `--list` prints this. */
const SECTION_NAMES = {
  1: "三个视口的默认值（字号 / 行高 / 段距 / 排版保真）",
  2: "笔记栏在 lg 以上可见、正文居中、开关把宽度还给正文",
  3: "设置：应用 / 刷新后保持 / 复位",
  4: "正文列两侧边界可拖动，栏可被推走",
  5: "改排版设置后阅读位置不变",
  6: "高亮与正文对齐（渲染文本 = 存储文本）",
  7: "长内容不撑宽页面",
};

const argv = process.argv.slice(2);
const onlyArg = (() => {
  const i = argv.indexOf("--only");
  if (i >= 0) return argv[i + 1] ?? "";
  const inline = argv.find((a) => a.startsWith("--only="));
  return inline === undefined ? null : inline.slice("--only=".length);
})();

if (argv.includes("--list")) {
  for (const [n, name] of Object.entries(SECTION_NAMES)) {
    console.log(`${n}  ${name}`);
  }
  process.exit(0);
}

/** `null` = run everything. */
const selected = (() => {
  if (onlyArg === null) return null;
  const set = new Set();
  for (const part of String(onlyArg).split(",")) {
    const token = part.trim();
    if (token === "") continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) set.add(n);
    } else if (/^\d+$/.test(token)) {
      set.add(Number(token));
    } else {
      console.error(`--only: 看不懂 "${token}"（用 4 / 4,6 / 4-6）`);
      process.exit(2);
    }
  }
  const known = Object.keys(SECTION_NAMES).join(", ");
  for (const n of set) {
    if (!(n in SECTION_NAMES)) {
      console.error(`--only: 没有第 ${n} 节。可用：${known}`);
      process.exit(2);
    }
  }
  if (set.size === 0) {
    console.error(`--only: 一节都没选。可用：${known}`);
    process.exit(2);
  }
  return set;
})();

const partial = selected !== null;
const sectionsRun = [];

/** Whether this section is being run. Called once per section. */
function wanted(n) {
  if (selected !== null && !selected.has(n)) return false;
  sectionsRun.push(n);
  return true;
}

const evidenceDir = join(
  root,
  "docs",
  "evidence",
  partial ? "reading-layout-v1-partial" : "reading-layout-v1",
);

const ARTICLE_ID = "local-reading-layout-fixture";

/**
 * The sample article.
 *
 * Chosen for the things the first version has to survive rather than for
 * being pleasant: a long title with no break opportunity, a paragraph of
 * several hundred Chinese characters, both list kinds, a code line wider
 * than the column, a blockquote, a pasted URL, and repeated paragraph text
 * (which is what the block-id tiebreak exists for).
 */
function fixtureArticle() {
  const LONG_CN =
    "这是一段用来检查中文长段落阅读体验的文字。中文正文的每一行大约排三十个全角字符，行与行之间保持一点八倍的行高，" +
    "段与段之间留出不到一个字高的间距。句子中间会夹杂 English words and 1234 numbers，用来观察中英混排时的基线，" +
    "以及标点符号，比如逗号、顿号、分号；还有括号（像这样）和引号“像这样”。排版的目标不是把整页塞满，" +
    "而是让视线在一行结束之后能够顺畅地找到下一行的开头。如果行长过宽，回行时容易串行；如果行距过紧，" +
    "长段落会显得拥挤。这里重复足够多的内容，使段落足以折行若干次，便于测量真实的文字列宽度与行高。";

  const paragraphs = [
    { index: 1, text: "第一版正文阅读排版", hash: "h01", type: "heading", level: 1 },
    { index: 2, text: "你好。", hash: "h02", type: "paragraph" },
    { index: 3, text: LONG_CN, hash: "h03", type: "paragraph" },
    {
      index: 4,
      text: "这一段包含行内标记：加粗、斜体、行内代码和删除线，以及一个很长的链接地址。",
      hash: "h04",
      type: "paragraph",
      spans: [
        { start: 9, end: 11, kinds: ["strong"] },
        { start: 12, end: 14, kinds: ["em"] },
        { start: 15, end: 19, kinds: ["code"] },
        { start: 20, end: 23, kinds: ["del"] },
        {
          start: 33,
          end: 76,
          kinds: ["link"],
          href: "https://example.com/a/very/long/path/that/keeps/going/without/any/break/opportunity/at/all?query=1",
        },
      ],
    },
    { index: 5, text: "列表与代码", hash: "h05", type: "heading", level: 2 },
    { index: 6, text: "无序列一", hash: "h06", type: "listItem", ordered: false },
    {
      index: 7,
      text: "无序列二，含加粗片段",
      hash: "h07",
      type: "listItem",
      ordered: false,
      spans: [{ start: 7, end: 11, kinds: ["strong"] }],
    },
    { index: 8, text: "有序一", hash: "h08", type: "listItem", ordered: true },
    { index: 9, text: "有序二", hash: "h09", type: "listItem", ordered: true },
    {
      index: 10,
      text: "const aVeryLongIdentifierName = computeSomething(withAnEquallyLongArgumentName, andAnotherOne); // 这一行代码比正文列宽很多",
      hash: "h10",
      type: "code",
      lang: "ts",
    },
    {
      index: 11,
      text: "引用的中文句子不应该被合成斜体，否则字形会被拉歪，反而更难读。",
      hash: "h11",
      type: "quote",
    },
    { index: 12, text: "重复段落。", hash: "h12", type: "paragraph" },
    { index: 13, text: "重复段落。", hash: "h13", type: "paragraph" },
    // Screenshot excerpt only; this is not the user's stored document.
    {
      index: 14,
      text: "佛告須菩提說：****‘諸菩薩、摩訶薩等應按照我下面所說的方法。’",
      hash: "h14",
      type: "paragraph",
      spans: [{ start: 0, end: 36, kinds: ["strong"] }],
    },
  ];

  return {
    id: ARTICLE_ID,
    url: "https://example.com/reading-layout",
    title: "正文阅读排版第一版：长标题不换行也不横向溢出的一整句话",
    author: "测试",
    publishedAt: "2026-10-19",
    paragraphs,
    createdAt: Date.now(),
  };
}

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

/** Read the things a reading layout is actually judged on. */
const PAGE_METRICS = `(() => {
  const column = document.querySelector('[data-testid="reading-column"]');
  const body = document.querySelector('.gloss-prose');
  const para = document.querySelector('.gloss-prose p[data-paragraph-index]');
  const prose = document.querySelector('.gloss-prose');
  const marker = para.querySelector('[data-paragraph-marker]');
  const cs = getComputedStyle(para);
  const rect = para.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const main = document.querySelector('main');
  return {
    fontFamily: cs.fontFamily,
    // The body size is the prose container's: a heading's computed size is
    // its own multiple of it, and the first block is a heading here.
    fontSizePx: parseFloat(getComputedStyle(prose).fontSize),
    lineHeightPx: parseFloat(cs.lineHeight),
    marginBottomPx: parseFloat(cs.marginBottom),
    paragraphFontSizePx: parseFloat(cs.fontSize),
    paragraphGapVar: getComputedStyle(column).getPropertyValue('--reading-para-gap'),
    paragraphTag: para.tagName + '/' + para.dataset.paragraphIndex + '/' + para.dataset.blockKind,
    paddingLeftPx: parseFloat(cs.paddingLeft),
    paddingRightPx: parseFloat(cs.paddingRight),
    // The measured text column: the paragraph's content box. The gutter is
    // padding, so it is subtracted — a "30 character" column that silently
    // loses 2rem to padding is not 30 characters.
    textWidthPx: rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    columnWidthPx: column.getBoundingClientRect().width,
    mainWidthPx: main.getBoundingClientRect().width,
    viewportWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    markerText: marker.textContent,
    markerRightOf: markerRect.right,
    paragraphTextLeft: rect.left + parseFloat(cs.paddingLeft),
    markerBox: {
      left: Math.round(markerRect.left),
      right: Math.round(markerRect.right),
      width: Math.round(markerRect.width),
      height: Math.round(markerRect.height),
      fontSizePx: parseFloat(getComputedStyle(marker).fontSize),
    },
    notesPanel: (() => {
      const panel = document.querySelector('[data-testid="notes-panel"]');
      if (!panel) return null;
      return {
        role: panel.getAttribute('role'),
        widthPx: panel.getBoundingClientRect().width,
        fixed: getComputedStyle(panel).position === 'fixed',
      };
    })(),
    readingPrefsBlob: localStorage.getItem('gloss-reading'),
    // The layout decision, and the arithmetic behind it, so a failure here
    // names the number that was wrong instead of only the verdict.
    notesBeside: (() => {
      const row = document.querySelector('[data-testid="reading-row"]');
      const main = document.querySelector('main');
      const prose = document.querySelector('.gloss-prose');
      const block = document.querySelector('.gloss-prose [data-paragraph-index]');
      const outline = document.querySelector('[data-testid="outline-sidebar"]');
      if (!row || !main || !prose || !block) return { decision: row ? row.dataset.notesBeside : null };
      const fontSize = parseFloat(getComputedStyle(prose).fontSize);
      const gutter = parseFloat(getComputedStyle(block).paddingLeft);
      const sidePadding = parseFloat(getComputedStyle(main).paddingLeft);
      const measure = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--reading-measure'),
      );
      const outlineWidth = outline ? outline.getBoundingClientRect().width : 0;
      return {
        decision: row.dataset.notesBeside,
        rowWidth: row.getBoundingClientRect().width,
        outlineWidth,
        fontSize,
        gutter,
        sidePadding,
        measure,
        column: measure * fontSize + 2 * gutter,
        available: row.getBoundingClientRect().width - outlineWidth,
      };
    })(),
    // Anything sticking out past the viewport. Recorded rather than merely
    // asserted on, because "the page scrolls sideways" is never actionable
    // without the name of the element that did it.
    overflowOffenders: (() => {
      const vw = window.innerWidth;
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 || r.left < -1) {
          out.push({
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 60),
            left: Math.round(r.left),
            right: Math.round(r.right),
          });
        }
      }
      return out.slice(0, 12);
    })(),
  };
})()`;

let vite;
let browser;

const results = {
  generatedAt: new Date().toISOString(),
  command: "node tests/reading-layout-browser.mjs",
  article: ARTICLE_ID,
  viewports: {},
  settings: {},
  notesPanel: {},
  position: {},
  highlight: {},
  overflow: {},
  screenshots: [],
};

try {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  vite = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { stdio: "ignore", windowsHide: true, cwd: root },
  );
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, `Vite did not start on the dynamic port ${port}`);

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  await mkdir(evidenceDir, { recursive: true });

  /**
   * Capture evidence.
   *
   * The settle delay is not cosmetic: the notes drawer and the settings
   * popover fade in over 200ms, and a screenshot taken mid-animation shows
   * a half-transparent panel that looks like a layout bug. Every panel in
   * this reader animates in, so every screenshot waits.
   */
  async function shoot(name, opts = {}) {
    await delay(320);
    const file = join(evidenceDir, `${name}.png`);
    await page.screenshot({ path: file, ...opts });
    results.screenshots.push({ name: `${name}.png`, viewport: page.viewportSize() });
  }

  /** Seed the fixture into the real store, then open it in the Reader. */
  async function openArticle() {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(async (article) => {
      const store = await import("/src/lib/store.ts");
      // The text is a body now; `saveArticle` is the one call that installs
      // the record and the text together, and it is asynchronous.
      const { paragraphs, ...record } = article;
      await store.useStore.getState().saveArticle(record, paragraphs);
    }, fixtureArticle());
    await page.goto(`${url}/#/r/${ARTICLE_ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="reading-column"]');
    await page.waitForSelector(".gloss-prose p[data-paragraph-index]");
  }

  async function metrics() {
    return page.evaluate(PAGE_METRICS);
  }

  /**
   * Back to a reader who has never dragged: both rails on screen, 30
   * characters, centred.
   *
   * Written through the stores rather than by clearing localStorage,
   * because `gloss-storage` also holds the article the fixture just saved.
   * Every block below that measures the layout starts here, so one block's
   * drag cannot decide another block's expectations.
   */
  async function resetRails() {
    await page.evaluate(async () => {
      const reading = await import("/src/lib/reading-prefs.ts");
      reading.useReadingPrefs.getState().reset();
      const store = await import("/src/lib/store.ts");
      store.useStore.getState().setOutlineOpen(true);
    });
    await delay(60);
  }



  /**
   * Flip one rail's switch.
   *
   * 目录 and 笔记栏 are no longer two icon buttons in the header: they are
   * two switches inside the reading-settings popover, which is where a
   * *view preference* belongs and which keeps the header down to four
   * controls. So driving them is open-panel → flip → close-panel, and the
   * close matters: the popover's click-away layer covers the viewport, and
   * a switch left open would swallow the next click the test makes
   * somewhere else on the page.
   *
   * `target` defaults to `page`; the phone block drives `touchPage`.
   */
  async function toggleRail(testid, target = page) {
    const panel = target.locator('[data-testid="reading-settings"]');
    if ((await panel.count()) === 0) {
      await target.click('[data-testid="reading-settings-toggle"]');
      await target.waitForSelector('[data-testid="reading-settings"]');
    }
    await target.click(`[data-testid="${testid}"]`);
    await target.keyboard.press("Escape");
    await target.waitForSelector('[data-testid="reading-settings"]', { state: "detached" });
    await delay(60);
  }

  // ── 1. The defaults at the three viewports the requirement names ───────
  if (wanted(1))
  for (const [label, width, height] of [
    ["mobile-390", 390, 844],
    ["tablet-1024", 1024, 800],
    ["desktop-1440", 1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await openArticle();
    const m = await metrics();
    results.viewports[label] = m;

    // The agreed starting points: 20px desktop, 18px phone, 1.8 line height,
    // 0.8em paragraph gap.
    const expectedFont = width >= 768 ? 20 : 18;
    assert.equal(m.fontSizePx, expectedFont, `${label}: body font size`);
    assert.ok(
      Math.abs(m.lineHeightPx / m.fontSizePx - 1.8) < 0.02,
      `${label}: line height ratio, got ${m.lineHeightPx / m.fontSizePx}`,
    );
    assert.ok(
      Math.abs(m.marginBottomPx - 0.8 * m.fontSizePx) < 0.6,
      `${label}: paragraph gap, got ${m.marginBottomPx}`,
    );

    const pagePadding = width >= 768 ? 64 : 40;
    // The text box is the column less both 2rem gutters (the left one holds
    // the paragraph numbers; the right one mirrors it so the text is centred
    // in the column rather than hugging its right edge).
    const expectedWidth = Math.min(
      600,
      m.mainWidthPx - pagePadding - 2 * m.paddingLeftPx,
    );
    assert.ok(Math.abs(m.textWidthPx - expectedWidth) <= 1,
      label + ': column must fit the restored sidebar layout');
    assert.equal(m.paddingLeftPx, 32, label + ': original paragraph gutter');
    assert.equal(
      m.paddingRightPx,
      m.paddingLeftPx,
      label + ': the right gutter mirrors the number gutter',
    );
    assert.equal(m.markerBox.fontSizePx, 12, label + ': original number size');
    assert.ok(m.markerRightOf <= m.paragraphTextLeft + 1, label + ': no number/text overlap');

    // The paragraph number lifts when you point at its paragraph, and
    // stays quiet otherwise.
    //
    // Worth a browser for one specific reason: the hover rule carries a
    // `:not([data-has-note])` guard, because the hover selector has one
    // more simple selector than the note rule below it and would
    // otherwise out-specify the accent and dim the one number that has
    // to stay lit. Asserted as "alpha rises, hue holds" rather than as a
    // colour string, since the channels come from the theme variables.
    const markerColor = (index) =>
      page.evaluate((i) => {
        const el = document.querySelector(
          `.gloss-prose [data-paragraph-index="${i}"] > [data-paragraph-marker]`,
        );
        return getComputedStyle(el).color;
      }, index);
    const channels = (color) => {
      const inner = color.match(/rgba?\(([^)]+)\)/);
      assert.ok(inner, `unparsable computed colour: ${color}`);
      const parts = inner[1].split(/[,/]/).map((part) => part.trim());
      return { rgb: parts.slice(0, 3).join(","), alpha: parts.length > 3 ? Number(parts[3]) : 1 };
    };

    const restColor = channels(await markerColor(3));
    await page.hover('.gloss-prose [data-paragraph-index="3"]');
    // The marker transitions its colour, and `getComputedStyle` reports
    // the value mid-transition rather than the value it is heading for.
    await page.waitForTimeout(300);
    const hoverColor = channels(await markerColor(3));
    assert.ok(
      hoverColor.alpha > restColor.alpha,
      `${label}: the number should lift on hover (${restColor.alpha} → ${hoverColor.alpha})`,
    );
    assert.equal(
      hoverColor.rgb,
      restColor.rgb,
      `${label}: hover must not take the number into another colour role`,
    );

    // Nothing may scroll sideways.
    assert.ok(
      m.docScrollWidth <= width + 1,
      `${label}: horizontal overflow (${m.docScrollWidth} > ${width}): ` +
        JSON.stringify(m.overflowOffenders),
    );

    const preserved = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('.gloss-prose [data-paragraph-index]')];
      const text = blocks.map((block) => {
        const clone = block.cloneNode(true);
        clone.querySelectorAll('[data-paragraph-marker]').forEach((marker) => marker.remove());
        return clone.textContent;
      });
      const plain = document.querySelector('.gloss-prose p[data-paragraph-index="2"]');
      const emphasized = document.querySelector('.gloss-prose p[data-paragraph-index="14"] strong');
      const headingSpacing = [...document.querySelectorAll('.gloss-reading-column h1, .gloss-prose h2, .gloss-prose h3')]
        .map((el) => getComputedStyle(el).letterSpacing);
      const column = document.querySelector('[data-testid="reading-column"]');
      column.style.fontFamily = 'monospace';
      const inheritedFont = getComputedStyle(plain).fontFamily;
      column.style.removeProperty('font-family');
      return { text, inheritedFont, headingSpacing,
        plainWeight: getComputedStyle(plain).fontWeight,
        strongWeight: getComputedStyle(emphasized).fontWeight,
      };
    });
    assert.deepEqual(preserved.text, fixtureArticle().paragraphs.map((p) => p.text), `${label}: preserve every original character`);
    assert.equal(preserved.plainWeight, '400', `${label}: plain text must not become bold`);
    assert.ok(Number(preserved.strongWeight) >= 600, `${label}: source emphasis must remain bold`);
    // The serif stack is system-local on purpose: `f927cbc` removed the
    // Google Fonts request (and with it Newsreader), so the shipped stack is
    // Charter → Georgia → Noto Serif SC.
    assert.ok(preserved.inheritedFont.includes('Charter'), label + ': reader font stack');
    assert.ok(preserved.headingSpacing.every((spacing) => spacing === 'normal' || parseFloat(spacing) === 0), `${label}: heading letter spacing`);
    results.viewports[label].contentPreservation = preserved;

    await shoot(`reader-${label}`);
    // The whole document, so the lists, code block, quote and link are all
    // in the evidence rather than only the first screenful.
    await shoot(`reader-${label}-full`, { fullPage: true });
  }

  // ── 2. The notes rail, and the article staying centred ────────────────
  const runSection2 = wanted(2);

  // The notes rail is on screen from lg, and a blob written before
  // `notesOpen` meant anything cannot take it away.
  if (runSection2)
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openArticle();
    await resetRails();
    const panel = page.locator('[data-testid="notes-panel"]');
    assert.equal(await panel.isVisible(), width >= 1024);
    assert.equal(await page.locator('[data-testid="notes-toggle"]').count(), 0);
    assert.equal(await page.locator('[role="dialog"][aria-label="笔记"]').count(), 0);
    if (width >= 1024) {
      // The rails take whatever the article leaves, split evenly. There is
      // no floor any more: at 1024 the default 30 characters is 728px, so
      // the rails get 148px each — which is above `RAIL_MIN_PX` (140), the
      // width at which a rail stops drawing its content.
      assert.ok(
        (await panel.boundingBox()).width >= 140,
        `${width}: the notes rail must be wide enough to draw`,
      );
      await page.keyboard.press("Escape");
      assert.equal(await panel.isVisible(), true);
      const side = await panel.boundingBox();
      const main = await page.locator('main').boundingBox();
      assert.ok(main.x + main.width <= side.x + 1);

      // `notesOpen: false` was the default in v1 and nothing read it — the
      // rail was drawn at every width — so an upgrade must not read it as
      // "the reader hid their notes". Handed in as a v1 blob, because that
      // is the only way to produce one; writing it through the store would
      // be a v2 choice and would mean something.
      await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem('gloss-reading') || '{"state":{}}');
        localStorage.setItem('gloss-reading', JSON.stringify({
          state: { ...raw.state, notesOpen: false },
          version: 1,
        }));
      });
      await page.reload();
      await page.waitForSelector('[data-testid="reading-column"]');
      assert.ok(
        (await panel.boundingBox()).width >= 140,
        `${width}: a v1 blob's notesOpen must not take the rail away`,
      );
      await shoot("notes-restored-" + width);
    }
    results.notesPanel[width] = { visible: await panel.isVisible(), width: width >= 1024 ? (await panel.boundingBox()).width : 0 };
  }

  // The reading area is centred at the width the reader chose, and the
  // outline's presence has nothing to do with either. This is the property
  // that keeps a document with no outline — or a reader who keeps the
  // outline closed — from ending up with the article shoved against the
  // left edge.
  results.centering = {};
  if (runSection2)
  for (const width of [1024, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 });
    await openArticle();
    await resetRails();
    const readLayout = () => page.evaluate(() => {
      const main = document.querySelector('main').getBoundingClientRect();
      const column = document.querySelector('[data-testid="reading-column"]').getBoundingClientRect();
      return { center: main.x + main.width / 2, viewportCenter: document.documentElement.clientWidth / 2,
        paperWidth: main.width, columnWidth: column.width, left: main.x,
        columnCenter: column.x + column.width / 2 };
    });
    const before = await readLayout();
    assert.ok(Math.abs(before.center - before.viewportCenter) <= 1, 'paper centered in window');
    assert.ok(Math.abs(before.columnCenter - before.center) <= 1, 'column centered in paper');
    assert.ok(before.paperWidth - before.columnWidth <= 65, 'wide screens must not grow paper padding');
    await page.getByRole('button', { name: '隐藏目录', exact: true }).click();
    assert.equal(await page.locator('[data-testid="outline-sidebar"]').count(), 0);
    await delay(120);
    const closed = await readLayout();
    // Hiding the outline is a visibility change and nothing else. The track
    // it was drawn in is still there, the article is still centred, and it
    // is still the width the reader chose: a rail's visibility is not
    // allowed to move the reading area.
    assert.equal(
      Math.round(closed.paperWidth),
      Math.round(before.paperWidth),
      `hiding the outline must not resize the article: ${before.paperWidth} → ${closed.paperWidth}`,
    );
    assert.ok(
      Math.abs(closed.center - closed.viewportCenter) <= 1,
      `and the paper is still centred: ${closed.center} vs ${closed.viewportCenter}`,
    );
    assert.ok(
      Math.abs(closed.left - before.left) <= 1,
      `and it has not moved: ${before.left} → ${closed.left}`,
    );
    await shoot('outline-closed-' + width);
    await page.getByRole('button', { name: '显示目录', exact: true }).click();
    await delay(120);
    const reopened = await readLayout();
    assert.equal(
      Math.round(reopened.paperWidth),
      Math.round(before.paperWidth),
      'and bringing it back changes nothing either',
    );
    results.centering[width] = { before, closed, reopened };
  }

  // ── 3. Settings: apply, persist across a reload, and reset ────────────
  if (wanted(3)) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArticle();

    await page.click('[data-testid="reading-settings-toggle"]');
    await page.waitForSelector('[data-testid="reading-settings"]');
    await shoot("reading-settings-desktop-1440");

    const initialFont = (await metrics()).fontFamily;
    assert.equal(await page.locator('[data-testid="reading-font-serif"]').count(), 0);
    await page.selectOption('[data-testid="reading-font-size"]', "22");
    await page.selectOption('[data-testid="reading-line-height"]', "1.95");
    await page.fill('[data-testid="reading-measure"]', "26");
    await page.selectOption('[data-testid="reading-paragraph-gap"]', "1");

    const chosen = await metrics();
    results.settings.chosen = chosen;
    assert.equal(chosen.fontSizePx, 22, "font size 22px must be applied");
    assert.ok(
      Math.abs(chosen.lineHeightPx - 22 * 1.95) < 0.6,
      `line height 1.95 × 22px, got ${chosen.lineHeightPx}`,
    );
    assert.ok(
      Math.abs(chosen.marginBottomPx - 22) < 0.6,
      `paragraph gap 1.0em × 22px, got ${chosen.marginBottomPx} ${JSON.stringify({pfs:chosen.paragraphFontSizePx, gapVar:chosen.paragraphGapVar, tag:chosen.paragraphTag})}`,
    );
    assert.equal(chosen.fontFamily, initialFont);
    assert.equal(chosen.paddingLeftPx, 32, "the desktop gutter is not a user setting");
    // 26 characters at 22px = 572px of text, plus the two 2rem gutters.
    assert.ok(
      Math.abs(chosen.textWidthPx - 572) <= 1,
      `measure 26 × 22px = 572px, got ${chosen.textWidthPx}`,
    );

    // No cap any more, and this is the combination that used to hit one.
    //
    // There was a 50rem ceiling here, and it had two effects that both had
    // to go: it re-capped a width the reader had dragged to, and — because
    // the three tracks have to fill the row — the room it refused the
    // article was handed to the other rail. 34 characters at 24px is 816px of
    // text, plus the two gutters = 880px, and that is what is drawn.
    await page.selectOption('[data-testid="reading-font-size"]', "24");
    await page.fill('[data-testid="reading-measure"]', "34");
    const wide = await metrics();
    results.settings.wide = wide;
    assert.equal(wide.fontSizePx, 24, "font size 24px must be applied");
    assert.ok(
      Math.abs(wide.columnWidthPx - 880) <= 1,
      `34 × 24px + two 2rem gutters is 880px, and nothing caps it: got ${wide.columnWidthPx}`,
    );
    assert.ok(
      Math.abs(wide.textWidthPx - 816) <= 1,
      `so the text is the whole 34 × 24px = 816px, got ${wide.textWidthPx}`,
    );

    // Back to the values the stored-blob assertions below expect.
    await page.selectOption('[data-testid="reading-font-size"]', "22");
    await page.fill('[data-testid="reading-measure"]', "26");

    const blob = JSON.parse(chosen.readingPrefsBlob);
    assert.equal(blob.state.fontSizePx, 22);
    assert.equal(blob.state.measure, 26);
    // v2 is where `notesOpen` became the notes rail's visibility; a v1 blob
    // migrates rather than being read as written.
    assert.equal(blob.version, 2);
    results.settings.blob = blob.state;

    await shoot("reader-custom-typography-desktop-1440");

    // Every field is 16px on a touch screen, so iOS Safari does not zoom
    // the page into it on focus and leave it zoomed.
    //
    // A second browser context is the only way to test this. `pointer:
    // coarse` follows the device, and CDP will not emulate it — an
    // `Emulation.setEmulatedMedia` call naming `pointer` is accepted and
    // silently ignored, which is how this check first read 12px.
    const touchContext = await browser.newContext({
      hasTouch: true,
      viewport: { width: 390, height: 844 },
    });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(url, { waitUntil: "domcontentloaded" });
    await touchPage.evaluate(async (article) => {
      const store = await import("/src/lib/store.ts");
      const { paragraphs, ...record } = article;
      await store.useStore.getState().saveArticle(record, paragraphs);
    }, fixtureArticle());
    await touchPage.goto(`${url}/#/r/${ARTICLE_ID}`, { waitUntil: "domcontentloaded" });
    await touchPage.waitForSelector(".gloss-prose p[data-paragraph-index]");
    await touchPage.click('[data-testid="reading-settings-toggle"]');
    await touchPage.waitForSelector('[data-testid="reading-font-size"]');

    const fieldFont = (target) =>
      target.evaluate(() =>
        parseFloat(
          getComputedStyle(document.querySelector('[data-testid="reading-font-size"]')).fontSize,
        ),
      );
    const coarseFont = await fieldFont(touchPage);
    const fineFont = await fieldFont(page);
    await touchContext.close();
    results.settings.touchField = { coarse: coarseFont, fine: fineFont };
    assert.equal(coarseFont, 16, `a field on a touch screen must be 16px, got ${coarseFont}`);
    assert.ok(fineFont < 16, `a field under a fine pointer keeps its own size, got ${fineFont}`);

    // A reload is the only honest test of "preferences are kept".
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".gloss-prose p[data-paragraph-index]");
    const reloaded = await metrics();
    results.settings.afterReload = reloaded;
    assert.equal(reloaded.fontSizePx, 22, "font size must survive a reload");
    assert.equal(reloaded.paddingLeftPx, 32);
    assert.ok(Math.abs(reloaded.textWidthPx - 572) <= 1, "measure must survive a reload");
    assert.equal(reloaded.fontFamily, initialFont);

    // Reset returns to the responsive default, not to a pinned 20px.
    await page.click('[data-testid="reading-settings-toggle"]');
    await page.waitForSelector('[data-testid="reading-reset"]');
    await page.click('[data-testid="reading-reset"]');
    const reset = await metrics();
    results.settings.afterReset = reset;
    assert.equal(reset.fontSizePx, 20, "reset restores the desktop default");
    assert.ok(Math.abs(reset.textWidthPx - 600) <= 1, "reset restores the 30-character measure");
    assert.equal(reset.fontFamily, initialFont);
    const resetBlob = JSON.parse(reset.readingPrefsBlob);
    assert.equal(
      "fontSizePx" in resetBlob.state ? resetBlob.state.fontSizePx : null,
      null,
      "reset must store 'no choice', so a phone gets 18px again",
    );

    // And the phone really does go back to 18px.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".gloss-prose p[data-paragraph-index]");
    assert.equal(
      (await metrics()).fontSizePx,
      18,
      "after reset, the phone default must be 18px again",
    );
  }

  // ── 4. The column edges are draggable ─────────────────────────────────
  //
  // Only a browser can say what the track sizes the Reader writes actually
  // do: that the edge that was dragged is the edge that moved and the far
  // rail did not budge, that the article's own padding is inside the number
  // the drag reports, and that the whole characters it stores are the
  // characters the resulting width really holds.
  if (wanted(4)) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArticle();

    const geometry = () =>
      page.evaluate(() => {
        const layout = document.querySelector(".gloss-reading-layout");
        const main = document.querySelector("main");
        const notes = document.querySelector('[data-testid="notes-panel"]');
        const outline = document.querySelector('[data-testid="outline-sidebar"]');
        const layoutWidth = layout.getBoundingClientRect().width;
        const column = main.getBoundingClientRect().width;
        const rightRail = notes ? notes.getBoundingClientRect().width : 0;
        // Same fallback the Reader uses: the outline rail is not in the
        // DOM at all while the outline is closed.
        const leftRail = outline
          ? outline.getBoundingClientRect().width
          : layoutWidth - column - rightRail;
        const para = document.querySelector(".gloss-prose p[data-paragraph-index]");
        const cs = getComputedStyle(para);
        const stored = JSON.parse(localStorage.getItem("gloss-reading") || "null");
        const shell = JSON.parse(localStorage.getItem("gloss-storage") || "null");
        // A rail that has been pushed out of the way is hidden rather than
        // unmounted, so "is it on screen" is a computed visibility of the
        // rail's own child — the thing `--reading-rail-*-content` sets.
        const railVisible = (rail) =>
          rail && rail.firstElementChild
            ? getComputedStyle(rail.firstElementChild).visibility === "visible"
            : null;
        return {
          viewport: layoutWidth,
          column,
          leftRail,
          rightRail,
          tracks: getComputedStyle(layout).gridTemplateColumns,
          columnVar: getComputedStyle(layout).getPropertyValue("--reading-column-w").trim(),
          inlineColumnVar: layout.style.getPropertyValue("--reading-column-w"),
          inlineLeftContent: layout.style.getPropertyValue("--reading-rail-left-content"),
          outlineRendered: Boolean(outline),
          outlineVisible: railVisible(outline),
          notesVisible: railVisible(notes),
          // The text the reader actually sees: the paragraph's content box,
          // which is the column less the paragraph-number gutter.
          textWidth:
            para.getBoundingClientRect().width -
            parseFloat(cs.paddingLeft) -
            parseFloat(cs.paddingRight),
          measure: stored ? stored.state.measure : null,
          railBalance: stored ? stored.state.railBalance : null,
          notesOpen: stored ? stored.state.notesOpen : null,
          outlineOpen: shell ? shell.state.outlineOpen : null,
        };
      });

    const dragBy = async (side, dx) => {
      const box = await page
        .locator(`[data-testid="column-grip-${side}"]`)
        .boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      // Several moves rather than one jump: a single event would pass even
      // if the handler only ever read the first `pointermove`.
      for (let step = 1; step <= 5; step++) {
        await page.mouse.move(x + (dx * step) / 5, y);
      }
      await page.mouse.up();
      await delay(90);
    };

    // Everything below starts from a reader who has never dragged: both
    // rails on screen, 30 characters, centred.
    await resetRails();

    assert.ok(
      await page.locator('[data-testid="column-grip-left"]').isVisible(),
      "the left handle must be visible at 1440",
    );
    assert.ok(
      await page.locator('[data-testid="column-grip-right"]').isVisible(),
      "the right handle must be visible at 1440",
    );

    const start = await geometry();
    results.grips = { start };

    // The left edge outward: the article widens and the *left* rail gives
    // way. The right rail must not move at all — the gesture means "this
    // edge follows the pointer", not "the article grows evenly".
    //
    // Both drags in this block are sized to stay under the readability
    // cap (an 864px column at 1440), because a drag that hits the clamp
    // would be testing the clamp rather than the gesture.
    await dragBy("left", -80);
    const afterLeft = await geometry();
    results.grips.afterLeftDrag = afterLeft;
    assert.ok(
      afterLeft.column > start.column + 60,
      `dragging the left edge out must widen the article: ${start.column} → ${afterLeft.column}`,
    );
    assert.ok(
      afterLeft.leftRail < start.leftRail - 50,
      `the left rail must give way: ${start.leftRail} → ${afterLeft.leftRail}`,
    );
    // Exactly, not approximately: the snap's half-character comes out of the
    // rail the reader is dragging, so the far one does not twitch at all.
    assert.ok(
      Math.abs(afterLeft.rightRail - start.rightRail) <= 1,
      `the right rail must not move: ${start.rightRail} → ${afterLeft.rightRail}`,
    );
    assert.ok(
      Math.abs(
        afterLeft.leftRail + afterLeft.column + afterLeft.rightRail - afterLeft.viewport,
      ) <= 1,
      "the three tracks must still fill the row exactly",
    );

    // What was stored is a whole number of characters, and the width on
    // screen is the width that number produces — the snap on release and
    // the store agree rather than being half a character apart.
    assert.ok(
      Number.isInteger(afterLeft.measure),
      `the stored measure must be a whole number of characters, got ${afterLeft.measure}`,
    );
    assert.ok(
      afterLeft.measure > start.measure,
      `the measure must have grown: ${start.measure} → ${afterLeft.measure}`,
    );
    assert.ok(
      Math.abs(afterLeft.textWidth - afterLeft.measure * 20) <= 1.5,
      `text width must be the stored measure × font size: ${afterLeft.textWidth} vs ${afterLeft.measure * 20}`,
    );

    // The right edge outward: the mirror image. Deliberately a smaller
    // drag than the first one, because at 1440 the readability cap on the
    // text is reached at an 896px column and a bigger drag would only be
    // testing the clamp. The clamp itself is checked further down.
    const beforeRight = await geometry();
    await dragBy("right", 60);
    const afterRight = await geometry();
    results.grips.afterRightDrag = afterRight;
    assert.ok(
      afterRight.column > beforeRight.column + 50,
      `dragging the right edge out must widen the article: ${beforeRight.column} → ${afterRight.column}`,
    );
    assert.ok(
      afterRight.rightRail < beforeRight.rightRail - 50,
      `the right rail must give way: ${beforeRight.rightRail} → ${afterRight.rightRail}`,
    );
    assert.ok(
      Math.abs(afterRight.leftRail - beforeRight.leftRail) <= 1,
      `the left rail must not move: ${beforeRight.leftRail} → ${afterRight.leftRail}`,
    );
    assert.ok(
      Math.abs(afterRight.textWidth - afterRight.measure * 20) <= 1.5,
      "the snapped width must hold after the second drag too",
    );

    // A drag is a preference like any other, so it has to survive a reload
    // — and survive it as the same width, not as the nearest preset.
    const persisted = afterRight.measure;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".gloss-prose p[data-paragraph-index]");
    const reloaded = await geometry();
    results.grips.afterReload = reloaded;
    await shoot("column-grips-1440");
    assert.equal(
      reloaded.measure,
      persisted,
      "a dragged measure must survive a reload unchanged",
    );
    assert.ok(
      Math.abs(reloaded.textWidth - persisted * 20) <= 1.5,
      "and must still be the width it was dragged to",
    );
    assert.ok(
      Math.abs(reloaded.railBalance - afterRight.railBalance) <= 0.01,
      "the off-centre position must survive too",
    );

    // The keyboard does the same thing one character at a time.
    const beforeKey = await geometry();
    await page.locator('[data-testid="column-grip-left"]').focus();
    await page.keyboard.press("ArrowLeft");
    await delay(90);
    const afterKey = await geometry();
    results.grips.afterKeyboard = afterKey;
    assert.equal(
      afterKey.measure,
      beforeKey.measure + 1,
      "ArrowLeft on the left handle must widen the article by one character",
    );
    assert.ok(
      afterKey.column > beforeKey.column,
      "and the column must actually be wider",
    );
    assert.ok(
      Math.abs(afterKey.rightRail - beforeKey.rightRail) <= 1,
      "a key step moves one edge, exactly as a drag does",
    );
    await page.keyboard.press("ArrowRight");
    await delay(90);
    assert.equal(
      (await geometry()).measure,
      beforeKey.measure,
      "ArrowRight must undo the step",
    );

    // ── The two limits, and what happens at them ──────────────────────
    //
    // The article has a narrowest — the bottom of `MEASURE_RANGE` — and a
    // widest, which is the window less the two handles' lanes. There is no
    // readability cap in between, and that is what this block is about: how
    // wide the line is, is the reader's decision. Nothing here may override
    // it, and nothing may hand the difference to the other rail.

    await resetRails();
    await dragBy("left", 2000);
    const floor = await geometry();
    results.grips.atLeftLimit = floor;
    assert.equal(floor.measure, 20, "the narrowest the article may be dragged to");
    assert.ok(
      Math.abs(floor.leftRail + floor.column + floor.rightRail - floor.viewport) <= 1,
      "the three tracks still fill the row",
    );

    // Outward, all the way: the outline is pushed out of the way and the
    // article takes every pixel of it.
    await dragBy("left", -4000);
    const ceiling = await geometry();
    results.grips.atCeiling = ceiling;
    assert.equal(
      ceiling.leftRail,
      12,
      `a pushed-aside rail keeps only its lane, got ${ceiling.leftRail}`,
    );
    assert.equal(
      Math.round(ceiling.column),
      Math.round(ceiling.viewport - 12 - ceiling.rightRail),
      "the article takes the whole of what the outline gave up",
    );
    assert.ok(
      ceiling.column > 1000,
      `which is past the 800px a readability cap would have allowed: ${ceiling.column}`,
    );
    assert.ok(
      Math.abs(ceiling.textWidth - ceiling.measure * 20) <= 1.5,
      `and the text is what the stored measure says: ${ceiling.textWidth} vs ${ceiling.measure * 20}`,
    );
    // The property the whole gesture rests on. An earlier version stopped
    // the article at a readability cap and handed the leftover to the far
    // rail, so dragging the left edge visibly widened the notes panel.
    //
    // The tolerance is half a character, not 1px: when the dragged rail has
    // been pushed all the way out (a lane has no width to give back), the
    // release snap lands its remainder on the far rail. That is the snap,
    // not the old bug — the bug moved the rail by hundreds of pixels.
    assert.ok(
      Math.abs(ceiling.rightRail - start.rightRail) <= 10.5,
      `the far rail must not move: ${start.rightRail} → ${ceiling.rightRail}`,
    );
    // The outline is gone: its content is hidden, and the store says so —
    // which is what the toolbar button reads, so the gesture and the button
    // cannot disagree.
    assert.equal(ceiling.outlineRendered, false, "the outline is not drawn");
    assert.equal(ceiling.outlineOpen, false, "and the toolbar button agrees");
    assert.equal(
      ceiling.inlineLeftContent,
      "hidden",
      "and its content is hidden while the gesture is still in flight",
    );
    assert.equal(ceiling.notesVisible, true, "the far rail is untouched");
    assert.equal(ceiling.notesOpen, true);
    assert.ok(
      Math.abs(ceiling.leftRail + ceiling.column + ceiling.rightRail - ceiling.viewport) <= 1,
      "the three tracks still fill the row",
    );
    await shoot("column-grips-1440-outline-pushed-aside");

    // And it comes back. The gesture is reversible without a mode: the
    // handle is still there, sitting in the rail's own lane.
    await dragBy("left", 250);
    const reopened = await geometry();
    results.grips.afterReopen = reopened;
    assert.ok(
      reopened.leftRail > 199,
      `dragging back out brings the outline back on screen, got ${reopened.leftRail}`,
    );
    assert.equal(reopened.outlineRendered, true);
    assert.equal(reopened.outlineOpen, true);
    assert.ok(
      reopened.column < ceiling.column - 100,
      `and the article gives the room back: ${ceiling.column} → ${reopened.column}`,
    );
    assert.ok(
      Math.abs(reopened.leftRail + reopened.column + reopened.rightRail - reopened.viewport) <= 1,
      "the three tracks still fill the row",
    );

    // The notes rail is dismissible the same way, from its own edge — and
    // the outline does not move for it either.
    await resetRails();
    await dragBy("right", 4000);
    const notesGone = await geometry();
    results.grips.notesPushedAside = notesGone;
    // "Only its lane" is a lane plus whatever the release snap could not put
    // back into a whole character — the collapsed rail is the only track left
    // to absorb it (up to half a character), and the content is hidden either
    // way. Exactness here was a coincidence of the old column arithmetic.
    assert.ok(
      Math.abs(notesGone.rightRail - 12) <= 10.5,
      `the notes rail keeps only its lane: ${notesGone.rightRail}`,
    );
    assert.equal(notesGone.notesVisible, false);
    assert.equal(notesGone.notesOpen, false);
    assert.equal(notesGone.outlineRendered, true, "the outline is untouched");
    assert.ok(
      Math.abs(notesGone.leftRail - start.leftRail) <= 1,
      `and it did not move: ${start.leftRail} → ${notesGone.leftRail}`,
    );
    assert.ok(
      notesGone.column > 1000,
      `the article took the room: ${notesGone.column}`,
    );
    await shoot("column-grips-1440-notes-pushed-aside");

    // The toolbar button is a *different* thing from a drag, and the
    // difference is the point: it decides whether a rail is drawn and
    // nothing else. Hiding the outline leaves the reading area exactly where
    // it was, which is what keeps a reader who keeps the outline closed —
    // or a document with no outline at all — from ending up with the
    // article shoved against the left edge.
    await resetRails();
    const beforeToggle = await geometry();
    await toggleRail("outline-toggle");
    await delay(120);
    const afterToggle = await geometry();
    results.grips.afterOutlineToggle = afterToggle;
    assert.equal(afterToggle.outlineRendered, false, "the button hides the outline");
    assert.ok(
      Math.abs(afterToggle.column - beforeToggle.column) <= 1,
      `and must not resize the article: ${beforeToggle.column} → ${afterToggle.column}`,
    );
    assert.ok(
      Math.abs(afterToggle.leftRail - beforeToggle.leftRail) <= 1,
      "the track it was drawn in is still there",
    );
    await toggleRail("outline-toggle");
    await delay(120);
    const toggledBack = await geometry();
    assert.equal(toggledBack.outlineRendered, true);
    assert.ok(
      Math.abs(toggledBack.column - beforeToggle.column) <= 1,
      "and showing it again changes nothing either",
    );
    await shoot("column-grips-1440-outline-toggle");

    // Showing a rail the reader had *dragged* shut is the one case where the
    // button has to touch the width: a rail sitting on its lane would come
    // back hidden, and a button that appears to do nothing is worse than one
    // that moves a boundary.
    await dragBy("left", -4000);
    assert.equal((await geometry()).leftRail, 12, "the drag shut the outline");
    await toggleRail("outline-toggle");
    await delay(120);
    const shown = await geometry();
    results.grips.afterShowingShutRail = shown;
    assert.equal(shown.outlineRendered, true);
    assert.ok(
      shown.leftRail >= 140,
      `the button must bring it back wide enough to draw: ${shown.leftRail}`,
    );
    assert.ok(
      shown.column < ceiling.column,
      `and the article gives the room back: ${ceiling.column} → ${shown.column}`,
    );

    // At 1024 there is no cap to bind and no floor to lean on: the rails are
    // simply whatever the article leaves. The default 30 characters is 728px
    // at every width, so the rails get 148 each — and dismissing one is worth
    // 136px of line, with the far rail staying exactly where it was.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".gloss-prose p[data-paragraph-index]");
    await resetRails();
    const narrowStart = await geometry();
    results.grips.narrowStart = narrowStart;
    assert.equal(narrowStart.measure, 30);
    assert.ok(
      Math.abs(narrowStart.column - 728) <= 1.5,
      `the default article is 30 characters at every width: ${narrowStart.column}`,
    );
    assert.ok(
      Math.abs(narrowStart.leftRail - narrowStart.rightRail) <= 1.5,
      `and the rails are equal: ${narrowStart.leftRail} vs ${narrowStart.rightRail}`,
    );
    assert.ok(
      narrowStart.leftRail >= 140,
      `which is above the width a rail stops drawing at: ${narrowStart.leftRail}`,
    );

    await dragBy("left", -4000);
    const narrow = await geometry();
    results.grips.atCeilingNarrow = narrow;
    assert.equal(narrow.leftRail, 12);
    assert.equal(narrow.outlineRendered, false);
    // Within one character, not exactly: the drag lands between characters
    // and the snap moves the article by up to half of one, which the far
    // rail — being the remainder — has to absorb.
    assert.ok(
      Math.abs(narrow.rightRail - narrowStart.rightRail) <= 20,
      `the notes rail must not move: ${narrowStart.rightRail} → ${narrow.rightRail}`,
    );
    // The outline was 148px wide; dismissing it leaves the lane and gives
    // the article 136px (its 148 minus the 12px lane), rounded to whole
    // characters. Anything close to a rail's width is the property that
    // matters, not the exact number.
    assert.ok(
      narrow.column > narrowStart.column + 120,
      `dismissing the outline is worth real width here: ${narrowStart.column} → ${narrow.column}`,
    );
    await shoot("column-grips-1024-outline-pushed-aside");

    // Leave the two rails where the rest of the suite expects them.
    await resetRails();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector(".gloss-prose p[data-paragraph-index]");
  }

  // ── 5. A settings change keeps the reader on the same paragraph ───────
  if (wanted(5)) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArticle();

    // Scroll to the middle of the article.
    await page.evaluate(() => {
      const blocks = document.querySelectorAll("[data-paragraph-index]");
      const target = blocks[Math.floor(blocks.length / 2)];
      window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 100);
    });
    await delay(80);

    const before = await page.evaluate(() => {
      const block = [...document.querySelectorAll("[data-paragraph-index]")].find(
        (el) => el.getBoundingClientRect().bottom > 0,
      );
      return { index: block.dataset.paragraphIndex, top: block.getBoundingClientRect().top, scrollY: window.scrollY };
    });

    await page.click('[data-testid="reading-settings-toggle"]');
    await page.selectOption('[data-testid="reading-font-size"]', "24");
    await page.selectOption('[data-testid="reading-line-height"]', "1.95");
    await delay(120);

    const after = await page.evaluate((index) => {
      const block = document.querySelector(`[data-paragraph-index="${index}"]`);
      return { top: block.getBoundingClientRect().top, scrollY: window.scrollY };
    }, before.index);

    results.position = { before, after, deltaPx: after.top - before.top };
    assert.ok(before.scrollY > 0, "the test must actually be scrolled down");
    assert.ok(
      Math.abs(after.top - before.top) <= 2,
      `the anchored paragraph moved by ${after.top - before.top}px; it should stay put`,
    );
    await shoot("reader-after-font-change-1440");
  }

  // ── 6. Highlights still line up with the text they were drawn on ──────
  if (wanted(6)) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openArticle();

    // (a) The invariant everything else rests on: a block's rendered text
    //     equals `paragraph.text` and nothing more. Generated content from
    //     the Typography plugin would show up here as extra characters.
    const textFidelity = await page.evaluate(async () => {
      const store = await import("/src/lib/store.ts");
      const article = store.useStore.getState().articles[window.location.hash.slice(4)];
      // The text is a body now: `articles[id]` is the record, and the
      // paragraphs live beside it.
      const body = store.useStore.getState().bodies[article.id];
      const paragraphs = body?.state === "present" ? body.body.paragraphs : [];
      const out = [];
      for (const paragraph of paragraphs) {
        const block = document.querySelector(`[data-paragraph-index="${paragraph.index}"]`);
        const marker = block.querySelector("[data-paragraph-marker]");
        const rendered = block.textContent.replace(marker ? marker.textContent : "", "");
        out.push({
          index: paragraph.index,
          matches: rendered === paragraph.text,
          rendered: rendered.slice(0, 40),
          expected: paragraph.text.slice(0, 40),
        });
      }
      return out;
    });
    results.highlight.textFidelity = textFidelity;
    for (const row of textFidelity) {
      assert.ok(
        row.matches,
        `paragraph ${row.index} renders "${row.rendered}" but stores "${row.expected}"`,
      );
    }

    // (b) A real `Range` over real rendered text, mapped back with the app's
    //     own offset function. The paragraph has inline markup in it, so the
    //     range has to cross `<strong>`/`<em>`/`<code>`/`<del>` nodes.
    const offsets = await page.evaluate(async () => {
      const { rangeToOffsets } = await import("/src/lib/text-offset.ts");
      const store = await import("/src/lib/store.ts");
      const article = store.useStore.getState().articles[window.location.hash.slice(4)];
      const body = store.useStore.getState().bodies[article.id];
      const paragraphs = body?.state === "present" ? body.body.paragraphs : [];
      const paragraph = paragraphs.find((p) => p.index === 4);
      const block = document.querySelector('[data-paragraph-index="4"]');

      // Walk the block's text nodes, skipping the marker, and map a global
      // character index onto a (node, offset) pair.
      const nodes = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest("[data-paragraph-marker]")) continue;
        nodes.push(node);
      }
      const locate = (charIndex) => {
        let remaining = charIndex;
        for (const textNode of nodes) {
          if (remaining <= textNode.data.length) return { node: textNode, offset: remaining };
          remaining -= textNode.data.length;
        }
        const last = nodes[nodes.length - 1];
        return { node: last, offset: last.data.length };
      };
      const range = document.createRange();
      const start = locate(9);
      const end = locate(23);
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const mapped = rangeToOffsets(block, range);
      return {
        mapped,
        rangeText: range.toString(),
        expectedText: paragraph.text.slice(9, 23),
        spansInRange: range.toString() !== paragraph.text.slice(9, 23),
      };
    });
    results.highlight.rangeRoundTrip = offsets;
    assert.deepEqual(offsets.mapped, { start: 9, end: 23 }, "range must map back to its offsets");
    assert.equal(offsets.rangeText, offsets.expectedText, "the range text must be the stored text");

    // (c) A stored highlight renders on exactly the characters it names.
    const marked = await page.evaluate(async () => {
      const store = await import("/src/lib/store.ts");
      const article = store.useStore.getState().articles[window.location.hash.slice(4)];
      const body = store.useStore.getState().bodies[article.id];
      const paragraphs = body?.state === "present" ? body.body.paragraphs : [];
      const paragraph = paragraphs.find((p) => p.index === 3);
      store.useStore.getState().addHighlight({
        articleId: article.id,
        paragraphIndex: 3,
        startOffset: 4,
        endOffset: 12,
        selectionText: paragraph.text.slice(4, 12),
        color: "yellow",
        style: "watercolor",
      });
      return paragraph.text.slice(4, 12);
    });
    await page.waitForSelector(".gloss-prose mark.gloss-mark");
    const markText = await page.textContent(".gloss-prose mark.gloss-mark");
    assert.equal(markText, marked, "the mark must cover exactly the stored selection text");
    results.highlight.storedMark = { expected: marked, rendered: markText };

    // (d) And the same thing through the real UI: drag over text with the
    //     mouse, pick a colour, and check the mark lands on what was dragged.
    //     The drag starts past the block's left padding — that padding is
    //     the number gutter, and a drag that begins inside it anchors to the
    //     element rather than to a character.
    await page.evaluate(() => {
      document
        .querySelector('[data-paragraph-index="3"]')
        .scrollIntoView({ block: "center" });
    });
    await delay(120);
    const drag = await page.evaluate(() => {
      const block = document.querySelector('[data-paragraph-index="3"]');
      const rect = block.getBoundingClientRect();
      const cs = getComputedStyle(block);
      return {
        x: rect.left + parseFloat(cs.paddingLeft) + 2,
        y: rect.top + parseFloat(cs.lineHeight) / 2,
        blockText: block.textContent.replace(
          block.querySelector("[data-paragraph-marker]").textContent,
          "",
        ),
      };
    });
    await page.mouse.move(drag.x, drag.y);
    await page.mouse.down();
    await page.mouse.move(drag.x + 90, drag.y, { steps: 12 });
    await delay(80);
    assert.equal(await page.locator('[data-testid="selection-toolbar"]').count(), 0,
      "toolbar must not appear during an unfinished drag");
    await page.mouse.up();
    await page.waitForSelector('[data-testid="selection-toolbar"]', { timeout: 5000 });
    const draggedText = await page.evaluate(() => window.getSelection().toString().trim());
    await shoot("selection-toolbar-1440");
    await page.click('.gloss-swatch[data-color="green"]');
    await page.waitForSelector('[data-paragraph-index="3"] mark[data-color="green"]');
    const uiMark = await page.evaluate(() =>
      [...document.querySelectorAll('[data-paragraph-index="3"] mark.gloss-mark')].map((m) => ({
        text: m.textContent,
        color: m.dataset.color,
      })),
    );
    results.highlight.uiDrag = { draggedText, marks: uiMark };
    assert.ok(draggedText.length > 0, "the drag must have selected something");
    assert.ok(uiMark.length > 0, "dragging and picking a colour must create a mark");
    assert.equal(uiMark[0].color, "green");
    assert.ok(
      drag.blockText.includes(uiMark[0].text),
      "the UI mark must be a substring of the paragraph it was drawn on",
    );

    // One highlight must remain continuous across source emphasis boundaries.
    const continuous = await page.evaluate(async () => {
      const { useStore } = await import('/src/lib/store.ts');
      const article = useStore.getState().articles[window.location.hash.slice(4)];
      const body = useStore.getState().bodies[article.id];
      const paragraphs = body?.state === "present" ? body.body.paragraphs : [];
      const paragraph = paragraphs.find((p) => p.index === 4);
      useStore.getState().addHighlight({ articleId: article.id, paragraphIndex: 4,
        startOffset: 9, endOffset: 23, selectionText: paragraph.text.slice(9, 23),
        color: 'yellow', style: 'watercolor' });
      return paragraph.text.slice(9, 23);
    });
    const continuousMark = page.locator('[data-paragraph-index="4"] mark');
    await continuousMark.waitFor();
    assert.equal(await continuousMark.count(), 1, 'one mark across inline emphasis');
    assert.equal(await continuousMark.textContent(), continuous);
    for (const tag of ['strong', 'em', 'code', 'del']) {
      assert.equal(await continuousMark.locator(tag).count(), 1, 'preserve source ' + tag);
    }
    assert.ok(!(await continuousMark.evaluate((el) => getComputedStyle(el).backgroundImage)).includes('radial-gradient'),
      'watercolor must not restart horizontal gradients at inline boundaries');

    // Start and finish a new drag inside an existing highlight.
    const existing = page.locator('[data-paragraph-index="3"] mark[data-color="green"]').first();
    await existing.scrollIntoViewIfNeeded();
    const box = await existing.boundingBox();
    await page.mouse.move(box.x + 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForSelector('[data-testid="selection-toolbar"]');
    assert.ok((await page.evaluate(() => window.getSelection().toString())).length > 0,
      'mark click must not consume a new text selection');
    assert.equal(await page.locator('[data-testid="selection-toolbar"]').getByText('造一个句子', { exact: false }).count(), 0);
    const toolbarBox = await page.locator('[data-testid="selection-toolbar"]').boundingBox();
    assert.ok(toolbarBox.y + toolbarBox.height <= box.y + 1 || toolbarBox.y >= box.y + box.height,
      'toolbar must stay clear of selected text');
    await page.mouse.move(drag.x, drag.y);
    await page.mouse.down();
    assert.equal(await page.locator('[data-testid="selection-toolbar"]').evaluate((el) => getComputedStyle(el).pointerEvents), 'none',
      'existing toolbar must not intercept a subsequent drag');
    await page.mouse.up();
    results.highlight.mergedFixes = { continuousText: continuous, emphasisPreserved: true,
      selectionInsideMark: true, noToolbarDuringDrag: true, toolbarHitTesting: true };
  }

  // ── 7. Long content does not widen the page ───────────────────────────
  if (wanted(7)) {
    for (const [label, width] of [
      ["mobile-390", 390],
      ["tablet-1024", 1024],
      ["desktop-1440", 1440],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await openArticle();
      const m = await page.evaluate(() => {
        const pre = document.querySelector(".gloss-pre");
        const link = document.querySelector('.gloss-prose a[href^="https://example.com/a/very"]');
        const title = document.querySelector("h1");
        const main = document.querySelector("main");
        return {
          docScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          preClientWidth: pre.clientWidth,
          preScrollWidth: pre.scrollWidth,
          preOverflowsInternally: pre.scrollWidth > pre.clientWidth,
          preWithinMain: pre.getBoundingClientRect().right <= main.getBoundingClientRect().right + 1,
          linkRight: link.getBoundingClientRect().right,
          mainRight: main.getBoundingClientRect().right,
          titleRight: title.getBoundingClientRect().right,
          titleLeft: title.getBoundingClientRect().left,
          titleFontSizePx: parseFloat(getComputedStyle(title).fontSize),
        };
      });
      results.overflow[label] = m;
      // The title steps down as it grows (`titleSizeClass`). The fixture
      // title is 26 Han characters — 52 width units, the third step — so
      // it must render *below* the 3rem it used to be fixed at. This is
      // the one thing only a browser can prove here: the step is a
      // Tailwind arbitrary value (`text-[clamp(…)]`), and a typo in that
      // string makes Tailwind emit no rule at all, leaving the heading at
      // the browser's default size. Nothing else would notice.
      assert.ok(
        m.titleFontSizePx < 48,
        `${label}: a 26-character title should step down from 3rem, got ${m.titleFontSizePx}px`,
      );
      assert.ok(
        m.titleFontSizePx >= 27.9,
        `${label}: the title should stay a title, got ${m.titleFontSizePx}px`,
      );
      assert.ok(
        m.docScrollWidth <= width + 1,
        `${label}: the page scrolls sideways (${m.docScrollWidth} > ${width})`,
      );
      assert.ok(m.preWithinMain, `${label}: the code block escapes the column`);
      assert.ok(
        m.linkRight <= m.mainRight + 1,
        `${label}: the long link escapes the column`,
      );
      assert.ok(
        m.titleRight <= m.mainRight + 1 && m.titleLeft >= -1,
        `${label}: the long title escapes the column`,
      );
    }
    await shoot("overflow-check-desktop-1440");
  }

  assert.deepEqual(consoleErrors, [], "no uncaught page errors");

  results.vitePort = port;
  results.consoleErrors = consoleErrors;
  // Which sections this file describes. A partial run's evidence is a
  // different artefact from the acceptance run's, and the only way to tell
  // them apart after the fact is to have written it down.
  results.sections = sectionsRun;
  results.partial = partial;
  await writeFile(
    join(evidenceDir, "result.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  if (partial) {
    console.log(
      `Reading-layout browser gate: 第 ${sectionsRun.join(", ")} 节通过（Vite 端口 ${port}）。`,
    );
    console.log("这是一次局部运行，其余各节没有跑，不能当作验收证据。");
  } else {
    console.log(`Reading-layout browser gate passed on Vite port ${port}.`);
  }
  console.log(`Evidence: ${evidenceDir}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (vite && vite.exitCode === null) {
    const done = once(vite, "exit");
    vite.kill();
    await Promise.race([done, delay(5000)]);
  }
}
