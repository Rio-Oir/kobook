// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the SMTP mail path and its configuration.
 *
 * The transport is exercised against a real (if minimal) SMTP server on
 * loopback: `net.createServer` speaking enough of RFC 5321 to greet, advertise
 * AUTH LOGIN, accept MAIL/RCPT, collect DATA and answer QUIT. That is the only
 * way to assert the things that matter without a provider account —
 *
 *   - credentials are actually sent through AUTH LOGIN;
 *   - the composed message carries the recipient, the RFC 2047-encoded Chinese
 *     subject and the verification link;
 *   - a rejected recipient or a bad password makes `send` reject instead of
 *     pretending delivery succeeded;
 *   - the error path logs the provider response but never the password.
 *
 * The plaintext mode is used here because a TLS listener would need a
 * certificate; certificate validation itself is nodemailer's (and Node TLS's)
 * job, and `config.ts` refuses plaintext in production.
 *
 * The configuration tests are the other half: a typo must fail startup, and
 * production must refuse both the in-memory outbox and the two unsafe SMTP
 * shortcuts (cleartext transport, unauthenticated relay).
 */

import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { loadMailSettings } from "../../server/src/lib/mail/config.js";
import { OutboxTransport } from "../../server/src/lib/mail/outbox.js";
import { resolveMail } from "../../server/src/lib/mail/resolve.js";
import {
  createSmtpTransport,
  type SmtpConfig,
  SmtpTransport,
} from "../../server/src/lib/mail/smtp.js";
import type { OutboundMail } from "../../server/src/lib/mail/transport.js";

/** The two account messages are the only traffic this server ever sees. */
const VERIFY_MAIL: OutboundMail = {
  to: "reader@example.test",
  subject: "验证你的邮箱 · KoBook",
  text:
    "reader，你好：\n\n请打开下面的链接完成邮箱验证：\n\n" +
    "https://ex.test/v/abc123\n\n链接 1 小时内有效，且只能使用一次。",
  url: "https://ex.test/v/abc123",
  purpose: "verify-email",
};

interface FakeSmtpOptions {
  /** When set, AUTH LOGIN is advertised and these values are required. */
  auth?: { user: string; pass: string };
  /** Reject RCPT TO, like a provider refusing an unverified recipient. */
  rejectRecipient?: boolean;
}

interface FakeSmtpServer {
  port: number;
  /** Raw DATA payloads, in delivery order. */
  messages: string[];
  /** Credentials seen through AUTH LOGIN, in attempt order. */
  authAttempts: Array<{ user: string; pass: string }>;
  close(): Promise<void>;
}

async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const messages: string[] = [];
  const authAttempts: Array<{ user: string; pass: string }> = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");

    let buffer = "";
    let inData = false;
    let data = "";
    let authStage: "idle" | "user" | "pass" = "idle";
    let pendingUser = "";

    socket.write("220 fake.smtp ESMTP ready\r\n");

    const reply = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buffer.slice(0, end);
          buffer = buffer.slice(end + "\r\n.\r\n".length);
          inData = false;
          messages.push(data);
          reply("250 2.0.0 queued as FAKE123");
          continue;
        }

        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          const capabilities = ["250-fake.smtp"];
          if (options.auth) capabilities.push("250-AUTH LOGIN");
          capabilities.push("250 8BITMIME");
          socket.write(`${capabilities.join("\r\n")}\r\n`);
        } else if (upper.startsWith("AUTH LOGIN")) {
          authStage = "user";
          reply("334 VXNlcm5hbWU6");
        } else if (authStage === "user") {
          pendingUser = Buffer.from(line, "base64").toString("utf8");
          authStage = "pass";
          reply("334 UGFzc3dvcmQ6");
        } else if (authStage === "pass") {
          const pass = Buffer.from(line, "base64").toString("utf8");
          authAttempts.push({ user: pendingUser, pass });
          authStage = "idle";
          if (
            options.auth &&
            (pendingUser !== options.auth.user || pass !== options.auth.pass)
          ) {
            reply("535 5.7.8 authentication failed");
          } else {
            reply("235 2.7.0 authenticated");
          }
        } else if (upper.startsWith("MAIL FROM")) {
          reply("250 2.1.0 ok");
        } else if (upper.startsWith("RCPT TO")) {
          reply(
            options.rejectRecipient
              ? "550 5.1.1 mailbox unavailable"
              : "250 2.1.5 ok",
          );
        } else if (upper === "DATA") {
          inData = true;
          data = "";
          reply("354 end with <CRLF>.<CRLF>");
        } else if (upper === "QUIT") {
          reply("221 2.0.0 bye");
          socket.end();
        } else {
          reply("250 2.0.0 ok");
        }
      }
    });

    socket.on("error", () => {
      // The test closes sockets during teardown; ECONNRESET is expected.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "fake SMTP did not bind");

  return {
    port: address.port,
    messages,
    authAttempts,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

function configFor(server: FakeSmtpServer, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: "127.0.0.1",
    port: server.port,
    security: "none",
    user: "smtp-user",
    pass: "smtp-pass",
    from: "no-reply@example.test",
    fromName: "KoBook",
    timeoutMs: 5_000,
    ...overrides,
  };
}

// ── Configuration ────────────────────────────────────────────────────────

test("mail settings: development/test default to the outbox", () => {
  for (const nodeEnv of ["development", "test"] as const) {
    const settings = loadMailSettings(nodeEnv, {});
    assert.equal(settings.mode, "outbox");
    assert.equal(settings.smtp, null);
  }
});

test("mail settings: production defaults to SMTP and refuses to boot unconfigured", () => {
  assert.throws(() => loadMailSettings("production", {}), /SMTP_HOST/);
  assert.throws(
    () => loadMailSettings("production", { MAIL_TRANSPORT: "outbox" }),
    /outbox/i,
  );
  assert.throws(
    () => loadMailSettings("production", { MAIL_TRANSPORT: "carrier-pigeon" }),
    /MAIL_TRANSPORT/,
  );
});

test("mail settings: parses an Alibaba Cloud DirectMail configuration", () => {
  const settings = loadMailSettings("production", {
    MAIL_TRANSPORT: "smtp",
    SMTP_HOST: " smtpdm.aliyun.com ",
    SMTP_USER: "no-reply@mail.example.test",
    SMTP_PASS: "  a password with spaces  ",
    SMTP_FROM: "no-reply@mail.example.test",
  });

  assert.equal(settings.mode, "smtp");
  assert.ok(settings.smtp);
  assert.equal(settings.smtp.host, "smtpdm.aliyun.com");
  assert.equal(settings.smtp.port, 465);
  assert.equal(settings.smtp.security, "ssl");
  assert.equal(settings.smtp.timeoutMs, 15_000);
  assert.equal(settings.smtp.fromName, "KoBook");
  // The password is a credential, not a display value: spaces stay.
  assert.equal(settings.smtp.pass, "  a password with spaces  ");
});

test("mail settings: STARTTLS on 587 and explicit tuning", () => {
  const settings = loadMailSettings("production", {
    MAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtpdm.aliyun.com",
    SMTP_SECURITY: "starttls",
    SMTP_PORT: "587",
    SMTP_USER: "no-reply@mail.example.test",
    SMTP_PASS: "secret",
    SMTP_FROM: "no-reply@mail.example.test",
    SMTP_FROM_NAME: "KoBook验证",
    SMTP_TIMEOUT_MS: "8000",
  });

  assert.equal(settings.smtp?.port, 587);
  assert.equal(settings.smtp?.security, "starttls");
  assert.equal(settings.smtp?.fromName, "KoBook验证");
  assert.equal(settings.smtp?.timeoutMs, 8000);
});

test("mail settings: malformed values fail startup instead of degrading", () => {
  const base = {
    MAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtpdm.aliyun.com",
    SMTP_USER: "no-reply@mail.example.test",
    SMTP_PASS: "secret",
    SMTP_FROM: "no-reply@mail.example.test",
  };

  assert.throws(() => loadMailSettings("production", { ...base, SMTP_PORT: "abc" }), /SMTP_PORT/);
  assert.throws(() => loadMailSettings("production", { ...base, SMTP_PORT: "0" }), /SMTP_PORT/);
  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_SECURITY: "plain" }),
    /SMTP_SECURITY/,
  );
  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_AUTH: "oauth2" }),
    /SMTP_AUTH/,
  );
  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_TIMEOUT_MS: "10" }),
    /SMTP_TIMEOUT_MS/,
  );
  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_FROM: "not-an-email" }),
    /SMTP_FROM/,
  );
  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_FROM: "" }),
    /SMTP_FROM/,
  );
  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_USER: "" }),
    /SMTP_USER/,
  );
  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_PASS: "" }),
    /SMTP_PASS/,
  );
});

test("mail settings: production refuses cleartext transport and anonymous relay", () => {
  const base = {
    MAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtpdm.aliyun.com",
    SMTP_USER: "no-reply@mail.example.test",
    SMTP_PASS: "secret",
    SMTP_FROM: "no-reply@mail.example.test",
  };

  assert.throws(
    () => loadMailSettings("production", { ...base, SMTP_SECURITY: "none" }),
    /SMTP_SECURITY=none/,
  );
  assert.throws(
    () =>
      loadMailSettings("production", {
        ...base,
        SMTP_AUTH: "none",
        SMTP_USER: "",
        SMTP_PASS: "",
      }),
    /SMTP_AUTH=none/,
  );
});

// ── Resolution ───────────────────────────────────────────────────────────

test("resolveMail: outbox mode exposes the dev inbox; smtp mode does not", async () => {
  const dev = resolveMail(loadMailSettings("development", {}), "development");
  assert.ok(dev.transport instanceof OutboxTransport);
  assert.ok(dev.outbox);

  await dev.transport.send(VERIFY_MAIL);
  assert.equal(dev.outbox.latestFor(VERIFY_MAIL.to)?.url, VERIFY_MAIL.url);

  const smtp = resolveMail(
    loadMailSettings("production", {
      MAIL_TRANSPORT: "smtp",
      SMTP_HOST: "127.0.0.1",
      SMTP_USER: "u@example.test",
      SMTP_PASS: "p",
      SMTP_FROM: "u@example.test",
    }),
    "production",
  );
  assert.ok(smtp.transport instanceof SmtpTransport);
  assert.equal(smtp.outbox, null);
  smtp.transport.close?.();
});

// ── Delivery against a loopback SMTP server ──────────────────────────────

test("smtp send: authenticates, delivers headers and the verification link", async () => {
  const server = await startFakeSmtp({ auth: { user: "smtp-user", pass: "smtp-pass" } });
  const transport = createSmtpTransport(configFor(server));
  try {
    await transport.send(VERIFY_MAIL);

    assert.equal(server.messages.length, 1);
    assert.deepEqual(server.authAttempts, [{ user: "smtp-user", pass: "smtp-pass" }]);

    const message = server.messages[0]!;
    assert.match(message, /^To: reader@example\.test$/m);
    assert.match(message, /^From: .*no-reply@example\.test.*$/m);
    // Chinese subject is RFC 2047-encoded rather than emitted raw.
    assert.match(message, /^Subject: =\?UTF-8\?/im);
    assert.match(message, /Content-Type: text\/plain; charset=utf-8/im);
    assert.match(message, /^Content-Transfer-Encoding: base64$/im);

    // The body is base64-transfer-encoded (it contains Chinese), so the
    // credential-carrying link only appears after decoding — which is itself
    // worth pinning, because a regression to raw 8-bit would break providers.
    const body = message.slice(message.indexOf("\r\n\r\n") + 4);
    const decoded = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
    assert.match(decoded, /https:\/\/ex\.test\/v\/abc123/);
    assert.ok(decoded.includes("请打开下面的链接完成邮箱验证"), "body text is preserved");
  } finally {
    transport.close();
    await server.close();
  }
});

test("smtp send: verify() authenticates without sending a message", async () => {
  const server = await startFakeSmtp({ auth: { user: "smtp-user", pass: "smtp-pass" } });
  const transport = createSmtpTransport(configFor(server));
  try {
    assert.equal(await transport.verify(), true);
    assert.equal(server.messages.length, 0);
    assert.deepEqual(server.authAttempts, [{ user: "smtp-user", pass: "smtp-pass" }]);
  } finally {
    transport.close();
    await server.close();
  }
});

test("smtp send: a rejected recipient rejects the send", async () => {
  const server = await startFakeSmtp({ rejectRecipient: true });
  const transport = createSmtpTransport(configFor(server));
  try {
    await assert.rejects(transport.send(VERIFY_MAIL), /550/);
    assert.equal(server.messages.length, 0);
  } finally {
    transport.close();
    await server.close();
  }
});

test("smtp send: a bad password rejects and the log never contains it", async () => {
  const server = await startFakeSmtp({ auth: { user: "smtp-user", pass: "smtp-pass" } });
  const logs: Array<Record<string, unknown>> = [];
  const transport = createSmtpTransport(configFor(server, { pass: "wrong-password" }), {
    info: (obj) => logs.push(obj),
    error: (obj) => logs.push(obj),
  });
  try {
    await assert.rejects(transport.send(VERIFY_MAIL), /535/);

    assert.equal(server.messages.length, 0);
    assert.equal(server.authAttempts[0]?.pass, "wrong-password");

    const serialized = JSON.stringify(logs);
    assert.match(serialized, /535/);
    assert.ok(
      !serialized.includes("wrong-password"),
      "SMTP password must never reach the log",
    );
    assert.ok(!serialized.includes("abc123"), "the single-use link must not be logged");
  } finally {
    transport.close();
    await server.close();
  }
});
