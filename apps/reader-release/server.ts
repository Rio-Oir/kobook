// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Release deployment entry.
 *
 * ## What this is
 *
 * The open-source build's process: **the complete base server**, plus the built
 * reader shell served from the same origin under `/reader/`.
 *
 * It used to be a *thin* service that mounted only the anonymous extractor —
 * no database, no accounts, no sessions — so that "the build cannot reach
 * cloud data" was a property of what was mounted rather than of a conditional
 * somewhere. That premise is gone: accounts, sessions, cloud sync and cloud
 * notes are part of this product, and the line is drawn at **payment**, which
 * is not part of this repository.
 *
 * So this file is deliberately small: the startup path is `buildFullServer` in
 * `server/src/index.ts` — the same environment loading, the same Prisma client,
 * the same Better Auth instance, the same mail transport and the same admin
 * bootstrap as `npm run start:server` — and the one thing added here is where
 * the shell lives.
 *
 * ## Requirements
 *
 * A database. This deployment is no longer database-less: it answers
 * `/api/health/ready`, and a deployment that cannot reach PostgreSQL reports
 * itself degraded rather than serving an app whose account features fail one
 * request at a time.
 *
 * ## Running it
 *
 * From the repository root, after `npm run build:release` (which produces
 * `apps/reader-release/dist`) and with the environment a server needs
 * (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`):
 *
 *   node --import tsx apps/reader-release/server.ts
 *
 * `tsx` is what resolves the `.js` specifiers the server sources use to their
 * `.ts` files; the built artifact (`npm run build:server`) runs the same graph
 * under plain `node`.
 */

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFullServer, type FullServer } from "../../server/src/index.js";
import { DEPLOY_BASE, FREE_CSP } from "./csp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SERVICE_NAME = "kobook-reader";

/** The release server: the full app, with the shell mounted beside it. */
export function buildReleaseServer(): Promise<FullServer> {
  return buildFullServer({
    shell: {
      root: path.join(HERE, "dist"),
      base: DEPLOY_BASE,
      csp: FREE_CSP,
    },
    // The deployment sits behind a local reverse proxy that overwrites
    // `X-Forwarded-For`. Off unless it is asked for, and never from a
    // non-loopback connection — see `BuildAppOptions.trustLoopbackProxy`.
    trustLoopbackProxy: process.env["TRUST_LOOPBACK_PROXY"] === "1",
  });
}

const isEntry =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js|mjs)$/, "") ===
    fileURLToPath(import.meta.url).replace(/\.(ts|js|mjs)$/, "");

if (isEntry) {
  const { app, env, shutdown } = await buildReleaseServer();

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: env.host, port: env.port });
    app.log.info(
      { service: SERVICE_NAME, host: env.host, port: env.port, shell: DEPLOY_BASE },
      `kobook reader on http://${env.host}:${env.port}${DEPLOY_BASE}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
