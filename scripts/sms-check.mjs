// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 阿里云短信自检：真正调用一次 SendSms。
 *
 * 用法（仓库根目录）：
 *   npm run sms:check -- 13800138000
 *
 * 只读取 .env / 进程环境，不连接数据库，所以不需要启动 Postgres，也不需要
 * 跑迁移。输出永远不包含 AccessKey、AccessKeySecret 或厂商的原始 message。
 *
 * 这一步验证的是「配置能被阿里云接受」：签名、模板、AccessKey 权限、模板变量
 * 名（必须是 code）任一不对，都会得到一个分类错误码。真实登录页的验证码流程
 * 还会多一层本站的号码预算与挑战表，见 docs/登录链路.md §16。
 */

import process from 'node:process';
import { randomInt } from 'node:crypto';
import { loadEnvFileOnce } from '../server/src/env.ts';
import { loadPhoneSettings } from '../server/src/lib/phone/config.ts';
import { createAliyunSmsTransport } from '../server/src/lib/phone/aliyun.ts';
import { assessPhone } from '../modules/phone-otp-kit/src/shared/phone.ts';

const raw = process.argv[2];

if (!raw) {
  console.error('用法: npm run sms:check -- 13800138000');
  process.exit(2);
}

const assessed = assessPhone(raw);
if (!assessed.ok) {
  console.error(
    assessed.reason === 'EMPTY' || assessed.reason === 'MALFORMED'
      ? '手机号格式不正确（示例：13800138000 或 +8613800138000）。'
      : '目前只支持中国大陆手机号。',
  );
  process.exit(2);
}

loadEnvFileOnce();

const nodeEnvRaw = (process.env['NODE_ENV'] ?? 'development').toLowerCase();
const nodeEnv =
  nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';

let settings;
try {
  settings = loadPhoneSettings(nodeEnv, process.env);
} catch (err) {
  console.error(`短信配置无效：${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

if (settings.transport !== 'aliyun' || settings.aliyun === undefined) {
  console.error('当前为 outbox 模式（未配置阿里云短信），不会真实发短信。');
  console.error(
    '请在 .env 中设置 SMS_TRANSPORT=aliyun、SMS_ALIYUN_ACCESS_KEY_ID、' +
      'SMS_ALIYUN_ACCESS_KEY_SECRET、SMS_ALIYUN_SIGN_NAME、SMS_ALIYUN_TEMPLATE_CODE 后重试。',
  );
  console.error('逐步配置见 docs/短信验证码-阿里云.md。');
  process.exit(2);
}

// 自检用的码：只发到操作者自己的手机，用来确认配置可用；不是任何账号的登录码。
const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

const transport = createAliyunSmsTransport({
  accessKeyId: settings.aliyun.accessKeyId,
  accessKeySecret: settings.aliyun.accessKeySecret,
  signName: settings.aliyun.signName,
  templateCode: settings.aliyun.templateCode,
  region: settings.aliyun.region,
});

transport.attachLogger({
  info: (obj, msg) => console.log(`· ${msg ?? ''}`, obj),
  debug: (obj, msg) => console.log(`· ${msg ?? ''}`, obj),
  error: (obj, msg) => console.error(`· ${msg ?? ''}`, obj),
});

console.log(
  `· 使用签名「${settings.aliyun.signName}」、模板 ${settings.aliyun.templateCode}、区域 ${settings.aliyun.region}`,
);

try {
  const result = await transport.send({
    toE164: assessed.e164,
    maskedTo: assessed.masked,
    code,
    purpose: 'sign-in',
    ttlSeconds: 300,
  });

  if (result.ok === true) {
    console.log(`· 阿里云已接受发送请求（${assessed.masked}）`);
    console.log(`· 自检验证码 ${code}，请勿用于登录；收到短信即说明配置可用`);
  } else {
    console.error(`· 发送失败：${result.failure}`);
    console.error('  分类含义见 docs/短信验证码-阿里云.md §4；厂商原文请到阿里云短信控制台「发送记录」查看。');
    process.exitCode = 1;
  }
} catch {
  console.error('· 发送失败：适配器抛出了未分类错误（不应发生，请检查配置）');
  process.exitCode = 1;
}
