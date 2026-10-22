// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Provisional AI entry point.
 *
 * Phase 2's "验证邮箱后才能使用 AI 入口" gate has to be observable on the
 * server even though the AI itself is not on the server yet. This route is
 * the smallest thing that exercises the verified-session gate end to end.
 *
 * Phase 4 replaces it with real generation endpoints (`/api/generations`)
 * that carry the same `createRequireVerifiedSession` pre-handler. The route
 * file is short on purpose: there is nothing here that should survive into
 * phase 4, and a future reader is supposed to delete the whole file rather
 * than ship a no-op endpoint forever.
 */

import type { FastifyInstance } from "fastify";
import {
  ROUTES,
  type AiEntryResponse,
} from "../../../shared/contracts/index.js";
import type { Auth } from "../auth.js";
import {
  createRequireVerifiedSession,
  currentSession,
} from "../plugins/session.js";

export function registerAiRoutes(app: FastifyInstance, auth: Auth): void {
  const requireVerified = createRequireVerifiedSession(auth);

  app.post(
    ROUTES.aiEntry,
    { preHandler: requireVerified },
    async (req): Promise<AiEntryResponse> => {
      return { allowed: true, actorUserId: currentSession(req).user.id, phase: 2 };
    },
  );
}
