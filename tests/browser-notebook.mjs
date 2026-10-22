// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 笔记本 (notebook drawer) gate — base line.
 *
 * What only a browser can prove about this feature, and why each check
 * exists:
 *
 *   - the drawer shows the records the store already holds, in the
 *     *article's* reading order rather than the order they were created,
 *     and opening it stores nothing new — the "old data appears
 *     immediately, no duplicate storage" requirement;
 *   - the jump lands on the occurrence the anchor names, not the first one
 *     with the same words, and refuses to move at all when the stored
 *     offsets no longer describe the text (原文位置已失效);
 *   - the notes rail keeps rendering, and a half-typed follow-up keeps its
 *     text, while the drawer is open — nothing is unmounted or aborted;
 *   - a personal remark survives a save, a reload and a JSON backup, is
 *     distinguishable from deleting the highlight, and a draft survives
 *     closing the drawer;
 *   - the export contains every entry regardless of the filter on screen,
 *     a clipboard failure is visible rather than silent, and the download
 *     name keeps the Chinese title and revokes its object URL;
 *   - the `N` shortcut and `Escape` respect text fields, modifiers and IME
 *     composition, and focus returns to the control that opened the drawer;
 *   - the drawer is usable at 390px with no horizontal overflow, and a jump
 *     there closes it so the passage is actually visible;
 *   - deleting a note mid-stream is safe: the existing deletion boundary
 *     absorbs late callbacks instead of resurrecting the record.
 *
 * Everything is synthetic and local: the app is started from source on a
 * free loopback port, the articles and their annotations are seeded through
 * the store the app itself uses, every request that leaves `127.0.0.1` is
 * aborted, and no model, account or extraction service is involved.
 *
 * Run: node tests/browser-notebook.mjs
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
/** Isolated evidence folder: the other suites' output is not ours. */
const evidenceDir = join(root, "docs", "evidence", "notebook-2026-10-19");

const ARTICLE_ID = "local-notebook-fixture";
const OTHER_ARTICLE_ID = "local-notebook-other";
const VERSION_ID = "v-new";
const OLD_VERSION_ID = "v-old";
/** The paragraph whose text repeats, and the second occurrence in it. */
const QUOTE_PARAGRAPH = 2;
const QUOTE = "世尊说：世尊。";
const DUP_START = 4;
const DUP_END = 6;
/** The paragraph a fresh, UI-made highlight is drawn in. */
const PICK_PARAGRAPH = 10;
const PICK_TEXT = `第${PICK_PARAGRAPH}段独有正文。`;

const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

/** Long enough to scroll, and every paragraph is unique so a quote is
 *  unambiguous — the duplicate-quote case is set up deliberately in ¶2. */
const filler = (n) =>
  `第${n}段独有正文。` + "这里是用于撑开页面高度的补充文字。".repeat(6);

function article(id, title, versionId) {
  const paragraphs = [
    { index: 1, text: "笔记本测试", hash: "h01", type: "heading", level: 1 },
    { index: QUOTE_PARAGRAPH, text: QUOTE, hash: "h02", type: "paragraph" },
    ...Array.from({ length: 30 }, (_, i) => ({
      index: i + 3,
      text: filler(i + 3),
      hash: `h${String(i + 3).padStart(2, "0")}`,
      type: "paragraph",
    })),
  ];
  return {
    id,
    title,
    url: "https://example.test/sutra",
    author: "佚名",
    publishedAt: "2026-01-02",
    createdAt: 1,
    paragraphs,
    ...(versionId ? { versionId } : {}),
  };
}

const turn = (noteId, role, content, sequence, status) => ({
  id: `${noteId}-t${sequence}`,
  noteId,
  role,
  content,
  sequence,
  createdAt: "2026-10-19T00:00:00.000Z",
  ...(status ? { status } : {}),
});

function seed() {
  const notes = {
    // Created last, but anchored to the earliest paragraph: the drawer must
    // place it first, which is the whole "reading order, not creation
    // order" claim. Left non-streaming here; the live case is set up after
    // mount, because a note that is streaming at mount is swept to
    // "interrupted" by design.
    live: {
      id: "live",
      articleId: ARTICLE_ID,
      paragraphIndex: 3,
      type: "ask",
      selectionText: "第3段独有正文",
      question: "第三段问什么？",
      answer: "",
      model: "demo-model",
      isStreaming: false,
      localStatus: "succeeded",
      createdAt: 9999,
      startParagraphIndex: 3,
      startOffset: 0,
      endParagraphIndex: 3,
      endOffset: 7,
      turns: [turn("live", "user", "第三段问什么？", 1)],
    },
    // Legacy shape: no turns at all, and no offsets either — a record
    // written before either existed.
    legacy: {
      id: "legacy",
      articleId: ARTICLE_ID,
      paragraphIndex: 5,
      type: "ask",
      selectionText: "第5段独有正文",
      question: "旧问题",
      answer: "旧回答。" + "这是很长的一段旧回答正文。".repeat(40),
      model: "demo-model",
      isStreaming: false,
      createdAt: 5000,
    },
    // Created first of everything, but third in the article.
    structured: {
      id: "structured",
      articleId: ARTICLE_ID,
      paragraphIndex: 8,
      type: "explain",
      selectionText: "第8段独有正文",
      question: "第一问",
      answer: "第一答\n\n---\n\n追问：追问一\n\n追问答",
      model: "demo-model",
      isStreaming: false,
      localStatus: "succeeded",
      createdAt: 100,
      startParagraphIndex: 8,
      startOffset: 0,
      endParagraphIndex: 8,
      endOffset: 7,
      turns: [
        turn("structured", "user", "第一问", 1),
        turn("structured", "assistant", "第一答", 2, "succeeded"),
        turn("structured", "user", "追问一", 3),
        turn("structured", "assistant", "追问答", 4, "succeeded"),
      ],
    },
    // Offsets that no longer slice out the quote: the document was
    // re-parsed and the same numbers now name other characters.
    "stale-note": {
      id: "stale-note",
      articleId: ARTICLE_ID,
      paragraphIndex: 9,
      type: "ask",
      selectionText: "第9段独有正文",
      question: "这条的锚点已经失效",
      answer: "仍然可以读",
      model: "demo-model",
      isStreaming: false,
      localStatus: "succeeded",
      createdAt: 4000,
      startParagraphIndex: 9,
      startOffset: 0,
      endParagraphIndex: 9,
      endOffset: 3,
    },
    failed: {
      id: "failed",
      articleId: ARTICLE_ID,
      paragraphIndex: 12,
      type: "ask",
      selectionText: "第12段独有正文",
      question: "失败的提问",
      answer: "半截回答\n\n[错误：连接被重置]",
      model: "demo-model",
      isStreaming: false,
      localStatus: "failed",
      createdAt: 3000,
      startParagraphIndex: 12,
      startOffset: 0,
      endParagraphIndex: 12,
      endOffset: 8,
    },
    cancelled: {
      id: "cancelled",
      articleId: ARTICLE_ID,
      paragraphIndex: 13,
      type: "ask",
      selectionText: "第13段独有正文",
      question: "被取消的提问",
      answer: "写了一半",
      model: "demo-model",
      isStreaming: false,
      localStatus: "cancelled",
      createdAt: 2000,
      startParagraphIndex: 13,
      startOffset: 0,
      endParagraphIndex: 13,
      endOffset: 8,
      turns: [
        turn("cancelled", "user", "被取消的提问", 1),
        turn("cancelled", "assistant", "写了一半", 2, "cancelled"),
      ],
    },
    // Anchored to a version the page is not showing.
    oldver: {
      id: "oldver",
      articleId: ARTICLE_ID,
      paragraphIndex: 14,
      type: "ask",
      selectionText: "第14段独有正文",
      question: "旧版本的问题",
      answer: "旧版本的回答",
      model: "demo-model",
      isStreaming: false,
      localStatus: "succeeded",
      createdAt: 1500,
      remoteVersionId: OLD_VERSION_ID,
      turns: [
        turn("oldver", "user", "旧版本的问题", 1),
        turn("oldver", "assistant", "旧版本的回答", 2, "succeeded"),
        turn("oldver", "user", "旧版本的追问", 3),
        turn("oldver", "assistant", "旧版本追问的半截", 4, "interrupted"),
      ],
    },
    "other-article-note": {
      id: "other-article-note",
      articleId: OTHER_ARTICLE_ID,
      paragraphIndex: 2,
      type: "ask",
      selectionText: "另一篇",
      question: "另一篇的问题",
      answer: "另一篇的回答",
      model: "demo-model",
      isStreaming: false,
      localStatus: "succeeded",
      createdAt: 1000,
    },
  };

  const highlights = {
    // The second "世尊" — the occurrence the reader actually marked.
    "dup-hl": {
      id: "dup-hl",
      articleId: ARTICLE_ID,
      paragraphIndex: QUOTE_PARAGRAPH,
      startOffset: DUP_START,
      endOffset: DUP_END,
      selectionText: "世尊",
      color: "yellow",
      createdAt: 800,
    },
    "remark-hl": {
      id: "remark-hl",
      articleId: ARTICLE_ID,
      paragraphIndex: 6,
      startOffset: 0,
      endOffset: 5,
      selectionText: "第6段独有",
      color: "green",
      createdAt: 700,
    },
    // In range, wrong characters: a re-parse moved the text under them.
    "stale-hl": {
      id: "stale-hl",
      articleId: ARTICLE_ID,
      paragraphIndex: 7,
      startOffset: 1,
      endOffset: 4,
      selectionText: "第7段",
      color: "blue",
      createdAt: 600,
    },
    "other-article-hl": {
      id: "other-article-hl",
      articleId: OTHER_ARTICLE_ID,
      paragraphIndex: 2,
      startOffset: 0,
      endOffset: 2,
      selectionText: "世尊",
      color: "red",
      createdAt: 500,
    },
  };

  return { notes, highlights };
}

let vite;
let browser;
const results = {
  generatedAt: new Date().toISOString(),
  command: "node tests/browser-notebook.mjs",
  article: ARTICLE_ID,
  checks: [],
  storage: {},
  pageErrors: [],
  externalRequests: [],
  screenshots: [],
};

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

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
  for (let i = 0; i < 300; i += 1) {
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // Nothing beyond the local dev server may be reached; the app's own
  // webfont stylesheet is recorded but still aborted, because the run must
  // not depend on the network. A page that quietly called a model or an
  // extraction service fails at the bottom rather than passing on someone
  // else's machine.
  await context.route("**/*", (route) => {
    const requestUrl = route.request().url();
    const host = new URL(requestUrl).hostname;
    if (host === "127.0.0.1") return route.continue();
    results.externalRequests.push({ url: requestUrl, host, known: FONT_HOSTS.has(host) });
    return route.abort();
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));

  const { notes, highlights } = seed();
  await page.goto(url);
  await page.evaluate(
    async ([art, other, seededNotes, seededHighlights]) => {
      const { useStore } = await import("/src/lib/store.ts");
      // Both articles go in through `saveArticle`, which is the only path that
      // installs a record *and* its text. The text is a body now, so a plain
      // `setState({ articles })` would leave the reader with nothing to render.
      useStore.setState({ notes: seededNotes, highlights: seededHighlights });
      for (const source of [art, other]) {
        const { paragraphs, ...record } = source;
        await useStore.getState().saveArticle(record, paragraphs);
      }
      useStore.setState({ currentArticleId: art.id });
      location.hash = `#/r/${art.id}`;
    },
    [
      article(ARTICLE_ID, "金刚经笔记本测试", VERSION_ID),
      article(OTHER_ARTICLE_ID, "另一篇文章"),
      notes,
      highlights,
    ],
  );
  // The first render of a cold Vite dev server transforms the whole module
  // graph, which can take longer than the default action timeout.
  await page.locator(`[data-paragraph-index="${QUOTE_PARAGRAPH}"]`).waitFor({ timeout: 90_000 });
  assert.equal(await page.locator("[data-paragraph-index]").count(), 32);
  results.checks.push("32 blocks rendered from the seeded article");

  const drawer = page.locator('[data-testid="notebook"]');
  const toggle = page.getByTestId("notebook-toggle");
  const entries = page.locator('[data-testid="notebook"] [data-entry-id]');

  async function openNotebook() {
    if ((await drawer.count()) === 0) {
      await toggle.click();
      await drawer.waitFor();
    }
  }
  async function closeNotebook() {
    if ((await drawer.count()) > 0) {
      await page.getByTestId("notebook-close").click();
      await drawer.waitFor({ state: "detached" });
    }
  }
  const entryIds = () =>
    entries.evaluateAll((els) => els.map((el) => el.dataset.entryId));

  // ── 1. Opening: the drawer, its placement, and what it did *not* do ──
  assert.equal(await drawer.count(), 0, "the drawer renders nothing while closed");
  const notesBefore = await page.evaluate(
    () => JSON.parse(localStorage.getItem("gloss-storage")).state,
  );
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 600));
  const scrolledTo = await page.evaluate(() => window.scrollY);
  await openNotebook();
  assert.equal(await drawer.count(), 1);
  assert.equal(
    await page.evaluate(() => window.scrollY),
    scrolledTo,
    "opening the drawer must not move the reading position",
  );
  results.checks.push("opening the drawer leaves the reading position alone");

  const geometry = await page.evaluate(() => {
    const aside = document.querySelector('[data-testid="notebook"]').getBoundingClientRect();
    const header = document.querySelector("header").getBoundingClientRect();
    return { top: aside.top, right: aside.right, headerBottom: header.bottom };
  });
  assert.ok(
    geometry.top >= geometry.headerBottom - 1,
    `the drawer must start below the app's top bar (${geometry.top} < ${geometry.headerBottom})`,
  );
  assert.ok(
    Math.abs(geometry.right - 1440) <= 1,
    "on desktop the drawer is anchored to the right edge",
  );
  results.checks.push("drawer sits below the top bar, anchored right on desktop");

  const afterOpen = await page.evaluate(
    () => JSON.parse(localStorage.getItem("gloss-storage")).state,
  );
  assert.deepEqual(Object.keys(afterOpen.notes).sort(), Object.keys(notesBefore.notes).sort());
  assert.deepEqual(
    Object.keys(afterOpen.highlights).sort(),
    Object.keys(notesBefore.highlights).sort(),
  );
  assert.equal(await page.locator('[data-testid="notes-panel"]').count(), 1);
  results.checks.push("opening it creates no records and unmounts no rail");

  // ── 2. Reading order, not creation order ────────────────────────────
  assert.deepEqual(await entryIds(), [
    "dup-hl", // ¶2
    "live", // ¶3
    "legacy", // ¶5
    "remark-hl", // ¶6
    "stale-hl", // ¶7
    "structured", // ¶8
    "stale-note", // ¶9
    "failed", // ¶12
    "cancelled", // ¶13
  ]);
  assert.equal(
    await page.getByTestId("notebook-summary").innerText(),
    "6 条 AI 问答，3 条高亮与备注",
  );
  results.storage.order = await entryIds();
  results.checks.push("entries follow the article's reading order, not creation order");

  // ── 3. Article isolation ────────────────────────────────────────────
  const html = await drawer.innerHTML();
  assert.ok(!html.includes("other-article-note"));
  assert.ok(!html.includes("other-article-hl"));
  assert.ok(!html.includes("另一篇"));
  results.checks.push("another article's records never appear");

  // ── 4. Legacy, structured and status-bearing notes ──────────────────
  const legacyEntry = page.locator('[data-entry-id="legacy"]');
  assert.match(await legacyEntry.innerText(), /旧问题/);
  assert.match(await legacyEntry.innerText(), /旧回答/);
  results.checks.push("a legacy note with no turns still shows its question and answer");

  // A long answer folds, and the control that opens it says which way it
  // goes. The button only exists when the text actually overflows.
  const fold = legacyEntry.getByTestId("notebook-clamp-toggle");
  assert.equal(await fold.innerText(), "展开全文");
  assert.equal(await fold.getAttribute("aria-expanded"), "false");
  await fold.click();
  assert.equal(await legacyEntry.getByTestId("notebook-clamp-toggle").innerText(), "收起");
  assert.equal(
    await legacyEntry.getByTestId("notebook-clamp-toggle").getAttribute("aria-expanded"),
    "true",
  );
  await legacyEntry.getByTestId("notebook-clamp-toggle").click();
  results.checks.push("a long answer folds to five lines and opens on demand");

  const structuredEntry = page.locator('[data-entry-id="structured"]');
  assert.equal(
    await structuredEntry.locator('[data-testid="notebook-qa-pair"]').count(),
    2,
    "the original exchange and the follow-up are separate pairs",
  );
  const structuredText = await structuredEntry.innerText();
  for (const part of ["第一问", "第一答", "追问一", "追问答"]) {
    assert.ok(structuredText.includes(part), `missing ${part}`);
  }
  assert.equal(
    structuredText.split("第一答").length - 1,
    1,
    "the flattened answer must not be rendered alongside the turns",
  );
  results.checks.push("structured turns render one pair per question, without duplication");

  assert.match(
    await page.locator('[data-entry-id="failed"] [data-testid="notebook-status"]').innerText(),
    /失败/,
  );
  assert.match(await page.locator('[data-entry-id="failed"]').innerText(), /连接被重置/);
  assert.match(
    await page.locator('[data-entry-id="cancelled"] [data-testid="notebook-status"]').innerText(),
    /已取消/,
  );
  assert.match(await page.locator('[data-entry-id="cancelled"]').innerText(), /内容不完整/);
  results.checks.push("failed and cancelled runs are labelled and their partial text kept");

  // ── 5. Stale anchors refuse to point anywhere ───────────────────────
  for (const id of ["stale-note", "stale-hl"]) {
    const jump = page.locator(`[data-entry-id="${id}"] [data-testid="notebook-jump"]`);
    assert.equal(await jump.isDisabled(), true, `${id} must not offer a jump`);
    assert.equal(await jump.innerText(), "原文位置已失效");
    assert.equal(await jump.getAttribute("data-jump-paragraph"), null);
  }
  results.checks.push("an anchor that no longer matches the text reports 原文位置已失效");

  // ── 6. Other-version notes: a labelled group with no jump ───────────
  const otherGroup = page.getByTestId("notebook-other-versions");
  assert.equal(await otherGroup.count(), 1);
  assert.match(await otherGroup.innerText(), /旧版本的问题/);
  assert.equal(await otherGroup.locator('[data-testid="notebook-jump"]').count(), 0);
  assert.equal(await otherGroup.locator('[data-testid="notebook-other-version-note"]').count(), 1);
  // The conversation is structured here too — a follow-up and its terminal
  // status must not depend on which group a note happens to be in.
  assert.equal(
    await otherGroup.locator('[data-testid="notebook-qa-pair"]').count(),
    2,
  );
  const otherText = await otherGroup.innerText();
  for (const part of ["旧版本的问题", "旧版本的回答", "旧版本的追问", "旧版本追问的半截"]) {
    assert.ok(otherText.includes(part), `other-version group missing ${part}`);
  }
  assert.match(otherText, /回答已中断，内容不完整/);
  results.checks.push("other-version notes are a separate labelled group with no jump");

  // ── 7. The live answer: once, and only while it is arriving ─────────
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("live", {
      isStreaming: true,
      localStatus: "running",
      activeTurnId: "turn-live",
      activeTurnText: "正在写的半截回答",
      answer: "正在写的半截回答",
    });
  });
  const liveEntry = page.locator('[data-entry-id="live"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-entry-id="live"] [data-testid="notebook-status"]')
        ?.textContent?.includes("生成中"),
  );
  const liveText = await liveEntry.innerText();
  assert.equal(
    liveText.split("正在写的半截回答").length - 1,
    1,
    "the streaming partial must appear exactly once",
  );
  assert.match(liveText, /正在生成/);
  results.checks.push("a streaming answer shows live, exactly once");

  await page.reload();
  await page.locator(`[data-paragraph-index="${QUOTE_PARAGRAPH}"]`).waitFor();
  await openNotebook();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-entry-id="live"] [data-testid="notebook-status"]')
        ?.textContent?.includes("已中断"),
  );
  assert.match(await page.locator('[data-entry-id="live"]').innerText(), /正在写的半截回答/);
  results.checks.push("a reload turns the interrupted run into 已中断 and keeps its partial text");

  // ── 8. The jump lands on the occurrence the offsets name ────────────
  await page.locator('[data-entry-id="dup-hl"] [data-testid="notebook-jump"]').click();
  await page.waitForFunction(
    (index) => {
      const rect = document
        .querySelector(`[data-paragraph-index="${index}"]`)
        .getBoundingClientRect();
      return rect.top > 60 && rect.bottom < innerHeight;
    },
    QUOTE_PARAGRAPH,
  );
  const mark = page.locator('[data-highlight-id="dup-hl"]');
  assert.equal(await mark.innerText(), "世尊");
  // The first "世尊" starts at offset 0; the second at 4. Comparing where
  // the mark actually is against where the paragraph's text starts is what
  // proves the jump used the offsets rather than picking the first match.
  const markOffset = await page.evaluate(() => {
    const para = document.querySelector('[data-paragraph-index="2"]');
    const markEl = document.querySelector('[data-highlight-id="dup-hl"]');
    const padding = parseFloat(getComputedStyle(para).paddingLeft);
    return markEl.getBoundingClientRect().left - (para.getBoundingClientRect().left + padding);
  });
  assert.ok(markOffset > 20, `the mark must be the second occurrence (offset ${markOffset}px)`);
  assert.equal(
    await drawer.count(),
    1,
    "at desktop width the drawer stays open beside the article",
  );
  await mkdir(evidenceDir, { recursive: true });
  const jumpShot = join(evidenceDir, "notebook-jump-desktop-1440.png");
  await page.screenshot({ path: jumpShot });
  results.screenshots.push(jumpShot);
  results.checks.push("the jump reaches the exact occurrence, not the first with the same words");

  // ── 9. The rail and its in-progress follow-up survive the drawer ────
  //
  // A record in the rail is compact until the reader opens it, and the
  // drawer covers the rail at this width, so: close the drawer, open the
  // structured record, type the draft, then open/close the drawer around
  // it. The draft has to survive both the drawer and the rail card
  // re-rendering from compact to expanded.
  await closeNotebook();
  await page
    .locator('[data-testid="note-card"][data-note-id="structured"] [data-testid="note-expand"]')
    .click();
  const followUp = page.locator(
    '[data-testid="note-card"][data-note-id="structured"] input[placeholder="继续追问…"]',
  );
  await followUp.fill("正在打的追问");
  await openNotebook();
  await closeNotebook();
  await openNotebook();
  assert.equal(await followUp.count(), 1, "the note card must not be unmounted");
  assert.equal(await followUp.inputValue(), "正在打的追问");
  results.checks.push("opening the drawer neither unmounts the rail nor clears a typed follow-up");

  // The connector is suppressed while the drawer is open: at this width the
  // drawer sits exactly over the notes rail, so a curve drawn to a card
  // underneath it would point at a card the reader cannot see.
  await page.locator('[data-entry-id="structured"] [data-testid="notebook-jump"]').click();
  await page.waitForFunction(() => document.querySelectorAll("[data-note-anchor]").length > 0);
  assert.equal(await page.locator('[data-testid="note-connection"]').count(), 0);
  await closeNotebook();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
  );
  await openNotebook();
  results.checks.push("the connector hides while the drawer covers the rail and returns after");

  // ── 10. Filters and their empty state ───────────────────────────────
  await page.getByTestId("notebook-filter-qa").click();
  const qaOnly = await entryIds();
  assert.equal(qaOnly.length, 6);
  assert.ok(qaOnly.every((id) => id !== "dup-hl" && id !== "remark-hl" && id !== "stale-hl"));
  await page.getByTestId("notebook-filter-highlight").click();
  assert.deepEqual(await entryIds(), ["dup-hl", "remark-hl", "stale-hl"]);
  await page.getByTestId("notebook-filter-all").click();
  assert.equal((await entryIds()).length, 9);
  results.checks.push("the filter narrows the list and the counts follow it");

  // ── 11. Export: everything, regardless of the filter on screen ──────
  await page.getByTestId("notebook-filter-highlight").click();
  await page.getByTestId("notebook-copy").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(copied, /^# 金刚经笔记本测试$/m);
  assert.match(copied, /原文来源：https:\/\/example\.test\/sutra/);
  assert.match(copied, /## ¶2 · 高亮/);
  assert.match(copied, /> 世尊/);
  // The filter said 高亮与备注; the export is still the reader's whole
  // notebook, because a view control must not decide what they own.
  assert.match(copied, /## ¶8 · AI问答（解释）/);
  assert.match(copied, /\*\*问 2：\*\* 追问一/);
  assert.match(copied, /追问答/);
  assert.match(copied, /（回答已取消，内容不完整。）/);
  assert.match(copied, /## 其他版本的笔记/);
  assert.ok(!copied.includes("demo-model"), "the model name must not be exported");
  assert.ok(!copied.includes("v-old"), "sync identifiers must not be exported");
  results.checks.push("copy exports every entry regardless of the filter, and nothing else");

  // ── 12. A clipboard failure is visible, not silent ──────────────────
  await page.evaluate(() => {
    window.__realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("拒绝访问")) },
    });
  });
  await page.getByTestId("notebook-copy").click();
  const copyError = page.getByTestId("notebook-copy-error");
  await copyError.waitFor();
  assert.match(await copyError.innerText(), /复制失败/);
  assert.match(await copyError.innerText(), /下载/);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: window.__realClipboard,
    });
  });
  results.checks.push("a failed copy says so and points at the download instead");

  // ── 13. Download: Unicode name, revoked object URL ──────────────────
  await page.evaluate(() => {
    window.__revoked = [];
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (value) => {
      window.__revoked.push(value);
      return original(value);
    };
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("notebook-download").click(),
  ]);
  const filename = download.suggestedFilename();
  assert.match(filename, /金刚经笔记本测试/);
  assert.match(filename, /\.md$/);
  await page.waitForFunction(() => window.__revoked.length > 0);
  results.storage.downloadName = filename;
  results.checks.push(`download keeps the Chinese title and revokes its URL (${filename})`);

  // ── 14. A personal remark: save, draft, cancel, reload, backup ──────
  const remarkEntry = page.locator('[data-entry-id="remark-hl"]');
  await remarkEntry.locator('[data-testid="notebook-remark-edit"]').click();
  // One number, three places: the editor's cap, the store's clamp and the
  // backup schema's bound. A remark the reader could type must never make
  // the whole backup refuse to build.
  const remarkLimit = await page.evaluate(
    async () => (await import("/src/lib/types.ts")).MAX_HIGHLIGHT_NOTE_LENGTH,
  );
  assert.equal(
    await remarkEntry
      .locator('[data-testid="notebook-remark-input"]')
      .getAttribute("maxlength"),
    String(remarkLimit),
  );
  const clamped = await page.evaluate(async (limit) => {
    const { useStore } = await import("/src/lib/store.ts");
    const before = useStore.getState().highlights["remark-hl"].note;
    useStore.getState().setHighlightNote("remark-hl", "长".repeat(limit + 500));
    const stored = useStore.getState().highlights["remark-hl"].note.length;
    useStore.getState().setHighlightNote("remark-hl", before);
    return { stored, limit };
  }, remarkLimit);
  assert.deepEqual(clamped, { stored: remarkLimit, limit: remarkLimit });
  results.checks.push("the remark editor, the store and the backup schema share one bound");
  await remarkEntry.locator('[data-testid="notebook-remark-input"]').fill("第一条备注");
  await remarkEntry.locator('[data-testid="notebook-remark-save"]').click();
  assert.match(await remarkEntry.innerText(), /第一条备注/);
  const storedRemark = async () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("gloss-storage")).state.highlights["remark-hl"]
          ?.note ?? null,
    );
  assert.equal(await storedRemark(), "第一条备注");
  results.checks.push("a remark is created through the notebook and stored on the highlight");

  // A draft must survive the editor being dismissed *and* the drawer being
  // closed — a half-typed remark is not something to throw away silently.
  await remarkEntry.locator('[data-testid="notebook-remark-edit"]').click();
  await remarkEntry.locator('[data-testid="notebook-remark-input"]').fill("还没保存的草稿");
  await page.keyboard.press("Escape");
  assert.equal(
    await remarkEntry.locator('[data-testid="notebook-remark-input"]').count(),
    0,
    "Escape dismisses the editor",
  );
  await closeNotebook();
  await openNotebook();
  await page.locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-edit"]').click();
  assert.equal(
    await page
      .locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-input"]')
      .inputValue(),
    "还没保存的草稿",
    "the draft must survive both the editor closing and the drawer closing",
  );
  results.checks.push("an unsaved remark draft survives Escape and a drawer close");

  // 取消 is the button that discards, and only that button.
  await page.locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-cancel"]').click();
  await page.locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-edit"]').click();
  assert.equal(
    await page
      .locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-input"]')
      .inputValue(),
    "第一条备注",
    "取消 restores the saved remark",
  );
  await page.locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-cancel"]').click();
  results.checks.push("取消 discards the draft and restores the saved remark");

  await page.reload();
  await page.locator(`[data-paragraph-index="${QUOTE_PARAGRAPH}"]`).waitFor();
  await openNotebook();
  assert.match(await page.locator('[data-entry-id="remark-hl"]').innerText(), /第一条备注/);
  results.checks.push("the remark survives a reload");

  // And a JSON backup, in the browser rather than only in a unit test.
  //
  // The backup validator refuses any record whose stored range no longer
  // matches the article text — a pre-existing rule of the format, not of
  // this feature. The two stale fixtures exist precisely to prove the
  // drawer refuses to guess at them, so they are set aside for the round
  // trip instead of quietly weakening the assertion.
  const backupRoundTrip = await page.evaluate(async () => {
    const { createLocalBackup, restoreLocalBackup, validateLocalBackup } =
      await import("/src/lib/local-backup.ts");
    const { useStore } = await import("/src/lib/store.ts");
    const start = useStore.getState();
    const parkedNotes = { "stale-note": start.notes["stale-note"] };
    const parkedHighlights = { "stale-hl": start.highlights["stale-hl"] };
    const without = (group, key) =>
      Object.fromEntries(Object.entries(group).filter(([k]) => k !== key));
    useStore.setState({
      notes: without(start.notes, "stale-note"),
      highlights: without(start.highlights, "stale-hl"),
    });
    try {
      // An oversized remark — one a caller got past the editor — must not be
      // able to take the reader's whole backup down with it.
      const { MAX_HIGHLIGHT_NOTE_LENGTH } = await import("/src/lib/types.ts");
      useStore.getState().setHighlightNote(
        "remark-hl",
        "长".repeat(MAX_HIGHLIGHT_NOTE_LENGTH + 500),
      );
      const clampedStored = useStore.getState().highlights["remark-hl"].note.length;
      const clampedBackup = validateLocalBackup(await createLocalBackup());
      const clampedValidated = clampedBackup.highlights["remark-hl"].note.length;
      useStore.getState().setHighlightNote("remark-hl", "第一条备注");

      const raw = await createLocalBackup();
      const before = useStore.getState().highlights["remark-hl"]?.note ?? null;
      useStore.getState().clearUserCache();
      await restoreLocalBackup(raw);
      return {
        clampedStored,
        clampedValidated,
        before,
        after: useStore.getState().highlights["remark-hl"]?.note ?? null,
        contains: raw.includes("第一条备注"),
      };
    } finally {
      const now = useStore.getState();
      useStore.setState({
        notes: { ...now.notes, ...parkedNotes },
        highlights: { ...now.highlights, ...parkedHighlights },
      });
    }
  });
  assert.deepEqual(backupRoundTrip, {
    clampedStored: 20_000,
    clampedValidated: 20_000,
    before: "第一条备注",
    after: "第一条备注",
    contains: true,
  });
  results.checks.push("the remark survives a JSON backup and restore");
  await page.reload();
  await page.locator(`[data-paragraph-index="${QUOTE_PARAGRAPH}"]`).waitFor();
  await openNotebook();
  assert.match(await page.locator('[data-entry-id="remark-hl"]').innerText(), /第一条备注/);

  // Deleting the remark keeps the highlight; deleting the highlight takes
  // both. The two are separate, labelled actions for exactly that reason.
  const highlightsBefore = await page.evaluate(
    () => Object.keys(JSON.parse(localStorage.getItem("gloss-storage")).state.highlights).length,
  );
  await page.locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-edit"]').click();
  await page.locator('[data-entry-id="remark-hl"] [data-testid="notebook-remark-delete"]').click();
  assert.equal(await storedRemark(), null);
  assert.equal(
    await page.evaluate(
      () => Object.keys(JSON.parse(localStorage.getItem("gloss-storage")).state.highlights).length,
    ),
    highlightsBefore,
    "removing a remark must not remove the highlight",
  );
  assert.equal(await page.locator('[data-entry-id="remark-hl"]').count(), 1);
  results.checks.push("deleting a remark leaves the highlight in place");

  // ── 15. The same remark flow through the highlight popover ──────────
  await closeNotebook();
  // The selection toolbar is placed against the selection's viewport rect,
  // so the paragraph has to be on screen before the selection is made.
  await page.locator(`[data-paragraph-index="${PICK_PARAGRAPH}"]`).scrollIntoViewIfNeeded();
  await page.locator(`[data-paragraph-index="${PICK_PARAGRAPH}"]`).evaluate((element, prefix) => {
    // The paragraph renders its number in a marker span and its body in one
    // text node; the selection is a prefix of that node.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) if (node.textContent.startsWith(prefix)) break;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, prefix.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, PICK_TEXT);
  await page.getByRole("button", { name: "用绿色划线", exact: true }).click();
  await page.locator(`[data-paragraph-index="${PICK_PARAGRAPH}"] mark`).first().click();
  const popover = page.getByTestId("highlight-remark-toggle");
  await popover.waitFor();
  await popover.click();
  await page.getByTestId("highlight-remark-input").fill("从弹窗写的备注");
  await page.getByTestId("highlight-remark-save").click();
  assert.match(await page.getByTestId("highlight-remark-preview").innerText(), /从弹窗写的备注/);
  const popupRemark = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("gloss-storage")).state;
    return Object.values(state.highlights).map((h) => h.note).filter(Boolean);
  });
  assert.ok(popupRemark.includes("从弹窗写的备注"));
  results.checks.push("a remark is created through the highlight popover");

  // Clicking away closes the popover without discarding an in-progress
  // draft: reopening shows what was typed.
  await page.getByTestId("highlight-remark-toggle").click();
  await page.getByTestId("highlight-remark-input").fill("弹窗里的草稿");
  await page.mouse.click(20, 400);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="highlight-remark-toggle"]').length === 0,
  );

  // ── 16. Keyboard: N, Escape, and the cases that must not fire ───────
  await closeNotebook();
  // `N` from the reading surface opens the drawer and moves focus into it.
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("n");
  await drawer.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "notebook-close",
  );
  results.checks.push("N opens the drawer and focus moves into it");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });

  // Opening it from a control and closing it hands focus back to that
  // control, rather than dropping the reader at the top of the document.
  await toggle.focus();
  await page.keyboard.press("n");
  await drawer.waitFor();
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "notebook-toggle",
  );
  results.checks.push("Escape closes the drawer and returns focus to the control that opened it");

  // The rail card is compact until opened (and the reloads above reset the
  // view state), so open the structured record before typing into it.
  await page
    .locator('[data-testid="note-card"][data-note-id="structured"] [data-testid="note-expand"]')
    .click();
  await followUp.fill("");
  await followUp.focus();
  await page.keyboard.type("n");
  assert.equal(await followUp.inputValue(), "n", "the keystroke belongs to the field");
  assert.equal(await drawer.count(), 0, "a text field must not open the drawer");
  await followUp.fill("");
  results.checks.push("N is ignored while a text field has focus");

  // Modifiers and IME composition are dispatched synthetically so the
  // browser's own Ctrl+N is not what is being measured.
  for (const init of [
    { key: "n", ctrlKey: true },
    { key: "n", metaKey: true },
    { key: "n", altKey: true },
    { key: "n", isComposing: true },
  ]) {
    await page.evaluate((options) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { ...options, bubbles: true }));
    }, init);
  }
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    el.textContent = "可编辑";
    document.body.appendChild(el);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    el.remove();
  });
  assert.equal(await drawer.count(), 0, "modifiers, IME and contenteditable must not open it");
  results.checks.push("N ignores modifiers, IME composition and contenteditable");

  // ── 17. Deleting mid-stream is absorbed by the deletion boundary ────
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("live", {
      isStreaming: true,
      localStatus: "running",
      activeTurnId: "turn-live",
      activeTurnText: "半截",
    });
  });
  await openNotebook();
  await page.locator('[data-entry-id="live"] button[aria-label="删除这条问答"]').click();
  await page.waitForFunction(
    () => !JSON.parse(localStorage.getItem("gloss-storage")).state.notes.live,
  );
  // Late callbacks from the run that was in flight when it was deleted: the
  // store's own guards have to absorb every one of them.
  const resurrected = await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    const store = useStore.getState();
    store.appendToNote("live", "迟到的分片");
    store.appendTurn("live", { role: "assistant", content: "迟到的回答" });
    store.finishNote("live");
    store.updateNote("live", { localStatus: "succeeded", isStreaming: false });
    await new Promise((r) => setTimeout(r, 50));
    return Boolean(JSON.parse(localStorage.getItem("gloss-storage")).state.notes.live);
  });
  assert.equal(resurrected, false, "a late callback must not resurrect a deleted note");
  assert.equal(await page.locator('[data-entry-id="live"]').count(), 0);
  results.checks.push("deleting a streaming note is final, even against late callbacks");

  // ── 18. Mobile ──────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[data-paragraph-index="${QUOTE_PARAGRAPH}"]`).waitFor();
  // An unbroken URL or code line is the one thing a 390px drawer can get
  // wrong: the body clips horizontal overflow, so text that does not wrap is
  // *hidden* rather than merely ugly. It has to wrap.
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    const note = useStore.getState().notes["structured"];
    useStore.getState().updateNote("structured", {
      turns: [
        ...(note.turns ?? []),
        {
          id: "structured-long-q",
          noteId: "structured",
          role: "user",
          content: "https://example.test/" + "a".repeat(400),
          sequence: 9,
          createdAt: "2026-10-19T00:00:09.000Z",
        },
        {
          id: "structured-long-a",
          noteId: "structured",
          role: "assistant",
          content: "b".repeat(400),
          sequence: 10,
          createdAt: "2026-10-19T00:00:10.000Z",
          status: "succeeded",
        },
      ],
    });
  });
  await openNotebook();
  const unbroken = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-entry-id="structured"] p')).map(
      (el) => el.scrollWidth - el.clientWidth,
    ),
  );
  assert.ok(
    unbroken.every((delta) => delta <= 1),
    `unbroken text must wrap inside the drawer, not be clipped (overflows: ${unbroken})`,
  );
  const mobile = await page.evaluate(() => {
    const aside = document.querySelector('[data-testid="notebook"]');
    const body = document.querySelector('[data-testid="notebook-body"]');
    return {
      width: aside.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      bodyScrollable: body.scrollHeight > body.clientHeight,
      bodyClientHeight: body.clientHeight,
    };
  });
  assert.ok(Math.abs(mobile.width - 390) <= 1, "the drawer uses the full phone width");
  assert.ok(
    mobile.scrollWidth <= mobile.innerWidth + 1,
    `no horizontal overflow (${mobile.scrollWidth} > ${mobile.innerWidth})`,
  );
  assert.ok(mobile.bodyScrollable, "the entry list scrolls inside the drawer");
  const mobileShot = join(evidenceDir, "notebook-mobile-390.png");
  await page.screenshot({ path: mobileShot, fullPage: false });
  results.screenshots.push(mobileShot);
  results.checks.push("at 390px the drawer is usable, scrolls, and does not overflow sideways");
  results.checks.push("an unbroken URL or code line wraps instead of being clipped");

  // A jump on a phone has to close the drawer, or it would hide the very
  // passage it just scrolled to.
  await page.locator('[data-entry-id="dup-hl"] [data-testid="notebook-jump"]').click();
  await drawer.waitFor({ state: "detached" });
  await page.waitForFunction(
    (index) => {
      const rect = document
        .querySelector(`[data-paragraph-index="${index}"]`)
        .getBoundingClientRect();
      return rect.top > 40 && rect.bottom < innerHeight;
    },
    QUOTE_PARAGRAPH,
  );
  results.checks.push("on a phone the jump closes the drawer and lands on the passage");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(`[data-paragraph-index="${QUOTE_PARAGRAPH}"]`).waitFor();

  // ── 19. An article whose only surviving notes belong to another version ─
  //
  // The case the export gate got wrong: nothing is anchored to the text on
  // screen, so `entries` is empty — and those notes are exactly the ones the
  // file is often the only way back to.
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    const state = useStore.getState();
    useStore.setState({
      // The JSON backup format deliberately carries no version identifiers
      // (they are a sync concern, not reading data), so the round trip above
      // dropped the article's `versionId`. It is re-stated here because the
      // whole point of this step is that a note can be recognised as
      // belonging to *another* version.
      articles: Object.fromEntries(
        Object.entries(state.articles).map(([id, a]) => [
          id,
          id === "local-notebook-fixture" ? { ...a, versionId: "v-new" } : a,
        ]),
      ),
      // `remoteVersionId` is likewise absent from the backup format, so it
      // is re-stated for the same reason: without it every restored note is
      // indistinguishable from one anchored to the text on screen.
      notes: Object.fromEntries(
        Object.entries(state.notes)
          .filter(
            ([, n]) => n.articleId !== "local-notebook-fixture" || n.id === "oldver",
          )
          .map(([id, n]) => [
            id,
            id === "oldver" ? { ...n, remoteVersionId: "v-old" } : n,
          ]),
      ),
      highlights: Object.fromEntries(
        Object.entries(state.highlights).filter(
          ([, h]) => h.articleId !== "local-notebook-fixture",
        ),
      ),
    });
  });
  await openNotebook();
  await page.getByTestId("notebook-filter-all").click();
  const leftover = await page
    .locator('[data-testid="notebook"] [data-entry-id]')
    .evaluateAll((els) => els.map((el) => el.dataset.entryId));
  assert.deepEqual(leftover, [], "no current-version entries should remain");
  assert.equal(await page.getByTestId("notebook-copy").isEnabled(), true);
  assert.equal(await page.getByTestId("notebook-download").isEnabled(), true);
  assert.equal(await page.getByTestId("notebook-other-versions").count(), 1);
  assert.match(await page.getByTestId("notebook-summary").innerText(), /其他版本的笔记/);
  await page.getByTestId("notebook-copy").click();
  const othersOnly = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(othersOnly, /## 其他版本的笔记/);
  assert.match(othersOnly, /## ¶14 · AI问答（其它版本）/);
  assert.match(othersOnly, /\*\*问 1：\*\* 旧版本的问题/);
  assert.match(othersOnly, /\*\*问 2：\*\* 旧版本的追问/);
  assert.match(othersOnly, /旧版本追问的半截/);
  assert.match(othersOnly, /（回答已中断，内容不完整。）/);
  assert.match(othersOnly, /共 1 条记录：当前正文 0 条，其他版本 1 条。/);
  results.checks.push(
    "an article whose only notes belong to another version still exports them, in full",
  );

  assert.deepEqual(errors, [], "the page must raise no errors");
  const offHost = results.externalRequests.filter((r) => !r.known);
  assert.deepEqual(offHost, [], "only the app's own webfont may leave 127.0.0.1");
  results.checks.push(
    `no model or extraction request: ${results.externalRequests.length} off-host request(s), all webfont`,
  );
  results.pageErrors = errors;
  results.pass = true;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "notebook.json"), JSON.stringify(results, null, 2));
  console.log(`Browser notebook: passed (${results.checks.length} checks, 0 page errors).`);
  console.log(`Evidence: ${evidenceDir}`);
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) {
    const done = once(vite, "exit");
    vite.kill();
    await done;
  }
}
