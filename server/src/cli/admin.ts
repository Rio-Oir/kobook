#!/usr/bin/env node

// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `npm run admin -- <cmd> ...` — manager for administrator state outside the
 * web UI. `grant` and `revoke` accept an email; `disable` and `enable` accept
 * an email plus an optional reason; `list` and `audit` produce a one-line
 * summary per record. Every state change writes an `admin_audit_event` with
 * `actorUserId = "cli"`, so the CLI is its own audit trail.
 *
 * `revoke` refuses to remove the last administrator.
 */

import process from "node:process";
import { createPrismaClient } from "../db.js";
import { parseAdminEmails } from "../lib/admin-bootstrap.js";

interface AdminAction {
  action: "grant_role" | "revoke_role" | "disable_account" | "enable_account";
  /** What to do to a single address. */
  run: (email: string) => Promise<{ applied: boolean; detail: string | null }>;
}

async function findUserByEmail(prisma: ReturnType<typeof createPrismaClient>, email: string) {
  return prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, role: true, banned: true },
  });
}

function buildActions(prisma: ReturnType<typeof createPrismaClient>): Record<string, AdminAction> {
  return {
    grant: {
      action: "grant_role",
      async run(email) {
        const user = await findUserByEmail(prisma, email);
        if (!user) return { applied: false, detail: "no account" };
        if (user.role === "admin") return { applied: false, detail: "already admin" };
        await prisma.user.update({ where: { id: user.id }, data: { role: "admin" } });
        return { applied: true, detail: null };
      },
    },
    revoke: {
      action: "revoke_role",
      async run(email) {
        const user = await findUserByEmail(prisma, email);
        if (!user) return { applied: false, detail: "no account" };
        if (user.role !== "admin") return { applied: false, detail: "not admin" };
        const remaining = await prisma.user.count({ where: { role: "admin" } });
        if (remaining <= 1) {
          return { applied: false, detail: "refusing to remove the last administrator" };
        }
        await prisma.user.update({ where: { id: user.id }, data: { role: "user" } });
        return { applied: true, detail: null };
      },
    },
    disable: {
      action: "disable_account",
      async run(email) {
        const user = await findUserByEmail(prisma, email);
        if (!user) return { applied: false, detail: "no account" };
        await prisma.user.update({
          where: { id: user.id },
          data: { banned: true, banReason: process.env["ADMIN_DISABLE_REASON"] ?? null, banExpires: null },
        });
        return { applied: true, detail: process.env["ADMIN_DISABLE_REASON"] ?? null };
      },
    },
    enable: {
      action: "enable_account",
      async run(email) {
        const user = await findUserByEmail(prisma, email);
        if (!user) return { applied: false, detail: "no account" };
        await prisma.user.update({
          where: { id: user.id },
          data: { banned: false, banReason: null, banExpires: null },
        });
        return { applied: true, detail: null };
      },
    },
  };
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(
      [
        "usage:",
        "  admin list                                — one line per account",
        "  admin audit [--limit N]                   — most recent audit rows",
        "  admin grant <email>                       — set role to admin",
        "  admin revoke <email>                      — set role to user",
        "  admin disable <email> [--reason <text>]   — ban the account",
        "  admin enable <email>                      — unban the account",
        "",
      ].join("\n"),
    );
    return;
  }

  const databaseUrl =
    process.env["DATABASE_URL"]?.trim() ||
    "postgresql://gloss_dev:local_dev_only@127.0.0.1:55434/gloss_dev";
  const prisma = createPrismaClient(databaseUrl);

  try {
    if (command === "list") {
      const rows = await prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        select: { id: true, email: true, role: true, banned: true, emailVerified: true, createdAt: true },
      });
      for (const row of rows) {
        process.stdout.write(
          `${row.id}  ${row.email}  role=${row.role}  banned=${row.banned}  verified=${row.emailVerified}  created=${row.createdAt.toISOString()}\n`,
        );
      }
      return;
    }

    if (command === "audit") {
      const limitIndex = rest.indexOf("--limit");
      const limit =
        limitIndex === -1
          ? 50
          : Math.max(1, Math.min(500, Number(rest[limitIndex + 1]) || 50));
      const rows = await prisma.adminAuditEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      for (const row of rows) {
        process.stdout.write(
          `${row.createdAt.toISOString()}  actor=${row.actorEmail}  action=${row.action}  result=${row.result}  target=${row.targetUserId}  detail=${row.detail ?? "-"}  requestId=${row.requestId ?? "-"}\n`,
        );
      }
      return;
    }

    if (command === "grant" || command === "revoke" || command === "disable" || command === "enable") {
      const email = rest[0];
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        process.stderr.write(`error: <email> is required and must be a valid address\n`);
        process.exitCode = 1;
        return;
      }
      // parseAdminEmails is used here as a strict validator rather than a
      // splitter, so a malformed address fails the same way it would in
      // `loadEnv`.
      parseAdminEmails(email);

      if (command === "disable") {
        const reasonIndex = rest.indexOf("--reason");
        if (reasonIndex !== -1) {
          process.env["ADMIN_DISABLE_REASON"] = rest.slice(reasonIndex + 1).join(" ").trim();
        }
      }

      const action = buildActions(prisma)[command]!;
      const user = await findUserByEmail(prisma, email);
      if (!user) {
        process.stderr.write(`error: no account for ${email}\n`);
        process.exitCode = 1;
        return;
      }
      const result = await action.run(email);
      const row = await prisma.adminAuditEvent.create({
        data: {
          actorUserId: "cli",
          actorEmail: "cli",
          targetUserId: user.id,
          action: action.action,
          result: result.applied ? "applied" : "rejected",
          detail: result.detail,
          requestId: null,
        },
      });
      process.stdout.write(
        `${result.applied ? "applied" : "rejected"}  ${action.action}  ${email}  auditId=${row.id}\n`,
      );
      if (!result.applied) process.exitCode = 1;
      return;
    }

    process.stderr.write(`error: unknown command '${command}'\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`admin failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
