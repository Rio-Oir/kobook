// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Mail transport contract.
 *
 * Two implementations exist: the development outbox (`outbox.ts`) and real
 * SMTP delivery (`smtp.ts`). This interface is the seam between them:
 * `mailer.ts` composes the messages, `auth.ts` decides when to send, and the
 * transport owns delivery — so choosing a provider changes nothing in the auth
 * configuration or the message text.
 *
 * A transport must not log the link (it carries a single-use token), the
 * message body or any credential; see `MailLogger`.
 */

/** Which flow produced a message. Used for routing and for test assertions. */
export type MailPurpose = "verify-email" | "reset-password" | "sign-in-otp";

export interface OutboundMail {
  to: string;
  subject: string;
  /** Plain-text body. User-facing, so it is written in Simplified Chinese. */
  text: string;
  /**
   * Absolute link the recipient is expected to open, exactly as Better Auth
   * produced it (see `mailer.ts` for the full round trip). Present for the two
   * link flows (verification, reset) and absent for a login code.
   *
   * It points at the auth endpoint and carries a single-use token, so it is a
   * credential: the transport must not echo it into any log outside
   * development, and the dev-only inbox endpoint is the sanctioned way to read
   * it back in tests.
   */
  url?: string;
  /**
   * Six-digit login code. Present only for `sign-in-otp`, and a credential in
   * exactly the same sense as `url`: never log it outside development, never
   * persist it beyond the development outbox.
   */
  code?: string;
  purpose: MailPurpose;
}

export interface MailTransport {
  send(mail: OutboundMail): Promise<void>;
  /**
   * Attaches the application logger. Optional because a transport is built
   * before the Fastify app exists; the outbox and SMTP transports implement
   * it, a test double may not.
   */
  attachLogger?(log: MailLogger): void;
  /** Opens a connection and authenticates without sending. SMTP only. */
  verify?(): Promise<boolean>;
  /** Releases pooled sockets at shutdown. SMTP only. */
  close?(): void;
}

/**
 * The logging surface a transport may use. Fastify's logger satisfies it, so
 * mail never needs a second logger.
 *
 * The contract for implementers: log the purpose and provider response, but
 * never the link (it carries a single-use token), the recipient's address, the
 * SMTP password, or the message body.
 */
export interface MailLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}
