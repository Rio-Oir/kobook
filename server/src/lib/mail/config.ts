// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Mail configuration.
 *
 * Two modes, resolved from the environment:
 *
 *   - `outbox` — the in-memory development inbox. Only allowed outside
 *     production, because messages vanish with the process;
 *   - `smtp`   — real delivery. The default in production, and the only way a
 *     deployment can verify an address or reset a password.
 *
 * Parsing is strict on purpose. A typo in `SMTP_PORT` or a forgotten
 * `SMTP_FROM` must fail startup, not produce a server that accepts sign-ups it
 * can never complete. Every error message names the variable that is wrong and
 * never echoes its value — `SMTP_PASS` is a credential, and the startup error
 * is written to stderr where an operator or a log shipper will read it.
 *
 * Two production-only refusals are worth spelling out:
 *   - `SMTP_SECURITY=none` would put the mailbox password on the wire in
 *     cleartext;
 *   - `SMTP_AUTH=none` would let this host relay unauthenticated mail, using
 *     the deployment's IP reputation as the credential.
 * Both are useful against a local test relay and neither is acceptable
 * against a provider reachable over the network.
 */

import process from "node:process";
import type { SmtpConfig, SmtpSecurity } from "./smtp.js";

export type MailNodeEnv = "development" | "test" | "production";

export type MailMode = "outbox" | "smtp";

export interface MailSettings {
  mode: MailMode;
  /** Non-null exactly when `mode` is "smtp". */
  smtp: SmtpConfig | null;
}

/** Deliberately loose: provider-side validation is the authority. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SECURITY_VALUES: readonly SmtpSecurity[] = ["ssl", "starttls", "none"];

const DEFAULT_PORTS: Readonly<Record<SmtpSecurity, number>> = {
  ssl: 465,
  starttls: 587,
  none: 25,
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function read(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function parsePort(raw: string, security: SmtpSecurity): number {
  if (raw === "") return DEFAULT_PORTS[security];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SMTP_PORT 不是合法端口：${JSON.stringify(raw)}。`);
  }
  return port;
}

function parseSecurity(raw: string, nodeEnv: MailNodeEnv): SmtpSecurity {
  const value = (raw === "" ? "ssl" : raw.toLowerCase()) as SmtpSecurity;
  if (!SECURITY_VALUES.includes(value)) {
    throw new Error(
      `SMTP_SECURITY 只能是 ssl / starttls / none（当前 ${JSON.stringify(raw)}）。`,
    );
  }
  if (nodeEnv === "production" && value === "none") {
    throw new Error(
      "NODE_ENV=production 时禁止 SMTP_SECURITY=none：明文 SMTP 会把邮箱密码与邮件内容暴露在网络上。请使用 ssl（465）或 starttls（如 80/25/587）。",
    );
  }
  return value;
}

function parseTimeout(raw: string): number {
  if (raw === "") return DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number(raw);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `SMTP_TIMEOUT_MS 必须是 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 之间的整数（当前 ${JSON.stringify(raw)}）。`,
    );
  }
  return timeoutMs;
}

function parseSmtpSettings(nodeEnv: MailNodeEnv, env: NodeJS.ProcessEnv): SmtpConfig {
  const host = read(env, "SMTP_HOST");
  if (host === "") {
    throw new Error(
      "MAIL_TRANSPORT=smtp 时必须配置 SMTP_HOST（阿里云邮件推送华东 1 为 smtpdm.aliyun.com）。",
    );
  }

  const security = parseSecurity(read(env, "SMTP_SECURITY"), nodeEnv);
  const port = parsePort(read(env, "SMTP_PORT"), security);

  const authRaw = read(env, "SMTP_AUTH").toLowerCase();
  const auth = authRaw === "" ? "login" : authRaw;
  if (auth !== "login" && auth !== "none") {
    throw new Error(
      `SMTP_AUTH 只能是 login / none（当前 ${JSON.stringify(authRaw)}）。`,
    );
  }
  if (nodeEnv === "production" && auth === "none") {
    throw new Error(
      "NODE_ENV=production 时禁止 SMTP_AUTH=none：无认证中继会让本机成为可被滥用的发信出口。请配置 SMTP_USER 与 SMTP_PASS。",
    );
  }

  const user = auth === "login" ? read(env, "SMTP_USER") : "";
  // A password may legitimately contain leading/trailing spaces, so it is
  // taken verbatim rather than trimmed; only emptiness is checked.
  const pass = auth === "login" ? (env["SMTP_PASS"] ?? "") : "";

  if (auth === "login" && user === "") {
    throw new Error("SMTP_AUTH=login 时必须配置 SMTP_USER（阿里云邮件推送为完整发信地址）。");
  }
  if (auth === "login" && pass === "") {
    throw new Error("SMTP_AUTH=login 时必须配置 SMTP_PASS（阿里云邮件推送在控制台设置的 SMTP 密码）。");
  }

  const from = read(env, "SMTP_FROM");
  if (from === "") {
    throw new Error("MAIL_TRANSPORT=smtp 时必须配置 SMTP_FROM（发信地址，需与 SMTP_USER 一致）。");
  }
  if (!EMAIL_PATTERN.test(from)) {
    throw new Error("SMTP_FROM 不是合法的邮箱地址。");
  }

  return {
    host,
    port,
    security,
    user,
    pass,
    from,
    fromName: read(env, "SMTP_FROM_NAME") || "KoBook",
    timeoutMs: parseTimeout(read(env, "SMTP_TIMEOUT_MS")),
  };
}

/**
 * Resolves the mail mode and, when it is "smtp", the full transport settings.
 *
 * `env` is injectable so the unit tests can exercise the parser without
 * mutating the process environment (which other tests in the same process
 * read).
 */
export function loadMailSettings(
  nodeEnv: MailNodeEnv,
  env: NodeJS.ProcessEnv = process.env,
): MailSettings {
  const rawMode = read(env, "MAIL_TRANSPORT").toLowerCase();
  const mode = rawMode === "" ? (nodeEnv === "production" ? "smtp" : "outbox") : rawMode;

  if (mode !== "outbox" && mode !== "smtp") {
    throw new Error(
      `MAIL_TRANSPORT 只能是 outbox / smtp（当前 ${JSON.stringify(rawMode)}）。`,
    );
  }

  if (mode === "outbox") {
    if (nodeEnv === "production") {
      throw new Error(
        "NODE_ENV=production 时不允许使用内存 outbox：验证邮件与重置邮件会静默丢失，" +
          "用户注册后永远无法验证邮箱。请设置 MAIL_TRANSPORT=smtp 并配置 SMTP_HOST / SMTP_FROM / SMTP_USER / SMTP_PASS。",
      );
    }
    return { mode: "outbox", smtp: null };
  }

  return { mode: "smtp", smtp: parseSmtpSettings(nodeEnv, env) };
}

