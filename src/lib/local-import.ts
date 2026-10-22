// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local (in-browser) article import — the offline half of the dual-channel
 * design.
 *
 * The product rule this implements: "粘贴文字/Markdown在浏览器解析为统一正文块、
 * 生成本机文章、保存并立即进入Reader；匿名和登录用户均不等待后端" and "粘贴
 * 正文在浏览器解析…不发提取请求".
 *
 * So this module has **no network path at all**. Not "it usually does not call
 * the server": there is no fetch, no base URL, no transport to inject. A caller
 * that only wants to read pasted text cannot accidentally reach the network
 * through this module, and that is what makes the four acceptance cases —
 * backend stopped, 404, 500, fully offline — indistinguishable from the happy
 * path here.
 *
 * Scope: text and Markdown. HTML paste is deliberately *not* handled locally.
 * The server's HTML path runs Readability over a jsdom document, and a browser
 * port would be a second DOM walker to keep in step with `html.ts`; the
 * dual-channel requirement is only that *text/Markdown* reads offline. HTML
 * pastes keep going through `POST /api/anonymous/extract` (`kind: "html"`),
 * which is already the behaviour today. See the handoff doc §7.5.
 */

import type { ParsedDocument, ParseResult } from "../../shared/contracts/index.js";
import { parseLocalMarkdown } from "./local-import-parse.js";

/**
 * Byte cap for a local paste.
 *
 * Mirrors the server's `MAX_INPUT_BYTES` (2 MB) for the anonymous extract
 * route, so "too large" means the same thing on both channels: content this
 * client refuses locally would also be refused by the fallback, and rejecting
 * it *before* parsing is what keeps an accidental multi-megabyte paste from
 * freezing the tab.
 *
 * Measured in UTF-8 bytes rather than `String.length` on purpose. A Chinese
 * document is ~3 bytes per character in UTF-8, so a UTF-16 length check would
 * let through roughly three times the server's limit — the two channels would
 * disagree about the same document.
 */
export const MAX_LOCAL_INPUT_BYTES = 2 * 1024 * 1024;

/** Why a local import did not produce a document. */
export type LocalImportFailureCode =
  /** Nothing but whitespace was pasted. */
  | "EMPTY_INPUT"
  /** Past `MAX_LOCAL_INPUT_BYTES`. */
  | "TOO_LARGE"
  /** The Markdown parsed, but held no retainable text (e.g. front matter only). */
  | "EMPTY_CONTENT"
  /** The Markdown parser threw. */
  | "PARSE_ERROR";

export type LocalImportResult =
  | {
      ok: true;
      /**
       * Always `"local"`. Named rather than assumed so a caller that records
       * where an article came from (the sync payload does) writes the same
       * literal the server's vocabulary uses.
       */
      source: "local";
      document: ParsedDocument;
      /** UTF-8 byte length of the accepted input, for logging/telemetry. */
      bytes: number;
    }
  | {
      ok: false;
      code: LocalImportFailureCode;
      /** Ready to show to the user. */
      message: string;
      bytes: number;
    };

export interface LocalImportOptions {
  /** Overrides the document title derived from the first heading. */
  title?: string;
  /** Overrides `MAX_LOCAL_INPUT_BYTES`. Intended for tests and fixtures. */
  maxBytes?: number;
}

/**
 * UTF-8 byte length, without materialising the encoded copy.
 *
 * Equivalent to `new TextEncoder().encode(input).byteLength` for well-formed
 * strings — including lone surrogates, which `TextEncoder` rewrites to U+FFFD
 * (3 bytes) and this counts as 3. Computed by walking instead of encoding
 * because the check runs *before* the size limit is applied, which is exactly
 * when copying the input is what we are trying to avoid.
 */
export function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Round a byte budget to one decimal place of MB, for a user-facing message. */
function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Turn pasted text / Markdown into a unified `ParsedDocument`.
 *
 * Synchronous by design. The caller can save the article and navigate in the
 * same tick it got the result, which is what "立即进入Reader" asks for and what
 * an awaited round trip cannot give.
 *
 * The empty and oversized cases are decided *here*, before parsing, so the
 * user gets a local validation message rather than a generic failure — and so
 * a caller cannot forget the check and hand 50 MB to remark.
 */
export function importFromPastedText(
  raw: string,
  options: LocalImportOptions = {},
): LocalImportResult {
  const maxBytes = options.maxBytes ?? MAX_LOCAL_INPUT_BYTES;
  const bytes = utf8ByteLength(raw);

  if (raw.trim().length === 0) {
    return { ok: false, code: "EMPTY_INPUT", message: "请粘贴文章正文。", bytes };
  }
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `正文超过 ${megabytes(maxBytes)} MB 上限，请分段粘贴，或改用链接导入。`,
      bytes,
    };
  }

  const parsed: ParseResult = parseLocalMarkdown(raw, {
    ...(options.title === undefined ? {} : { title: options.title }),
  });
  if (!parsed.ok) {
    // `parseLocalMarkdown` itself never produces `UNSUPPORTED_INPUT` (it
    // refuses unknown content shapes before the discriminator matters), but
    // `ParseFailureCode` is a wider union than `LocalImportFailureCode`; map
    // anything that slips through to `PARSE_ERROR` so the local failure type
    // is closed.
    const code: LocalImportFailureCode =
      parsed.code === "EMPTY_CONTENT"
        ? "EMPTY_CONTENT"
        : parsed.code === "PARSE_ERROR"
          ? "PARSE_ERROR"
          : "PARSE_ERROR";
    return {
      ok: false,
      code,
      message:
        code === "EMPTY_CONTENT"
          ? "未能从这段内容中提取正文，请确认粘贴的是完整文章。"
          : "正文解析失败，请检查 Markdown 格式，或改用链接导入。",
      bytes,
    };
  }

  return { ok: true, source: "local", document: parsed.document, bytes };
}

export { parseLocalMarkdown } from "./local-import-parse.js";
export type { LocalMarkdownParseOptions } from "./local-import-parse.js";
