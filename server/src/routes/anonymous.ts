// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Anonymous content extraction.
 *
 * Reading behaves identically whether or not someone is signed in; an account
 * only adds hosted saving and sync. So this route runs the same
 * `parseContent` layer, the same `importFromUrl` resolver and the same
 * `ParsedDocument` response as any other import, and is unauthenticated. It
 * is deliberately different in four ways:
 *
 *   - **It writes nothing.** No article, no document version, no paragraph
 *     and no user row. An anonymous reader who imports twenty articles leaves
 *     no rows at all, so there is no "ghost account" to clean up.
 *   - **It is metered.** The `config.rateLimit` declaration is enforced
 *     by `lib/rate-limit-store.ts` (both a fixed window and an in-flight
 *     ceiling), because this is the one unauthenticated route that can make
 *     the server open sockets.
 *   - **It never lets the client choose the proxy.** There is no outbound
 *     proxy to choose, and the body schema's `additionalProperties: false`
 *     means a request that tries to add one is a 400 rather than a silent
 *     override.
 *   - **It has its own hard deadline** on top of the resolver's own
 *     timeouts, so a request that somehow stalls in a layer the resolver
 *     does not cover still ends.
 *
 * The controlled backend is *direct HTTP + Readability only*: this route calls
 * no third-party reader service, and no environment value can change that. The
 * browser is still the one that tries its direct channel first
 * (`browser-jina`), and only a browser-side failure reaches this endpoint.
 *
 * No email-verification gate: there is no email to verify, and reading does
 * not require an account.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ROUTES,
  type AnonymousExtractRequest,
  type AnonymousExtractResponse,
  type ApiErrorCode,
  type ArticleImportKind,
} from "../../../shared/contracts/index.js";
import { parseContent, type ParseKind } from "../lib/parse/index.js";
import { importFromUrl } from "../lib/url-import.js";
import { SsrfBlockedError, SsrfTimeoutError } from "../lib/ssrf-guard.js";
import {
  getRateLimitRelease,
  type RateLimitedRouteDeclaration,
} from "../lib/rate-limit-store.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;

/**
 * Whole-request deadline. Deliberately shorter than the sum of the
 * resolver's own per-hop budgets, so a pathological chain of slow hops
 * cannot keep the connection open for minutes.
 */
const ANONYMOUS_REQUEST_BUDGET_MS = 20_000;

/**
 * The bucket the limiter uses. Named rather than derived from the route
 * pattern so renaming the path cannot silently reset the counters.
 */
export const ANONYMOUS_RATE_LIMIT_KEY = "anonymous-extract";

/**
 * The routes this module declares a limit on. Exported so the service can
 * assert at boot that the limiter is actually wired to them — the whole point
 * being that a declaration nobody enforces is worse than no declaration,
 * because it reads as protection in review.
 */
export const ANONYMOUS_RATE_LIMITED_ROUTES: RateLimitedRouteDeclaration[] = [
  { method: "POST", url: ROUTES.anonymousExtract },
];

/**
 * Send a shared-contract error from inside a handler.
 *
 * Declared explicitly rather than thrown because a thrown 5xx is
 * deliberately stripped of its message by the app-wide error handler
 * (so SQL and stack text never reach a client), and the messages here
 * are the ones a user has to act on — "the URL resolved to a private
 * address" is not interchangeable with "the server could not complete
 * the request".
 */
function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send({
    error: { code, message, requestId: String(req.id) },
  });
}

export function registerAnonymousRoutes(app: FastifyInstance): void {
  app.post<{ Body: AnonymousExtractRequest }>(
    ROUTES.anonymousExtract,
    {
      config: {
        // Only the bucket name is declared here. The limits themselves
        // come from the limiter's configuration (`ANON_RATE_LIMIT_MAX`,
        // `ANON_RATE_LIMIT_WINDOW`, `ANON_RATE_LIMIT_MAX_CONCURRENT`,
        // `ANON_RATE_LIMIT_GLOBAL_CONCURRENT`), because hardcoding them
        // at the route would make those variables silently ineffective —
        // an operator raising the ceiling would see no change and no
        // error explaining why.
        rateLimit: { key: ANONYMOUS_RATE_LIMIT_KEY },
      },
      schema: {
        body: {
          type: "object",
          required: ["kind", "content"],
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["text", "html", "url"] },
            content: { type: "string", minLength: 1, maxLength: MAX_INPUT_BYTES },
            title: { type: "string", maxLength: 512 },
          },
        },
      },
    },
    async (req, reply): Promise<AnonymousExtractResponse | FastifyReply> => {
      // The slot acquired by the limiter is held until this handler's
      // work is actually over, not until the socket closes. Releasing on
      // the socket would let a client free its own slot by disconnecting
      // while the upstream fetch was still running, so a reconnect loop
      // could keep more work in flight than the ceiling allows.
      const releaseSlot = getRateLimitRelease(req);
      const controller = new AbortController();
      const budget = setTimeout(() => controller.abort(), ANONYMOUS_REQUEST_BUDGET_MS);
      // Abort the upstream work when the caller goes away. Without this
      // the fetch would continue to completion for a response nobody is
      // waiting for, holding a socket and a slot for its full duration.
      //
      // **Which event means "gone" is the whole subtlety here.** The
      // obvious-looking `req.raw.once("close", …)` is wrong: with the
      // Node version this project pins, the *request* stream emits
      // `'close'` as soon as the request message is fully received —
      // i.e. right after body parsing and long before the client has
      // given up. Wiring the abort there made every anonymous URL
      // import cancel its own upstream fetch, so the route could only
      // ever return a failure even when the source was perfectly
      // reachable.
      //
      // The response object is the one whose `'close'` marks the end of
      // the exchange, so the rule is: abort only if it closed while the
      // response had not finished being written. That distinguishes a
      // caller who disconnected from a caller who received the reply.
      const onClientGone = (): void => controller.abort();
      const onResponseClosed = (): void => {
        if (!reply.raw.writableFinished) onClientGone();
      };
      // `'aborted'` on the request is the explicit "the peer aborted"
      // signal and is kept alongside it.
      req.raw.on("aborted", onClientGone);
      reply.raw.on("close", onResponseClosed);
      try {
        if (req.body.kind === "url") {
          const result = await importFromUrl(req.body.content, {
            // No outbound-service configuration is read or forwarded: a
            // deployment value must not be able to open an egress this route
            // is not meant to have. The body schema declares
            // `additionalProperties: false` and the app disables AJV's
            // `removeAdditional`, so a client that *tries* to name a proxy
            // gets a 400 rather than a silent strip.
            signal: controller.signal,
          });
          return {
            document: result.document,
            extractor: result.extractor,
            ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
          };
        }
        const kind: ParseKind = req.body.kind === "text" ? "markdown" : "html";
        const parsed = parseContent(kind, req.body.content, { title: req.body.title });
        if (!parsed.ok) {
          return fail(req, reply, 422, parsed.code as ApiErrorCode, parsed.message);
        }
        if (
          parsed.document.blocks.length === 0 ||
          !parsed.document.blocks.some((b) => b.type !== "heading")
        ) {
          return fail(req, reply, 422, "EMPTY_ARTICLE", "未能提取任何正文段落。");
        }
        return { document: parsed.document, extractor: "local" };
      } catch (err: unknown) {
        if (err instanceof SsrfBlockedError) {
          // "We refused this URL" — the message is the guard's own
          // user-readable Chinese text.
          return fail(req, reply, 422, "VALIDATION_FAILED", err.message);
        }
        if (err instanceof SsrfTimeoutError) {
          return fail(req, reply, 504, "UPSTREAM_FAILED", err.message);
        }
        if (err instanceof Error && err.name === "AbortError") {
          return fail(req, reply, 504, "UPSTREAM_FAILED", "匿名抓取超时。");
        }
        // Anything else is reported generically. This route is
        // *unauthenticated*, so an upstream's own error text is not
        // something to hand back verbatim: it can carry a resolved IP, a
        // port, a hostname, or a driver message. The detail goes to the
        // log against the same request id the caller is given, which is
        // enough to correlate a report without disclosing topology.
        req.log.warn(
          { requestId: String(req.id), err: err instanceof Error ? err.message : String(err) },
          "anonymous extraction failed",
        );
        return fail(req, reply, 502, "UPSTREAM_FAILED", "抓取失败，请稍后重试。");
      } finally {
        clearTimeout(budget);
        req.raw.off("aborted", onClientGone);
        reply.raw.off("close", onResponseClosed);
        releaseSlot?.();
      }
    },
  );
}

export type { ArticleImportKind };
