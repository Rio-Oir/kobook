// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Database lifecycle for local development and the acceptance runs.
 *
 * Actions:
 *   up         start the compose PostgreSQL services and wait for health
 *   down       stop them (volumes are preserved)
 *   migrate    apply migrations to the *development* database
 *   bootstrap  create the databases the test suites connect to, if missing
 *
 * `bootstrap` is the piece the acceptance runs used to depend on by hand.
 * Every suite connects first to a fixed *administration* database (e.g.
 * `gloss_phase3_test`) and then creates its own throwaway
 * `gloss_phase3_test_<timestamp>` from it. Those fixed names existed only
 * because someone had created them once, so a fresh clone — or a wiped
 * volume — failed with an opaque "database does not exist" from `pg`
 * before any test ran.
 *
 * This script makes that state reproducible. It is deliberately additive:
 *
 *   - it only ever `CREATE DATABASE`s a name that is absent, so running it
 *     twice is a no-op and running it against a populated server cannot
 *     touch existing data;
 *   - it never drops, resets or truncates anything, and never removes a
 *     volume (the handover explicitly forbids `down -v` and volume
 *     deletion, because the databases on this machine are not disposable);
 *   - it prints exactly what it created, so a run's evidence says what
 *     changed rather than "bootstrap ok".
 *
 * The throwaway `*_<timestamp>` databases that previous runs left behind
 * are *not* pruned here. Deleting databases is a destructive operation
 * that a bootstrap step has no business performing, and the list of names
 * is not something this script can verify the provenance of.
 */

import { Client } from "pg";
import { run } from "./process.mjs";

/**
 * Run the Prisma CLI through this repository's own `node_modules`.
 *
 * Defined here rather than imported from `./process.mjs`, where it used to
 * live. `process.mjs` is a *base*-owned file and base removed the runner from
 * it deliberately — the base line has no schema to generate and no client to
 * migrate — so re-adding the export would put a value-added concern back into a
 * file every future merge from `codex/base` touches. Keeping it beside its only
 * caller leaves the base file byte-identical and the dependency one-way.
 *
 * The import was broken for several commits before this: `db.mjs` kept
 * `import { run, prisma }` after `process.mjs` stopped exporting it, so every
 * `db:*` script — and therefore every `pretest:phase*` hook, and therefore
 * every integration run — died on a module-resolution error before touching a
 * database. Nothing noticed because the failure is at import time in a script
 * only the integration suites invoke.
 */
const prisma = (args, env = process.env) =>
  run(process.execPath, ["node_modules/prisma/build/index.js", ...args], { env });

const action = process.argv[2] ?? "up";

const devUrl = "postgresql://gloss_dev:local_dev_only@127.0.0.1:55434/gloss_dev";

/** The fixed administration databases the suites connect through. */
export const TEST_ADMIN_DATABASES = [
  "gloss_phase1_test",
  "gloss_phase2_test",
  "gloss_phase3_test",
  "gloss_browserauth_test",
  "gloss_browserarticles_test",
];

const testAdminUrl =
  "postgresql://gloss_test:local_test_only@127.0.0.1:55433/postgres";

/**
 * Create any missing administration database.
 *
 * `CREATE DATABASE` cannot run inside a transaction, and a concurrent run
 * can win the race between the existence check and the create, so the
 * duplicate-database error is treated as success rather than as a
 * failure.
 */
export async function bootstrapTestDatabases() {
  const client = new Client({ connectionString: testAdminUrl });
  await client.connect();
  const created = [];
  const present = [];
  try {
    const existing = new Set(
      (
        await client.query(
          "SELECT datname FROM pg_database WHERE datistemplate = false",
        )
      ).rows.map((row) => row.datname),
    );
    for (const name of TEST_ADMIN_DATABASES) {
      if (existing.has(name)) {
        present.push(name);
        continue;
      }
      try {
        // The identifier is from a module constant, never from input.
        await client.query(`CREATE DATABASE "${name}"`);
        created.push(name);
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "42P04") {
          present.push(name);
          continue;
        }
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return { created, present };
}

if (action === "up") {
  await run("docker", ["compose", "up", "-d", "--wait", "db-dev", "db-test"]);
} else if (action === "down") {
  await run("docker", ["compose", "down"]);
} else if (action === "migrate") {
  await prisma(["migrate", "deploy"], { ...process.env, DATABASE_URL: devUrl });
} else if (action === "bootstrap") {
  const { created, present } = await bootstrapTestDatabases();
  if (created.length > 0) {
    process.stdout.write(`created test databases: ${created.join(", ")}\n`);
  }
  if (present.length > 0) {
    process.stdout.write(`already present: ${present.join(", ")}\n`);
  }
  if (created.length === 0) {
    process.stdout.write("nothing to do\n");
  }
} else {
  throw new Error(`Unknown db action: ${action}`);
}
