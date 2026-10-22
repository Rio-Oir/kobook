// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * ADMIN_EMAILS bootstrap.
 *
 * The first administrators cannot be created through the API (nobody has the
 * role yet, and the role field is `input: false` so it cannot be self-assigned),
 * so they are seeded from the environment at startup.
 *
 * Deliberate rules:
 *   - **Grant only, never revoke.** Removing an address from ADMIN_EMAILS does
 *     not demote anyone. Demotion is an explicit, audited CLI action: a bad
 *     environment edit could otherwise lock the last administrator out, and
 *     environment variables are not an audit trail. Idempotent by construction,
 *     so restarting the server never changes an existing administrator.
 *   - **Never create users.** An address with no account is reported as unknown
 *     and warned about, not minted. A typo must not produce an account.
 *   - **Every grant is recorded**, attributed to "system", so there is a record
 *     of how someone became an administrator.
 */

import type { AppPrisma } from "../db.js";

export interface AdminSyncResult {
  granted: Array<{ email: string; userId: string }>;
  /** Addresses that already had the admin role. */
  alreadyAdmin: string[];
  /** Addresses in the whitelist with no account. */
  unknown: string[];
}

/**
 * Splits, normalises and validates the whitelist.
 *
 * A malformed entry throws: silently ignoring it would grant fewer privileges
 * than the operator asked for, which is the kind of failure that is discovered
 * only when someone cannot reach the admin surface.
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const seen = new Set<string>();
  const emails: string[] = [];
  for (const entry of entries) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry)) {
      throw new Error(
        `ADMIN_EMAILS contains a value that is not an email address: ${JSON.stringify(entry)}`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    emails.push(entry);
  }
  return emails;
}

export async function syncAdminEmails(
  prisma: AppPrisma,
  emails: string[],
): Promise<AdminSyncResult> {
  const result: AdminSyncResult = { granted: [], alreadyAdmin: [], unknown: [] };
  if (emails.length === 0) return result;

  // Emails are stored as the user typed them at sign-up, so match
  // case-insensitively rather than assuming normalisation.
  const accounts = await prisma.user.findMany({
    where: { email: { in: emails, mode: "insensitive" } },
    select: { id: true, email: true, role: true },
  });

  const byEmail = new Map(accounts.map((account) => [account.email.toLowerCase(), account]));

  for (const email of emails) {
    const account = byEmail.get(email);
    if (!account) {
      result.unknown.push(email);
      continue;
    }
    if (account.role === "admin") {
      result.alreadyAdmin.push(email);
      continue;
    }

    await prisma.user.update({ where: { id: account.id }, data: { role: "admin" } });
    await prisma.adminAuditEvent.create({
      data: {
        actorUserId: "system",
        actorEmail: "system",
        targetUserId: account.id,
        action: "grant_role",
        result: "applied",
        detail: "ADMIN_EMAILS bootstrap",
      },
    });
    result.granted.push({ email, userId: account.id });
  }

  return result;
}
