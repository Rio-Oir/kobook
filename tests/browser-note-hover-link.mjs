// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Hover/focus association and connector gate (base line).
 *
 * The behaviour this file exists to prove is the one the screenshot
 * showed: a curve painted nowhere near the card it belongs to, and no way
 * for the reader to say *which* record they are pointing at. Three things
 * have to hold, and none of them can be seen in a unit test:
 *
 *   - pointing at a card highlights the exact passage that record resolves
 *     to — not the whole paragraph — and leaving restores whatever was
 *     emphasised before, without expanding the card or scrolling the page;
 *   - the connector follows the card under the pointer (falling back to the
 *     active one), and its two endpoints are the DOM endpoints: the same
 *     numbers `getBoundingClientRect()` reports, before and after scrolling
 *     up and down, and never painted outside the viewport;
 *   - an open record's bounded adjustment keeps its top clear of the
 *     header while its passage is on screen, and is released when the
 *     passage leaves.
 *
 * Everything is synthetic and local: the app is started from source on a
 * free loopback port, the article and notes are seeded through the store
 * the app itself uses, every request that leaves `127.0.0.1` is aborted,
 * and no model call is made. Run: node tests/browser-note-hover-link.mjs
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
const evidenceDir = join(root, "docs", "evidence", "note-hover-link-2026-10-19");

const ARTICLE_ID = "local-note-hover-fixture";
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

/** The tall first body paragraph: the open record is nudged against it. */
const TALL_INDEX = 2;
/** A short paragraph carrying two records over different words. */
const PAIR_INDEX = 3;
/** A paragraph whose quote wraps, so the anchor has several line boxes. */
const MULTI_INDEX = 4;
/** The paragraph whose record holds a follow-up draft. */
const DRAFT_INDEX = 5;
/** Far enough down that scrolling to it puts the upper passages off screen. */
const AWAY_INDEX = 35;

const PAIR_TEXT = "阿难说：这一段很短，但里面有两个词。";

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

function fixture() {
  const paragraphs = [
    { index: 1, text: "旁注悬停关联测试", hash: "h01", type: "heading", level: 1 },
    // Tall on purpose: its first lines can be under the header while the
    // rest of it is still well inside the reading area.
    { index: TALL_INDEX, text: "这是第二段测试正文。".repeat(30), hash: "h02", type: "paragraph" },
    { index: PAIR_INDEX, text: PAIR_TEXT, hash: "h03", type: "paragraph" },
    { index: MULTI_INDEX, text: "这是第四段测试正文。".repeat(12), hash: "h04", type: "paragraph" },
    { index: DRAFT_INDEX, text: "第五段用来放追问草稿。", hash: "h05", type: "paragraph" },
    ...Array.from({ length: 35 }, (_, i) => {
      const index = i + 6;
      return {
        index,
        text: `这是第${index}段测试正文。`.repeat(8),
        hash: `h${String(index).padStart(2, "0")}`,
        type: "paragraph",
      };
    }),
  ];
  return { id: ARTICLE_ID, title: "旁注悬停关联测试", createdAt: Date.now(), paragraphs };
}

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
    // A compact record on the heading, directly above the tall paragraph.
    // Its card is what pushes the open record's own top *below* its
    // passage, which is the case where the nudge has to be measured from
    // the collision-resolved position rather than from the passage.
    "hb-head": at("hb-head", 1, 0, 2, "旁注", 0),
    // Four lines of the tall paragraph, so the record's own passage stays
    // "on screen" (per the hysteresis rule) while its top edge does not.
    // The quote has to be the text its offsets actually cover: a note whose
    // stored quote and offsets disagree resolves to no anchor at all (see
    // `lib/note-anchors.ts`), which would make every assertion below pass
    // for the wrong reason.
    "hb-nudge": at("hb-nudge", TALL_INDEX, 0, 120, "这是第二段测试正文。".repeat(12), 1, {
      answer: "这一条的回答很短。",
    }),
    // Two records over different words of one short paragraph: the pair
    // that proves emphasis is per slice and that hovering picks the right
    // one of two overlapping cards.
    "hb-a": at("hb-a", PAIR_INDEX, 0, 2, "阿难", 2),
    "hb-b": at("hb-b", PAIR_INDEX, 2, 4, "说：", 3),
    // A quote that wraps across lines, for the `getClientRects()` rule.
    "hb-multi": at("hb-multi", MULTI_INDEX, 0, 40, "这是第四段测试正文。".repeat(4), 4),
    "hb-draft": at("hb-draft", DRAFT_INDEX, 0, 3, "第五段", 5),
    "hb-away": at("hb-away", AWAY_INDEX, 0, 3, "这是第", 6),
  };
}

let vite;
let browser;
const results = {
  generatedAt: new Date().toISOString(),
  command: "node tests/browser-note-hover-link.mjs",
  article: ARTICLE_ID,
  checks: [],
  measurements: {},
  pageErrors: [],
  externalRequests: [],
  screenshots: [],
};

const cardOf = (id) => `[data-testid="note-card"][data-note-id="${id}"]`;
const slotOf = (id) => `[data-note-slot="${id}"]`;

async function storedNotes(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("gloss-storage")).state.notes);
}

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

async function scrollToParagraph(page, index) {
  await page.evaluate((i) => {
    document
      .querySelector(`[data-paragraph-index="${i}"]`)
      ?.scrollIntoView({ block: "center" });
  }, index);
  await delay(150);
}

/** Move the real pointer onto a card, without Playwright's auto-scroll. */
async function hoverCard(page, id) {
  const point = await page.evaluate((noteId) => {
    const card = document.querySelector(`[data-testid="note-card"][data-note-id="${noteId}"]`);
    const rect = card.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, id);
  await page.mouse.move(point.x, point.y);
  await delay(120);
}

/** The emphasis a note currently has in the article, read from the DOM. */
async function emphasisOf(page) {
  return page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll("[data-note-anchor]"));
    return spans.map((el) => ({
      anchor: el.dataset.noteAnchor,
      emphasised: el.dataset.noteEmphasis === "true",
      background: getComputedStyle(el).backgroundColor,
      text: el.textContent,
    }));
  });
}

/**
 * The connector's two endpoints as the browser reports them, plus the same
 * numbers taken independently from the DOM.
 *
 * `painted` is what a reader would see; `dom` is what the geometry should
 * be. Comparing the two is the whole point — a curve can be internally
 * consistent and still be drawn in the wrong coordinate space.
 */
async function endpoints(page) {
  return page.evaluate(() => {
    const path = document.querySelector('[data-testid="note-connection"]');
    const header = document.querySelector("header");
    const readingTop = header.getBoundingClientRect().bottom + 12;
    const readingBottom = window.innerHeight - 12;
    const active =
      document.querySelector('[data-note-id][data-note-associated="true"]') ??
      document.querySelector('[data-note-id][data-note-active="true"]');
    const id = active?.dataset.noteId ?? null;
    const main = document.querySelector("main");
    const card = active;
    const anchors = id
      ? Array.from(document.querySelectorAll(`[data-note-anchor="${id}"]`))
      : [];
    let lineBottom = null;
    for (const anchor of anchors) {
      for (const rect of Array.from(anchor.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.bottom > readingTop && rect.top < readingBottom) lineBottom = rect.bottom;
      }
    }
    const d = path?.getAttribute("d") ?? null;
    let painted = null;
    if (d) {
      const m = d.match(
        /^M ([\d.-]+) ([\d.-]+) C [\d.-]+ [\d.-]+, [\d.-]+ [\d.-]+, ([\d.-]+) ([\d.-]+)$/,
      );
      if (m) painted = { x: Number(m[1]), y: Number(m[2]), targetX: Number(m[3]), targetY: Number(m[4]) };
    }
    const pathRect = path?.getBoundingClientRect() ?? null;
    return {
      scrollY: Math.round(window.scrollY),
      id,
      d,
      painted,
      paintedBounds: pathRect
        ? { top: pathRect.top, bottom: pathRect.bottom, left: pathRect.left, right: pathRect.right }
        : null,
      dom: {
        x: main.getBoundingClientRect().right - 18,
        y: lineBottom === null ? null : lineBottom - 2,
        targetX: card.getBoundingClientRect().left,
        targetY: card.getBoundingClientRect().top + 24,
      },
    };
  });
}

function assertEndpoints(measured, label, tolerance = 1.5) {
  assert.ok(measured.painted, `${label}: the connector must be drawn`);
  const { painted, dom } = measured;
  assert.ok(dom.y !== null, `${label}: the passage must have a visible line box`);
  const pairs = [
    ["start x", painted.x, dom.x],
    ["start y", painted.y, dom.y],
    ["end x", painted.targetX, dom.targetX],
    ["end y", painted.targetY, dom.targetY],
  ];
  for (const [name, actual, expected] of pairs) {
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `${label}: ${name} painted at ${actual}, DOM says ${expected}`,
    );
  }
  return { painted, dom };
}

try {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  vite = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
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
  await page.locator(`[data-paragraph-index="${PAIR_INDEX}"]`).waitFor();
  await delay(400);
  assert.equal(await page.locator('[data-testid="note-card"]').count(), 7);
  // A note whose stored quote disagrees with its offsets resolves to no
  // anchor, and every emphasis assertion below would then be vacuous.
  assert.equal(
    await page.locator("[data-note-anchor]").count(),
    7,
    "every fixture record must resolve to exactly one underlined slice",
  );
  results.checks.push("seven saved records render compact on load, each resolving to its quote");

  // ── 1. Hovering a compact card highlights exactly its passage ────────
  await scrollToParagraph(page, PAIR_INDEX);
  const beforeHover = await page.evaluate(() => ({
    scrollY: window.scrollY,
    active: document.querySelector('[data-note-id][data-note-active="true"]')?.dataset.noteId ?? null,
    expanded: Array.from(document.querySelectorAll("[data-note-id]")).filter(
      (el) => el.dataset.noteExpanded === "true",
    ).length,
  }));
  await hoverCard(page, "hb-a");
  const hovered = await emphasisOf(page);
  const emphasisedA = hovered.filter((s) => s.emphasised);
  assert.ok(emphasisedA.length > 0, "hovering a card must emphasise its passage");
  assert.ok(
    emphasisedA.every((s) => s.anchor === "hb-a"),
    "only the pointed-at note's slices may be emphasised",
  );
  assert.ok(
    emphasisedA.every((s) => s.background === "rgba(100, 133, 220, 0.22)"),
    `the emphasis must be a visible wash, got ${emphasisedA.map((s) => s.background).join("/")}`,
  );
  assert.ok(
    emphasisedA.every((s) => PAIR_TEXT.includes(s.text)),
    "the emphasis must be the resolved quote, not the paragraph",
  );
  assert.ok(
    !emphasisedA.some((s) => s.text.length > 6),
    "a two-character quote must not emphasise a whole paragraph",
  );
  const afterHover = await page.evaluate(() => ({
    scrollY: window.scrollY,
    active: document.querySelector('[data-note-id][data-note-active="true"]')?.dataset.noteId ?? null,
    expanded: Array.from(document.querySelectorAll("[data-note-id]")).filter(
      (el) => el.dataset.noteExpanded === "true",
    ).length,
    associated:
      document.querySelector('[data-note-id="hb-a"]')?.dataset.noteAssociated ?? null,
  }));
  assert.equal(afterHover.scrollY, beforeHover.scrollY, "hovering must not scroll");
  assert.equal(afterHover.expanded, beforeHover.expanded, "hovering must not expand a card");
  assert.equal(afterHover.active, beforeHover.active, "hovering must not change the active note");
  assert.equal(afterHover.associated, "true");
  results.checks.push(
    `hovering a compact card emphasises its exact quote (${emphasisedA.length} slice(s)) without expanding or scrolling`,
  );

  // ── 2. Leaving restores the emphasis that was there before ──────────
  await page.mouse.move(600, 300);
  await delay(150);
  const left = await emphasisOf(page);
  assert.equal(
    left.filter((s) => s.emphasised).length,
    0,
    "leaving the card must clear the temporary emphasis",
  );
  assert.equal(
    left.filter((s) => s.background === "rgba(100, 133, 220, 0.22)").length,
    0,
  );
  results.checks.push("leaving the card restores the previous emphasis");

  // ── 3. An active record keeps its own, quieter, emphasis ────────────
  await page.locator('[data-note-anchor="hb-a"]').first().click();
  await delay(250);
  const activeState = await emphasisOf(page);
  const activeSlice = activeState.find((s) => s.anchor === "hb-a");
  assert.equal(
    activeSlice?.background,
    "rgba(100, 133, 220, 0.08)",
    "the active record keeps its own emphasis while nothing is pointed at",
  );
  results.checks.push("the active record keeps its quieter emphasis when nothing is pointed at");

  // Hovering the *other* record over the same paragraph moves the strong
  // emphasis onto it and leaves the active one where it was.
  await hoverCard(page, "hb-b");
  const bothHovered = await emphasisOf(page);
  const strong = bothHovered.filter((s) => s.background === "rgba(100, 133, 220, 0.22)");
  assert.ok(strong.length > 0 && strong.every((s) => s.anchor === "hb-b"));
  const stillActive = bothHovered.filter((s) => s.background === "rgba(100, 133, 220, 0.08)");
  assert.ok(
    stillActive.length > 0 && stillActive.every((s) => s.anchor === "hb-a"),
    "the active record keeps its emphasis while a different one is pointed at",
  );
  results.checks.push("hovering a second record over the same paragraph moves only the strong emphasis");

  // ── 4. Keyboard focus is equivalent to hovering ─────────────────────
  await page.mouse.move(600, 300);
  await delay(150);
  await page.locator(`${slotOf("hb-b")} [data-testid="note-expand"]`).focus();
  await delay(250);
  const focused = await emphasisOf(page);
  const focusedStrong = focused.filter((s) => s.background === "rgba(100, 133, 220, 0.22)");
  assert.ok(
    focusedStrong.length > 0 && focusedStrong.every((s) => s.anchor === "hb-b"),
    "tabbing into a card must emphasise its passage the same way hovering does",
  );
  const focusedState = await page.evaluate(() => ({
    associated: document.querySelector('[data-note-id="hb-b"]')?.dataset.noteAssociated,
    active: document.querySelector('[data-note-id][data-note-active="true"]')?.dataset.noteId ?? null,
  }));
  assert.equal(focusedState.associated, "true");
  assert.equal(
    focusedState.active,
    "hb-a",
    "focus must associate without moving the active identity the reader clicked",
  );
  results.checks.push("keyboard focus emphasises the same passage as hover without re-activating");

  // Blur restores the record the reader actually clicked.
  await page.evaluate(() => document.activeElement?.blur());
  await delay(250);
  const blurred = await emphasisOf(page);
  assert.equal(
    blurred.filter((s) => s.background === "rgba(100, 133, 220, 0.22)").length,
    0,
    "blurring must drop the temporary emphasis",
  );
  const restored = blurred.find((s) => s.anchor === "hb-a");
  assert.equal(
    restored?.background,
    "rgba(100, 133, 220, 0.08)",
    "blurring must restore the last clicked record's emphasis",
  );
  results.checks.push("leaving focus restores the last clicked record's emphasis");

  // ── 5. The curve's endpoints are the DOM endpoints, after scrolling ──
  await page.locator('[data-note-anchor="hb-a"]').first().click();
  await delay(300);
  const settled = await endpoints(page);
  const measured1 = assertEndpoints(settled, "at rest");
  results.measurements.atRest = measured1;
  results.checks.push("the connector's endpoints match the DOM endpoints at rest");

  await page.evaluate(() => window.scrollBy(0, 260));
  await delay(350);
  const down = await endpoints(page);
  assert.ok(
    down.paintedBounds && down.paintedBounds.top >= -1 && down.paintedBounds.bottom <= 1001,
    `after scrolling down the curve must stay inside the viewport, got ${JSON.stringify(down.paintedBounds)}`,
  );
  const measured2 = assertEndpoints(down, "after scrolling down");
  results.measurements.scrolledDown = measured2;

  await page.evaluate(() => window.scrollBy(0, -260));
  await delay(350);
  const up = await endpoints(page);
  const measured3 = assertEndpoints(up, "after scrolling back up");
  results.measurements.scrolledUp = measured3;
  assert.ok(
    Math.abs(measured3.painted.y - measured1.painted.y) <= 2,
    "returning to the same scroll position must put the curve back where it was",
  );
  results.checks.push(
    "the endpoints stay on the DOM endpoints after scrolling down and back up, and never leave the viewport",
  );

  // ── 6. The curve follows the card under the pointer ────────────────
  await scrollToParagraph(page, PAIR_INDEX);
  await page.locator('[data-note-anchor="hb-a"]').first().click();
  await delay(300);
  const activeCurve = await endpoints(page);
  assert.equal(activeCurve.id, "hb-a");
  await hoverCard(page, "hb-b");
  const hoverCurve = await endpoints(page);
  assert.equal(hoverCurve.id, "hb-b", "the curve must retarget to the card under the pointer");
  assertEndpoints(hoverCurve, "while hovering another card");
  await page.mouse.move(600, 300);
  await delay(250);
  const backCurve = await endpoints(page);
  assert.equal(backCurve.id, "hb-a", "leaving must return the curve to the active record");
  results.checks.push("the connector targets the pointed-at card and falls back to the active one");

  // ── 7. Bounded adjustment of an open record ────────────────────────
  //
  // The record on the heading is what pushes this one's card *below* its
  // own passage, so the nudge has to be measured from the position the
  // collision pass resolved rather than from the passage — that is the
  // case the two-pass layout exists for.
  const measureNudge = () =>
    page.evaluate(() => {
      const header = document.querySelector("header").getBoundingClientRect().bottom;
      const stage = document.querySelector('[data-testid="notes-stage"]').getBoundingClientRect().top;
      const slot = document.querySelector('[data-note-slot="hb-nudge"]');
      const anchor = document.querySelector('[data-note-anchor="hb-nudge"]');
      return {
        header,
        readingTop: header + 8,
        cardTop: slot.getBoundingClientRect().top,
        anchorTop: anchor.getBoundingClientRect().top,
        anchorBottom: anchor.getBoundingClientRect().bottom,
        push: slot.getBoundingClientRect().top - anchor.getBoundingClientRect().top,
      };
    });

  // Scroll so the passage's own top is above the reading area's top edge,
  // while the passage (four lines of it) is still on screen. 38px of
  // shortfall: well inside the 96px bound.
  const alignForNudge = async () => {
    await page.evaluate(() => {
      const header = document.querySelector("header").getBoundingClientRect().bottom;
      const anchor = document.querySelector('[data-note-anchor="hb-nudge"]');
      window.scrollBy(0, anchor.getBoundingClientRect().top - (header + 8 - 38));
    });
    await delay(500);
  };

  await alignForNudge();
  const compactPush = await measureNudge();
  assert.ok(
    compactPush.push > 0,
    `scenario precondition: the record above must push this one down, got ${compactPush.push}`,
  );
  assert.ok(
    compactPush.cardTop < compactPush.readingTop,
    `scenario precondition: the card's top must start under the reading area, got ${compactPush.cardTop} vs ${compactPush.readingTop}`,
  );

  await expandNote(page, "hb-nudge");
  await alignForNudge();
  const nudge = await measureNudge();
  assert.ok(
    nudge.anchorBottom > nudge.header + 24,
    `scenario precondition: the passage must still be on screen (bottom ${nudge.anchorBottom} vs header ${nudge.header})`,
  );
  assert.ok(
    Math.abs(nudge.cardTop - nudge.readingTop) <= 2,
    `an open record's top must be nudged clear of the header, got ${nudge.cardTop} for reading top ${nudge.readingTop}`,
  );
  assert.ok(
    nudge.push - compactPush.push <= 96,
    `the nudge must stay bounded, got ${nudge.push - compactPush.push}`,
  );
  assert.ok(
    nudge.push > compactPush.push,
    `the nudge must be applied on top of the collision push (${compactPush.push} -> ${nudge.push})`,
  );
  results.measurements.nudge = { compactPush, nudge };
  results.checks.push(
    `an open record under the header is nudged ${Math.round(nudge.push - compactPush.push)}px clear of it, on top of a ${Math.round(compactPush.push)}px collision push`,
  );

  // Scroll away: the record collapses and the adjustment is released, so
  // the card is back to exactly the collision push it had while compact.
  await scrollToParagraph(page, AWAY_INDEX);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-note-id="hb-nudge"]')?.dataset.noteExpanded === "false",
    undefined,
    { timeout: 5000 },
  );
  const released = await measureNudge();
  assert.ok(
    Math.abs(released.push - compactPush.push) <= 3,
    `a record whose passage has left must drop the nudge and keep only its collision push, got ${released.push} vs ${compactPush.push}`,
  );
  results.checks.push("scrolling the passage away collapses the record and releases the adjustment");

  // ── 8. No curve unless both endpoints are visible ───────────────────
  await scrollToParagraph(page, PAIR_INDEX);
  await page.locator('[data-note-anchor="hb-a"]').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  results.checks.push("the connector is drawn when both endpoints are on screen");

  // The passage scrolled off the top: there is nothing left to point at.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await delay(600);
  const atBottom = await page.evaluate(() => {
    const anchor = document.querySelector('[data-note-anchor="hb-a"]');
    return {
      anchorBottom: anchor.getBoundingClientRect().bottom,
      drawn: document.querySelectorAll('[data-testid="note-connection"]').length,
    };
  });
  assert.ok(
    atBottom.anchorBottom < 0,
    `scenario precondition: the passage must be above the viewport, got ${atBottom.anchorBottom}`,
  );
  assert.equal(atBottom.drawn, 0, "a passage above the viewport must not be connected");
  results.checks.push("a passage scrolled off the top is not connected");

  await scrollToParagraph(page, PAIR_INDEX);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  results.checks.push("scrolling back to the passage brings the curve back");

  // The card pushed below the fold while its own passage is still on
  // screen — the shape of the screenshot. The line must vanish rather than
  // stretch into empty space below the viewport.
  const longAnswer = "很长的回答。".repeat(300);
  await page.evaluate(async (answer) => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("hb-nudge", { answer });
  }, longAnswer);
  await expandNote(page, "hb-nudge");
  await page.locator(`${slotOf("hb-nudge")} input`).fill("保持展开");
  await page.evaluate(() => document.activeElement?.blur());
  await delay(250);
  await page.locator('[data-note-anchor="hb-a"]').first().click();
  await page.evaluate(() => {
    const anchor = document.querySelector('[data-note-anchor="hb-a"]');
    window.scrollBy(0, anchor.getBoundingClientRect().top - 120);
  });
  await delay(500);
  const pushed = await page.evaluate(() => {
    const anchor = document.querySelector('[data-note-anchor="hb-a"]');
    const card = document.querySelector('[data-note-id="hb-a"]');
    return {
      anchorTop: anchor.getBoundingClientRect().top,
      cardTop: card.getBoundingClientRect().top,
      drawn: document.querySelectorAll('[data-testid="note-connection"]').length,
    };
  });
  assert.ok(
    pushed.anchorTop > 60 && pushed.anchorTop < 400,
    `scenario precondition: the passage must be on screen, got ${pushed.anchorTop}`,
  );
  assert.ok(
    pushed.cardTop > 1000,
    `scenario precondition: the card must be below the fold, got ${pushed.cardTop}`,
  );
  assert.equal(
    pushed.drawn,
    0,
    "a card pushed past the bottom of the viewport must not be connected",
  );
  results.measurements.cardBelowFold = pushed;
  results.checks.push("a card pushed below the fold is not connected to its visible passage");

  // Put the fixture back the way the remaining checks expect it.
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("hb-nudge", { answer: "这一条的回答很短。" });
  });
  await page.locator(`${slotOf("hb-nudge")} input`).fill("");
  await page.evaluate(() => document.activeElement?.blur());
  await scrollToParagraph(page, PAIR_INDEX);
  await delay(400);

  // ── 8b. Switching the target to a record with nothing on screen must
  //        *clear* the curve. Regression: the "nothing to draw" key used
  //        to compare equal to the effect's initial value, so the state
  //        write was skipped and the previous target's path stayed on
  //        screen — a line pointing at a card the reader had stopped
  //        asking about.
  await scrollToParagraph(page, AWAY_INDEX);
  await page.locator('[data-note-anchor="hb-away"]').first().click();
  await delay(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(700);
  const awaySetup = await page.evaluate(() => ({
    active:
      document.querySelector('[data-note-id][data-note-active="true"]')?.dataset.noteId ?? null,
    cardTop: document.querySelector('[data-note-id="hb-away"]').getBoundingClientRect().top,
    drawn: document.querySelectorAll('[data-testid="note-connection"]').length,
  }));
  assert.equal(awaySetup.active, "hb-away");
  assert.ok(
    awaySetup.cardTop > 1000,
    `scenario precondition: the active record's card must be off screen, got ${awaySetup.cardTop}`,
  );
  assert.equal(awaySetup.drawn, 0, "an off-screen target draws nothing to begin with");

  // Point at a card that *is* visible: the curve appears...
  await hoverCard(page, "hb-nudge");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  // ...and leaving must hand the target back to the off-screen active
  // record and clear the curve, not leave the pointed-at card's line behind.
  await page.mouse.move(600, 300);
  await delay(350);
  assert.equal(
    await page.locator('[data-testid="note-connection"]').count(),
    0,
    "switching to a target with nothing on screen must clear the curve",
  );
  results.checks.push(
    "switching the target to a record with nothing on screen clears the curve (no leftover line)",
  );

  // Back to a state the width checks expect.
  await scrollToParagraph(page, PAIR_INDEX);
  await page.locator('[data-note-anchor="hb-a"]').first().click();
  await delay(400);

  // ── 9. Pushing the rail away leaves no ghost line ──────────────────
  await scrollToParagraph(page, PAIR_INDEX);
  await page.locator('[data-note-anchor="hb-a"]').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  await toggleRail("notes-rail-toggle");
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-testid="notes-stage"]')).visibility ===
      "hidden",
    undefined,
    { timeout: 5000 },
  );
  await delay(300);
  const hiddenRail = await page.evaluate(() => {
    const card = document.querySelector('[data-note-id="hb-a"]');
    return {
      cardVisibility: getComputedStyle(card).visibility,
      cardRectValid: card.getBoundingClientRect().height > 0,
      drawn: document.querySelectorAll('[data-testid="note-connection"]').length,
    };
  });
  assert.equal(hiddenRail.cardVisibility, "hidden");
  assert.equal(hiddenRail.cardRectValid, true, "a hidden card still reports a usable rect");
  assert.equal(
    hiddenRail.drawn,
    0,
    "a card the reader cannot see must not be connected",
  );
  results.measurements.hiddenRail = hiddenRail;
  results.checks.push("pushing the rail away hides the curve even though the card still measures");

  await toggleRail("notes-rail-toggle");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  results.checks.push("restoring the rail brings the curve back");

  // ── 10. Widths: 1024 keeps it, 390 has nothing to connect ──────────
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  assert.equal(await page.locator('[data-testid="notes-panel"]').isVisible(), true);
  results.checks.push("the connector and the rail hold at exactly 1024px");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 0,
    undefined,
    { timeout: 5000 },
  );
  results.checks.push("mobile 390px has no rail and therefore no curve");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  results.checks.push("the curve returns at 1440px");

  // ── 11. Two records on one paragraph still never overlap ───────────
  await scrollToParagraph(page, PAIR_INDEX);
  await delay(300);
  const pair = await page.evaluate(() => {
    const a = document.querySelector('[data-note-slot="hb-a"]').getBoundingClientRect();
    const b = document.querySelector('[data-note-slot="hb-b"]').getBoundingClientRect();
    return { aBottom: a.bottom, bTop: b.top, gap: b.top - a.bottom };
  });
  assert.ok(
    pair.gap >= 10,
    `two records on one paragraph must stay clear of each other, gap was ${pair.gap}`,
  );
  results.measurements.pairGap = pair;
  results.checks.push("two records on one paragraph are still pushed clear of each other");

  // ── 12. The multi-line quote connects from a visible line ──────────
  await page.locator('[data-note-anchor="hb-multi"]').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="note-connection"]').length === 1,
    undefined,
    { timeout: 5000 },
  );
  const multi = await page.evaluate(() => {
    const anchor = document.querySelector('[data-note-anchor="hb-multi"]');
    const rects = Array.from(anchor.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    return { lines: rects.length, first: rects[0]?.top, last: rects.at(-1)?.bottom };
  });
  assert.ok(multi.lines > 1, `the fixture quote must wrap, got ${multi.lines} line box(es)`);
  assertEndpoints(await endpoints(page), "multi-line quote");
  results.measurements.multiLine = multi;
  results.checks.push(`a ${multi.lines}-line quote connects from a line the reader can see`);

  // ── 13. ✕ keeps the record, the underline and the draft ────────────
  await scrollToParagraph(page, DRAFT_INDEX);
  await expandNote(page, "hb-draft");
  await page.locator(`${slotOf("hb-draft")} input`).fill("半截追问");
  await page.locator(`${slotOf("hb-draft")} [data-testid="note-collapse"]`).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-note-id="hb-draft"]')?.dataset.noteExpanded === "false",
    undefined,
    { timeout: 5000 },
  );
  const afterClose = await storedNotes(page);
  assert.equal(afterClose["hb-draft"].selectionText, "第五段");
  assert.equal(Object.keys(afterClose).length, 7);
  assert.equal(await page.locator('[data-note-anchor="hb-draft"]').count(), 1);
  await expandNote(page, "hb-draft");
  assert.equal(
    await page.locator(`${slotOf("hb-draft")} input`).inputValue(),
    "半截追问",
    "collapsing must not discard a half-typed follow-up",
  );
  results.checks.push("✕ collapses the record and keeps the underline, the record and the draft");

  // A running stream survives the same collapse: the card stays mounted.
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("hb-draft", { isStreaming: true });
  });
  await page.waitForFunction(
    () => document.querySelector('[data-note-id="hb-draft"]')?.dataset.noteStreaming === "true",
    undefined,
    { timeout: 5000 },
  );
  await page.locator(`${slotOf("hb-draft")} [data-testid="note-collapse"]`).click();
  await delay(250);
  const streaming = await page.evaluate(() => {
    const card = document.querySelector('[data-note-id="hb-draft"]');
    return {
      expanded: card.dataset.noteExpanded,
      streaming: card.dataset.noteStreaming,
      inputPresent: Boolean(card.querySelector("input")),
    };
  });
  assert.equal(streaming.streaming, "true", "collapsing must not clear the streaming flag");
  assert.equal(streaming.inputPresent, true, "collapsing must not unmount the follow-up input");
  results.checks.push("collapsing a streaming record neither clears the flag nor unmounts its input");
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    useStore.getState().updateNote("hb-draft", { isStreaming: false });
  });

  // ── 14. The whole run stayed local ────────────────────────────────
  assert.deepEqual(errors, [], "the page must raise no errors");
  const offHost = results.externalRequests.filter((r) => !r.known);
  assert.deepEqual(offHost, [], "only the app's own webfont may leave 127.0.0.1");
  results.checks.push(
    `no model or extraction request: ${results.externalRequests.length} off-host request(s), all webfont`,
  );

  results.storage = { remainingNotes: Object.keys(await storedNotes(page)).sort() };
  results.pageErrors = errors;
  results.pass = true;
  await mkdir(evidenceDir, { recursive: true });
  const shot = join(evidenceDir, "note-hover-link-desktop-1440.png");
  await page.screenshot({ path: shot });
  results.screenshots.push(shot);
  await writeFile(join(evidenceDir, "note-hover-link.json"), JSON.stringify(results, null, 2));
  console.log(
    `Browser note hover/link: passed (${results.checks.length} checks, 0 page errors).`,
  );
  console.log(`Evidence: ${evidenceDir}`);
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) {
    const done = once(vite, "exit");
    vite.kill();
    await done;
  }
}
