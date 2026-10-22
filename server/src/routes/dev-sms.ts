// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read-only development SMS inbox.
 *
 * Mounted by `app.ts` only when the active transport is the in-process outbox
 * and NODE_ENV is not "production" — under Aliyun the code really leaves the
 * host and there is no in-process copy to read. The shape mirrors the
 * development mail inbox on purpose: the acceptance run reads a code from here
 * instead of asking a phone.
 *
 * The full number is returned, not only the mask, because the test harness
 * needs to match a code to the number it was requested for and this endpoint
 * cannot exist in a deployment.
 */

import type { FastifyInstance } from "fastify";
import {
  ROUTES,
  type DevSmsLatestResponse,
  type DevSmsListResponse,
  type DevSmsMessage,
} from "../../../shared/contracts/index.js";
import { isPhoneOtpPurpose } from "../lib/phone/config.js";
import type { SmsOutboxEntry, SmsOutboxTransport } from "../lib/phone/outbox.js";

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 20;

function toMessage(entry: SmsOutboxEntry): DevSmsMessage {
  return {
    id: entry.id,
    to: entry.to,
    maskedTo: entry.maskedTo,
    purpose: entry.purpose,
    code: entry.code,
    queuedAt: entry.queuedAt,
  };
}

export function registerDevSmsRoutes(
  app: FastifyInstance,
  outbox: SmsOutboxTransport,
): void {
  app.get(ROUTES.devSms, async (req): Promise<DevSmsListResponse> => {
    const limitParam = (req.query as { limit?: string }).limit;
    const parsed = limitParam !== undefined ? Number(limitParam) : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT));
    return { messages: outbox.list(limit).map(toMessage) };
  });

  app.get(ROUTES.devSmsLatest, async (req): Promise<DevSmsLatestResponse> => {
    const query = req.query as { to?: string; purpose?: string };
    if (!query.to) return { message: null };
    const purpose = isPhoneOtpPurpose(query.purpose) ? query.purpose : undefined;
    const entry = outbox.latestFor(query.to, purpose);
    return { message: entry ? toMessage(entry) : null };
  });
}
