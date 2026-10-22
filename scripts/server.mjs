// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { run } from './process.mjs';
try { process.loadEnvFile(); } catch {}
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://gloss_dev:local_dev_only@127.0.0.1:55434/gloss_dev',
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:8080',
};
await run(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], { env });
