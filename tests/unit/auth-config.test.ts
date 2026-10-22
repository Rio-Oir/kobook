// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the configuration helpers the phase-2 backend relies on.
 *
 *   - `loadAuthRateLimitConfig` parses env strictly: a typo must fail
 *     startup rather than silently disable the limiter.
 *   - `toBetterAuthRateLimit` produces the exact `customRules` key set
 *     the rate-limiter matches, in basePath-stripped form.
 *   - `parseAdminEmails` throws on malformed input rather than ignoring.
 *   - `loadMailSettings` defaults development/test to the in-memory outbox
 *     and refuses production without a real SMTP configuration, so a deploy
 *     that forgot the provider fails at boot rather than silently dropping
 *     every verification and reset email.
 *   - `reconcileOwner` is the pure decision function behind the cache
 *     isolation gate; it has to keep anonymous-owned data on first
 *     sign-up and clear it on a switch.
 *   - `readAccountState` recognises an expired ban as "not banned",
 *     matching the session-create hook's lazy-clear behaviour.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadAuthRateLimitConfig,
  toBetterAuthRateLimit,
  RATE_LIMIT_RULES,
} from "../../server/src/lib/rate-limit.js";
import { parseAdminEmails } from "../../server/src/lib/admin-bootstrap.js";
import { loadMailSettings } from "../../server/src/lib/mail/config.js";
import {
  ANONYMOUS_OWNER,
  reconcileOwner,
} from "../../shared/contracts/identity.js";
import { readAccountState } from "../../server/src/plugins/session.js";

test("loadAuthRateLimitConfig defaults match the library's hardcoded rules", () => {
  const cfg = loadAuthRateLimitConfig("production", {});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.window, 10);
  assert.equal(cfg.max, 100);
  assert.equal(cfg.loginWindow, 10);
  assert.equal(cfg.loginMax, 3);
  assert.equal(cfg.mailWindow, 60);
  assert.equal(cfg.mailMax, 3);
});

test("loadAuthRateLimitConfig enables the limiter by default in production only", () => {
  assert.equal(loadAuthRateLimitConfig("development", {}).enabled, false);
  assert.equal(loadAuthRateLimitConfig("test", {}).enabled, false);
  assert.equal(loadAuthRateLimitConfig("production", {}).enabled, true);
});

test("loadAuthRateLimitConfig throws on malformed values", () => {
  assert.throws(() => loadAuthRateLimitConfig("development", { AUTH_RATE_LIMIT_WINDOW: "abc" }));
  assert.throws(() => loadAuthRateLimitConfig("development", { AUTH_RATE_LIMIT_MAX: "-1" }));
  assert.throws(() =>
    loadAuthRateLimitConfig("development", { AUTH_RATE_LIMIT_ENABLED: "maybe" }),
  );
});

test("toBetterAuthRateLimit exposes the four gate paths in basePath-stripped form", () => {
  const cfg = loadAuthRateLimitConfig("production", {
    AUTH_RATE_LIMIT_LOGIN_WINDOW: "5",
    AUTH_RATE_LIMIT_LOGIN_MAX: "2",
  });
  const rateLimit = toBetterAuthRateLimit(cfg);
  assert.equal(rateLimit.enabled, true);
  assert.equal(rateLimit.storage, "memory");
  const keys = Object.keys(rateLimit.customRules ?? {}).sort();
  assert.deepEqual(keys, [...RATE_LIMIT_RULES.login, ...RATE_LIMIT_RULES.mail].sort());
  for (const path of RATE_LIMIT_RULES.login) {
    const rule = (rateLimit.customRules as Record<string, { window: number; max: number }>)[path];
    assert.deepEqual(rule, { window: 5, max: 2 });
  }
});

test("parseAdminEmails trims, lowercases, dedupes and throws on malformed", () => {
  assert.deepEqual(parseAdminEmails("a@b.c, B@d.c, A@B.C"), ["a@b.c", "b@d.c"]);
  assert.deepEqual(parseAdminEmails(""), []);
  assert.deepEqual(parseAdminEmails(undefined), []);
  assert.throws(() => parseAdminEmails("nope"));
  assert.throws(() => parseAdminEmails("a@b,c@d.com"));
});

test("loadMailSettings: dev defaults to outbox, production requires SMTP", () => {
  assert.equal(loadMailSettings("development", {}).mode, "outbox");
  assert.equal(loadMailSettings("test", {}).mode, "outbox");
  assert.throws(() => loadMailSettings("production", {}), /SMTP_HOST/);
  assert.throws(
    () => loadMailSettings("production", { MAIL_TRANSPORT: "outbox" }),
    /outbox/i,
  );
});

test("reconcileOwner keeps the same account, adopts anonymous, and clears a switch", () => {
  assert.equal(reconcileOwner("user-1", "user-1"), "keep");
  assert.equal(reconcileOwner(ANONYMOUS_OWNER, "user-2"), "adopt");
  assert.equal(reconcileOwner("", "user-2"), "adopt");
  assert.equal(reconcileOwner("user-1", "user-2"), "clear");
});

test("readAccountState normalises role and recognises an expired ban", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  assert.deepEqual(readAccountState({}), { role: "user", banned: false, banReason: null });
  assert.deepEqual(
    readAccountState({ role: "admin", banned: false }),
    { role: "admin", banned: false, banReason: null },
  );
  assert.deepEqual(
    readAccountState({ role: "superuser" }),
    { role: "user", banned: false, banReason: null },
  );
  assert.deepEqual(
    readAccountState({ banned: true }),
    { role: "user", banned: true, banReason: null },
  );
  // Expired ban is treated as not banned.
  assert.deepEqual(
    readAccountState({ banned: true, banExpires: past }),
    { role: "user", banned: false, banReason: null },
  );
  // Active ban with reason.
  assert.deepEqual(
    readAccountState({ banned: true, banExpires: future, banReason: "spam" }),
    { role: "user", banned: true, banReason: "spam" },
  );
});
