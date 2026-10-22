// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Development mail outbox.
 *
 * The in-memory inbox for development and test: messages are kept in a bounded
 * per-process list instead of being delivered. Two things read that list — the
 * server log (so a developer running `npm run dev` can click the link or read
 * the login code straight from the terminal) and the read-only
 * `GET /api/dev/mail*` endpoint, which is mounted only outside production and
 * only when this transport is the active one (an SMTP deployment has no inbox
 * to expose).
 *
 * Real delivery lives in `smtp.ts`. Production cannot select this transport:
 * `config.ts` refuses the combination, because the list never survives the
 * process and a sign-up whose verification mail vanished is a broken sign-up.
 */

import { randomUUID } from "node:crypto";
import type {
  MailLogger,
  MailPurpose,
  MailTransport,
  OutboundMail,
} from "./transport.js";

export interface OutboxEntry extends OutboundMail {
  id: string;
  queuedAt: string;
}

/** Bounded: an unbounded inbox in a long-running process is a memory leak. */
export const OUTBOX_CAPACITY = 20;

export class OutboxTransport implements MailTransport {
  /**
   * @param logLinks Whether the link (which carries a single-use token) may be
   * written to the log. True in development only — that is what makes
   * `npm run dev` usable without opening the dev endpoint. In `test` and
   * `production` links are never logged, which is what keeps the "credentials
   * never appear in the log" acceptance check meaningful rather than
   * vacuously true.
   */
  constructor(private readonly logLinks: boolean) {}

  private readonly entries: OutboxEntry[] = [];
  private log: MailLogger | undefined;

  /**
   * The transport is built before the Fastify app exists (the auth config owns
   * the mail callbacks, and `createAuth` runs first), so the logger is attached
   * once the app is available. Before that, messages are stored but not logged.
   */
  attachLogger(log: MailLogger): void {
    this.log = log;
  }

  async send(mail: OutboundMail): Promise<void> {
    const entry: OutboxEntry = {
      ...mail,
      id: randomUUID(),
      queuedAt: new Date().toISOString(),
    };

    this.entries.unshift(entry);
    if (this.entries.length > OUTBOX_CAPACITY) {
      this.entries.length = OUTBOX_CAPACITY;
    }

    if (!this.log) return;

    // Never log `purpose`-specific credentials: in test and production the
    // link and the login code are omitted entirely, because they are bare
    // strings that pino's key-based redaction cannot see inside.
    if (this.logLinks) {
      this.log.info(
        {
          mailId: entry.id,
          to: entry.to,
          purpose: entry.purpose,
          ...(entry.url ? { url: entry.url } : {}),
          ...(entry.code ? { code: entry.code } : {}),
        },
        "开发邮件已写入内存收件箱",
      );
    } else {
      this.log.info(
        { mailId: entry.id, to: entry.to, purpose: entry.purpose },
        "邮件已排队（本环境不记录链接或验证码）",
      );
    }
  }

  /** Newest first. */
  list(limit: number = OUTBOX_CAPACITY): OutboxEntry[] {
    return this.entries.slice(0, Math.max(0, Math.min(limit, OUTBOX_CAPACITY)));
  }

  /** Newest message for an address, optionally filtered by purpose. */
  latestFor(to: string, purpose?: MailPurpose): OutboxEntry | null {
    const wanted = to.trim().toLowerCase();
    const found = this.entries.find(
      (entry) =>
        entry.to.trim().toLowerCase() === wanted &&
        (purpose === undefined || entry.purpose === purpose),
    );
    return found ?? null;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// The environment resolver that used to live here moved to `resolve.ts`, which
// chooses between this outbox and the SMTP transport. Production is refused
// there (and in `config.ts`) rather than by the outbox itself, so the "cannot
// verify anyone" gate now means "no SMTP configured", not "no provider exists".
