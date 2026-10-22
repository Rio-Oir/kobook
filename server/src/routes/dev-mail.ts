// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Read-only development mail inbox.
 *
 * Mounted by `app.ts` only when the active transport is the in-memory outbox
 * and NODE_ENV is not "production"; under SMTP the links really leave the host
 * and there is no in-process copy to read. The acceptance run asserts the mount
 * is absent in production (a route the `setNotFoundHandler` catches means a 404
 * with the shared error contract). The body returns the link exactly as Better
 * Auth built it, plus a `token` field parsed from the URL so tests do not have
 * to re-parse link shapes.
 */

import type { FastifyInstance } from "fastify";
import {
  ROUTES,
  type DevMailLatestResponse,
  type DevMailListResponse,
  type DevMailMessage,
} from "../../../shared/contracts/index.js";
import type {
  OutboxEntry,
  OutboxTransport,
} from "../lib/mail/outbox.js";

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 20;

/**
 * Extracts the single-use token from a Better Auth link.
 *
 * The shapes are different on purpose: verification is `?token=…`, and the
 * reset link is `/api/auth/reset-password/<token>?callbackURL=…`. The
 * extracted string is whatever Better Auth gave us, byte for byte. A login
 * code has no link, so it has no token; `toMessage` surfaces the code
 * separately.
 */
function parseToken(url: string, purpose: DevMailMessage["purpose"]): string {
  if (purpose === "sign-in-otp") return "";
  if (purpose === "verify-email") {
    try {
      return new URL(url).searchParams.get("token") ?? "";
    } catch {
      return "";
    }
  }
  const match = url.match(/\/reset-password\/([^/?#]+)/);
  return match?.[1] ?? "";
}

const MAIL_PURPOSES: readonly DevMailMessage["purpose"][] = [
  "verify-email",
  "reset-password",
  "sign-in-otp",
];

function readPurpose(raw: string | undefined): DevMailMessage["purpose"] | undefined {
  return MAIL_PURPOSES.find((purpose) => purpose === raw);
}

function toMessage(entry: OutboxEntry): DevMailMessage {
  const url = entry.url ?? "";
  return {
    id: entry.id,
    purpose: entry.purpose,
    to: entry.to,
    subject: entry.subject,
    url,
    token: parseToken(url, entry.purpose),
    code: entry.code ?? "",
    queuedAt: entry.queuedAt,
  };
}

export function registerDevMailRoutes(
  app: FastifyInstance,
  outbox: OutboxTransport,
): void {
  app.get(ROUTES.devMail, async (req): Promise<DevMailListResponse> => {
    const limitParam = (req.query as { limit?: string }).limit;
    const parsed = limitParam !== undefined ? Number(limitParam) : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT));
    return { messages: outbox.list(limit).map(toMessage) };
  });

  app.get(ROUTES.devMailLatest, async (req): Promise<DevMailLatestResponse> => {
    const query = req.query as { to?: string; purpose?: string };
    if (!query.to) return { message: null };
    // An explicit purpose matters once an address can hold both a link and a
    // login code: "latest for this address" would otherwise depend on timing.
    const entry = outbox.latestFor(query.to, readPurpose(query.purpose));
    return { message: entry ? toMessage(entry) : null };
  });
}
