// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Make the emitted server JavaScript runnable by Node.
 *
 * ## The problem this solves, precisely
 *
 * `tsc` does not rewrite module specifiers. Prisma's generated client
 * (`server/src/generated/prisma/**`) is written for *bundler* resolution
 * (extensionless relative imports), and it is not this tree's to restyle —
 * `prisma generate` would undo any edit. Compiling it as-is therefore produces
 * `server/dist/**` where `server.js` says `import … from "./types"` — which
 * Node's ESM loader refuses with `ERR_MODULE_NOT_FOUND`. Type-checking passes;
 * the artifact does not run. That difference is exactly what a "just switch
 * the tsconfig to Bundler" change hides, so the artifact is verified by
 * loading it, not only by compiling it (see `tests/server/artifact-smoke.mjs`).
 *
 * ## What it does
 *
 * After `tsc`, every relative specifier in the emitted `.js` files that has no
 * file extension is resolved *against the emitted tree* and given one:
 *
 *   `./types`        → `./types.js`        when `types.js` was emitted
 *   `./postgres`     → `./postgres/index.js` when it is a directory with an index
 *
 * Nothing is rewritten unless it resolves, and a specifier that resolves to
 * nothing **fails the build** rather than shipping an artifact that cannot
 * start. Sources, the generated client and the type-checked output are
 * untouched — only the extension of an already-emitted string changes.
 *
 * ## What it does not do, stated plainly
 *
 * The match is textual, not syntactic: it finds `from "…"` and `import("…")`,
 * and a *string literal* containing that same text would be rewritten too. In
 * this tree that case does not arise — every specifier-shaped occurrence in
 * the emitted output is a real import statement, and `server/src` is already
 * required to write `.js` extensions by
 * `tests/unit/server-import-extensions.test.ts`, so only the generated client
 * has anything to rewrite. It is a limitation of a post-processing pass, not
 * a property being relied on silently: if a future file introduces a string
 * that looks like an import of a real sibling module, it would be rewritten
 * and nothing here would say so.
 *
 * Exit codes: 0 when every relative specifier resolves, 1 when any does not (the
 * list of unresolved specifiers is printed).
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../dist");

/** Extensions that already satisfy Node's loader. */
const RESOLVED = /\.(?:js|mjs|cjs|json|node)$/u;

/** `import … from "x"` / `export … from "x"`. */
const STATIC_PATTERN = /(\bfrom\s*)(['"])((?:\.\.?\/)[^'"]*)\2/gu;
/** `import("x")`. */
const DYNAMIC_PATTERN = /(\bimport\s*\(\s*)(['"])((?:\.\.?\/)[^'"]*)\2/gu;

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Resolve one specifier against the emitted tree.
 *
 * Returns the specifier to write, or `null` when nothing in the emitted tree
 * matches — which the caller reports as a build failure.
 */
export async function resolveSpecifier(fromFile, specifier) {
  if (RESOLVED.test(specifier)) return specifier;
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (await exists(`${base}.js`)) return `${specifier}.js`;
  if (await exists(path.join(base, "index.js"))) return `${specifier}/index.js`;
  return null;
}

/**
 * Rewrite one emitted file's specifiers.
 *
 * Exported so the transformation can be tested directly
 * (`tests/unit/emit-esm-extensions.test.ts`) instead of only through a full
 * compile — the failure this guards against is a *string* problem, and a
 * string test says so much more precisely than "the build broke".
 */
export async function rewriteSource(source, fromFile) {
  const pending = [];
  for (const pattern of [STATIC_PATTERN, DYNAMIC_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      pending.push({ prefix: match[1], quote: match[2], specifier: match[3], whole: match[0] });
    }
  }
  if (pending.length === 0) return { source, rewritten: 0, unresolved: [] };

  let next = source;
  let rewritten = 0;
  const unresolved = [];
  // Longest first, so replacing `./types` cannot corrupt `./types/index` — and
  // each replacement is anchored to the full matched text, not the bare
  // specifier, so an unrelated string with the same text is never touched.
  for (const item of pending.sort((a, b) => b.whole.length - a.whole.length)) {
    const specifier = await resolveSpecifier(fromFile, item.specifier);
    if (specifier === null) {
      unresolved.push({ specifier: item.specifier });
      continue;
    }
    if (specifier === item.specifier) continue;
    const replacement = `${item.prefix}${item.quote}${specifier}${item.quote}`;
    if (!next.includes(item.whole)) continue;
    next = next.replace(item.whole, replacement);
    rewritten += 1;
  }
  return { source: next, rewritten, unresolved };
}

async function rewriteFile(file, unresolved) {
  const source = await readFile(file, "utf8");
  const result = await rewriteSource(source, file);
  for (const item of result.unresolved) {
    unresolved.push({ file: path.relative(DIST, file), specifier: item.specifier });
  }
  return { source: result.source, rewritten: result.rewritten };
}

async function main() {
  const files = await listFiles(DIST);
  let changedFiles = 0;
  let rewritten = 0;
  const unresolved = [];

  for (const file of files) {
    const { source, rewritten: count } = await rewriteFile(file, unresolved);
    if (count === 0) continue;
    await writeFile(file, source, "utf8");
    changedFiles += 1;
    rewritten += count;
  }

  if (unresolved.length > 0) {
    console.error(
      `[server-emit] FAILED: ${unresolved.length} relative import(s) do not resolve in the emitted tree:`,
    );
    for (const item of unresolved.slice(0, 20)) {
      console.error(`  ${item.file} → ${item.specifier}`);
    }
    process.exit(1);
  }

  console.log(
    `[server-emit] ${rewritten} relative import(s) given an extension across ${changedFiles} file(s)`,
  );
}

// Only run when invoked as a script: the pure helpers above are imported by a
// unit test, and importing a module that rewrites the build output as a side
// effect would be a trap.
const isEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  await main();
}
