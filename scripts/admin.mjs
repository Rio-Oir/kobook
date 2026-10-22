#!/usr/bin/env node

// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `npm run admin -- …` — entrypoint that loads `.env` (if present) and runs
 * the admin CLI in a single process. Mirrors `scripts/db.mjs`: spawn-and-await
 * with `cwd: root, stdio: 'inherit'` is the pattern of choice for repos whose
 * rest of the dev tooling is written in `*.mjs`, and it leaves the CLI itself
 * in TypeScript so the project typecheck covers it.
 */
import process from "node:process";
import { spawn } from "node:child_process";
import { root } from "./process.mjs";

try {
  // Best-effort .env load so `npm run admin -- …` against the dev container
  // works without a manual export.
  process.loadEnvFile?.();
} catch {
  // no .env present
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "server/src/cli/admin.ts", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
