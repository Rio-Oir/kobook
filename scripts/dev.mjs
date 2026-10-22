// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from 'node:child_process';
import { root } from './process.mjs';
try { process.loadEnvFile(); } catch {}
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://gloss_dev:local_dev_only@127.0.0.1:55434/gloss_dev', BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:8080' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort'], { cwd: root, stdio: 'inherit', windowsHide: true }),
  spawn(`${root}/.tools/caddy/caddy.exe`, ['run', '--config', 'dev/Caddyfile', '--adapter', 'caddyfile'], { cwd: root, stdio: 'inherit', windowsHide: true }),
];
const stop = () => { for (const child of children) child.kill(); };
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(); process.exitCode = 1; });
  child.on('exit', code => { if (code) process.exitCode = code; stop(); });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
