// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SMTP 自检：登录并发送一封测试邮件。
 *
 * 用法（仓库根目录）：
 *   npm run mail:check -- 收件邮箱@example.com
 *
 * 只读取 .env / 进程环境，不连接数据库，所以不需要启动 Postgres。输出永远
 * 不包含 SMTP 密码或邮件正文中的链接。
 */

import process from 'node:process';
import { loadEnvFileOnce } from '../server/src/env.ts';
import { loadMailSettings } from '../server/src/lib/mail/config.ts';
import { resolveMail } from '../server/src/lib/mail/resolve.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const to = process.argv[2];

if (!to || !EMAIL_RE.test(to)) {
  console.error('用法: npm run mail:check -- 收件邮箱@example.com');
  process.exit(2);
}

loadEnvFileOnce();

const nodeEnvRaw = (process.env['NODE_ENV'] ?? 'development').toLowerCase();
const nodeEnv = nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';

let mail;
try {
  mail = resolveMail(loadMailSettings(nodeEnv, process.env), nodeEnv);
} catch (err) {
  console.error(`邮件配置无效：${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

if (mail.outbox) {
  console.error('当前为 outbox 模式（未配置 SMTP），不会真实发信。');
  console.error('请在 .env 中设置 MAIL_TRANSPORT=smtp、SMTP_HOST、SMTP_USER、SMTP_PASS、SMTP_FROM 后重试。');
  process.exit(2);
}

const transport = mail.transport;
transport.attachLogger?.({
  info: (obj, msg) => console.log(`· ${msg ?? ''}`, obj),
  error: (obj, msg) => console.error(`· ${msg ?? ''}`, obj),
});

try {
  await transport.verify?.();
  console.log('· SMTP 连接与认证通过');

  await transport.send({
    to,
    subject: '测试邮件 · KoBook',
    text:
      '这是一封来自KoBook的 SMTP 自检邮件。\n\n' +
      `发送时间：${new Date().toISOString()}\n\n` +
      '收到这封邮件说明：服务器能用配置的 SMTP 账号登录并发信。',
    // 自检没有真实令牌；该字段在邮件正文中不会被使用。
    url: '',
    purpose: 'verify-email',
  });

  console.log(`· 已发送到 ${to}，请检查收件箱与垃圾邮件目录`);
} catch (err) {
  const shape = err && typeof err === 'object' ? err : {};
  const detail = shape.response ?? shape.message ?? String(err);
  console.error(`· 发送失败：${String(detail).slice(0, 300)}`);
  process.exitCode = 1;
} finally {
  transport.close?.();
}

