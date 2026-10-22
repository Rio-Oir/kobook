// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The log gate ("密码与会话凭据不进入日志") has two parts:
 *
 *   1. Pino's `redact` is configured to strip every key that holds a
 *      credential. This test pins the redact path set so an accidental
 *      rename or removal surfaces immediately.
 *   2. `sanitizeRequestUrl` is the layer that handles a credential
 *      embedded in a string, which redact cannot see. Without it,
 *      Fastify's default `req.url` serializer would land single-use
 *      tokens in the access log.
 *
 * Together, the two tests assert the gate is passable, which is what
 * `tests/phase2.ts` will then verify at the integration level.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REDACT_PATHS,
  REDACTION_CENSOR,
  buildLoggerOptions,
  sanitizeRequestUrl,
  type SerializableRequest,
} from "../../server/src/lib/logger.js";

test("redact path set contains every credential key the gate names", () => {
  // The phase-2 gate forbids these. Adding a new credential field
  // anywhere is a contract change, and this assertion is the early warning.
  const required = [
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
  ];
  for (const path of required) {
    assert.ok(
      REDACT_PATHS.includes(path),
      `REDACT_PATHS must include ${JSON.stringify(path)}`,
    );
  }

  // The auth bridge copies set-cookie across; ensure the keys that
  // commonly hold it are redacted.
  for (const path of [
    "req.headers.cookie",
    "req.headers.authorization",
    "req.headers['set-cookie']",
    "res.headers['set-cookie']",
  ]) {
    assert.ok(REDACT_PATHS.includes(path), `REDACT_PATHS must include ${JSON.stringify(path)}`);
  }
});

test("sanitizeRequestUrl drops query strings for /api/auth/*", () => {
  // Verification GET and reset GET both carry single-use tokens; the
  // entire query string is dropped because nothing operationally useful
  // sits there, and a value-independent rule means we do not depend on
  // knowing every parameter name.
  assert.equal(
    sanitizeRequestUrl("/api/auth/verify-email?token=SECRET&callbackURL=/#/verify-email"),
    "/api/auth/verify-email",
  );
  assert.equal(
    sanitizeRequestUrl(
      "/api/auth/sign-in/email?email=a@b.c&password=SECRET&callbackURL=/",
    ),
    "/api/auth/sign-in/email",
  );
});

test("sanitizeRequestUrl masks the reset-password token in the path", () => {
  assert.equal(
    sanitizeRequestUrl(
      "/api/auth/reset-password/TOKEN_VALUE?callbackURL=/#/reset-password",
    ),
    "/api/auth/reset-password/[redacted]",
  );
  // The query is dropped wholesale for /api/auth/* paths.
  assert.equal(
    sanitizeRequestUrl("/api/auth/reset-password/TOKEN?callbackURL=/"),
    "/api/auth/reset-password/[redacted]",
  );
});

test("sanitizeRequestUrl preserves non-auth paths but redacts credential parameters", () => {
  // Future /api/articles/import will carry the source URL; that is fine.
  // But if a non-auth path ever acquires a token, the credential-shaped
  // parameter name is still censored.
  assert.equal(
    sanitizeRequestUrl("/api/articles/import?url=https%3A%2F%2Fexample.com%2Fpost"),
    "/api/articles/import?url=https%3A%2F%2Fexample.com%2Fpost",
  );
  assert.equal(
    sanitizeRequestUrl(
      "/api/articles/import?url=https%3A%2F%2Fexample.com%2Fpost&token=ABC",
    ),
    "/api/articles/import?url=https%3A%2F%2Fexample.com%2Fpost&token=[redacted]",
  );
  // Case-insensitive match for the parameter name.
  assert.equal(
    sanitizeRequestUrl("/api/anything?Token=ABC&keep=1"),
    "/api/anything?Token=[redacted]&keep=1",
  );
});

test("the custom request serializer scrubs the verification/reset URL before logging", () => {
  const opts = buildLoggerOptions("info", false) as {
    serializers: { req: (req: SerializableRequest) => Record<string, unknown> };
  };
  const sample = {
    method: "GET",
    url: "/api/auth/verify-email?token=SECRET",
    headers: { cookie: "session_token=XYZ", host: "127.0.0.1:8080" },
    host: "127.0.0.1:8080",
    ip: "127.0.0.1",
    socket: { remotePort: 4242 },
  };
  const serialized = opts.serializers.req(sample);
  assert.equal(serialized["url"], "/api/auth/verify-email");
  // The default Fastify shape is reproduced (so nothing is silently lost).
  assert.equal(serialized["method"], "GET");
  assert.equal(serialized["host"], "127.0.0.1:8080");
  assert.equal(serialized["remoteAddress"], "127.0.0.1");
  assert.equal(serialized["remotePort"], 4242);
});

test("sanitizeRequestUrl tolerates URLs without a query", () => {
  assert.equal(sanitizeRequestUrl("/api/health/live"), "/api/health/live");
  assert.equal(sanitizeRequestUrl("/"), "/");
});
