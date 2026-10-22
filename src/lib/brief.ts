// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Brief: one-shot LLM call that returns a gist + 5 key claims as JSON.
// Uses its own system context (different focus than explain) but the same
// stable-prefix pattern for cache reuse.
//
// Phase 4 routes the request through `streamChat` instead of driving
// `streamText` here. A second, hand-rolled SDK call site meant a second,
// worse lifecycle: no timeout, no cancellation, no `maxRetries: 0`, and —
// because it iterated `textStream` — a provider error mid-stream looked
// like an empty success. Going through `streamChat` means the brief inherits
// the same error/cancel/timeout/cleanup rules as every other AI call.

import type { Article, Paragraph } from "./types";
import { z } from "zod";
import { streamChat } from "./ai";
import { readSettings } from "./settings";
import {
  buildBriefSystemContext,
  buildBriefQuestion,
  findInvalidParagraphRef,
} from "./context";

const BriefSchema = z.object({
  gist: z.string().max(800),
  claims: z
    .array(
      z.object({
        text: z.string().max(400),
        paragraphRef: z.string().regex(/^¶\d+(-\d+)?$/),
      }),
    )
    .length(5),
});

export type Brief = z.infer<typeof BriefSchema>;

export type GenerateBriefOptions = {
  /** Cancels the brief the same way a chat cancel does (sign-out, navigate away). */
  signal?: AbortSignal;
  /** Override the default stream deadline. */
  timeoutMs?: number;
};

export async function generateBrief(
  article: Article,
  paragraphs: readonly Paragraph[],
  onProgress?: (raw: string) => void,
  opts: GenerateBriefOptions = {},
): Promise<Brief> {
  const s = readSettings();
  if (!s.apiKey) {
    // No key ⇒ demo mode, and the mock is a local, obviously-labelled
    // excerpt. It is *not* routed through `streamChat`: a mock text stream
    // is not JSON, and pretending a demo reply parsed into a brief is the
    // "演示模式当真实供应商验收" mistake the rules call out.
    return mockBrief(article, paragraphs);
  }

  const messages = [
    { role: "system" as const, content: buildBriefSystemContext(article, paragraphs) },
    { role: "user" as const, content: buildBriefQuestion() },
  ];

  return await new Promise<Brief>((resolve, reject) => {
    let raw = "";
    streamChat({
      messages,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      temperature: 0.3,
      onChunk: (delta) => {
        raw += delta;
        onProgress?.(raw);
      },
      onDone: () => {
        try {
          resolve(parseBrief(raw, paragraphs));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
      // A failed or cancelled brief rejects: the caller shows the reason and
      // the partial text it already streamed stays on screen. It must never
      // resolve into a brief that came from a truncated JSON body.
      onError: (err) => reject(err),
      onCancelled: () => reject(new Error("摘要生成已取消。")),
      onInterrupted: () => reject(new Error("摘要生成被中断，可重试。")),
    }).catch((err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Parse + validate the model's reply. Exported for the unit tests. */
export function parseBrief(raw: string, paragraphs: readonly Paragraph[]): Brief {
  // Strip code fences if the model added them
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let decoded: unknown;
  try {
    decoded = JSON.parse(cleaned);
  } catch {
    throw new Error("模型返回的摘要不是有效 JSON");
  }
  const parsed = BriefSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      "模型返回的摘要格式不正确：" + parsed.error.message,
    );
  }
  // Every reference must resolve inside the *current* version of the
  // article: a claim pointing at ¶13 of a 10-paragraph revision is worse
  // than no brief, because the reader would click through to nothing.
  for (const claim of parsed.data.claims) {
    const reason = findInvalidParagraphRef(claim.paragraphRef, paragraphs);
    if (reason) {
      throw new Error(`模型返回了无效的段落引用（${reason}）`);
    }
  }
  const gistReason = findInvalidParagraphRef(parsed.data.gist, paragraphs);
  if (gistReason) {
    throw new Error(`模型返回了无效的段落引用（${gistReason}）`);
  }
  return parsed.data;
}

function mockBrief(article: Article, paragraphs: readonly Paragraph[]): Brief {
  const ps = paragraphs.slice(0, 5);
  return {
    gist:
      "[演示摘要：以下是原文节选，并非 AI 总结。请在设置中填写 API 密钥后生成真实摘要。]\n\n" +
      (ps[0]?.text.slice(0, 400) || "暂无正文。"),
    claims: ps.map((p, i) => ({
      text: p.text.slice(0, 120) + (p.text.length > 120 ? "…" : ""),
      paragraphRef: `¶${p.index}`,
    })),
  };
}
