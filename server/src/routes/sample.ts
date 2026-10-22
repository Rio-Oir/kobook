// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sample routes for the phase 1 acceptance evidence.
 *
 * `/api/sample/echo`  — proves that the session check and JSON body parsing
 *                       coexist: the session comes from the cookie, the
 *                       payload comes from the body, and neither is taken
 *                       from the other.
 * `/api/sample/parse` — fixture-only content extraction through the unified
 *                       block contract.
 *
 * There is deliberately no endpoint that accepts an arbitrary URL. Outbound
 * fetching is not implemented in phase 1: until DNS/redirect egress controls
 * exist, an arbitrary-URL endpoint would be an SSRF hole, so the parse route
 * only accepts text the caller already holds.
 */

import type { FastifyInstance } from "fastify";
import type {
  EchoResponse,
  ParseRequest,
  ParseResponse,
} from "../../../shared/contracts/index.js";
import {
  ROUTES,
  buildApiError,
  httpStatusForCode,
  type ApiErrorCode,
} from "../../../shared/contracts/index.js";
import type { Auth } from "../auth.js";
import { createRequireSession, currentSession } from "../plugins/session.js";
import { getRawBody } from "../plugins/auth-bridge.js";
import { parseContent } from "../lib/parse/index.js";

/** Reject oversized bodies before they are parsed into memory. */
export const MAX_PARSE_INPUT_BYTES = 2 * 1024 * 1024;

const echoSchema = {
  body: {
    type: "object",
    required: ["payload", "marker"],
    additionalProperties: false,
    properties: {
      payload: {},
      marker: { type: "string", minLength: 1, maxLength: 256 },
    },
  },
} as const;

const parseSchema = {
  body: {
    type: "object",
    required: ["kind", "content"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["html", "markdown"] },
      content: { type: "string", minLength: 1, maxLength: MAX_PARSE_INPUT_BYTES },
      title: { type: "string", maxLength: 512 },
    },
  },
} as const;

export async function registerSampleRoutes(app: FastifyInstance, auth: Auth): Promise<void> {
  const requireSession = createRequireSession(auth);

  app.post(
    ROUTES.sampleEcho,
    { preHandler: requireSession, schema: echoSchema },
    async (req): Promise<EchoResponse> => {
      const { user } = currentSession(req);
      const body = req.body as { payload: unknown; marker: string };
      const raw = getRawBody(req) ?? "";
      return {
        marker: body.marker,
        payload: body.payload,
        receivedBytes: Buffer.byteLength(raw, "utf8"),
        // Identity comes from the session, never from the body.
        actorUserId: user.id,
      };
    },
  );

  app.post(
    ROUTES.sampleParse,
    { preHandler: requireSession, schema: parseSchema },
    async (req, reply) => {
      const body = req.body as ParseRequest;
      const result = parseContent(body.kind, body.content, {
        ...(body.title !== undefined ? { title: body.title } : {}),
      });

      if (!result.ok) {
        const code: ApiErrorCode =
          result.code === "EMPTY_CONTENT"
            ? "EMPTY_CONTENT"
            : result.code === "UNSUPPORTED_INPUT"
              ? "UNSUPPORTED_INPUT"
              : "VALIDATION_FAILED";
        reply.code(httpStatusForCode(code));
        return buildApiError(code, result.message, String(req.id));
      }

      const response: ParseResponse = { document: result.document };
      return response;
    },
  );
}
