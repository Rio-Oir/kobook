// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every relative import in `server/src` must carry an explicit `.js`
 * extension.
 *
 * ## Why this is a test and not a compiler setting
 *
 * The server used to be type-checked with `moduleResolution: "NodeNext"`,
 * which refuses a relative import without an extension. It had to change to
 * `Bundler` because the server now composes two module packages that are
 * written for bundler resolution (see `server/tsconfig.json`), and those
 * packages are frozen artifacts of another line.
 *
 * Node's own ESM loader still requires the extension. Nothing about the
 * runtime changed — only the compiler's ability to say so — so the check moves
 * here, where it keeps working:
 *
 *   - the emitted JavaScript is imported by Node, not by a bundler, so a
 *     missing extension is a boot failure, and it is the *kind* of boot
 *     failure that only shows up when that one file is first reached;
 *   - the two module packages are exempt by construction: they are outside
 *     `server/src` and are not this tree's to restyle.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE, "../../server/src");

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // `server/src/generated/**` is the Prisma client, written by a generator
    // for bundler resolution and not this repository's code to restyle. It is
    // also gitignored, so it is not part of what a checkout contains.
    if (entry.isDirectory() && entry.name === "generated") continue;
    if (entry.isDirectory()) out.push(...(await listTypeScriptFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every module specifier the file names, from any import/export form. */
function specifiersIn(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/gu, // import … from "x" / export … from "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu, // dynamic import("x")
    /\bimport\s+["']([^"']+)["']/gu, // bare side-effect import "x"
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return found;
}

test("every relative import in server/src ends in .js", async () => {
  const files = await listTypeScriptFiles(SERVER_SRC);
  assert.ok(files.length > 20, `expected the server sources, found ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith(".")) continue;
      if (specifier.endsWith(".js")) continue;
      offenders.push(`${path.relative(SERVER_SRC, file)} → ${specifier}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Node's ESM loader needs the extension; add `.js` (the source file stays `.ts`)",
  );
});

test("no server source reaches into a `modules/` package", async () => {
  // `modules/` is where the value-added line's commercial packages live
  // (`payment-kit`, `commercial-entitlements`). This line composes none of
  // them, and the boundary is meant to hold in the *source*, not only in the
  // built artifact: a `server/src` file that reached into one would make the
  // open-source tree depend on a package that is not in it.
  //
  // One package is part of this tree and is exempt by name:
  // `modules/phone-otp-kit/` is the phone-verification module registered in
  // `docs/手机号注册登录后续开发计划.md` as an independent sub-project *for this
  // reader*, and `server/src/lib/phone/` is its documented integration point.
  // The exemption is an explicit allowlist rather than a loosened pattern, so
  // the commercial packages stay refused by the same test.
  const files = await listTypeScriptFiles(SERVER_SRC);
  // Import specifiers, not any quoted string: prose that names the package in a
  // comment documents the boundary rather than crossing it, and a check that
  // failed on a comment would push people to stop writing the comment.
  const MODULE_IMPORT = /(?:\bfrom\s*|import\s*\(\s*|require\s*\(\s*)["'`][^"'`]*\bmodules\/(?!phone-otp-kit\/)/;
  const offenders: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (MODULE_IMPORT.test(source)) {
      offenders.push(path.relative(SERVER_SRC, file).split(path.sep).join("/"));
    }
  }
  assert.deepEqual(offenders, [], "base's server must not import a value-added module");
});
