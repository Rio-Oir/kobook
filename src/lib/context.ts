// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Stable context builder.
//
// The key insight: the article + metadata + fixed instructions are the SAME
// for every LLM call within a single article's reading session. By putting
// them in the system message and keeping the user message dynamic, we hit
// DeepSeek's / OpenAI's / Anthropic's prompt cache on every subsequent call.
//
// DeepSeek caches on the first 1024 tokens of the prompt (prefix match).
// OpenAI caches on 128+ token prefixes. Anthropic needs explicit breakpoints.
// The Vercel AI SDK passes the messages array through, so this pattern works
// for all three.

import type { Article } from "./types";

const MAX_DOCUMENT_CHARS = 120_000;
const MAX_SELECTION_CHARS = 8_000;
const MAX_QUESTION_CHARS = 4_000;

function limit(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[内容已截断]`;
}

export function buildStableContext(article: Article): string {
  const paragraphs = article.paragraphs.map((p) => `[¶${p.index}] ${p.text}`).join("\n\n");
  return `<metadata>
Title: ${article.title}
Author: ${article.author || "Unknown"}
Source: ${article.url ? safeHostname(article.url) : "pasted text"}
Paragraphs: ${article.paragraphs.length}
</metadata>

<document>
${limit(paragraphs, MAX_DOCUMENT_CHARS)}
</document>

INSTRUCTIONS:
You are a careful close reader. The user is reading the document above and will ask about specific passages.

When answering:
- Answer in Simplified Chinese by default, unless the user explicitly requests another language. Keep exact quotations in their original language.
- Quote the exact text from the document before drawing conclusions.
- Reference paragraphs using ¶N (single) or ¶N-M (range).
- Keep responses under 200 words.
- If the document does not contain the answer, say so clearly.
- Do not invent paragraph numbers.`;
}

export function buildExplainQuestion(selectionText: string): string {
  return `用户选中了：“${limit(selectionText, MAX_SELECTION_CHARS)}”

请结合上下文解释这段文字的含义，并引用相关段落。`;
}

export function buildAskQuestion(
  selectionText: string,
  userQuestion: string,
): string {
  return `用户正在阅读：“${limit(selectionText, MAX_SELECTION_CHARS)}”

用户的问题：“${limit(userQuestion, MAX_QUESTION_CHARS)}”

请清楚地回答，并引用相关段落。`;
}

export function buildFollowUpQuestion(
  selectionText: string,
  userQuestion: string,
): string {
  return `原问题仍保留。用户针对这段文字继续追问：“${limit(selectionText, MAX_SELECTION_CHARS)}”

新的问题：“${limit(userQuestion, MAX_QUESTION_CHARS)}”`;
}

/**
 * Why a `¶N` / `¶N-M` reference in model output is not usable against this
 * article, or `null` when every reference checks out.
 *
 * The brief's schema only pins the *shape* of a reference; the article is
 * what decides whether it exists. Returning the reason (instead of a bare
 * boolean) lets the caller tell the user which reference was rejected
 * rather than "格式不正确".
 */
export function findInvalidParagraphRef(
  text: string,
  article: Article,
): string | null {
  const allowed = new Set(article.paragraphs.map((p) => p.index));
  for (const match of text.matchAll(/¶(\d+)(?:-(\d+))?/g)) {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start > end) return `段落范围起点大于终点：${match[0]}`;
    if (!allowed.has(start)) return `段落不存在：¶${start}`;
    if (!allowed.has(end)) return `段落不存在：¶${end}`;
  }
  return null;
}

export function validateParagraphRefs(text: string, article: Article): boolean {
  return findInvalidParagraphRef(text, article) === null;
}

export function buildBriefQuestion(): string {
  return `Produce the brief as specified in the system instructions.`;
}

// Brief uses a slightly different system prompt — it wants JSON output and
// a different focus. We keep it in the same "stable prefix" pattern so that
// re-generating a brief for the same article also benefits from the cache.
//
// The document goes through the same `MAX_DOCUMENT_CHARS` clamp as the
// explain/ask context: a long article must not turn a brief request into an
// unbounded (and silently failing) prompt.
export function buildBriefSystemContext(article: Article): string {
  const paragraphs = article.paragraphs.map((p) => `[¶${p.index}] ${p.text}`).join("\n\n");
  return `<metadata>
Title: ${article.title}
Author: ${article.author || "Unknown"}
Source: ${article.url ? safeHostname(article.url) : "pasted text"}
Paragraphs: ${article.paragraphs.length}
</metadata>

<document>
${limit(paragraphs, MAX_DOCUMENT_CHARS)}
</document>

INSTRUCTIONS:
Produce a JSON object with exactly two fields:
Write the gist and claim text in Simplified Chinese. Preserve paragraph references and JSON field names exactly.
1. "gist": a one-paragraph summary of the main argument, ≤ 120 words.
2. "claims": an array of EXACTLY 5 key claims, each with:
   - "text": the claim (≤ 30 words)
   - "paragraphRef": a reference like "¶3" or "¶13-26" pointing to the most relevant paragraph(s)

Return ONLY valid JSON, no markdown fencing.`;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
