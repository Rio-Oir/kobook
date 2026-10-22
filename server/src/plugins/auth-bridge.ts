// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fastify <-> Better Auth bridge.
 *
 * Better Auth ships a Web-standard handler (`auth.handler(Request)`), plus a
 * Node adapter (`toNodeHandler`) that expects to own the raw request stream.
 * Handing the socket over to `toNodeHandler` inside Fastify fights with
 * Fastify's own lifecycle, so instead this plugin:
 *
 *   1. registers a content-type parser that captures the *exact* request
 *      bytes AND still lets Fastify parse the JSON body for normal routes;
 *   2. rebuilds an equivalent `Request` from the Fastify request;
 *   3. calls `auth.handler()` and copies the response back verbatim —
 *      including every `Set-Cookie` header, of which sign-in emits more than
 *      one.
 *
 * Requirement checks that this file exists to satisfy:
 *   - "注册获取 Cookie 会话并验证请求体桥接": the echo route proves a
 *     session-authenticated JSON body survives the same pipeline;
 *   - "必须保留所有 set-cookie": `getSetCookie()` is used, not
 *     `headers.get("set-cookie")`, which would fold multiple cookies into one
 *     comma-joined string and corrupt them.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth } from "../auth.js";
import { CLIENT_REF_HEADER } from "../lib/phone/plugin.js";
import { ROUTES } from "../../../shared/contracts/index.js";

/** Request decoration holding the raw body bytes for the auth bridge. */
export interface RawBodyCarrier {
  rawBody?: string;
}

/** Methods Better Auth may need to answer. */
const AUTH_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export function getRawBody(req: FastifyRequest): string | undefined {
  return (req as FastifyRequest & RawBodyCarrier).rawBody;
}

async function forwardToAuth(
  auth: Auth,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const origin = `${req.protocol}://${req.headers.host ?? "127.0.0.1"}`;
  const url = new URL(req.raw.url ?? req.url, origin);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    // Rebuilt from the body we pass; forwarding them would produce a
    // mismatch that undici rejects.
    if (lower === "content-length" || lower === "transfer-encoding") continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }

  const method = (req.raw.method ?? "GET").toUpperCase();
  const rawBody = getRawBody(req);
  const body = method === "GET" || method === "HEAD" ? undefined : rawBody;

  // Server-derived client identity for the phone verification budgets.
  //
  // The kit requires a reference the caller cannot choose, and an endpoint
  // mounted on the auth instance has no other access to the socket. `req.ip`
  // is the Fastify-resolved peer address (proxy headers are only honoured when
  // `trustLoopbackProxy` is set), and the header is overwritten here, so a
  // request that tries to name its own bucket has the value discarded.
  headers.set(CLIENT_REF_HEADER, `client-${req.ip}`);

  const authResponse = await auth.handler(
    new Request(url, { method, headers, body, redirect: "manual" }),
  );

  reply.code(authResponse.status);

  // Cache anywhere that holds a single-use token must be re-pulled from the
  // server on every navigation, and the redirect that drops the user into the
  // SPA after verification must not carry the token to subsequent pages.
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");

  for (const [key, value] of authResponse.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    reply.header(key, value);
  }

  // Multiple cookies must stay separate headers.
  const setCookies = authResponse.headers.getSetCookie();
  if (setCookies.length > 0) {
    reply.header("set-cookie", setCookies);
  }

  if (authResponse.status === 204 || authResponse.status === 304) {
    await reply.send();
    return;
  }

  const text = await authResponse.text();
  await reply.send(text);
}

export async function registerAuthBridge(app: FastifyInstance, auth: Auth): Promise<void> {
  app.addContentTypeParser(
    ["application/json", "application/*+json"],
    { parseAs: "string" },
    (req, body, done) => {
      const raw = typeof body === "string" ? body : String(body);
      (req as FastifyRequest & RawBodyCarrier).rawBody = raw;
      if (raw.trim().length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.route({
    method: [...AUTH_METHODS],
    url: ROUTES.authMount,
    handler: (req, reply) => forwardToAuth(auth, req, reply),
  });
}
