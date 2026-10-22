// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * AI 打标签模块：解析、取材、跳过分支与晚到写保护。
 *
 * 这一套测试不联网：纯函数直接断言；需要「真的发一次请求」的路径把
 * `globalThis.fetch` 换成一个本地的假 chat/completions，返回标准 JSON
 * 响应，于是 `generateText` → `@ai-sdk/openai-compatible` → 全局 fetch
 * 这整条真实链路都跑到，但没有一个字节离开本进程。
 *
 * 正文在 base 里与记录分离（IndexedDB 的 `bodies`），所以这里用真实的
 * 存储层：`storage-fixture` 装 fake-indexeddb，文章用 `saveArticle` 写入。
 * 重点覆盖 `ensureArticleTags` 的跳过（无 key / 已有标签 / 文章不在 /
 * 正文读到不到）和晚到丢弃（文章被删 / 切账号 / session epoch 变化）——
 * 这些分支写错时的表现是「标签悄悄写进别人的空间」或「一次导入被后台
 * 请求拖垮」，都不会自然暴露。
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { installMemoryLocalStorage, resetBodyStorage } from "./storage-fixture.js";
import type { Article, Paragraph } from "../../src/lib/types.js";

installMemoryLocalStorage();
const { useStore } = await import("../../src/lib/store.js");
const { useSettings } = await import("../../src/lib/settings.js");
const { bumpSessionEpoch } = await import("../../src/lib/session-epoch.js");
const { removeBody } = await import("../../src/lib/storage/bodies.js");
const tagging = await import("../../src/lib/tagging.js");
const backup = await import("../../src/lib/local-backup.js");

beforeEach(async () => {
  useStore.getState().clearUserCache();
  localStorage.clear();
  await resetBodyStorage();
  useSettings.getState().reset();
});

// ── fixtures ──────────────────────────────────────────────────────────────

const PARAGRAPHS: Paragraph[] = [
  { index: 1, text: "缘起性空是佛教哲学的核心。", hash: "hash-1" },
  { index: 2, text: "禅宗强调直指人心。", hash: "hash-2" },
];

/** 写入一条真实的文章记录 + 正文，走的是 Home 导入同一条 store 路径。 */
async function seedArticle(
  id: string,
  overrides: Partial<Article> = {},
): Promise<void> {
  await useStore.getState().saveArticle(
    {
      id,
      title: "佛教与哲学",
      createdAt: 1,
      ...overrides,
    },
    PARAGRAPHS,
  );
}

/** 配好一个「可用」的 BYOK 设置：有 key 且接口地址已确认。 */
function configureModel(): void {
  const s = useSettings.getState();
  s.setApiKey("sk-test-tagging");
  s.setModel("fake-model");
  s.setBaseURL("https://api.example.test/v1");
  s.confirmEndpoint();
}

type CapturedFetch = { url: string; body: Record<string, unknown> | null };

/**
 * 用一个假 chat/completions 顶替全局 fetch。
 *
 * `content` 可以是固定字符串，也可以是 Promise 工厂——后者让测试精确
 * 控制「模型什么时候返回」，从而在请求在途时改 store。
 */
function stubChatCompletion(content: string | (() => Promise<string>)): {
  calls: CapturedFetch[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: CapturedFetch[] = [];

  const abortRejection = (signal?: AbortSignal | null): Promise<never> => {
    if (!signal) return new Promise<never>(() => {});
    if (signal.aborted) {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    }
    return new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  };

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    calls.push({ url: String(input), body });

    const text = await Promise.race([
      typeof content === "string" ? Promise.resolve(content) : content(),
      abortRejection(init?.signal),
    ]);

    return new Response(
      JSON.stringify({
        id: "chatcmpl-tagging-test",
        created: 1,
        model: "fake-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** 一个可以从外部放行的 Promise，用来把模型响应卡在「在途」状态。 */
function gatedResponse(): { promise: Promise<string>; release: (value: string) => void } {
  let release!: (value: string) => void;
  const promise = new Promise<string>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待打标请求发出超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── parseTagResponse ──────────────────────────────────────────────────────

test("parseTagResponse: 纯 JSON 字符串数组", () => {
  assert.deepEqual(tagging.parseTagResponse('["佛教","哲学"]'), ["佛教", "哲学"]);
});

test("parseTagResponse: 容忍 ```json 围栏与前后闲聊", () => {
  const raw = '好的，标签如下：\n```json\n["量子力学", "科普"]\n```\n以上。';
  assert.deepEqual(tagging.parseTagResponse(raw), ["量子力学", "科普"]);
});

test("parseTagResponse: 去重、去 # 号与尾部标点", () => {
  const raw = '["#佛教", "佛教", "哲学。", " 哲学 "]';
  assert.deepEqual(tagging.parseTagResponse(raw), ["佛教", "哲学"]);
});

test("parseTagResponse: 过滤空泛词、超长标签与空串", () => {
  const raw = '["标签", "总结", "这是一个超过八个字的长标签", "", "禅宗"]';
  assert.deepEqual(tagging.parseTagResponse(raw), ["禅宗"]);
});

test("parseTagResponse: 最多保留 MAX_TAGS 个", () => {
  const tags = tagging.parseTagResponse('["一", "二", "三", "四", "五", "六"]');
  assert.equal(tagging.MAX_TAGS, 4);
  assert.deepEqual(tags, ["一", "二", "三", "四"]);
});

test("parseTagResponse: JSON 解析失败时按分隔符兜底", () => {
  assert.deepEqual(tagging.parseTagResponse("佛教，哲学、禅宗 唯识"), [
    "佛教",
    "哲学",
    "禅宗",
    "唯识",
  ]);
  assert.deepEqual(tagging.parseTagResponse("#佛教 #哲学"), ["佛教", "哲学"]);
  // 兜底切出来的全是空泛词：宁可返回空列表，也不要把「分类/文章/总结」
  // 落成标签。
  assert.deepEqual(tagging.parseTagResponse("分类，文章，总结"), []);
});

test("parseTagResponse: 空输出、空数组与非字符串元素返回空列表", () => {
  assert.deepEqual(tagging.parseTagResponse(""), []);
  assert.deepEqual(tagging.parseTagResponse("   "), []);
  assert.deepEqual(tagging.parseTagResponse("[]"), []);
  assert.deepEqual(tagging.parseTagResponse('[1, 2, null, {"a": 1}]'), []);
  assert.deepEqual(tagging.parseTagResponse("```json\n```"), []);
});

test("parseTagResponse: 复用 knownTags 的现有写法，未命中则保持模型输出", () => {
  assert.deepEqual(tagging.parseTagResponse('["佛 学"]', ["佛学"]), ["佛学"]);
  assert.deepEqual(tagging.parseTagResponse('["禅宗"]', ["佛学"]), ["禅宗"]);
});

// ── taggableText ──────────────────────────────────────────────────────────

test("taggableText: 标题与段落用换行连接，默认截断到 3000 字符", () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => ({
    text: "字".repeat(100),
    hash: `hash-${i}`,
  }));
  const text = tagging.taggableText("标题", paragraphs);
  assert.equal(text.length, 3000);
  assert.equal(text.startsWith("标题\n"), true);
});

test("taggableText: maxChars 截断、跳过空段落、0 返回空串", () => {
  const text = tagging.taggableText(
    "标题",
    [{ text: "   " }, { text: "一二三四五六七八九十" }],
    4,
  );
  assert.equal(text, "标题\n一");
  assert.equal(tagging.taggableText("标题", [{ text: "正文" }], 0), "");
  assert.equal(tagging.taggableText("", [], 100), "");
});

// ── hasTaggingModel ───────────────────────────────────────────────────────

test("hasTaggingModel: 无 key / 地址未确认时为 false，确认后为 true", () => {
  assert.equal(tagging.hasTaggingModel(), false, "无 key 时不能打标");

  const s = useSettings.getState();
  s.setApiKey("sk-test-tagging");
  s.setModel("fake-model");
  s.setBaseURL("https://api.example.test/v1");
  assert.equal(
    tagging.hasTaggingModel(),
    false,
    "有 key 但接口地址未确认时，密钥不能被发出去",
  );

  s.confirmEndpoint();
  assert.equal(tagging.hasTaggingModel(), true);
});

// ── collectKnownTags ──────────────────────────────────────────────────────

test("collectKnownTags: 无文章为空；按出现次数降序聚合", async () => {
  assert.deepEqual(tagging.collectKnownTags(), []);

  await seedArticle("k1", { tags: ["佛教", "哲学"] });
  await seedArticle("k2", { tags: ["佛教", "哲学"] });
  await seedArticle("k3", { tags: ["佛教", "禅宗"] });

  assert.deepEqual(tagging.collectKnownTags(), ["佛教", "哲学", "禅宗"]);
});

test("collectKnownTags: limit 截断，0 返回空列表", async () => {
  await seedArticle("k1", { tags: ["佛教", "哲学"] });
  assert.deepEqual(tagging.collectKnownTags(1), ["佛教"]);
  assert.deepEqual(tagging.collectKnownTags(0), []);
});

// ── store.setArticleTags：最后一道闸 ──────────────────────────────────────

test("setArticleTags: 清洗、去重、去 #，并清除来源信息", async () => {
  await seedArticle("stored");
  const store = useStore.getState();

  // 语义过滤（空泛词、长度）是 tagging 的职责；store 只做落库前的结构清洗，
  // 否则同一条规则会有两个会漂移的副本。
  store.setArticleTags("stored", ["#佛教", "佛教", " 哲学 "], {
    model: "fake-model",
    at: 42,
  });
  let record = useStore.getState().articles["stored"];
  assert.deepEqual(record?.tags, ["佛教", "哲学"], "去重、去 #、去首尾空白");
  assert.equal(record?.tagsModel, "fake-model");
  assert.equal(record?.tagsAt, 42);

  store.setArticleTags("stored", undefined);
  record = useStore.getState().articles["stored"];
  assert.equal(record?.tags, undefined);
  assert.equal(record?.tagsModel, undefined);
  assert.equal(record?.tagsAt, undefined);

  // 空数组与 undefined 同义：强制重跑没产出标签时，库里不能留下空壳。
  store.setArticleTags("stored", ["哲学"], { model: "fake-model", at: 7 });
  store.setArticleTags("stored", []);
  assert.equal(useStore.getState().articles["stored"]?.tags, undefined);
});

test("setArticleTags: 最多保留 MAX_TAGS 个", async () => {
  await seedArticle("stored");
  useStore.getState().setArticleTags("stored", ["一", "二", "三", "四", "五", "六"]);
  assert.deepEqual(useStore.getState().articles["stored"]?.tags, ["一", "二", "三", "四"]);
});

// ── ensureArticleTags：跳过分支 ───────────────────────────────────────────

test("ensureArticleTags: 无 key 时返回 null、不发请求、不写 store", async () => {
  const stub = stubChatCompletion('["佛教"]');
  try {
    await seedArticle("no-key");
    const result = await tagging.ensureArticleTags("no-key");

    assert.equal(result, null);
    assert.equal(stub.calls.length, 0, "无 key 时一个请求都不能发");
    assert.equal(
      useStore.getState().articles["no-key"]?.tags,
      undefined,
      "跳过时不能改写文章",
    );
    assert.equal(tagging.isTagging("no-key"), false);
  } finally {
    stub.restore();
  }
});

test("ensureArticleTags: 文章已有标签且未 force 时跳过", async () => {
  configureModel();
  const stub = stubChatCompletion('["新标签"]');
  try {
    await seedArticle("tagged", { tags: ["旧"], tagsModel: "old", tagsAt: 1 });

    const result = await tagging.ensureArticleTags("tagged");

    assert.equal(result, null);
    assert.equal(stub.calls.length, 0, "已有标签时不应再花一次请求");
    assert.deepEqual(useStore.getState().articles["tagged"]?.tags, ["旧"]);
  } finally {
    stub.restore();
  }
});

test("ensureArticleTags: 文章记录不存在时返回 null 且不发请求", async () => {
  configureModel();
  const stub = stubChatCompletion('["佛教"]');
  try {
    const result = await tagging.ensureArticleTags("missing");
    assert.equal(result, null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("ensureArticleTags: 正文不在本机时返回 null 且不发请求", async () => {
  configureModel();
  const stub = stubChatCompletion('["佛教"]');
  try {
    await seedArticle("no-body");
    useStore.setState({ bodies: {} });
    await removeBody("no-body");

    const result = await tagging.ensureArticleTags("no-body");

    assert.equal(result, null, "没有正文就没有可打标的内容");
    assert.equal(stub.calls.length, 0);
    assert.equal(useStore.getState().articles["no-body"]?.tags, undefined);
  } finally {
    stub.restore();
  }
});

test("isTagging: 空闲时为 false", () => {
  assert.equal(tagging.isTagging("anything"), false);
});

// ── ensureArticleTags：成功路径 ───────────────────────────────────────────

test("ensureArticleTags: 成功时写入 tags/tagsModel/tagsAt 并返回标签", async () => {
  configureModel();
  const stub = stubChatCompletion('```json\n["佛教","哲学"]\n```');
  try {
    await seedArticle("ok");

    const result = await tagging.ensureArticleTags("ok");

    assert.deepEqual(result, ["佛教", "哲学"]);
    assert.equal(stub.calls.length, 1);
    const record = useStore.getState().articles["ok"];
    assert.deepEqual(record?.tags, ["佛教", "哲学"]);
    assert.equal(record?.tagsModel, "fake-model");
    assert.equal(typeof record?.tagsAt, "number");
    // 打标只该改标签：记录里不能出现正文（base 把正文存在 bodies）。
    assert.equal(
      Object.prototype.hasOwnProperty.call(record ?? {}, "paragraphs"),
      false,
      "Article 记录不能重新带上 paragraphs",
    );
    assert.deepEqual(record?.bodyStats, {
      paragraphs: PARAGRAPHS.length,
      chars: PARAGRAPHS.reduce((total, p) => total + p.text.length, 0),
    });
    assert.equal(tagging.isTagging("ok"), false);

    // 请求里确实带了 system 提示词与文章内容，system 要求只输出 JSON 数组。
    const body = stub.calls[0]?.body ?? {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    assert.equal(messages[0]?.role, "system");
    assert.match(messages[0]?.content ?? "", /JSON 字符串数组/);
    const last = messages[messages.length - 1];
    assert.match(last?.content ?? "", /佛教与哲学/);
  } finally {
    stub.restore();
  }
});

test("ensureArticleTags: 正文未加载进内存时从存储读取再打标", async () => {
  configureModel();
  const stub = stubChatCompletion('["佛教"]');
  try {
    await seedArticle("cold");
    // 模拟「书库打开过但这篇文章还没在 Reader 里打开」：内存里没有正文。
    useStore.setState({ bodies: {} });
    assert.equal(useStore.getState().bodies["cold"], undefined);

    const result = await tagging.ensureArticleTags("cold");

    assert.deepEqual(result, ["佛教"]);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(useStore.getState().articles["cold"]?.tags, ["佛教"]);
  } finally {
    stub.restore();
  }
});

test("ensureArticleTags: 同文章在途请求复用，只发一次请求", async () => {
  configureModel();
  const gate = gatedResponse();
  const stub = stubChatCompletion(() => gate.promise);
  try {
    await seedArticle("shared");

    const first = tagging.ensureArticleTags("shared");
    assert.equal(tagging.isTagging("shared"), true, "调用后立即登记为在途");
    const second = tagging.ensureArticleTags("shared");

    await waitFor(() => stub.calls.length === 1);
    gate.release('["佛教"]');

    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, ["佛教"]);
    assert.deepEqual(b, ["佛教"]);
    assert.equal(stub.calls.length, 1, "第二次调用必须复用同一个 Promise");
  } finally {
    stub.restore();
  }
});

test("ensureArticleTags: force 时覆盖旧标签", async () => {
  configureModel();
  const stub = stubChatCompletion('["新标签"]');
  try {
    await seedArticle("force", { tags: ["旧"], tagsAt: 1 });

    const result = await tagging.ensureArticleTags("force", { force: true });

    assert.deepEqual(result, ["新标签"]);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(useStore.getState().articles["force"]?.tags, ["新标签"]);
  } finally {
    stub.restore();
  }
});

test("ensureArticleTags: 模型没给出可用标签时返回 null 并保留旧标签", async () => {
  configureModel();
  const stub = stubChatCompletion('["标签", ""]');
  try {
    await seedArticle("empty", { tags: ["旧"] });

    const result = await tagging.ensureArticleTags("empty", { force: true });

    assert.equal(result, null);
    assert.deepEqual(useStore.getState().articles["empty"]?.tags, ["旧"]);
  } finally {
    stub.restore();
  }
});

// ── 晚到写保护 ────────────────────────────────────────────────────────────

test("晚到写保护: 文章在请求返回前被删除时不写入", async () => {
  configureModel();
  const gate = gatedResponse();
  const stub = stubChatCompletion(() => gate.promise);
  try {
    await seedArticle("deleted");

    const run = tagging.ensureArticleTags("deleted");
    await waitFor(() => stub.calls.length === 1);

    useStore.getState().deleteArticle("deleted");
    gate.release('["佛教"]');

    assert.equal(await run, null);
    assert.equal(
      useStore.getState().articles["deleted"],
      undefined,
      "文章已被删除，结果必须丢弃",
    );
  } finally {
    stub.restore();
  }
});

test("晚到写保护: 账号切换后丢弃结果", async () => {
  configureModel();
  const gate = gatedResponse();
  const stub = stubChatCompletion(() => gate.promise);
  try {
    await seedArticle("owner");

    const run = tagging.ensureArticleTags("owner");
    await waitFor(() => stub.calls.length === 1);

    useStore.getState().setOwner("user-other");
    gate.release('["佛教"]');

    assert.equal(await run, null);
    assert.equal(
      useStore.getState().articles["owner"]?.tags,
      undefined,
      "旧账号发起的请求不能写进新账号的空间",
    );
  } finally {
    stub.restore();
  }
});

test("晚到写保护: session epoch 变化后丢弃结果", async () => {
  configureModel();
  const gate = gatedResponse();
  const stub = stubChatCompletion(() => gate.promise);
  try {
    await seedArticle("epoch");

    const run = tagging.ensureArticleTags("epoch");
    await waitFor(() => stub.calls.length === 1);

    bumpSessionEpoch();
    gate.release('["佛教"]');

    assert.equal(await run, null);
    assert.equal(useStore.getState().articles["epoch"]?.tags, undefined);
  } finally {
    stub.restore();
  }
});

// ── generateTags：超时 ────────────────────────────────────────────────────

test("generateTags: 超时会中止请求并报超时", async () => {
  configureModel();
  const gate = gatedResponse();
  const stub = stubChatCompletion(() => gate.promise);
  try {
    await assert.rejects(
      () => tagging.generateTags({ title: "标题", text: "正文", timeoutMs: 30 }),
      /秒/,
    );
  } finally {
    gate.release("[]");
    stub.restore();
  }
});

// ── 备份 / 恢复：标签随记录一起走 ────────────────────────────────────────

test("backup and restore keep an article's tags", async () => {
  await seedArticle("local-backup-tags", { title: "带标签的文章" });
  useStore.getState().setArticleTags("local-backup-tags", ["佛教", "哲学"], {
    model: "fake-model",
    at: 123,
  });
  const raw = await backup.createLocalBackup();
  useStore.getState().clearUserCache();
  await backup.restoreLocalBackup(raw);
  const restored = useStore.getState().articles["local-backup-tags"];
  assert.deepEqual(restored?.tags, ["佛教", "哲学"]);
  assert.equal(restored?.tagsModel, "fake-model");
  assert.equal(restored?.tagsAt, 123);
});
