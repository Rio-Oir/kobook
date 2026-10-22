// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Note-record lifecycle gate (base line).
 *
 * The behaviour this file exists to prove cannot be seen in a unit test:
 * a record that belongs to a passage, collapses when the reader scrolls
 * away, and comes back when they click it — without ever losing the saved
 * question, the underline, the follow-up draft, or a running stream.
 *
 * What only a browser can show, and why each check exists:
 *
 *   - a card's document-space top is the passage's own top, so scrolling
 *     the article carries the record with it instead of leaving a
 *     conversation pinned to the viewport;
 *   - the ✕ collapses and nothing else: the record and its underline are
 *     still in `localStorage`, and clicking the compact record reopens
 *     the same note;
 *   - scrolling away collapses an idle conversation, but never one whose
 *     input has focus, whose draft is non-empty, or that is streaming —
 *     and an explicit collapse does not abort the stream or drop the
 *     draft, because the card stays mounted;
 *   - two notes over the same words resolve to their own occurrences, and
 *     two notes on one paragraph do not overlap;
 *   - a note whose anchor no longer resolves is placed, readable and
 *     deletable without a guessed underline;
 *   - narrow (1024) and mobile (390) layouts do not overflow.
 *
 * Everything is synthetic and local: the app is started from source on a
 * free loopback port, the article and notes are seeded through the store
 * the app itself uses, every request that leaves `127.0.0.1` is aborted,
 * and no model call is made. Run: node tests/browser-note-lifecycle.mjs
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
const evidenceDir = join(root, "docs", "evidence", "note-lifecycle-2026-10-19");

const ARTICLE_ID = "local-note-lifecycle-fixture";
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
/** A paragraph with the same two characters three times, for repeat-quote checks. */
const REPEAT_INDEX = 2;
const REPEAT_TEXT = "世尊说：世尊。世尊又说。";
const STREAM_INDEX = 3;
const LEGACY_INDEX = 4;
const DRAFT_INDEX = 5;
const COLLISION_INDEX = 20;
/** Far enough down that scrolling to it puts the upper passages off screen. */
const AWAY_INDEX = 35;

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

function fixture() {
  const paragraphs = [
    { index: 1, text: "旁注生命周期测试", hash: "h01", type: "heading", level: 1 },
    { index: REPEAT_INDEX, text: REPEAT_TEXT, hash: "h02", type: "paragraph" },
    { index: STREAM_INDEX, text: "第三段用于流式测试。", hash: "h03", type: "paragraph" },
    { index: LEGACY_INDEX, text: "第四段有唯一词孤舟。", hash: "h04", type: "paragraph" },
    { index: DRAFT_INDEX, text: "第五段用来放追问草稿。", hash: "h05", type: "paragraph" },
    ...Array.from({ length: 35 }, (_, i) => {
      const index = i + 6;
      const text =
        index === COLLISION_INDEX
          ? "第二十段碰撞测试。"
          : `这是第${index}段测试正文。`.repeat(8);
      return {
        index,
        text,
        hash: `h${String(index).padStart(2, "0")}`,
        type: "paragraph",
      };
    }),
  ];
  return {
    id: ARTICLE_ID,
    title: "旁注生命周期测试",
    createdAt: Date.now(),
    paragraphs,
  };
}

/**
 * The note fixtures, in creation order.
 *
 * `lc-first` / `lc-second` are the same two characters at different
 * offsets in one paragraph — the pair that proves the underline and the
 * card follow the stored range, not the first occurrence. The two
 * `lc-collide-*` notes share one paragraph, for the collision rule.
 * `lc-orphan` names a paragraph that does not exist and has no offsets:
 * nothing can be underlined, and nothing should be guessed.
 */
function fixtureNotes() {
  const base = {
    articleId: ARTICLE_ID,
    model: "fixture-model",
    isStreaming: false,
    answer: "演示回答。",
    question: "演示问题",
    type: "ask",
  };
  const at = (id, index, start, end, text, createdAt, extra = {}) => ({
    ...base,
    id,
    paragraphIndex: index,
    startParagraphIndex: index,
    endParagraphIndex: index,
    startOffset: start,
    endOffset: end,
    selectionText: text,
    createdAt,
    ...extra,
  });
  return {
    "lc-first": at("lc-first", REPEAT_INDEX, 0, 2, "世尊", 1, {
      answer: "第一处。参见¶30。",
    }),
    "lc-second": at("lc-second", REPEAT_INDEX, 4, 6, "世尊", 2, {
      answer: "第二处。",
    }),
    "lc-collide-a": at("lc-collide-a", COLLISION_INDEX, 0, 3, "第二十", 3),
    "lc-collide-b": at("lc-collide-b", COLLISION_INDEX, 3, 6, "段碰撞", 4),
    "lc-stream": at("lc-stream", STREAM_INDEX, 0, 3, "第三段", 5, {
      answer: "流式前的内容。",
    }),
    "lc-legacy": {
      ...base,
      id: "lc-legacy",
      paragraphIndex: LEGACY_INDEX,
      selectionText: "孤舟",
      createdAt: 6,
    },
    "lc-draft": at("lc-draft", DRAFT_INDEX, 0, 3, "第五段", 7),
    "lc-orphan": {
      ...base,
      id: "lc-orphan",
      paragraphIndex: 999,
      selectionText: "不存在",
      createdAt: 8,
    },
  };
}

let vite;
let browser;
const results = {
  generatedAt: new Date().toISOString(),
  command: "node tests/browser-note-lifecycle.mjs",
  article: ARTICLE_ID,
  checks: [],
  storage: {},
  pageErrors: [],
  externalRequests: [],
  screenshots: [],
};

const cardOf = (id) => `[data-testid="note-card"][data-note-id="${id}"]`;
const slotOf = (id) => `[data-note-slot="${id}"]`;

async function isExpanded(page, id) {
  return page.evaluate(
    (noteId) =>
      document.querySelector(`[data-testid="note-card"][data-note-id="${noteId}"]`)?.dataset
        .noteExpanded === "true",
    id,
  );
}

async function expandNote(page, id) {
  if (await isExpanded(page, id)) return;
  await page.locator(`${slotOf(id)} [data-testid="note-expand"]`).click();
  await page.waitForFunction(
    (noteId) =>
      document.querySelector(`[data-testid="note-card"][data-note-id="${noteId}"]`)?.dataset
        .noteExpanded === "true",
    id,
  );
}

async function collapseNote(page, id) {
  await page.locator(`${slotOf(id)} [data-testid="note-collapse"]`).click();
  await page.waitForFunction(
    (noteId) =>
      document.querySelector(`[data-testid="note-card"][data-note-id="${noteId}"]`)?.dataset
        .noteExpanded === "false",
    id,
  );
}

async function scrollToParagraph(page, index) {
  await page.evaluate((i) => {
    document
      .querySelector(`[data-paragraph-index="${i}"]`)
      ?.scrollIntoView({ block: "center" });
  }, index);
  await delay(120);
}

async function waitCollapsed(page, id, timeout = 5000) {
  await page.waitForFunction(
    (noteId) =>
      document.querySelector(`[data-testid="note-card"][data-note-id="${noteId}"]`)?.dataset
        .noteExpanded === "false",
    id,
    { timeout },
  );
}

async function storedNotes(page) {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("gloss-storage")).state.notes,
  );
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", (route) => {
    const requestUrl = route.request().url();
    const host = new URL(requestUrl).hostname;
    if (host === "127.0.0.1") return route.continue();
    results.externalRequests.push({ url: requestUrl, host, known: FONT_HOSTS.has(host) });
    return route.abort();
  });
  const page = await context.newPage();



/**
 * Flip one rail's switch.
 *
 * 目录 / 笔记栏 moved out of the header into the reading-settings popover
 * (they are view preferences, and the header now holds four controls), so
 * the switch has to be opened, flipped, and the popover closed again — its
 * click-away layer covers the viewport and would otherwise swallow the next
 * click anywhere else on the page.
 */
async function toggleRail(testid) {
  if ((await page.locator('[data-testid="reading-settings"]').count()) === 0) {
    await page.click('[data-testid="reading-settings-toggle"]');
    await page.waitForSelector('[data-testid="reading-settings"]');
  }
  await page.getByTestId(testid).click();
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="reading-settings"]', { state: "detached" });
}

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));

  await page.goto(url);
  await page.evaluate(
    async ([id, article, notes]) => {
      const { useStore } = await import("/src/lib/store.ts");
      // The text is a body now, and `saveArticle` is the one path that
      // installs both halves. A bare `setState({ articles })` would put a
      // record in the store whose text is nowhere — which the reader reports
      // as unavailable rather than rendering, so the gate would time out
      // waiting for paragraphs that were never saved.
      const { paragraphs, ...record } = article;
      useStore.setState({ notes });
      await useStore.getState().saveArticle(record, paragraphs);
      location.hash = `#/r/${id}`;
    },
    [ARTICLE_ID, fixture(), fixtureNotes()],
  );
  await page.locator(`[data-paragraph-index="${REPEAT_INDEX}"]`).waitFor();
  assert.equal(await page.locator("[data-paragraph-index]").count(), 40);
  results.checks.push("40 blocks rendered from the seeded article");

  // ── 1. Every record starts compact, in document space ───────────────
  assert.equal(await page.locator('[data-testid="note-card"]').count(), 8);
  assert.equal(await page.locator('[data-testid="note-card"][data-note-expanded="true"]').count(), 0);
  results.checks.push("all eight saved records render compact on load");

  assert.equal(await page.locator("[data-note-anchor]").count(), 7);
  results.checks.push("seven saved anchors underline their stored range");

  await delay(300);
  const geometry = await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="notes-stage"]');
    const slot = document.querySelector('[data-note-slot="lc-first"]');
    const anchor = document.querySelector('[data-note-anchor="lc-first"]');
    const stageTop = stage.getBoundingClientRect().top;
    return {
      slotOffset: slot.getBoundingClientRect().top - stageTop,
      anchorOffset: anchor.getBoundingClientRect().top - stageTop,
    };
  });
  assert.ok(
    Math.abs(geometry.slotOffset - geometry.anchorOffset) <= 3,
    `the card must sit at its passage (card ${geometry.slotOffset}, passage ${geometry.anchorOffset})`,
  );
  results.checks.push("a record's rail top is its passage's top in document space");

  assert.equal(
    await page.locator(`${slotOf("lc-orphan")}`).getAttribute("data-note-position"),
    "unresolved",
  );
  assert.equal(
    await page.locator(cardOf("lc-orphan")).getAttribute("data-note-anchored"),
    "false",
  );
  assert.equal(await page.locator('[data-note-anchor="lc-orphan"]').count(), 0);
  results.checks.push("an unanchored old note is placed and marked, with no guessed underline");

  // The unresolved record is still a readable, openable, closable record —
  // it just cannot claim a passage.
  await page.locator(`${slotOf("lc-orphan")}`).scrollIntoViewIfNeeded();
  await expandNote(page, "lc-orphan");
  assert.equal(await page.locator(`${slotOf("lc-orphan")} input`).isVisible(), true);
  await collapseNote(page, "lc-orphan");
  assert.ok((await storedNotes(page))["lc-orphan"], "closing it must not delete it");
  results.checks.push("an unanchored note still opens, closes and stays saved");

  // ── 2. Repeat quote: each underline opens its own record ────────────
  await page.locator('[data-note-anchor="lc-second"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-note-id="lc-second"]')?.dataset.noteActive === "true" &&
      document.querySelector('[data-note-id="lc-second"]')?.dataset.noteExpanded === "true",
  );
  assert.equal(await isExpanded(page, "lc-first"), false);
  results.checks.push("clicking the second occurrence's underline opens the second note");

  await page.locator('[data-note-anchor="lc-first"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-note-id="lc-first"]')?.dataset.noteActive === "true" &&
      document.querySelector('[data-note-id="lc-first"]')?.dataset.noteExpanded === "true",
  );
  assert.equal(await isExpanded(page, "lc-second"), false);
  await page.locator('[data-testid="note-connection"]').waitFor();
  results.checks.push("clicking the first occurrence opens the first note, and the connector draws");

  // ── 3. ✕ collapses; the record and underline stay saved ─────────────
  await collapseNote(page, "lc-first");
  const afterCollapse = await storedNotes(page);
  assert.equal(afterCollapse["lc-first"].selectionText, "世尊");
  assert.equal(afterCollapse["lc-first"].startOffset, 0);
  assert.equal(Object.keys(afterCollapse).length, 8);
  assert.equal(await page.locator("[data-note-anchor]").count(), 7);
  assert.equal(await page.locator(cardOf("lc-first")).count(), 1);
  results.checks.push("closing with ✕ keeps the saved record, its offsets and its underline");

  // ── 4. The compact record reopens the same note ─────────────────────
  await expandNote(page, "lc-first");
  assert.equal(await isExpanded(page, "lc-first"), true);
  assert.equal(await page.locator(`${slotOf("lc-first")} input`).isVisible(), true);
  results.checks.push("clicking the compact record reopens the saved note");

  // ── 5. Draft and focus: protected, and a collapse keeps the text ────
  // Ordinary controls inside a card are *not* "in use". Focus is sticky —
  // after any click the button keeps it — so if a focused copy/collapse
  // button counted as use, a record that was ever opened would stay open
  // for the rest of the session. (This is the regression the review
  // caught; it must stay fixed here.)
  await expandNote(page, "lc-first");
  await page.locator(`${slotOf("lc-first")} [aria-label="复制回答"]`).focus();
  await scrollToParagraph(page, AWAY_INDEX);
  await waitCollapsed(page, "lc-first");
  results.checks.push("focus on an ordinary card control does not keep a record open");

  // An editable field is different: scrolling away while the reader's
  // caret is in the follow-up input must not hide the field under them.
  await expandNote(page, "lc-draft");
  await page.locator(`${slotOf("lc-draft")} input`).focus();
  await scrollToParagraph(page, AWAY_INDEX);
  await delay(600);
  assert.equal(
    await isExpanded(page, "lc-draft"),
    true,
    "a focused follow-up input must not be collapsed away",
  );
  results.checks.push("a focused follow-up keeps its conversation open while the page scrolls");

  // With focus gone and no draft, the same scroll collapses it.
  await page.evaluate(() => document.activeElement?.blur());
  await waitCollapsed(page, "lc-draft");

  await scrollToParagraph(page, DRAFT_INDEX);
  await expandNote(page, "lc-draft");
  await page.locator(`${slotOf("lc-draft")} input`).fill("半截追问");
  await page.evaluate(() => document.activeElement?.blur());
  // Still on screen: nothing collapses just because focus moved away.
  await delay(400);
  assert.equal(await isExpanded(page, "lc-draft"), true);
  await scrollToParagraph(page, AWAY_INDEX);
  await delay(600);
  assert.equal(
    await isExpanded(page, "lc-draft"),
    true,
    "a card with a non-empty draft must not collapse",
  );
  assert.equal(await page.locator(`${slotOf("lc-draft")} input`).inputValue(), "半截追问");
  results.checks.push("a non-empty draft keeps the conversation open and keeps its text");

  // Clearing the draft lets the same scroll collapse it.
  await page.locator(`${slotOf("lc-draft")} input`).fill("");
  await page.evaluate(() => document.activeElement?.blur());
  await scrollToParagraph(page, AWAY_INDEX);
  await waitCollapsed(page, "lc-draft");
  const afterDraftScroll = await storedNotes(page);
  assert.equal(afterDraftScroll["lc-draft"].selectionText, "第五段");
  assert.equal(await page.locator('[data-note-anchor="lc-draft"]').count(), 1);
  results.checks.push("scrolling away collapses an idle conversation, keeping its record and underline");

  await scrollToParagraph(page, DRAFT_INDEX);
  await expandNote(page, "lc-draft");
  assert.equal(await page.locator(`${slotOf("lc-draft")} input`).inputValue(), "");
  results.checks.push("a cleared draft is not resurrected by reopening the record");

  // ── 6. Streaming: protected, and a collapse never interrupts it ─────
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("lc-stream", {
      isStreaming: true,
      localStatus: "running",
      activeTurnId: "turn-lifecycle",
      activeTurnText: "半截流式内容",
      answer: "半截流式内容",
    });
  });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-note-id="lc-stream"]')?.dataset.noteStreaming === "true",
  );
  await scrollToParagraph(page, STREAM_INDEX);
  await expandNote(page, "lc-stream");
  await scrollToParagraph(page, AWAY_INDEX);
  await delay(600);
  assert.equal(
    await isExpanded(page, "lc-stream"),
    true,
    "a streaming note must not auto-collapse",
  );
  results.checks.push("a streaming conversation stays open when its passage scrolls away");

  await collapseNote(page, "lc-stream");
  assert.equal(
    await page.locator(`${slotOf("lc-stream")} input`).count(),
    1,
    "collapsing must not unmount the card or its input",
  );
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().appendToNote("lc-stream", "＋迟到的分片");
  });
  const streamed = await storedNotes(page);
  assert.ok(streamed["lc-stream"].answer.includes("＋迟到的分片"));
  assert.equal(
    await page.locator(cardOf("lc-stream")).getAttribute("data-note-streaming"),
    "true",
  );
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("lc-stream", {
      isStreaming: false,
      activeTurnText: undefined,
      localStatus: "succeeded",
    });
  });
  const finished = await storedNotes(page);
  assert.ok(finished["lc-stream"].answer.includes("半截流式内容"));
  results.checks.push("an explicit collapse keeps the stream's card, input and incoming text alive");

  // ── 7. Two notes on one paragraph never overlap ─────────────────────
  await scrollToParagraph(page, COLLISION_INDEX);
  await expandNote(page, "lc-collide-a");
  const overlap = await page.evaluate(() => {
    const a = document.querySelector('[data-note-slot="lc-collide-a"]').getBoundingClientRect();
    const b = document.querySelector('[data-note-slot="lc-collide-b"]').getBoundingClientRect();
    return { aBottom: a.bottom, bTop: b.top, bTopBefore: b.top };
  });
  assert.ok(
    overlap.bTop >= overlap.aBottom - 1,
    `colliding records must not overlap (a.bottom ${overlap.aBottom}, b.top ${overlap.bTop})`,
  );
  await collapseNote(page, "lc-collide-a");
  const moved = await page.evaluate(
    () =>
      document.querySelector('[data-note-slot="lc-collide-b"]').getBoundingClientRect().top,
  );
  assert.ok(
    moved < overlap.bTopBefore,
    `collapsing the card above must let the next record move up (${moved} < ${overlap.bTopBefore})`,
  );
  results.checks.push("two records on one paragraph stack without overlap and close the gap");

  // ── 8. Paragraph citations still work from the rail ─────────────────
  await scrollToParagraph(page, REPEAT_INDEX);
  await expandNote(page, "lc-first");
  await page.getByRole("button", { name: "第 30 段", exact: true }).click();
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-paragraph-index="30"]').getBoundingClientRect();
    return rect.top > 60 && rect.bottom < innerHeight;
  });
  results.checks.push("a ¶30 citation in an answer still scrolls to that paragraph");

  // ── 9. Explicit delete: armed, then confirmed ───────────────────────
  await scrollToParagraph(page, REPEAT_INDEX);
  await expandNote(page, "lc-second");
  await page.locator(`${slotOf("lc-second")} [data-testid="note-delete"]`).click();
  assert.equal(
    await page.locator(`${slotOf("lc-second")} [data-testid="note-delete"]`).getAttribute("aria-label"),
    "确认删除笔记",
  );
  assert.equal(await page.locator('[data-note-anchor="lc-second"]').count(), 1);
  assert.ok((await storedNotes(page))["lc-second"], "arming delete must not remove anything");
  await page.locator(`${slotOf("lc-second")} [data-testid="note-delete"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-note-anchor="lc-second"]').length === 0);
  const afterDelete = await storedNotes(page);
  assert.equal(afterDelete["lc-second"], undefined);
  assert.equal(Object.keys(afterDelete).length, 7);
  results.checks.push("delete is a separate action (arm, then confirm) and removes only that note");

  // ── 10. Narrow and mobile: no overflow ──────────────────────────────
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.locator('[data-testid="notes-panel"]').waitFor();
  const narrow = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="notes-panel"]');
    const overflowing = Array.from(document.querySelectorAll("[data-note-slot]")).filter((slot) => {
      const card = slot.firstElementChild;
      return card && card.scrollWidth - card.clientWidth > 1;
    }).length;
    return {
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panelVisible: getComputedStyle(panel).display !== "none",
      overflowing,
    };
  });
  assert.ok(narrow.documentOverflow <= 1, `1024 must not overflow (${narrow.documentOverflow}px)`);
  assert.equal(narrow.panelVisible, true);
  assert.equal(narrow.overflowing, 0, "no card may overflow its rail at 1024");
  results.checks.push("at 1024 the rail is visible and neither the page nor a card overflows");

  await page.setViewportSize({ width: 390, height: 844 });
  await delay(150);
  const mobile = await page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    panelVisible: getComputedStyle(document.querySelector('[data-testid="notes-panel"]')).display !== "none",
  }));
  assert.ok(mobile.documentOverflow <= 1, `390 must not overflow (${mobile.documentOverflow}px)`);
  assert.equal(mobile.panelVisible, false);
  assert.equal(await page.locator("[data-note-anchor]").count(), 6);
  await mkdir(evidenceDir, { recursive: true });
  const mobileShot = join(evidenceDir, "note-lifecycle-mobile-390.png");
  await page.screenshot({ path: mobileShot, fullPage: true });
  results.screenshots.push(mobileShot);
  results.checks.push("at 390 the rail is hidden, the page does not overflow, and underlines remain");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(`[data-paragraph-index="${REPEAT_INDEX}"]`).waitFor();
  await scrollToParagraph(page, REPEAT_INDEX);
  await expandNote(page, "lc-first");
  await page.waitForTimeout(150);
  const desktopShot = join(evidenceDir, "note-lifecycle-desktop-1440.png");
  await page.screenshot({ path: desktopShot });
  results.screenshots.push(desktopShot);

  await page.evaluate(() => document.activeElement?.blur());
  await scrollToParagraph(page, AWAY_INDEX);
  await waitCollapsed(page, "lc-first");
  const scrolledShot = join(evidenceDir, "note-lifecycle-scrolled-away.png");
  await page.screenshot({ path: scrolledShot });
  results.screenshots.push(scrolledShot);
  results.checks.push("desktop evidence captured for the open record and the collapsed scroll-away");

  // ── 11. A new question opens its record, and the rail with it ───────
  const railStage = page.locator('[data-testid="notes-stage"]');
  await toggleRail("notes-rail-toggle");
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-testid="notes-stage"]')).visibility ===
      "hidden",
  );
  const beforeIds = Object.keys(await storedNotes(page));
  await scrollToParagraph(page, AWAY_INDEX);
  await page.locator(`[data-paragraph-index="${AWAY_INDEX}"]`).evaluate((element, length) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.textContent ?? "").trim().length >= length) break;
    }
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, 3);
  await page.getByRole("button", { name: "解释", exact: true }).click();
  await page.waitForFunction((known) => {
    const notes = JSON.parse(localStorage.getItem("gloss-storage")).state.notes;
    return Object.values(notes).some(
      (note) =>
        !known.includes(note.id) && note.answer.includes("演示模式") && !note.isStreaming,
    );
  }, beforeIds);
  const created = await page.evaluate((known) => {
    const notes = JSON.parse(localStorage.getItem("gloss-storage")).state.notes;
    return Object.values(notes).find((note) => !known.includes(note.id));
  }, beforeIds);
  await page.waitForFunction(
    (noteId) =>
      document.querySelector(`[data-testid="note-card"][data-note-id="${noteId}"]`)?.dataset
        .noteExpanded === "true" &&
      document.querySelector(`[data-testid="note-card"][data-note-id="${noteId}"]`)?.dataset
        .noteActive === "true",
    created.id,
  );
  assert.equal(await railStage.isVisible(), true, "a new question must reopen the notes rail");
  assert.equal(await page.locator(`[data-note-anchor="${created.id}"]`).count(), 1);
  results.checks.push("asking a new question reopens the rail and opens the new record");

  // ── 12. The whole run stayed local ──────────────────────────────────
  assert.deepEqual(errors, [], "the page must raise no errors");
  const offHost = results.externalRequests.filter((r) => !r.known);
  assert.deepEqual(offHost, [], "only the app's own webfont may leave 127.0.0.1");
  results.checks.push(
    `no model or extraction request: ${results.externalRequests.length} off-host request(s), all webfont`,
  );
  results.storage.remainingNotes = Object.keys(await storedNotes(page)).sort();
  results.pageErrors = errors;
  results.pass = true;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "note-lifecycle.json"), JSON.stringify(results, null, 2));
  console.log(`Browser note lifecycle: passed (${results.checks.length} checks, 0 page errors).`);
  console.log(`Evidence: ${evidenceDir}`);
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) {
    const done = once(vite, "exit");
    vite.kill();
    await done;
  }
}
