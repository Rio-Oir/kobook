// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Prisma client construction.
 *
 * Prisma 7 talks to PostgreSQL through a driver adapter; we use the official
 * `@prisma/adapter-pg`. There is intentionally no SQLite fallback anywhere in
 * this project — the acceptance criteria require a real PostgreSQL server, so
 * silently degrading to an embedded database would invalidate the evidence.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type AppPrisma = InstanceType<typeof PrismaClient>;

export function createPrismaClient(connectionString: string): AppPrisma {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

/**
 * Readiness probe. Returns a boolean only — the caller must not surface the
 * driver error text, which can contain host/database/user details.
 */
export async function isDatabaseReachable(prisma: AppPrisma): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports the server version string (e.g. "PostgreSQL 17.6 ..."). Used by the
 * database sample to prove the target really is PostgreSQL rather than an
 * embedded or mocked engine.
 */
export async function databaseVersion(prisma: AppPrisma): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version() AS version`;
  return rows[0]?.version ?? "unknown";
}
