// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serial acceptance run.
 *
 * Default (fail-fast): stop at the first non-zero step, which is what a
 * developer wants while iterating — a broken typecheck should not be
 * followed by twenty minutes of integration suites.
 *
 * `--all`: run every step regardless and record each exit code. The
 * acceptance run needs this. With fail-fast, one failing step hides the
 * result of every step after it, so a report cannot say "phase 1 and 2
 * and 3 all passed; this one thing did not" — it can only say "it stopped
 * here". The full picture is the point of the run, so the mode exists and
 * the report is generated from it.
 *
 * `--only <substring>`: run the steps whose name contains the substring.
 * Used to re-run one step without repeating the whole serial suite after
 * a change that cannot affect the others.
 *
 * Both modes write `artifacts/verification.json` with the same shape, so
 * the report and any tooling read one file.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { root } from './process.mjs';

const checks = [
  ['generate', ['node_modules/prisma/build/index.js', 'generate']],
  ['frontend typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['server typecheck', ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json', '--noEmit']],
  ['test typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tests/tsconfig.json', '--noEmit']],
  ['frontend build', ['node_modules/vite/bin/vite.js', 'build']],
  ['server build', ['node_modules/typescript/bin/tsc', '-p', 'server/tsconfig.json']],
  ['unit tests (all suites)', ['--import', 'tsx', '--test', 'tests/unit/*.test.ts']],
  // Phase 4 owns the BYOK fixture and these tests; they are run here rather
  // than reimplemented, so the joint acceptance covers them and there is one
  // implementation of the local fake provider.
  ['unit tests (BYOK)', ['--import', 'tsx', '--test', 'tests/unit/byok-*.test.ts']],
  // This list used to carry three steps that no longer exist anywhere —
  // `tests/home-dual-extract.mjs`, `tests/home-offline-real.mjs` and
  // `tests/local-import-browser.mjs` — plus `tests/browser.mjs`, which drove a
  // composer that both lines have since replaced (`改为粘贴正文` toggle, a
  // `文章正文` box, paste routed through the server). A serial acceptance that
  // lists steps which cannot run reports "stopped here" about a file that is
  // not there, so they are gone and the suites that actually exist are listed
  // instead. The paste-then-read flow they covered is the first section of
  // `tests/browser-articles.mjs`.
  ['PostgreSQL + HTTP auth + Caddy SSE', ['--import', 'tsx', 'tests/phase1.ts']],
  ['accounts, roles, rate limit, mail', ['--import', 'tsx', 'tests/phase2.ts']],
  ['articles, library, isolation, log scrub', ['--import', 'tsx', 'tests/phase3.ts']],
  ['browser: notes and anchors', ['tests/browser-note-anchors.mjs']],
  ['browser: note hover link', ['tests/browser-note-hover-link.mjs']],
  ['browser: note lifecycle', ['tests/browser-note-lifecycle.mjs']],
  ['browser: notebook', ['tests/browser-notebook.mjs']],
  ['browser: reading layout', ['tests/reading-layout-browser.mjs']],
  ['browser: account isolation', ['tests/browser-auth.mjs']],
  ['browser: article library and cloud notes', ['tests/browser-articles.mjs']],
  ['browser: BYOK (local fake provider)', ['tests/byok-browser.mjs']],
];

const argv = process.argv.slice(2);
const runAll = argv.includes('--all');
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : null;

const selected = only ? checks.filter(([name]) => name.includes(only)) : checks;
if (only && selected.length === 0) {
  throw new Error(`--only ${JSON.stringify(only)} matched no step`);
}

const results = [];
for (const [name, args] of selected) {
  console.log(`Running ${name}`);
  const start = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  results.push({ name, command: ['node', ...args], exitCode, durationMs: Date.now() - start });
  if (exitCode !== 0) {
    process.exitCode = 1;
    if (!runAll) break;
  }
}

// `pass` only means something for a complete run; a partial one is
// reported as `complete: false` so nobody reads "the steps I happened to
// run were fine" as acceptance.
const complete = !only && results.length === checks.length;
await mkdir('artifacts', { recursive: true });
await writeFile(
  'artifacts/verification.json',
  JSON.stringify(
    {
      at: new Date().toISOString(),
      complete,
      ranAll: runAll,
      pass: complete && results.every((r) => r.exitCode === 0),
      results,
    },
    null,
    2,
  ) + '\n',
);
