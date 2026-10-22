// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Stage pdf.js's data tables into `public/pdfjs/`.
 *
 * ## Why these are copied rather than imported
 *
 * `cmaps/` and `standard_fonts/` are not modules — they are data files that
 * pdf.js fetches by name at parse time, because which ones it needs depends on
 * the document in front of it. A PDF that identifies glyphs by CID asks for
 * `UniGB-UCS2-H.bcmap`; one that does not asks for nothing. Bundling cannot
 * express that, so they are served as static files and pdf.js is told where
 * with `cMapUrl` / `standardFontDataUrl`.
 *
 * ## What is deliberately not copied
 *
 * - **`wasm/`** (1.6 MB). It holds image decoders (JBIG2, JPEG2000) and a
 *   colour-management module — none of which text extraction touches — plus
 *   `quickjs-eval.wasm`, the sandboxed replacement for the `new Function` path
 *   pdf.js removed in v6. WebAssembly instantiation needs `'wasm-unsafe-eval'`
 *   in `script-src`, which this application's policy deliberately does not
 *   grant, so shipping them would add weight for files that could not run.
 * - **`iccs/`**, **`image_decoders/`**, **`web/`**, **`legacy/`** — rendering
 *   and viewer assets.
 *
 * ## Why the worker is staged here rather than imported
 *
 * `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"` is the
 * documented Vite idiom and it does not reliably do the right thing here: a
 * production build was observed pulling the worker into the pdf.js chunk as a
 * module instead of emitting it as a URL asset, which leaves `workerSrc`
 * pointing at a file that was never written and the import failing at runtime
 * with nothing in the build output to explain it.
 *
 * Copying it makes the URL a plain static path, which is the same mechanism the
 * CMaps already use — no bundler behaviour to depend on, and the file sits
 * beside them in the offline shell's precache list. It must be served as
 * JavaScript: an `.mjs` worker fetched with the wrong MIME type is refused by
 * the browser before a line of it runs.
 *
 * ## What is copied, and what it costs
 *
 * `cmaps/` is 169 files and about 1.5 MB, `standard_fonts/` about 800 KB, and
 * the worker about 1 MB. All are precached by the offline shell, so a first
 * install carries them. `cmaps/` is not optional for this application — without
 * it every Chinese PDF extracts as garbage.
 *
 * The output directory is gitignored: these are build inputs from a pinned
 * dependency, not source.
 *
 * Run from the repository root:
 *   node scripts/pdfjs-assets.mjs
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SOURCE = path.join(REPO_ROOT, "node_modules", "pdfjs-dist");
const DESTINATION = path.join(REPO_ROOT, "public", "pdfjs");

/** Directories pdf.js fetches by name at parse time. */
const DIRECTORIES = ["cmaps", "standard_fonts"];

/** Single files pdf.js loads by URL, relative to the staged root. */
const FILES = ["build/pdf.worker.min.mjs"];

/** Recursive file count, for the log line. */
async function countFiles(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    total += entry.isDirectory()
      ? await countFiles(path.join(directory, entry.name))
      : 1;
  }
  return total;
}

async function main() {
  if (!existsSync(path.join(SOURCE, "package.json"))) {
    console.error("[pdfjs-assets] pdfjs-dist is not installed. Run `npm ci` first.");
    process.exit(1);
  }
  for (const directory of DIRECTORIES) {
    if (!existsSync(path.join(SOURCE, directory))) {
      console.error(`[pdfjs-assets] pdfjs-dist is missing ${directory}/`);
      process.exit(1);
    }
  }
  for (const file of FILES) {
    if (!existsSync(path.join(SOURCE, file))) {
      console.error(`[pdfjs-assets] pdfjs-dist is missing ${file}`);
      process.exit(1);
    }
  }

  // Rebuilt wholesale rather than merged: a table left over from an older
  // pdfjs-dist is worse than none, because pdf.js would read data that no
  // longer matches the library.
  await rm(DESTINATION, { recursive: true, force: true });
  await mkdir(DESTINATION, { recursive: true });
  for (const directory of DIRECTORIES) {
    await cp(path.join(SOURCE, directory), path.join(DESTINATION, directory), {
      recursive: true,
    });
  }
  for (const file of FILES) {
    // Flattened to the staged root: `workerSrc` is then a single-segment path
    // beside the CMap directory, with no `build/` in the deployed URL.
    await cp(path.join(SOURCE, file), path.join(DESTINATION, path.basename(file)));
  }

  console.log(`[pdfjs-assets] staged ${await countFiles(DESTINATION)} files into public/pdfjs/`);
}

await main();
