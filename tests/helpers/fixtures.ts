// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared helpers for the phase 1 unit tests.
 *
 * Fixtures are read from `tests/fixtures`, which contains only locally
 * authored files. No test in this suite performs a network request.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ContentBlock,
  ParsedDocument,
  ParseResult,
} from "../../shared/contracts/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "fixtures");

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/** Unwraps a successful parse, failing loudly on an unexpected failure. */
export function expectOk(result: ParseResult): ParsedDocument {
  if (!result.ok) {
    throw new Error(`expected a successful parse but got ${result.code}: ${result.message}`);
  }
  return result.document;
}

export function blocksOfType(doc: ParsedDocument, type: ContentBlock["type"]): ContentBlock[] {
  return doc.blocks.filter((b) => b.type === type);
}

export function textsOf(doc: ParsedDocument): string[] {
  return doc.blocks.map((b) => b.text);
}
