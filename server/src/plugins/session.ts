// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Session resolution and the three access gates.
 *
 * The authenticated principal always comes from the session cookie via
 * Better Auth. Nothing in a request body, query string or header is trusted as
 * an identity claim — in particular there is no `userId` parameter anywhere,
 * matching the plan's rule that knowing an id is not authorisation.
 *
 * Why the account state is re-checked on every request: Better Auth's
 * `getSession` knows nothing about roles or disabled accounts, and its admin
 * plugin only checks the ban flag when a session is *created*. An account
 * disabled while signed in would therefore keep working until its session
 * expired. The gate "禁用账号及时拒绝受保护请求" requires the check to happen per
 * request, and that is what `resolveSession` does. As a consequence a role
 * change also applies on the very next request, with no re-login and no cache
 * to invalidate.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth } from "../auth.js";
import type { SessionUser, UserRole } from "../../../shared/contracts/index.js";
import { buildApiError } from "../../../shared/contracts/index.js";

export interface ResolvedSession {
  user: SessionUser;
  session: { id: string; expiresAt: Date };
}

/** Request decoration set by the gates below. */
export interface AuthedRequest extends FastifyRequest {
  authSession?: ResolvedSession;
}

/** Account state read from the session user, normalised and never trusted raw. */
interface AccountState {
  role: UserRole;
  banned: boolean;
  banReason: string | null;
}

/**
 * Reads the governance fields defensively.
 *
 * The values arrive from an untyped JSON-shaped user record, so nothing here
 * may assume a shape: a database value like `"superuser"` must degrade to the
 * least privilege rather than be passed through as a role.
 */
export function readAccountState(user: unknown): AccountState {
  const record = (user ?? {}) as Record<string, unknown>;

  const role: UserRole = record["role"] === "admin" ? "admin" : "user";

  const banExpires = record["banExpires"];
  const expiresAt =
    typeof banExpires === "string" || banExpires instanceof Date
      ? new Date(banExpires).getTime()
      : null;
  // An expired ban has stopped applying, even if the flag has not been cleared
  // yet (the session-creation hook clears it lazily).
  const banned = record["banned"] === true && (expiresAt === null || expiresAt > Date.now());

  const reason = record["banReason"];
  return {
    role,
    banned,
    banReason: typeof reason === "string" && reason.length > 0 ? reason : null,
  };
}

interface GateOptions {
  /** Reject sessions whose address is not verified. */
  requireVerified?: boolean;
  /** Reject sessions without this role. */
  requireRole?: UserRole;
}

/**
 * Resolves the session, applies the account-state gates in a fixed order, and
 * replies directly when a gate rejects. Returns null once a reply has been
 * sent, so callers must treat null as "stop".
 *
 * Order is 401 → disabled → unverified → role, so a response never depends on
 * how the caller happens to be both disabled and unverified.
 */
async function resolveSession(
  auth: Auth,
  req: FastifyRequest,
  reply: FastifyReply,
  options: GateOptions = {},
): Promise<ResolvedSession | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.raw.headers),
  });

  if (!session) {
    await reply
      .code(401)
      .send(buildApiError("UNAUTHORIZED", "Authentication required.", String(req.id)));
    return null;
  }

  const state = readAccountState(session.user);

  if (state.banned) {
    await reply
      .code(403)
      .send(
        buildApiError(
          "ACCOUNT_DISABLED",
          state.banReason ? `账号已被停用：${state.banReason}` : "账号已被停用，请联系管理员。",
          String(req.id),
        ),
      );
    return null;
  }

  const emailVerified = Boolean(session.user.emailVerified);

  if (options.requireVerified && !emailVerified) {
    await reply
      .code(403)
      .send(
        buildApiError(
          "EMAIL_NOT_VERIFIED",
          "请先完成邮箱验证后再使用该功能。",
          String(req.id),
        ),
      );
    return null;
  }

  if (options.requireRole && state.role !== options.requireRole) {
    await reply
      .code(403)
      .send(buildApiError("FORBIDDEN", "没有权限执行该操作。", String(req.id)));
    return null;
  }

  const resolved: ResolvedSession = {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      emailVerified,
      phoneNumber:
        typeof (session.user as { phoneNumber?: unknown }).phoneNumber === "string"
          ? ((session.user as { phoneNumber: string }).phoneNumber)
          : null,
      role: state.role,
    },
    session: {
      id: session.session.id,
      expiresAt: session.session.expiresAt,
    },
  };

  (req as AuthedRequest).authSession = resolved;
  return resolved;
}

/** Any signed-in, enabled account. */
export function createRequireSession(auth: Auth) {
  return async function requireSession(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await resolveSession(auth, req, reply);
  };
}

/** A signed-in, enabled account with a verified email address. */
export function createRequireVerifiedSession(auth: Auth) {
  return async function requireVerifiedSession(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await resolveSession(auth, req, reply, { requireVerified: true });
  };
}

/** A signed-in, enabled account holding the given role. */
export function createRequireRole(auth: Auth, role: UserRole) {
  return async function requireRole(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await resolveSession(auth, req, reply, { requireRole: role });
  };
}

/**
 * Reads the session set by one of the gates above. Throws if used on a route
 * that did not run a gate, which would be a programming error rather than
 * something a client can trigger.
 */
export function currentSession(req: FastifyRequest): ResolvedSession {
  const session = (req as AuthedRequest).authSession;
  if (!session) {
    throw new Error("currentSession() called on a route without a session gate");
  }
  return session;
}
