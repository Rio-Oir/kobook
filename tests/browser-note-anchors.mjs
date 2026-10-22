// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sidebar ↔ original-text association gate (base line).
 *
 * What only a browser can prove about this feature, and why each check
 * exists:
 *
 *   - a real `Range` built over rendered text produces the *stored*
 *     offsets, and the underline lands on the occurrence the reader
 *     dragged over rather than the first one with the same words;
 *   - the anchor survives a reload, because it is the stored note that
 *     drives it, not in-memory state;
 *   - a `¶N` reference in an answer scrolls to that paragraph, and a
 *     reference to a paragraph this document does not have is disabled
 *     rather than silently dead or silently dropped — the record is
 *     reopened first when the jump carried its passage off screen and the
 *     lifecycle collapsed it;
 *   - the connector is drawn only when both of its ends are on screen and
 *     the notes rail is actually rendered, which is a claim about
 *     viewport width and about the rail's own scroll container;
 *   - the existing reading layout still works around all of it: the
 *     outline sidebar opens and closes, the layout survives a resize
 *     across the `lg` breakpoint, and the connector is re-measured rather
 *     than left pointing at where something used to be;
 *   - closing a note with its ✕ collapses it without touching the saved
 *     record or its underline, clicking the compact record reopens it,
 *     and the separate explicit delete (armed, then confirmed) is what
 *     actually removes both ends.
 *
 * Everything is synthetic and local: the app is started from source on a
 * free loopback port, the article is seeded through the store the app
 * itself uses, every request that leaves `127.0.0.1` is aborted, and the
 * model is the built-in no-key demo reply. No real API call, no account,
 * no user data.
 *
 * Run: node tests/browser-note-anchors.mjs
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
/** Isolated evidence folder: the reading-layout suite's output is not ours. */
const evidenceDir = join(root, "docs", "evidence", "base-migration-2026-10-19");

const ARTICLE_ID = "local-note-anchor-fixture";
/**
 * The only off-host requests this app makes on its own: the webfont
 * stylesheet `index.html` links. They are recorded rather than asserted
 * away, and they are still aborted — the run must not depend on the
 * network, and the fallback face renders the same glyphs.
 */
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
/** The paragraph the selection is made in, and its quoted text. */
const ANCHOR_INDEX = 2;
const QUOTE = "世尊说：世尊。";
/** The second "世尊" — the occurrence the test drags over. */
const START_OFFSET = 4;
const END_OFFSET = 6;

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

/**
 * A heading (so the outline sidebar has something to show and its toggle
 * is rendered at all), the quote paragraph, and enough long paragraphs
 * below to make the page scroll — the connector has to be measured
 * against a scrolled article, not a document that fits on one screen.
 */
function fixtureArticle() {
  const paragraphs = [
    { index: 1, text: "旁注定位测试", hash: "h01", type: "heading", level: 1 },
    { index: ANCHOR_INDEX, text: QUOTE, hash: "h02", type: "paragraph" },
    ...Array.from({ length: 34 }, (_, i) => ({
      index: i + 3,
      text: `这是第${i + 3}段测试正文。`.repeat(8),
      hash: `h${String(i + 3).padStart(2, "0")}`,
      type: "paragraph",
    })),
  ];
  return {
    id: ARTICLE_ID,
    title: "旁注定位测试",
    createdAt: Date.now(),
    paragraphs,
  };
}

let vite;
let browser;
const results = {
  generatedAt: new Date().toISOString(),
  command: "node tests/browser-note-anchors.mjs",
  article: ARTICLE_ID,
  checks: [],
  storage: {},
  pageErrors: [],
  externalRequests: [],
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
  // No network beyond the local dev server, the app's own webfont
  // stylesheet aside. Every off-host request is aborted and recorded, so a
  // page that quietly called a model or an extraction service would fail
  // the run at the bottom rather than succeed on someone's machine.
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

  await page.goto(url);
  await page.evaluate(
    async ([id, article]) => {
      const { useStore } = await import("/src/lib/store.ts");
      // The text is a body now, and `saveArticle` is the one path that
      // installs both halves. A bare `setState({ articles })` would put a
      // record in the store whose text is nowhere — which the reader reports
      // as unavailable rather than rendering, so the gate would time out
      // waiting for paragraphs that were never saved.
      const { paragraphs, ...record } = article;
      useStore.setState({ notes: {} });
      await useStore.getState().saveArticle(record, paragraphs);
      location.hash = `#/r/${id}`;
    },
    [ARTICLE_ID, fixtureArticle()],
  );
  await page.locator(`[data-paragraph-index="${ANCHOR_INDEX}"]`).waitFor();
  assert.equal(await page.locator("[data-paragraph-index]").count(), 36);
  results.checks.push("36 blocks rendered from the seeded article");

  // ── A real selection, mapped through the app's own offset logic ──
  await page
    .locator(`[data-paragraph-index="${ANCHOR_INDEX}"]`)
    .evaluate((element, [start, end, quote]) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent === quote) break;
      }
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    }, [START_OFFSET, END_OFFSET, QUOTE]);

  await page.getByRole("button", { name: "解释", exact: true }).click();
  await page.waitForFunction(() => {
    const blob = JSON.parse(localStorage.getItem("gloss-storage"));
    return Object.values(blob.state.notes).some(
      (note) => note.answer.includes("演示模式") && !note.isStreaming,
    );
  });

  const stored = await page.evaluate(() => {
    const blob = JSON.parse(localStorage.getItem("gloss-storage"));
    return Object.values(blob.state.notes)[0];
  });
  // The offsets are the ones the drag produced, not the first occurrence
  // of "世尊" (which is at 0) — that distinction is the whole point.
  assert.equal(stored.startOffset, START_OFFSET);
  assert.equal(stored.endOffset, END_OFFSET);
  assert.equal(stored.startParagraphIndex, ANCHOR_INDEX);
  assert.equal(stored.selectionText, "世尊");
  results.storage.note = {
    startOffset: stored.startOffset,
    endOffset: stored.endOffset,
    startParagraphIndex: stored.startParagraphIndex,
    selectionText: stored.selectionText,
  };
  results.checks.push("selection mapped to the second occurrence (4..6), not the first");

  const anchor = page.locator("[data-note-anchor]");
  assert.equal(await anchor.count(), 1);
  assert.equal(await anchor.innerText(), "世尊");
  results.checks.push("exact quote underlined in the article");

  const connection = page.locator('[data-testid="note-connection"]');
  await connection.waitFor();
  assert.equal(await page.locator('[data-note-id][data-note-active="true"]').count(), 1);
  results.checks.push("connector drawn and the note marked active");

  // ── Paragraph references in the answer ──
  await page.evaluate(async () => {
    const { useStore } = await import("/src/lib/store.ts");
    const note = Object.values(useStore.getState().notes)[0];
    useStore.getState().updateNote(note.id, { answer: "请参见¶27；不存在的引用¶999。" });
  });
  await page.getByRole("button", { name: "第 27 段", exact: true }).click();
  await page.waitForFunction(() => {
    const rect = document.querySelector('[data-paragraph-index="27"]').getBoundingClientRect();
    return rect.top > 60 && rect.bottom < innerHeight;
  });
  results.checks.push("valid ¶27 reference scrolls to the paragraph");

  // Jumping to ¶27 carried this note's passage (§2) out of the reading
  // area, so the record collapsed — that is the lifecycle this suite now
  // exercises. The rest of the answer lives in the expanded half, so the
  // record is reopened before its references are read. (Nothing is
  // deleted: the record and its underline were asserted above.)
  await page.getByRole("button", { name: "展开笔记" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="note-card"][data-note-expanded="true"]') !== null,
  );

  const invalid = page.getByRole("button", { name: "第 999 段", exact: true });
  assert.equal(await invalid.isDisabled(), true);
  assert.equal(await invalid.getAttribute("title"), "此引用在当前正文中不可定位");
  // The unavailable reference is *rendered*, not dropped: silently
  // editing the model's answer is the failure mode this rules out.
  assert.ok((await invalid.innerText()).includes("第 999 段"));
  results.checks.push("invalid ¶999 reference is disabled, not dropped");

  // ── Back to the passage, from the card ──
  await page.getByRole("button", { name: "第 2 段 ↗", exact: true }).click();
  await page.waitForFunction((index) => {
    const rect = document
      .querySelector(`[data-paragraph-index="${index}"]`)
      .getBoundingClientRect();
    return rect.top > 60 && rect.bottom < innerHeight;
  }, ANCHOR_INDEX);
  await connection.waitFor();
  await page.waitForTimeout(200);
  await mkdir(evidenceDir, { recursive: true });
  const shot = join(evidenceDir, "note-anchors-desktop-1440.png");
  await page.screenshot({ path: shot });
  results.screenshots.push(shot);
  results.checks.push("note card jump returns to the passage and reconnects");

  // ── Persistence ──
  await page.reload();
  await page.locator(`[data-paragraph-index="${ANCHOR_INDEX}"]`).waitFor();
  assert.equal(await page.locator("[data-note-anchor]").innerText(), "世尊");
  results.checks.push("underline survives a reload");

  await page.locator("[data-note-anchor]").click();
  await connection.waitFor();
  results.checks.push("clicking the underline activates the note again");

  // ── Existing layout: outline sidebar open/close, resize ──
  const outline = page.locator('[data-testid="outline-sidebar"]');
  assert.equal(await outline.count(), 1);
  await page.getByRole("button", { name: "隐藏目录" }).click();
  assert.equal(await outline.count(), 0);
  await connection.waitFor();
  results.checks.push("closing the outline sidebar keeps the connector resolved");
  await page.getByRole("button", { name: "显示目录" }).click();
  assert.equal(await outline.count(), 1);
  await connection.waitFor();
  results.checks.push("reopening the outline sidebar keeps the connector resolved");

  await page.setViewportSize({ width: 1024, height: 900 });
  await connection.waitFor();
  assert.equal(
    await page.locator('[data-testid="notes-panel"]').isVisible(),
    true,
    "the notes rail is visible at exactly the lg breakpoint",
  );
  results.checks.push("connector and notes rail hold at 1024px");

  // ── Mobile: no rail, therefore no connector ──
  await page.setViewportSize({ width: 390, height: 844 });
  await connection.waitFor({ state: "detached" });
  assert.equal(await page.locator('[data-testid="notes-panel"]').isVisible(), false);
  const mobileShot = join(evidenceDir, "note-anchors-mobile-390.png");
  await page.screenshot({ path: mobileShot, fullPage: true });
  results.screenshots.push(mobileShot);
  results.checks.push("mobile 390px hides the rail and the connector");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(`[data-paragraph-index="${ANCHOR_INDEX}"]`).waitFor();
  await connection.waitFor();
  results.checks.push("connector returns after resizing back to desktop");

  // ── The ✕ collapses; the saved record and its underline stay ──
  await page.getByRole("button", { name: "收起笔记" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="note-card"][data-note-expanded="false"]') !==
      null,
  );
  const collapsed = await page.evaluate(() => {
    const blob = JSON.parse(localStorage.getItem("gloss-storage"));
    return Object.values(blob.state.notes)[0];
  });
  assert.equal(collapsed.selectionText, "世尊");
  assert.equal(
    await page.locator("[data-note-anchor]").count(),
    1,
    "collapsing must not remove the saved underline",
  );
  results.checks.push("closing a note collapses it and keeps the saved record and underline");

  // ── The compact record reopens the same saved note ──
  await page.getByRole("button", { name: "展开笔记" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="note-card"][data-note-expanded="true"]') !== null,
  );
  assert.equal(await page.locator("[data-note-anchor]").count(), 1);
  results.checks.push("clicking the compact record reopens the same saved note");

  // ── Deleting is a separate, explicitly confirmed action ──
  await page.getByRole("button", { name: "删除笔记" }).click();
  // The first click only arms the control: nothing is gone yet.
  assert.equal(await page.locator("[data-note-anchor]").count(), 1);
  assert.equal(
    await page.evaluate(
      () => Object.keys(JSON.parse(localStorage.getItem("gloss-storage")).state.notes).length,
    ),
    1,
  );
  await page.getByRole("button", { name: "确认删除笔记" }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-note-anchor]").length === 0);
  assert.equal(await connection.count(), 0);
  results.checks.push("explicit delete (armed, then confirmed) removes the underline and the connector");

  // ── Routes ──
  await page.evaluate(() => {
    location.hash = "#/r/phase1-missing";
  });
  await page.getByText("文章不存在或已被删除。").waitFor();
  await page.evaluate((id) => {
    location.hash = `#/r/${id}`;
  }, ARTICLE_ID);
  await page.locator(`[data-paragraph-index="${ANCHOR_INDEX}"]`).waitFor();
  assert.equal(await page.locator("[data-note-anchor]").count(), 0);
  results.checks.push("route away and back leaves no stale anchor");

  assert.deepEqual(errors, [], "the page must raise no errors");
  const offHost = results.externalRequests.filter((r) => !r.known);
  assert.deepEqual(offHost, [], "only the app's own webfont may leave 127.0.0.1");
  results.checks.push(
    `no model or extraction request: ${results.externalRequests.length} off-host request(s), all webfont`,
  );
  results.pageErrors = errors;
  results.pass = true;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "note-anchors.json"), JSON.stringify(results, null, 2));
  console.log(`Browser note anchors: passed (${results.checks.length} checks, 0 page errors).`);
  console.log(`Evidence: ${evidenceDir}`);
} finally {
  await browser?.close();
  if (vite && vite.exitCode === null) {
    const done = once(vite, "exit");
    vite.kill();
    await done;
  }
}
