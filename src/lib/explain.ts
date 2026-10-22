// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Explain: returns a messages array ready for the LLM.
// Pattern: stable system context (caches after first call) + dynamic user
// question at the END (Anthropic's "question at end" advice, also the
// natural place for DeepSeek/OpenAI's prompt cache to begin invalidating).

import type { Article, Paragraph } from "./types";
import { buildStableContext, buildExplainQuestion } from "./context";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function buildExplainMessages(
  article: Article,
  paragraphs: readonly Paragraph[],
  selectionText: string,
  priorMessages: ChatMessage[] = [],
): ChatMessage[] {
  return [
    { role: "system", content: buildStableContext(article, paragraphs) },
    ...priorMessages,
    {
      role: "user",
      content: buildExplainQuestion(selectionText),
    },
  ];
}
