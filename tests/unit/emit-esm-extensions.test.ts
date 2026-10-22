// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The emitted-artifact rewriter, tested as the string transformation it is.
 *
 * `npm run build:server` runs `server/scripts/emit-esm-extensions.mjs` after
 * `tsc`, because the two frozen module packages are written for bundler
 * resolution and `tsc` does not rewrite specifiers — so the emitted JavaScript
 * would otherwise say `import … from "./types"`, which Node's ESM loader
 * refuses. `tests/server/artifact-smoke.mjs` proves the *result* loads; these
 * tests say precisely what the transformation does to a string, which is a far
 * better error message than "the build broke".
 *
 * The tree it resolves against is a miniature emitted tree in a fresh temp
 * directory: resolution is a filesystem question, so the test has to give it
 * real `.js` files, and a fresh `mkdtemp` per call rather than a fixed name
 * because this machine runs several sessions at once.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveSpecifier, rewriteSource } from "../../server/scripts/emit-esm-extensions.mjs";

/**
 * A miniature emitted tree:
 *
 *   types.js
 *   postgres/index.js
 *
 * — one file and one directory, which are the two shapes `tsc` emits for a
 * module specifier.
 */
async function emittedTree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gloss-emit-"));
  await mkdir(path.join(dir, "postgres"), { recursive: true });
  await writeFile(path.join(dir, "types.js"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(dir, "postgres", "index.js"), "export const b = 2;\n", "utf8");
  return dir;
}

test("a specifier that already satisfies the loader is left alone", async () => {
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  for (const specifier of ["./types.js", "./postgres/index.js", "../shared/x.mjs", "./x.json"]) {
    assert.equal(await resolveSpecifier(file, specifier), specifier);
  }
});

test("an extensionless specifier is resolved against the emitted tree", async () => {
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  assert.equal(await resolveSpecifier(file, "./types"), "./types.js");
  // A directory import becomes its index — the shape `tsc` emits for
  // `import … from "./postgres"` in the frozen packages.
  assert.equal(await resolveSpecifier(file, "./postgres"), "./postgres/index.js");
});

test("a specifier that resolves to nothing is reported, not guessed", async () => {
  // The caller turns this into a failed build. Silently leaving it alone is the
  // failure this whole script exists to prevent: the artifact would type-check
  // and then refuse to load.
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  assert.equal(await resolveSpecifier(file, "./absent"), null);
});

test("both static and dynamic imports are rewritten", async () => {
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  const result = await rewriteSource(
    [
      'import { a } from "./types";',
      'export { b } from "./types";',
      'const lazy = await import("./types");',
    ].join("\n"),
    file,
  );
  assert.deepEqual(result.unresolved, []);
  assert.equal(
    result.source,
    [
      'import { a } from "./types.js";',
      'export { b } from "./types.js";',
      'const lazy = await import("./types.js");',
    ].join("\n"),
  );
});

test("every occurrence of one specifier is rewritten, not only the first", async () => {
  // `String.replace` with a string pattern replaces one occurrence. A file that
  // imports the same module twice — which the frozen packages do — would
  // otherwise keep a second, unloadable specifier while the build reported
  // success.
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  const result = await rewriteSource(
    ['import { a } from "./types";', 'import { b } from "./types";'].join("\n"),
    file,
  );
  assert.equal(result.rewritten, 2);
  assert.equal(
    result.source,
    ['import { a } from "./types.js";', 'import { b } from "./types.js";'].join("\n"),
  );
});

test("one specifier being a prefix of another does not corrupt the longer one", async () => {
  // `./types` is a prefix of `./types/index`; replacing the short one first
  // would turn the long one into `./types.js/index`.
  const dir = await emittedTree();
  await mkdir(path.join(dir, "types"), { recursive: true });
  await writeFile(path.join(dir, "types", "index.js"), "export const c = 3;\n", "utf8");
  const file = path.join(dir, "caller.js");
  const result = await rewriteSource(
    ['import { a } from "./types";', 'import { c } from "./types/index";'].join("\n"),
    file,
  );
  assert.deepEqual(result.unresolved, []);
  assert.equal(
    result.source,
    ['import { a } from "./types.js";', 'import { c } from "./types/index.js";'].join("\n"),
  );
});

test("an unresolvable specifier is reported and left as it was", async () => {
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  const result = await rewriteSource(
    ['import { a } from "./types";', 'import { z } from "./absent";'].join("\n"),
    file,
  );
  assert.deepEqual(result.unresolved, [{ specifier: "./absent" }]);
  assert.equal(
    result.source,
    ['import { a } from "./types.js";', 'import { z } from "./absent";'].join("\n"),
    "the resolvable one is still fixed; the report is what fails the build",
  );
});

test("a non-relative specifier is not this script's business", async () => {
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  const source = ['import fastify from "fastify";', 'import x from "node:path";'].join("\n");
  const result = await rewriteSource(source, file);
  assert.equal(result.source, source);
  assert.equal(result.rewritten, 0);
  assert.deepEqual(result.unresolved, []);
});

test("a file with no relative imports is returned untouched", async () => {
  const dir = await emittedTree();
  const file = path.join(dir, "caller.js");
  const source = "export const answer = 42;\n";
  const result = await rewriteSource(source, file);
  assert.equal(result.source, source);
  assert.equal(result.rewritten, 0);
  assert.deepEqual(result.unresolved, []);
});
