// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SMTP transport — the real delivery path for verification and reset mail.
 *
 * Phase 2 shipped an in-memory outbox and refused to start in production. This
 * module is the provider the phase-2 comment pointed at: it delivers over
 * standard SMTP, which is the interface every transactional provider offers
 * (Alibaba Cloud DirectMail uses `smtpdm.aliyun.com`, with implicit TLS on 465
 * and STARTTLS on 25/80). The auth layer and the message text do not
 * change: `mailer.ts` still composes the two messages and `auth.ts` still
 * decides when to send; only delivery moves here.
 *
 * What this transport deliberately does NOT do:
 *  - it never logs the link, the token or the SMTP password. The message text
 *    is a credential carrier (the verification/reset URL is single-use), and a
 *    URL is not covered by pino's key-based redaction;
 *  - it does not silently swallow a failure. `send` rejects, so Better Auth
 *    answers the sign-up / reset request with an error instead of pretending a
 *    message went out. A sign-up the user cannot verify is a broken sign-up;
 *  - it does not turn off certificate validation, in any environment. The only
 *    plaintext mode (`none`) exists for local test relays and is refused in
 *    production by `config.ts`.
 */

import nodemailer from "nodemailer";
import type { MailLogger, MailTransport, OutboundMail } from "./transport.js";

/** How the socket is protected. */
export type SmtpSecurity = "ssl" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  /**
   * Empty string means "no AUTH". That is only reachable for a local test
   * relay: `config.ts` refuses an unauthenticated relay in production, where
   * an open relay would be a credential-free way to send mail through us.
   */
  user: string;
  /** Never logged, never included in an error message. */
  pass: string;
  /** Envelope sender — must be a sending address the provider has verified. */
  from: string;
  /** Display name in the From header; defaults to KoBook. */
  fromName: string;
  /** Per-step socket timeout in milliseconds. */
  timeoutMs: number;
}

const SMTP_ERROR_FIELDS = ["code", "response", "responseCode", "message"] as const;

/**
 * Reduces a nodemailer error to loggable fields.
 *
 * Nodemailer's error object carries the server's reply (`535 5.7.8 ...`) but
 * not the credentials, and we still bound the string: a provider that echoes
 * the full command line must not be able to push arbitrary content into the
 * log. The caller decides where these fields go; no field here contains the
 * password or the message body.
 */
export function describeSmtpError(err: unknown): Record<string, unknown> {
  if (typeof err !== "object" || err === null) {
    return { smtpError: String(err) };
  }

  const source = err as Partial<Record<(typeof SMTP_ERROR_FIELDS)[number], unknown>>;
  const result: Record<string, unknown> = {};

  if (typeof source.code === "string") result["code"] = source.code;
  if (typeof source.responseCode === "number") result["responseCode"] = source.responseCode;

  if (typeof source.response === "string") {
    result["smtpResponse"] = source.response.slice(0, 300);
  } else if (typeof source.message === "string") {
    result["errorMessage"] = source.message.slice(0, 300);
  }

  return result;
}

export class SmtpTransport implements MailTransport {
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>;
  private log: MailLogger | undefined;

  constructor(
    private readonly config: SmtpConfig,
    logger?: MailLogger,
  ) {
    this.log = logger;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // `secure` = implicit TLS from the first byte (465). STARTTLS starts
      // plaintext, upgrades after EHLO, and `requireTLS` makes a server that
      // advertises no STARTTLS a hard failure instead of a silent downgrade.
      secure: config.security === "ssl",
      requireTLS: config.security === "starttls",
      ignoreTLS: config.security === "none",
      ...(config.user.length > 0
        ? { auth: { user: config.user, pass: config.pass } }
        : {}),
      // Reuse one connection for the low, bursty volume of account mail;
      // opening a fresh TLS session per message is the slow path.
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
      connectionTimeout: config.timeoutMs,
      greetingTimeout: config.timeoutMs,
      // A DATA phase that stalls after connect still needs its own bound.
      socketTimeout: config.timeoutMs * 2,
      tls: { minVersion: "TLSv1.2" },
    });
  }

  attachLogger(log: MailLogger): void {
    this.log = log;
  }

  async send(mail: OutboundMail): Promise<void> {
    const startedAt = Date.now();
    try {
      const info = await this.transporter.sendMail({
        from: { name: this.config.fromName, address: this.config.from },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        // Spell the envelope out: the provider authorises `SMTP_FROM`, and
        // the header From is not necessarily what MAIL FROM carries.
        envelope: { from: this.config.from, to: [mail.to] },
        headers: { "X-Auto-Response-Suppress": "All" },
      });

      // No address, no subject, no link: an access log is not an inbox.
      this.log?.info(
        {
          purpose: mail.purpose,
          messageId: info.messageId,
          durationMs: Date.now() - startedAt,
        },
        "SMTP 邮件已发送",
      );
    } catch (err) {
      this.log?.error(
        {
          purpose: mail.purpose,
          durationMs: Date.now() - startedAt,
          ...describeSmtpError(err),
        },
        "SMTP 邮件发送失败",
      );
      // Re-thrown on purpose: see the module comment.
      throw err;
    }
  }

  /** Opens a connection, authenticates and disconnects. Used by `mail:check`. */
  async verify(): Promise<boolean> {
    return this.transporter.verify();
  }

  /** Releases pooled sockets at shutdown. */
  close(): void {
    this.transporter.close();
  }
}

export function createSmtpTransport(
  config: SmtpConfig,
  logger?: MailLogger,
): SmtpTransport {
  return new SmtpTransport(config, logger);
}

