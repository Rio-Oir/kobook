// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// UNUSED — kept only so an out-of-tree caller does not fail to resolve.
//
// This is an early implementation that fetched an article from a URL by
// calling a third-party reader service (r.jina.ai) directly from the browser
// and then re-parsed the returned Markdown into paragraphs here. Both halves
// have been superseded:
//
//   - URL import goes through `src/lib/browser-extract.ts`, and its server
//     fallback `POST /api/anonymous/extract`, which run the same parser the
//     rest of the application uses;
//   - text and file import go through `src/lib/local-import.ts`.
//
// Nothing in this repository imports it, and it must not be adopted as-is:
// it reaches a remote service from the browser with no SSRF guard, no byte
// cap and no deadline, and its paragraph hashes use a different algorithm
// (SHA-1, first 12 hex characters) from the `sha256`-based block hashes every
// stored anchor is expressed in, so its ids would not resolve against
// existing notes.
//
// Deleting it is a packaging decision rather than a code change, so it is
// left in place and flagged rather than removed here.

import type { Article, Paragraph } from "./types";

// Simple SHA-1 (good enough for paragraph hashes)
async function sha1(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha1Short(text: string): Promise<string> {
  return (await sha1(text)).slice(0, 12);
}

export async function articleIdFor(url: string): Promise<string> {
  return sha1Short(url.trim());
}

type JinaResponse = {
  data: {
    title?: string;
    author?: string;
    publishedTime?: string;  // ISO-ish date string
    description?: string;
    content?: string; // markdown
    url?: string;
  };
};

export async function fetchArticle(url: string): Promise<Article> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("请输入文章链接");

  // Validate the URL: must be a parseable http(s) URL. We prepend https://
  // when no protocol is given so "bun.com/blog" works. This blocks SSRF
  // attempts (file://, gopher://, javascript:, etc.) before the request
  // hits jina.ai.
  let urlObj: URL;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    urlObj = new URL(withProtocol);
  } catch {
    throw new Error("文章链接格式不正确");
  }
  if (!["http:", "https:"].includes(urlObj.protocol)) {
    throw new Error("仅支持 http 和 https 链接");
  }
  const normalized = urlObj.toString();

  // jina.ai's reader endpoint. Returns JSON when Accept: application/json.
  // Free, no auth needed for low-volume use. Returns up to 30k chars of clean markdown.
  const endpoint = `https://r.jina.ai/${normalized}`;
  const res = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      "X-Return-Format": "markdown",
    },
  });

  if (!res.ok) {
    throw new Error(`文章导入失败：${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as JinaResponse;
  const data = json.data || {};
  const md = data.content || "";
  if (!md) throw new Error("未能获取文章正文，请尝试粘贴正文");

  const { paragraphs, title, author } = await parseMarkdown(md);
  if (!paragraphs.length) throw new Error("未能提取可阅读的段落，请尝试粘贴正文");
  const id = await articleIdFor(normalized);

  return {
    id,
    url: normalized,
    title: title || data.title || extractTitleFromUrl(normalized),
    author: author || data.author,
    publishedAt: normalizeDate(data.publishedTime),
    paragraphs,
    createdAt: Date.now(),
  };
}

function normalizeDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function parseMarkdown(md: string): Promise<{
  paragraphs: Paragraph[];
  title: string;
  author: string;
}> {
  // Strip YAML frontmatter if any
  const cleaned = md.replace(/^---\n[\s\S]*?\n---\n/, "");

  // Extract title from first H1 if present
  const titleMatch = cleaned.match(/^#\s+(.+?)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract author from a line like "By Foo Bar" right after the title
  const authorMatch = cleaned.match(/^\*?By\s+([^\n*]+?)\*?\s*$/im);
  const author = authorMatch ? authorMatch[1].trim() : "";

  // Split on blank lines. Then within each block, strip headings, lists, etc.
  const blocks = cleaned
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const paragraphs: Paragraph[] = [];
  let counter = 0;
  for (const block of blocks) {
    // Skip headings
    if (/^#{1,6}\s/.test(block)) continue;
    // Skip code fences
    if (block.startsWith("```")) continue;
    // Skip image-only / link-only blocks
    if (/^!\[.*\]\(.*\)$/.test(block)) continue;

    // Strip leading list markers like "- " or "1. " from each line
    const stripped = block
      .split("\n")
      .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))
      .join(" ")
      .replace(/\*\*(.+?)\*\*/g, "$1") // bold
      .replace(/\*(.+?)\*/g, "$1")     // italic
      .replace(/`([^`]+)`/g, "$1")     // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
      .trim();

    if (!stripped) continue; // Preserve short Chinese paragraphs.

    counter += 1;
    const hash = (await sha1(stripped)).slice(0, 12);
    paragraphs.push({ index: counter, text: stripped, hash });
  }

  return { paragraphs, title, author };
}

function extractTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return last.replace(/[-_]/g, " ").replace(/\.\w+$/, "");
  } catch {
    return url;
  }
}
