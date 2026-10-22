// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The two things every SMS transport in this server has in common: the kit's
 * transport contract, and the logging surface a transport may use.
 *
 * The kit's `SmsTransport` is re-exported rather than redeclared so the
 * adapter boundary is the kit's, not this file's. `SmsLogger` exists for the
 * same reason `MailLogger` does: Fastify's pino instance satisfies it, so the
 * server never needs a second logging stack.
 *
 * The rule for implementers, stated once: log the purpose and the provider's
 * classification, never the destination number, the message body or the code.
 */

import type { SmsTransport } from "../../../../modules/phone-otp-kit/src/otp/sms.js";

export type { SmsSendRequest, SmsSendResult, SmsTransport } from "../../../../modules/phone-otp-kit/src/otp/sms.js";

export interface SmsLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * A transport that can be handed the process logger after the Fastify app
 * exists. The phone service is constructed before `buildApp` (the auth instance
 * owns the endpoints), so the logger is attached afterwards, exactly like the
 * mail outbox.
 */
export interface SmsTransportHandle extends SmsTransport {
  attachLogger?(log: SmsLogger): void;
  /** Release sockets / timers at shutdown. HTTP adapters need nothing. */
  close?(): void;
}
