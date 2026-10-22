// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Logging configuration for Fastify (pino).
 *
 * Requirements:
 *  - request logs must never contain passwords, cookies, session tokens,
 *    authorization headers, verification/reset tokens, or database
 *    credentials;
 *  - the request *body* is never logged (Better Auth sign-in payloads carry
 *    passwords).
 *
 * Redaction is applied at the logger itself rather than relying on call sites.
 * Note the two mechanisms do different jobs and neither replaces the other:
 *
 *   - `redact` matches *object keys*. It cannot see a credential embedded in a
 *     string, and Fastify's default `req` serializer logs `req.url` verbatim —
 *     so `/api/auth/verify-email?token=…` and
 *     `/api/auth/reset-password/<token>` would land in the access log intact.
 *     That is why `sanitizeRequestUrl` exists.
 *   - `serializers.req` replaces Fastify's default request serializer
 *     (a user-supplied one wins), so it must reproduce the default fields
 *     itself. `asReqValue` in fastify/lib/logger-pino.js is the shape being
 *     mirrored; the unit test pins it so a Fastify upgrade that changes the
 *     default fails loudly instead of silently losing log fields.
 */

export interface LoggerOptions {
  level: string;
  redact: {
    paths: string[];
    censor: string;
  };
  serializers: {
    req: (req: SerializableRequest) => Record<string, unknown>;
  };
  /** Never enable body logging: auth payloads contain passwords. */
  disableRequestLogging?: boolean;
}

/** The subset of the Fastify request the serializer reads. */
export interface SerializableRequest {
  method: string;
  url: string;
  headers: Record<string, unknown>;
  host: string;
  ip: string;
  socket?: { remotePort?: number };
}

/** Better Auth endpoints, whose URLs routinely carry single-use credentials. */
const AUTH_PATH_PREFIX = "/api/auth/";

/**
 * Query parameters that carry credentials wherever they appear. Compared
 * case-insensitively; matched as whole parameter names.
 */
const CREDENTIAL_QUERY_PARAMS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "state",
  "password",
  "api_key",
  "apikey",
]);

/**
 * Token-shaped path segments. `/api/auth/reset-password/<token>` is the reset
 * link, so the segment is a credential.
 */
const CREDENTIAL_PATH_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^\/api\/auth\/reset-password\/[^/]+/i, "/api/auth/reset-password/[redacted]"],
  [/^\/api\/auth\/verify-email\/[^/]+/i, "/api/auth/verify-email/[redacted]"],
];

function redactQuery(query: string): string {
  if (query.length === 0) return "";
  const redacted = query
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      if (separator === -1) return pair;
      const name = pair.slice(0, separator);
      return CREDENTIAL_QUERY_PARAMS.has(name.toLowerCase())
        ? `${name}=[redacted]`
        : pair;
    })
    .join("&");
  return `?${redacted}`;
}

/**
 * Makes a request URL safe to log.
 *
 * For Better Auth paths the whole query string is dropped: those parameters
 * are credentials (tokens, callbacks carrying tokens) and none of them is
 * operationally useful in an access log. For every other path, credential-ish
 * parameters are redacted by name and the rest is preserved, so ordinary
 * debugging still works.
 */
export function sanitizeRequestUrl(url: string): string {
  const withoutFragment = url.split("#", 1)[0] ?? url;
  const queryIndex = withoutFragment.indexOf("?");
  const path = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutFragment.slice(queryIndex + 1);

  let maskedPath = path;
  for (const [pattern, replacement] of CREDENTIAL_PATH_PATTERNS) {
    if (pattern.test(maskedPath)) {
      maskedPath = replacement;
      break;
    }
  }

  if (maskedPath.startsWith(AUTH_PATH_PREFIX)) {
    return maskedPath;
  }

  return `${maskedPath}${redactQuery(query)}`;
}

/**
 * Paths are pino redaction paths, evaluated per log object.
 * `*.` wildcards cover nested connection objects.
 *
 * Deliberately absent:
 *  - `url` / `*.url`: a blanket redaction would censor the development mail
 *    link that the outbox logs on purpose, and would hide future legitimate
 *    URLs (article sources) permanently. Request URLs are handled by
 *    `sanitizeRequestUrl` instead, which is where the token actually appears.
 *  - `x-forwarded-for`: not a credential, and it is the value needed to reason
 *    about how the rate limiter keys its buckets behind the proxy.
 */
export const REDACT_PATHS: readonly string[] = [
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers['set-cookie']",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "headers.cookie",
  "headers.authorization",
  "headers['set-cookie']",
  "body.password",
  "body.newPassword",
  "body.currentPassword",
  "body.token",
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "secret",
  "databaseUrl",
  "DATABASE_URL",
  "connectionString",
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.token",
  "*.secret",
  "*.connectionString",
];

export const REDACTION_CENSOR = "[redacted]";

export function buildLoggerOptions(
  level: string,
  usePretty: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACTION_CENSOR,
    },
    serializers: {
      req(req: SerializableRequest): Record<string, unknown> {
        return {
          method: req.method,
          url: sanitizeRequestUrl(req.url),
          version: req.headers["accept-version"],
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  };

  if (usePretty) {
    base["transport"] = {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
    };
  }

  return base;
}
