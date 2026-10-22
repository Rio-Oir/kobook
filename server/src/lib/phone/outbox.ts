// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The in-process SMS outbox.
 *
 * Development and test only, exactly like the mail outbox: it keeps the code in
 * process memory so the acceptance run and a local developer can read it back
 * from `GET /api/dev/sms/latest`, without a provider account and without a
 * real message. `loadPhoneSettings` refuses `SMS_TRANSPORT=outbox` in
 * production, so the route and the transport cannot reach a deployment that
 * would mistake "queued" for "delivered".
 *
 * The logging rule is the mail outbox's rule: print the code only when
 * `NODE_ENV=development`. Under `test` a printed code would defeat the
 * acceptance gate that asserts a code never reaches the captured server log,
 * and production never mounts this transport at all.
 */

import type { SmsSendRequest, SmsSendResult } from "../../../../modules/phone-otp-kit/src/otp/sms.js";
import type { SmsLogger, SmsTransportHandle } from "./transport.js";

export interface SmsOutboxEntry {
  readonly id: string;
  /** Full E.164 destination. Development only — never logged by the route. */
  readonly to: string;
  readonly maskedTo: string;
  readonly purpose: string;
  /** The six-digit code that was "sent". */
  readonly code: string;
  readonly queuedAt: string;
}

export interface SmsOutboxTransport extends SmsTransportHandle {
  readonly kind: "outbox";
  list(limit: number): readonly SmsOutboxEntry[];
  /** Most recent message for one destination, optionally filtered by purpose. */
  latestFor(to: string, purpose?: string): SmsOutboxEntry | undefined;
  attachLogger(logger: SmsLogger): void;
  clear(): void;
}

const MAX_ENTRIES = 50;

let sequence = 0;

export function createSmsOutbox(options: {
  /** Print the code to the log only in development. */
  logCodes: boolean;
}): SmsOutboxTransport {
  const entries: SmsOutboxEntry[] = [];
  let logger: SmsLogger | undefined;

  const transport: SmsOutboxTransport = {
    kind: "outbox",

    async send(request: SmsSendRequest): Promise<SmsSendResult> {
      sequence += 1;
      const entry: SmsOutboxEntry = {
        id: `sms-${Date.now()}-${sequence}`,
        to: request.toE164,
        maskedTo: request.maskedTo,
        purpose: request.purpose,
        code: request.code,
        queuedAt: new Date().toISOString(),
      };
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.shift();

      if (options.logCodes) {
        // Deliberate: this is the only place a code is ever printed, and it is
        // gated on the development environment rather than on a flag a
        // deployment could turn on by accident.
        logger?.info(
          { to: entry.maskedTo, purpose: entry.purpose, code: entry.code },
          "development SMS outbox: verification code",
        );
      } else {
        logger?.debug(
          { to: entry.maskedTo, purpose: entry.purpose },
          "development SMS outbox: message captured",
        );
      }

      return { ok: true };
    },

    list(limit: number): readonly SmsOutboxEntry[] {
      return entries.slice(-limit).reverse();
    },

    latestFor(to: string, purpose?: string): SmsOutboxEntry | undefined {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        if (entry.to !== to) continue;
        if (purpose !== undefined && entry.purpose !== purpose) continue;
        return entry;
      }
      return undefined;
    },

    attachLogger(next: SmsLogger): void {
      logger = next;
    },

    clear(): void {
      entries.length = 0;
    },
  };

  return transport;
}
