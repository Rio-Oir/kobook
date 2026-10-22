// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Administrator surface (phase 2).
 *
 * Deliberately small. The plan's phase-6 admin view covers usage, error
 * summaries and limit configuration, none of which exist yet; this file is
 * just enough to satisfy the phase-2 gates and the audit-trail obligation:
 *
 *   - list accounts, with their governance state, in pages;
 *   - grant and revoke the `admin` role;
 *   - disable and enable accounts;
 *   - read the audit trail.
 *
 * The shape is honest about what it does not have: it joins nothing to
 * private content, and it never reads an article, note or conversation —
 * phase-2 users have none, and the contract exists to keep the same
 * posture when they do.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { type UserRole } from "../../../shared/contracts/index.js";
import {
  ROUTES,
  type AdminAuditEntry,
  type AdminAuditResponse,
  type AdminDisableRequest,
  type AdminSetRoleRequest,
  type AdminUserListResponse,
  type AdminUserResponse,
  type AdminUserSummary,
} from "../../../shared/contracts/index.js";
import type { AppPrisma } from "../db.js";
import type { Auth } from "../auth.js";
import {
  createRequireRole,
  currentSession,
} from "../plugins/session.js";

const PAGE_SIZE = 50;

/** Opaque cursor: base64url of the last id, so a future shape change does not break old cursors. */
function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
function decodeCursor(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function toUserSummary(row: {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  role: string;
  banned: boolean;
  banReason: string | null;
  createdAt: Date;
}): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.emailVerified,
    role: row.role === "admin" ? "admin" : "user",
    banned: row.banned,
    banReason: row.banReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAuditEntry(row: {
  id: string;
  actorUserId: string;
  actorEmail: string;
  targetUserId: string;
  action: string;
  result: string;
  detail: string | null;
  requestId: string | null;
  createdAt: Date;
}): AdminAuditEntry {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    targetUserId: row.targetUserId,
    action: row.action as AdminAuditEntry["action"],
    result: row.result as AdminAuditEntry["result"],
    detail: row.detail,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

function userIdParam(request: FastifyRequest): string {
  const id = (request.params as { userId?: string }).userId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("userId route parameter is required");
  }
  return id;
}

async function recordAudit(
  prisma: AppPrisma,
  request: FastifyRequest,
  actor: { userId: string; email: string },
  targetUserId: string,
  action:
    | "grant_role"
    | "revoke_role"
    | "disable_account"
    | "enable_account",
  result: "applied" | "rejected",
  detail: string | null,
): Promise<string> {
  const row = await prisma.adminAuditEvent.create({
    data: {
      actorUserId: actor.userId,
      actorEmail: actor.email,
      targetUserId,
      action,
      result,
      detail,
      requestId: String(request.id),
    },
  });
  return row.id;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  prisma: AppPrisma,
  auth: Auth,
): void {
  const requireAdmin = createRequireRole(auth, "admin");

  // ── List ──────────────────────────────────────────────────────────────
  app.get(ROUTES.adminUsers, { preHandler: requireAdmin }, async (req): Promise<AdminUserListResponse> => {
    const cursor = decodeCursor((req.query as { cursor?: string }).cursor);
    const rows = await prisma.user.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: "asc" },
      take: PAGE_SIZE + 1,
    });
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const next = hasMore ? encodeCursor(page[page.length - 1]!.id) : null;
    return { users: page.map(toUserSummary), nextCursor: next };
  });

  // ── Set role ──────────────────────────────────────────────────────────
  app.post<{ Params: { userId: string }; Body: AdminSetRoleRequest }>(
    ROUTES.adminUserRole,
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["role"],
          additionalProperties: false,
          properties: {
            role: { type: "string", enum: ["user", "admin"] },
          },
        },
      },
    },
    async (req): Promise<AdminUserResponse> => {
      const target = await prisma.user.findUnique({ where: { id: userIdParam(req) } });
      if (!target) {
        // The shared error handler maps statusCode 404 to a NOT_FOUND body
        // whose `message` is this string, so the wire shape stays in the
        // shared error contract instead of inventing a new one.
        throw Object.assign(new Error("用户不存在。"), { statusCode: 404 });
      }
      const targetRole: UserRole = target.role === "admin" ? "admin" : "user";
      const requested = req.body.role;
      if (targetRole === requested) {
        const auditId = await recordAudit(
          prisma,
          req,
          { userId: currentSession(req).user.id, email: currentSession(req).user.email },
          target.id,
          requested === "admin" ? "grant_role" : "revoke_role",
          "applied",
          "role unchanged",
        );
        return { user: toUserSummary(target), auditId };
      }
      const updated = await prisma.user.update({
        where: { id: target.id },
        data: { role: requested },
      });
      const auditId = await recordAudit(
        prisma,
        req,
        { userId: currentSession(req).user.id, email: currentSession(req).user.email },
        target.id,
        requested === "admin" ? "grant_role" : "revoke_role",
        "applied",
        requested,
      );
      return { user: toUserSummary(updated), auditId };
    },
  );

  // ── Disable ──────────────────────────────────────────────────────────
  app.post<{ Params: { userId: string }; Body: AdminDisableRequest }>(
    ROUTES.adminUserDisable,
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { reason: { type: "string", maxLength: 500 } },
        },
      },
    },
    async (req): Promise<AdminUserResponse> => {
      const target = await prisma.user.findUnique({ where: { id: userIdParam(req) } });
      if (!target) {
        throw Object.assign(new Error("用户不存在。"), { statusCode: 404 });
      }
      const updated = await prisma.user.update({
        where: { id: target.id },
        data: {
          banned: true,
          banReason: req.body.reason ?? null,
          banExpires: null,
        },
      });
      const auditId = await recordAudit(
        prisma,
        req,
        { userId: currentSession(req).user.id, email: currentSession(req).user.email },
        target.id,
        "disable_account",
        "applied",
        req.body.reason ?? null,
      );
      return { user: toUserSummary(updated), auditId };
    },
  );

  // ── Enable ───────────────────────────────────────────────────────────
  app.post<{ Params: { userId: string } }>(
    ROUTES.adminUserEnable,
    {
      preHandler: requireAdmin,
      schema: {
        params: {
          type: "object",
          required: ["userId"],
          additionalProperties: false,
          properties: { userId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req): Promise<AdminUserResponse> => {
      const target = await prisma.user.findUnique({ where: { id: userIdParam(req) } });
      if (!target) {
        throw Object.assign(new Error("用户不存在。"), { statusCode: 404 });
      }
      const updated = await prisma.user.update({
        where: { id: target.id },
        data: { banned: false, banReason: null, banExpires: null },
      });
      const auditId = await recordAudit(
        prisma,
        req,
        { userId: currentSession(req).user.id, email: currentSession(req).user.email },
        target.id,
        "enable_account",
        "applied",
        null,
      );
      return { user: toUserSummary(updated), auditId };
    },
  );

  // ── Audit ────────────────────────────────────────────────────────────
  app.get(ROUTES.adminAudit, { preHandler: requireAdmin }, async (req): Promise<AdminAuditResponse> => {
    const cursor = decodeCursor((req.query as { cursor?: string }).cursor);
    const rows = await prisma.adminAuditEvent.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: "asc" },
      take: PAGE_SIZE + 1,
    });
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return { entries: page.map(toAuditEntry) };
  });
}
