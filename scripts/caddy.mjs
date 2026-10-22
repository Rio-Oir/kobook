// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run, root } from './process.mjs';
export const caddyPath = join(root, '.tools', 'caddy', 'caddy.exe');
const sha512 = '88347875f0cd4b5e26bb39cd1f359613f932d54158d560e03244004d1ba6e61aae0cd625ba7c913bd46df096ef973fef2249396b0bb81143414378cb4447aeb8';
const zipPath = join(root, '.tools', 'caddy', 'caddy.zip');
const action = process.argv[2] ?? 'setup';
if (process.platform !== 'win32') throw new Error('This portable Caddy launcher supports Windows x64. See README prerequisites.');
if (action === 'setup') {
  await mkdir(join(root, '.tools', 'caddy'), { recursive: true });
  let archive;
  try { archive = await readFile(zipPath); } catch {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Invoke-WebRequest -Uri 'https://github.com/caddyserver/caddy/releases/download/v2.10.2/caddy_2.10.2_windows_amd64.zip' -OutFile $env:GLOSS_CADDY_ZIP"], {
      env: { ...process.env, GLOSS_CADDY_ZIP: zipPath },
    });
    archive = await readFile(zipPath);
  }
  if (createHash('sha512').update(archive).digest('hex') !== sha512) throw new Error('Caddy archive does not match pinned official SHA-512.');
  // Paths are passed through environment variables, never interpolated as shell code.
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:GLOSS_CADDY_ZIP -DestinationPath $env:GLOSS_CADDY_DIR -Force'], {
    env: { ...process.env, GLOSS_CADDY_ZIP: zipPath, GLOSS_CADDY_DIR: join(root, '.tools', 'caddy') },
  });
  await run(caddyPath, ['version']);
} else if (action === 'run') await run(caddyPath, ['run', '--config', 'dev/Caddyfile', '--adapter', 'caddyfile']);
else throw new Error(`Unknown Caddy action: ${action}`);
