// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// AI 自动打标签（BYOK）。给每篇文章生成 2–4 个中文短标签，供书库分类与
// 阅读页的标签行使用。
//
// 这里做的是「后台增强」，不是阅读流程的一部分：
//
//   - 无 key、或 key 尚未确认可以发往当前接口地址时，`ensureArticleTags`
//     直接返回 null，一个请求都不发。打标绝不能变成导入文章的阻塞步骤。
//   - 结果落地只走 `setArticleTags`。文章对象本身可能在这几百毫秒里被
//     替换（重新导入）、删除或清空（切账号），所以写入前必须重读 store，
//     并核对 owner / session epoch——和 `cloud-notes` 对远程写的规则一致：
//     开始时的账号不能把结果写到另一个账号的空间里。
//   - 同一篇文章的在途请求只保留一个。Reader 打开时的自动打标与 Home 导入
//     后的触发可能同时发生，两个请求会各花一次用户的钱，且后到的结果可能
//     覆盖先到的。
//
// 正文与记录是分开存的（见 `types.ts` 的 `ArticleBody` 和
// `storage/bodies.ts`）：书库列表永远不读正文，所以打标签这里才需要显式
// `readBody`。正文不在本机（被淘汰/尚未同步）时直接跳过，不生成半截标签。
//
// 标签提示词要求模型只输出 JSON 字符串数组（如 ["佛教","哲学"]）。但模型
// 输出不可控：可能包一层 ```json 围栏、前面加一句「好的，标签如下：」、
// 用中文逗号分隔、或者带上 # 号。`parseTagResponse` 的职责是把这些写法
// 统一成一条短列表，而不是让一个格式偏差把整次调用判为失败。

import { generateText } from "ai";
import { getActiveModel, redactSecrets } from "./ai";
import { endpointStatus, readSettings } from "./settings";
import { currentSessionEpoch } from "./session-epoch";
import { useStore } from "./store";
import { readBody } from "./storage/bodies";
import { pushTagsNow } from "./cloud-article-meta";
import type { Paragraph } from "./types";

/** 一篇文章最多保留几个标签。书库筛选条和阅读页标签行都按短列表排版。 */
export const MAX_TAGS = 4;

/** 送进模型的正文上限。够判断主题，又不至于让一次打标变成全文计费。 */
const DEFAULT_TEXT_CHARS = 3000;

/** 一次打标的默认截止时间。打标是后台增强，用户不该等它。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** 一个标签的字符上限。超过它，多半是模型把短语或句子当成了标签。 */
const MAX_TAG_CHARS = 8;

/** 提示词里请求已有标签的条数上限。太多会让 system prompt 变成标签墙。 */
const DEFAULT_KNOWN_TAGS = 20;

/**
 * 空泛词：几乎每篇文章都成立，放进筛选条只会把所有文章混在一起。
 * 比较用 `tagKey`（去空白、小写），所以这里按同样形式书写即可。
 */
const VAGUE_TAGS = new Set([
  "标签",
  "标签列表",
  "分类",
  "文章",
  "总结",
  "主题",
  "主题标签",
  "内容",
  "关键词",
  "摘要",
  "其他",
  "其余",
  "综合",
  "未分类",
  "无",
  "暂无",
]);

const SYSTEM_PROMPT = [
  "你是中文阅读器的打标签助手。阅读用户给出的文章，输出 2–4 个能帮助读者在书库中按主题检索的中文短标签。",
  '只输出一个 JSON 字符串数组，例如：["佛教","哲学"]。',
  "不要输出解释、编号、Markdown 代码围栏或数组之外的任何字符。",
  "每个标签 2–8 个字，不要带 # 号，不要带标点；不要使用“标签”“分类”“文章”“总结”这类空泛词。",
].join("\n");

export type GenerateTagsInput = {
  title: string;
  text: string;
  /** 书库里已经在用的标签，模型能对应上时应原样复用，避免同义标签分裂。 */
  knownTags?: string[];
  signal?: AbortSignal;
  /** 覆盖默认 20s 截止时间；0 表示不设截止时间（测试用）。 */
  timeoutMs?: number;
};

export type EnsureArticleTagsOptions = {
  /** 强制重新生成：已有标签也重新请求（书库/阅读页的「重新生成」入口）。 */
  force?: boolean;
  signal?: AbortSignal;
};

/**
 * 当前设置是否具备打标能力：有 key，且该 key 已被用户确认可以发往当前
 * 接口地址。两者缺一，打标必须静默跳过——无 key 不能发请求，未确认的
 * 地址更不能带着用户的密钥去试。
 */
export function hasTaggingModel(): boolean {
  const s = readSettings();
  return s.apiKey.trim().length > 0 && endpointStatus(s).confirmed;
}

/** 标签比较用的键：空白不参与比较，拉丁字母大小写不参与比较。 */
function tagKey(tag: string): string {
  return tag.replace(/\s+/gu, "").toLowerCase();
}

/**
 * 清洗一个候选标签：去围栏/JSON/列表残留、去首尾标点、压缩空白。
 *
 * 只做「剥掉语法外壳」这一件事；判断能不能用交给 `isUsableTag`，这样
 * knownTags 复用与模型输出走的是同一套标准。
 */
function cleanTag(raw: string): string {
  let tag = raw.trim();
  // 开头的 #、列表符号、引号、括号都是输出的外壳，不是标签内容。
  tag = tag.replace(/^[\s"'`*#\-•·（(【[\]{]+/u, "");
  // 结尾同理，再加上中英文标点。
  tag = tag.replace(/[\s"'`*#\-•·）)】\]}，,。.；;：:！!？?、]+$/u, "");
  // 标签内部不允许换行；连续空白压成一个空格（"佛 学" 与 "佛学" 由
  // `tagKey` 判定为同一个标签）。
  tag = tag.replace(/\s+/gu, " ");
  return tag.trim();
}

/** 清洗后的候选是否是一个可落库的标签。 */
function isUsableTag(tag: string): boolean {
  if (!tag) return false;
  const length = Array.from(tag).length;
  if (length < 1 || length > MAX_TAG_CHARS) return false;
  // 夹着冒号的候选几乎一定是「标签：佛教」这类散文片段，不是标签。
  if (/[:：]/.test(tag)) return false;
  return !VAGUE_TAGS.has(tagKey(tag));
}

/** 书库已有标签的「比较键 → 原写法」映射，用于让模型输出复用现有拼写。 */
function knownTagMap(knownTags?: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of knownTags ?? []) {
    if (typeof raw !== "string") continue;
    const tag = cleanTag(raw);
    if (!isUsableTag(tag)) continue;
    const key = tagKey(tag);
    if (!map.has(key)) map.set(key, tag);
  }
  return map;
}

/**
 * 把候选列表收敛成最终标签：去重、去空泛词、限制长度与数量。
 *
 * 已知标签优先：模型写「佛 学」而库里是「佛学」时，落库的仍是库里的
 * 写法，筛选条不会因为一个空格分裂成两个标签。
 */
function sanitizeTags(
  candidates: readonly unknown[],
  known: Map<string, string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const cleaned = cleanTag(candidate);
    if (!isUsableTag(cleaned)) continue;
    const key = tagKey(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(known.get(key) ?? cleaned);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 从 `start` 处的 `[` 找到与它配对的 `]`（跳过字符串里的括号）。
 * 返回闭括号下标，找不到返回 -1。
 */
function matchingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 找出输出里的第一个 JSON 数组。
 *
 * 从每个 `[` 开始尝试配对解析，而不是简单取「第一个 `[` 到最后一个 `]`」：
 * 模型常在数组前面写「标签如下：[注]…」，后者会把两段拼成非法 JSON，让
 * 本来可用的结果被判定为解析失败。返回 `null` 表示没找到任何数组（可以
 * 走兜底切分），空数组则是一次「确实什么都没给」的成功应答。
 */
function extractJsonArray(raw: string): unknown[] | null {
  for (
    let start = raw.indexOf("[");
    start !== -1;
    start = raw.indexOf("[", start + 1)
  ) {
    const end = matchingBracket(raw, start);
    if (end === -1) continue;
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 不是 JSON：继续找下一个 `[`，最后交给分隔符兜底。
    }
  }
  return null;
}

/** 解析失败时的兜底：模型直接写了「佛教，哲学、禅宗」。 */
function splitFallback(raw: string): string[] {
  return raw
    // 代码围栏和 JSON 括号只是语法，不是标签的一部分。
    .replace(/```[a-zA-Z]*/g, " ")
    .replace(/[\[\]{}"'`]/g, " ")
    .split(/[,，、\s]+/u)
    .filter((token) => token.length > 0);
}

/**
 * 把模型的原始输出解析成最终标签列表。
 *
 * 顺序：先找 JSON 字符串数组（容忍围栏与前后闲聊）；找不到数组才按
 * `[,，、\s]+` 兜底切分。任何一步失败都返回空数组——"这次没有标签"
 * 由调用方决定是否重试，绝不抛错把一次导入拖垮。
 */
export function parseTagResponse(raw: string, knownTags?: string[]): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const known = knownTagMap(knownTags);
  const array = extractJsonArray(raw);
  if (array !== null) return sanitizeTags(array, known);
  return sanitizeTags(splitFallback(raw), known);
}

/**
 * 文章送进模型的文本：标题 + 正文段落，段落之间用换行连接，整体截断到
 * `maxChars`。标题放在最前面，因为主题通常先由标题给出。
 *
 * 正文是参数而不是 `article.paragraphs`：记录里根本没有正文，调用方必须
 * 先 `readBody` 并明确处理"正文不在这里"的情况。
 */
export function taggableText(
  title: string,
  paragraphs: readonly Pick<Paragraph, "text">[],
  maxChars: number = DEFAULT_TEXT_CHARS,
): string {
  const parts: string[] = [];
  const heading = (title ?? "").trim();
  if (heading) parts.push(heading);
  for (const paragraph of paragraphs) {
    const text = (paragraph?.text ?? "").trim();
    if (text) parts.push(text);
  }
  const joined = parts.join("\n");
  if (!(maxChars > 0)) return "";
  return joined.slice(0, Math.floor(maxChars));
}

/**
 * 真正发起一次打标请求。没有 key 时抛 `未配置 AI 密钥`（调用方按“跳过”
 * 处理，而不是按“失败”处理）。
 *
 * 超时用 `AbortController`：打标是附加能力，一次卡死的请求不该让读者
 * 看到「正在打标签」转到天荒地老。截止后重抛为超时错误，与用户主动
 * 取消区分开。
 */
export async function generateTags(
  input: GenerateTagsInput,
): Promise<{ tags: string[]; model: string }> {
  // `getActiveModel` 会校验设置并在 key 未确认时抛错；这里只需要模型与
  // 实际用的密钥（错误脱敏用）。
  const active = getActiveModel();
  if (!active) throw new Error("未配置 AI 密钥");
  if (input.signal?.aborted) throw new Error("打标签请求已取消。");

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  input.signal?.addEventListener("abort", cancel, { once: true });

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  const known = (input.knownTags ?? []).filter((tag) => tag.trim().length > 0);
  const system =
    known.length > 0
      ? `${SYSTEM_PROMPT}\n现有标签（能对应上时必须原样复用，不要另造近义词）：${known.join("、")}`
      : SYSTEM_PROMPT;
  const prompt = `标题：${input.title.trim() || "（无标题）"}\n\n正文：\n${input.text}`;

  try {
    const result = await generateText({
      model: active.model,
      system,
      prompt,
      // 标签应当稳定可复现，不欢迎创作型温度。
      temperature: 0.2,
      // 只输出几个短标签：给足上限，又不让模型借机写解释。
      maxOutputTokens: 200,
      // 与流式对话同一规则：失败不重试。打标是幂等增强，重试只会再花
      // 一次用户的钱。
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    return {
      tags: parseTagResponse(result.text, input.knownTags),
      model: active.name,
    };
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `打标签请求超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成，已停止。`,
      );
    }
    if (input.signal?.aborted) throw new Error("打标签请求已取消。");
    // 供应商可能在错误里回显密钥（401 常见），对外只给脱敏后的消息。
    // ai.ts 的 `redactSecrets` 是这条规则唯一的实现，直接复用。
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(message, [active.apiKey, readSettings().apiKey]));
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * 书库里已经在用的标签，按出现次数降序（同次数按名称排序，与
 * `library-groups.aggregateTags` 一致，筛选条的次序因此保持稳定）。
 * 供提示词复用，也方便调用方限制条数。
 */
export function collectKnownTags(limit: number = DEFAULT_KNOWN_TAGS): string[] {
  const counts = new Map<string, number>();
  for (const article of Object.values(useStore.getState().articles)) {
    for (const raw of article.tags ?? []) {
      const tag = raw.trim();
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const ordered = Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
    (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"),
  );
  const capped = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : ordered.length;
  return ordered.slice(0, capped).map((entry) => entry.tag);
}

/** 在途打标请求，按文章 id 去重。 */
const inflightTags = new Map<string, Promise<string[] | null>>();

/** 这篇文章当前是否有打标请求在途中（阅读页用来显示「正在生成标签」）。 */
export function isTagging(articleId: string): boolean {
  return inflightTags.has(articleId);
}

/**
 * 保证一篇文章有标签。返回最终写入的标签；跳过的三种情况返回 null：
 *
 *   1. 文章已不在 store 里（被删除/被清空）；
 *   2. 已有标签且 `force` 为 false；
 *   3. 没有可用的 key / 当前接口地址未确认。
 *
 * 失败（网络/鉴权/超时/取消）reject——调用方若是 fire-and-forget，需要
 * 自己 catch；成功但没有产出可用标签时同样返回 null，并保留原标签。
 */
export async function ensureArticleTags(
  articleId: string,
  opts: EnsureArticleTagsOptions = {},
): Promise<string[] | null> {
  // 同一篇文章已有请求在途：直接复用，不再花一次钱、也不让两个结果竞争。
  const pending = inflightTags.get(articleId);
  if (pending) return pending;

  const run = runTagging(articleId, opts);
  inflightTags.set(articleId, run);
  try {
    return await run;
  } finally {
    // 只清理自己登记的那一条，避免误删后来者登记的在途记录。
    if (inflightTags.get(articleId) === run) inflightTags.delete(articleId);
  }
}

/** `ensureArticleTags` 的实际流程；与在途去重分开，避免重复登记。 */
async function runTagging(
  articleId: string,
  opts: EnsureArticleTagsOptions,
): Promise<string[] | null> {
  const started = useStore.getState();
  const article = started.articles[articleId];
  if (!article) return null;
  if (!opts.force && article.tags && article.tags.length > 0) return null;
  if (!hasTaggingModel()) return null;

  // 冻结「这次请求属于谁」：必须在第一个 await（下面的读正文）之前取，
  // 否则「读 IndexedDB 的这段时间里切了账号」会被漏掉，结果写进新账号。
  const startedOwner = started.ownerUserId;
  const startedEpoch = currentSessionEpoch();

  // 正文优先用内存里已加载的那一份；否则读一次 IndexedDB。读不到正文
  // （被淘汰 / 还没同步到这台设备）就不打标——只凭标题生成的标签会把
  // 很多文章打到同一个宽泛主题上。
  const cached = started.bodies[articleId];
  const paragraphs =
    cached?.state === "present"
      ? cached.body.paragraphs
      : await readBody(articleId).then(
          (body) => body?.paragraphs ?? null,
          () => null,
        );
  if (!paragraphs || paragraphs.length === 0) return null;

  const text = taggableText(article.title, paragraphs);
  // 标题和正文都为空：没有可打标的内容，不发请求。
  if (!text.trim()) return null;

  const { tags, model } = await generateTags({
    title: article.title,
    text,
    knownTags: collectKnownTags(),
    signal: opts.signal,
  });
  if (tags.length === 0) return null;

  const now = useStore.getState();
  // 晚到写保护：文章可能已被删除/清空，owner 或会话 epoch 也可能已经换了。
  if (!now.articles[articleId]) return null;
  if (now.ownerUserId !== startedOwner) return null;
  if (currentSessionEpoch() !== startedEpoch) return null;

  // 只通过 setArticleTags 写：它不会用请求开始时捕获的旧文章副本覆盖
  // 期间发生的其它修改（段落、remoteId 等）。
  now.setArticleTags(articleId, tags, { model, at: Date.now() });
  // 标签是账号数据，不是本机数据：推给服务端，书库筛选和另一台设备才能看到同一批
  // 标签。失败不影响本次结果——下次打开这篇文章时 `pushArticleMetadata` 会再试。
  void pushTagsNow(articleId);
  return tags;
}
