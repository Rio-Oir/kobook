// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the six-digit sign-in code: message composition and the
 * development outbox's logging rules.
 *
 * The full round trip (send endpoint -> outbox -> sign-in endpoint) is covered
 * by phase2 G11 against a real server and database. What is pinned here is the
 * part that is easy to regress silently:
 *
 *   - the code reaches the message body and nothing else (no link, no token);
 *   - the subject is the code mail, not the verification mail;
 *   - the outbox logs the code in development (that is what makes `npm run dev`
 *     usable) and does not log it under `test`, which is the environment the
 *     acceptance run asserts against.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMailer } from "../../server/src/lib/mail/mailer.js";
import { OutboxTransport } from "../../server/src/lib/mail/outbox.js";

const CONFIG = {
  verificationExpiresInSeconds: 3600,
  resetExpiresInSeconds: 1800,
  signInOtpExpiresInSeconds: 600,
};

test("mailer composes a link-free sign-in code message", async () => {
  const outbox = new OutboxTransport(false);
  const mailer = createMailer({ transport: outbox, ...CONFIG });

  await mailer.sendSignInOtp({ user: { email: "reader@example.test" }, otp: "426913" });

  const entry = outbox.latestFor("reader@example.test", "sign-in-otp");
  assert.ok(entry, "code mail was not queued");
  assert.equal(entry.purpose, "sign-in-otp");
  assert.equal(entry.code, "426913");
  assert.equal(entry.url, undefined, "a code mail must not carry a link");
  assert.match(entry.subject, /登录验证码/);
  assert.ok(entry.text.includes("426913"), "the code is in the body");
  assert.ok(entry.text.includes("10 分钟"), "the expiry matches the plugin setting");
  assert.ok(entry.text.includes("5 次"), "the attempt budget is stated");
  assert.ok(!/https?:\/\//.test(entry.text), "no URL in the code mail");
});

test("mailer keeps the link mails untouched", async () => {
  const outbox = new OutboxTransport(false);
  const mailer = createMailer({ transport: outbox, ...CONFIG });

  await mailer.sendVerificationEmail({
    user: { email: "reader@example.test" },
    url: "https://example.test/verify?token=abc",
  });
  await mailer.sendResetPassword({
    user: { email: "reader@example.test" },
    url: "https://example.test/reset/token",
  });

  const verify = outbox.latestFor("reader@example.test", "verify-email");
  const reset = outbox.latestFor("reader@example.test", "reset-password");
  assert.ok(verify);
  assert.ok(reset);
  assert.ok(verify.url?.includes("token=abc"));
  assert.equal(verify.code, undefined);
  assert.match(verify.subject, /验证你的邮箱 · KoBook/);
  assert.ok(reset.url?.includes("/reset/"));
  assert.match(reset.subject, /重置密码 · KoBook/);
});

test("outbox logs the code in development and never in test", async () => {
  const devLogs: Array<Record<string, unknown>> = [];
  const dev = new OutboxTransport(true);
  dev.attachLogger({ info: (obj) => devLogs.push(obj), error: () => undefined });
  await dev.send({
    to: "reader@example.test",
    subject: "登录验证码",
    text: "426913",
    code: "426913",
    purpose: "sign-in-otp",
  });

  const devEntry = dev.latestFor("reader@example.test");
  assert.ok(devEntry);
  assert.equal(devLogs[0]?.["code"], "426913", "development logs the code");

  const testLogs: Array<Record<string, unknown>> = [];
  const forTests = new OutboxTransport(false);
  forTests.attachLogger({ info: (obj) => testLogs.push(obj), error: () => undefined });
  await forTests.send({
    to: "reader@example.test",
    subject: "登录验证码",
    text: "426913",
    code: "426913",
    purpose: "sign-in-otp",
  });

  assert.equal(testLogs[0]?.["code"], undefined, "the test environment must not log the code");
  assert.ok(
    !JSON.stringify(testLogs).includes("426913"),
    "the code must not appear anywhere in the test log",
  );
});
