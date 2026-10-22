// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Health probes.
 *
 * `/live` never touches the database, so it keeps answering while PostgreSQL
 * is down. `/ready` checks the database and answers 503 when it is
 * unreachable.
 *
 * Neither response discloses a connection string, host, port, user, driver
 * version or raw driver error.
 */

import type { FastifyInstance } from "fastify";
import type { ReadyHealth, LiveHealth } from "../../../shared/contracts/index.js";
import { ROUTES } from "../../../shared/contracts/index.js";
import type { AppPrisma } from "../db.js";
import { isDatabaseReachable } from "../db.js";

export interface HealthRouteOptions {
  prisma: AppPrisma;
  serviceName: string;
  version: string;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  const startedAt = Date.now();

  const uptimeSeconds = (): number => Math.round((Date.now() - startedAt) / 1000);

  app.get(ROUTES.healthLive, async (): Promise<LiveHealth> => {
    return {
      status: "ok",
      service: options.serviceName,
      version: options.version,
      uptimeSeconds: uptimeSeconds(),
    };
  });

  app.get(ROUTES.healthReady, async (_req, reply): Promise<ReadyHealth> => {
    const database = (await isDatabaseReachable(options.prisma)) ? "up" : "down";
    const body: ReadyHealth = {
      status: database === "up" ? "ok" : "degraded",
      service: options.serviceName,
      version: options.version,
      uptimeSeconds: uptimeSeconds(),
      checks: { database },
    };
    if (body.status !== "ok") reply.code(503);
    return body;
  });
}
