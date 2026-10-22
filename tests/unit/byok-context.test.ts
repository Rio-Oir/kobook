// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Context construction and the brief pipeline.
 *
 * The brief used to drive `streamText` directly, which meant a second call
 * site with no timeout, no cancellation and no `maxRetries: 0` — and, since
 * it iterated `textStream`, a mid-stream provider error turned into "模型
 * 返回的摘要不是有效 JSON", blaming the model for a transport failure. It
 * now goes through `streamChat`, which is what this suite runs against the
 * fake provider.
 */

import assert from "node:assert/strict";
import { test, before, beforeEach, after } from "node:test";
import type { Article, Paragraph } from "../../src/lib/types.js";
import {
  DONE_FRAME,
  chunkFrame,
  errorFrame,
  finishFrame,
  installLocalStorage,
  startFakeProvider,
  successFrames,
  type FakeProvider,
} from "./byok-fake-provider.js";

// `types.ts` is only imported for its types; the runtime modules below are
// what the assertions actually exercise.
void (0 as unknown as Article);

const memory = installLocalStorage();

let settings: typeof import("../../src/lib/settings.js");
let context: typeof import("../../src/lib/context.js");
let briefModule: typeof import("../../src/lib/brief.js");

before(async () => {
  settings = await import("../../src/lib/settings.js");
  context = await import("../../src/lib/context.js");
  briefModule = await import("../../src/lib/brief.js");
});

beforeEach(() => {
  memory.clear();
  settings.useSettings.getState().reset();
});

/**
 * A record and its text.
 *
 * Returned together because every gate in this file needs both and they are no
 * longer the same object: the record is the article, the text is a body. A
 * helper that returned only the record would have every call site invent its
 * own paragraphs.
 */
function makeArticle(texts: string[] = ["第一段。", "第二段。", "第三段。"]): {
  article: Article;
  paragraphs: Paragraph[];
} {
  const paragraphs: Paragraph[] = texts.map((text, i) => ({ index: i + 1, text, hash: `h${i + 1}` }));
  return {
    article: {
      id: "a-test",
      url: "https://example.com/post",
      title: "测试文章",
      author: "作者",
      createdAt: 1,
      bodyStats: {
        paragraphs: paragraphs.length,
        chars: paragraphs.reduce((total, p) => total + p.text.length, 0),
      },
    },
    paragraphs,
  };
}

/** The two halves, spread into a call that takes them positionally. */
function spreadFixture(fixture: { article: Article; paragraphs: Paragraph[] }): [Article, Paragraph[]] {
  return [fixture.article, fixture.paragraphs];
}

function configure(baseURL: string, apiKey = "sk-fake-byok"): void {
  const s = settings.useSettings.getState();
  s.setApiKey(apiKey);
  s.setModel("fake-model");
  s.setBaseURL(baseURL);
  s.confirmEndpoint();
}

/** One delta carrying the whole reply — cheaper than a frame per character. */
function oneShotFrames(text: string): string[] {
  return [
    chunkFrame({ role: "assistant", content: "" }),
    chunkFrame({ content: text }),
    finishFrame({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
    DONE_FRAME,
  ];
}

const servers: FakeProvider[] = [];
async function provider(...args: Parameters<typeof startFakeProvider>) {
  const p = await startFakeProvider(...args);
  servers.push(p);
  return p;
}

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

// ── context construction ──────────────────────────────────────────────────

test("the system context keeps the document separate from the instructions", () => {
  const { article, paragraphs } = makeArticle();
  const ctx = context.buildStableContext(article, paragraphs);

  assert.match(ctx, /<document>/);
  assert.match(ctx, /\[¶1\] 第一段。/);
  assert.ok(
    ctx.indexOf("</document>") < ctx.indexOf("INSTRUCTIONS:"),
    "the instructions come after the quoted document, not mixed into it",
  );
  assert.match(ctx, /¶N/);
});

test("a long document is clamped instead of being sent whole", () => {
  const huge = "长".repeat(300_000);
  const { article, paragraphs } = makeArticle([huge]);
  const ctx = context.buildStableContext(article, paragraphs);
  assert.ok(ctx.length < 200_000, "the prompt must stay bounded; got " + ctx.length);
  assert.match(ctx, /\[内容已截断\]/);

  // The brief context used to skip the clamp entirely.
  const briefCtx = context.buildBriefSystemContext(article, paragraphs);
  assert.ok(briefCtx.length < 200_000, "the brief prompt must be bounded too");
  assert.match(briefCtx, /\[内容已截断\]/);
});

test("the selection and the question are clamped, and stay in the user turn", () => {
  const q = context.buildAskQuestion("选".repeat(20_000), "问".repeat(10_000));
  assert.match(q, /\[内容已截断\]/);
  assert.ok(q.length < 15_000);
  assert.match(context.buildExplainQuestion("选文"), /选文/);
});

test("a follow-up keeps the original question as its own message", () => {
  const messages = [
    { role: "user" as const, content: context.buildAskQuestion("选文", "原问题") },
    { role: "assistant" as const, content: "原回答" },
    { role: "user" as const, content: context.buildFollowUpQuestion("选文", "追问") },
  ];
  assert.equal(messages.length, 3);
  assert.match(messages[0]!.content, /原问题/);
  assert.match(messages[2]!.content, /追问/);
  assert.match(messages[2]!.content, /原问题仍保留/);
});

test("paragraph references are validated against the article, including ranges", () => {
  const { paragraphs } = makeArticle();
  assert.equal(context.findInvalidParagraphRef("见 ¶1 与 ¶2-3", paragraphs), null);
  assert.match(context.findInvalidParagraphRef("见 ¶9", paragraphs) ?? "", /不存在/);
  assert.match(context.findInvalidParagraphRef("见 ¶2-9", paragraphs) ?? "", /不存在/);
  assert.match(context.findInvalidParagraphRef("见 ¶3-1", paragraphs) ?? "", /起点大于终点/);
  assert.equal(context.validateParagraphRefs("见 ¶1", paragraphs), true);
  assert.equal(context.validateParagraphRefs("见 ¶0", paragraphs), false);
  assert.equal(context.validateParagraphRefs("没有引用", paragraphs), true);
});

// ── brief parsing ─────────────────────────────────────────────────────────

const goodBrief = {
  gist: "这是一段摘要，引用 ¶1。",
  claims: [
    { text: "主张一", paragraphRef: "¶1" },
    { text: "主张二", paragraphRef: "¶2" },
    { text: "主张三", paragraphRef: "¶3" },
    { text: "主张四", paragraphRef: "¶1-2" },
    { text: "主张五", paragraphRef: "¶2" },
  ],
};

test("parseBrief accepts fenced JSON and rejects everything that is not a brief", () => {
  const { paragraphs } = makeArticle();
  const parsed = briefModule.parseBrief("```json\n" + JSON.stringify(goodBrief) + "\n```", paragraphs);
  assert.equal(parsed.claims.length, 5);

  assert.throws(() => briefModule.parseBrief("不是 JSON", paragraphs), /不是有效 JSON/);
  assert.throws(
    () => briefModule.parseBrief(JSON.stringify({ gist: "x", claims: [] }), paragraphs),
    /格式不正确/,
  );
  assert.throws(
    () =>
      briefModule.parseBrief(
        JSON.stringify({
          ...goodBrief,
          claims: goodBrief.claims.map((c, i) => (i === 0 ? { ...c, paragraphRef: "¶99" } : c)),
        }),
        paragraphs,
      ),
    /无效的段落引用/,
  );
  assert.throws(
    () => briefModule.parseBrief(JSON.stringify({ ...goodBrief, gist: "见 ¶42" }), paragraphs),
    /无效的段落引用/,
  );
});

// ── the brief over the real SDK ───────────────────────────────────────────

test("the brief rides streamChat: one request, bounded prompt, parsed result", async () => {
  const p = await provider([{ frames: oneShotFrames(JSON.stringify(goodBrief)) }]);
  configure(p.baseURL);

  const { article, paragraphs } = makeArticle();
  let lastProgress = "";
  const brief = await briefModule.generateBrief(article, paragraphs, (raw) => {
    lastProgress = raw;
  });

  assert.equal(brief.claims.length, 5);
  assert.equal(brief.gist, goodBrief.gist);
  assert.match(lastProgress, /主张五/, "progress reports the accumulated text");

  assert.equal(p.requests.length, 1);
  const body = p.requests[0]!.body as {
    model: string;
    stream: boolean;
    temperature: number;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.messages[0]!.role, "system");
  assert.match(body.messages[0]!.content, /<document>/);
  assert.equal(body.messages[1]!.role, "user", "the task stays in its own turn");
  assert.equal(p.requests[0]!.authorization, "Bearer sk-fake-byok");
});

test("a provider error frame rejects the brief instead of blaming the JSON", async () => {
  const p = await provider([{ frames: [chunkFrame({ role: "assistant" }), errorFrame("上游 502")] }]);
  configure(p.baseURL);

  await assert.rejects(
    () => briefModule.generateBrief(...spreadFixture(makeArticle())),
    (err: Error) => {
      assert.match(err.message, /上游 502/);
      assert.doesNotMatch(err.message, /不是有效 JSON/, "a transport failure is not a format problem");
      return true;
    },
  );
});

test("an empty brief response is rejected", async () => {
  const p = await provider([{ frames: [chunkFrame({ role: "assistant" }), finishFrame(), DONE_FRAME] }]);
  configure(p.baseURL);
  await assert.rejects(() => briefModule.generateBrief(...spreadFixture(makeArticle())), /空响应/);
});

test("a cancelled brief rejects and keeps its partial text out of the result", async () => {
  const p = await provider([
    { frames: successFrames(JSON.stringify(goodBrief)), frameDelayMs: 20 },
  ]);
  configure(p.baseURL);

  const controller = new AbortController();
  const run = briefModule.generateBrief(...spreadFixture(makeArticle()), undefined, { signal: controller.signal });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(() => run, /取消/);
});

test("with no key the brief is a clearly-labelled local demo, not a model answer", async () => {
  const p = await provider([{ frames: oneShotFrames(JSON.stringify(goodBrief)) }]);
  const brief = await briefModule.generateBrief(...spreadFixture(makeArticle()));
  assert.match(brief.gist, /演示摘要/);
  assert.equal(p.requests.length, 0, "the demo path must not call any provider");
});
