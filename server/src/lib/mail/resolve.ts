// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Mail assembly.
 *
 * Turns the parsed settings into the objects the server uses, and keeps the
 * two concerns apart:
 *
 *   - `transport` is what `mailer.ts` sends through — an outbox or SMTP;
 *   - `outbox` is non-null only in outbox mode, because the development
 *     `GET /api/dev/mail*` inbox has nothing to read when mail really leaves
 *     the process. `app.ts` therefore mounts that route only when this is set.
 *
 * Production cannot reach the outbox branch: `loadMailSettings` refuses that
 * combination before this function runs.
 */

import type { MailNodeEnv, MailSettings } from "./config.js";
import { OutboxTransport } from "./outbox.js";
import { createSmtpTransport } from "./smtp.js";
import type { MailTransport } from "./transport.js";

export interface ResolvedMail {
  transport: MailTransport;
  /** Non-null only in outbox mode; the dev inbox route needs it. */
  outbox: OutboxTransport | null;
}

export function resolveMail(settings: MailSettings, nodeEnv: MailNodeEnv): ResolvedMail {
  if (settings.mode === "outbox") {
    const outbox = new OutboxTransport(nodeEnv === "development");
    return { transport: outbox, outbox };
  }

  if (settings.smtp === null) {
    // Unreachable through `loadMailSettings`; kept so a future caller cannot
    // pair "smtp" with a missing config and get a crash-free no-op.
    throw new Error("MAIL_TRANSPORT=smtp 但 SMTP 配置缺失。");
  }

  return { transport: createSmtpTransport(settings.smtp), outbox: null };
}
