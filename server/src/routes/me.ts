// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `GET /api/me` — the authenticated principal.
 *
 * This is the endpoint the acceptance test uses to prove that the cookie
 * issued by Better Auth's sign-up/sign-in actually resolves to a session
 * through the Fastify bridge.
 */

import type { FastifyInstance } from "fastify";
import type { MeResponse } from "../../../shared/contracts/index.js";
import { ROUTES } from "../../../shared/contracts/index.js";
import type { Auth } from "../auth.js";
import { createRequireSession, currentSession } from "../plugins/session.js";

export async function registerMeRoutes(app: FastifyInstance, auth: Auth): Promise<void> {
  const requireSession = createRequireSession(auth);

  app.get(ROUTES.me, { preHandler: requireSession }, async (req): Promise<MeResponse> => {
    const { user, session } = currentSession(req);
    return {
      user,
      session: {
        id: session.id,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  });
}
