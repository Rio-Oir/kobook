// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where a verification run writes its evidence.
 *
 * Default: `<repo>/artifacts/<suite>`, which `.gitignore` excludes, so a run
 * never leaves output inside the tracked tree.
 *
 * `EVIDENCE_DIR` overrides the location entirely — an absolute path, or a path
 * relative to the repository root. An external audit harness uses it to keep a
 * run's logs, screenshots and fixtures out of the working copy; the acceptance
 * runner forwards it to the child processes it spawns, so one setting covers
 * every step.
 *
 * The directory is created on demand. Nothing here decides *what* is written;
 * a suite names its own files.
 *
 * Plain JavaScript on purpose: this module is imported by the runners that
 * `npm` launches with bare `node`, not through a TypeScript loader.
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** The repository root, resolved from this file rather than from `cwd`. */
export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function evidenceDir(suite) {
  const override = process.env["EVIDENCE_DIR"]?.trim();
  const dir = override
    ? path.resolve(repoRoot, override)
    : path.join(repoRoot, "artifacts", suite);
  mkdirSync(dir, { recursive: true });
  return dir;
}
