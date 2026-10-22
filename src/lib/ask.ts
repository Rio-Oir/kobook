// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Ask: a custom question about a passage. Same caching pattern as explain.

import type { Article, Paragraph } from "./types";
import { buildStableContext, buildAskQuestion } from "./context";
import type { ChatMessage } from "./explain";

export function buildAskMessages(
  article: Article,
  paragraphs: readonly Paragraph[],
  selectionText: string,
  userQuestion: string,
  priorMessages: ChatMessage[] = [],
): ChatMessage[] {
  return [
    { role: "system", content: buildStableContext(article, paragraphs) },
    ...priorMessages,
    {
      role: "user",
      content: buildAskQuestion(selectionText, userQuestion),
    },
  ];
}
