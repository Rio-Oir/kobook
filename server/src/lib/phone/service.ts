// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Assembly of the phone verification service.
 *
 * The kit owns the order of operations (charge the budget, generate, reserve,
 * send, publish-or-roll-back) and the error vocabulary. This file only decides
 * *which* components it runs on, from the loaded settings:
 *
 * | environment            | store               | limiter            | transport |
 * | ---------------------- | ------------------- | ------------------ | --------- |
 * | development / test     | PostgreSQL table    | in-process windows | outbox    |
 * | production             | PostgreSQL table    | in-process windows | Aliyun    |
 *
 * The store is the durable one in every environment, which is deliberate: the
 * acceptance run and a local developer exercise the same transaction and
 * advisory-lock path as production, so "it worked in the test" means something.
 * A second replica would need the limiter moved to a shared store; that is a
 * deployment task, recorded rather than hidden behind a flag.
 */

import type { NodeEnv } from "../../env.js";
import type { AppPrisma } from "../../db.js";
import { PhoneOtpService } from "../../../../modules/phone-otp-kit/src/otp/service.js";
import type { PhoneOtpObservation } from "../../../../modules/phone-otp-kit/src/otp/config.js";
import { createAliyunSmsTransport } from "./aliyun.js";
import { PHONE_OTP_PURPOSES, type PhoneSettings } from "./config.js";
import { createProcessRateLimiter, type ProcessRateLimiter } from "./limiter.js";
import { createSmsOutbox, type SmsOutboxTransport } from "./outbox.js";
import { createPrismaChallengeStore, type PrismaChallengeStore } from "./store.js";
import type { SmsLogger, SmsTransportHandle } from "./transport.js";

export interface PhoneRuntime {
  service: PhoneOtpService;
  store: PrismaChallengeStore;
  limiter: ProcessRateLimiter;
  /** Present exactly when the outbox transport is wired in. */
  outbox?: SmsOutboxTransport;
  /** Attached after the Fastify app exists, like the mail outbox. */
  attachLogger(log: SmsLogger): void;
  close(): void;
}

export interface PhoneRuntimeOptions {
  settings: PhoneSettings;
  nodeEnv: NodeEnv;
  prisma: AppPrisma;
}

export function createPhoneRuntime(options: PhoneRuntimeOptions): PhoneRuntime {
  const { settings, nodeEnv, prisma } = options;

  const store = createPrismaChallengeStore(prisma);
  const limiter = createProcessRateLimiter();

  const outbox = settings.transport === "outbox"
    ? createSmsOutbox({ logCodes: nodeEnv === "development" })
    : undefined;

  const transport: SmsTransportHandle = outbox ?? createAliyunSmsTransport({
    accessKeyId: settings.aliyun?.accessKeyId ?? "",
    accessKeySecret: settings.aliyun?.accessKeySecret ?? "",
    signName: settings.aliyun?.signName ?? "",
    templateCode: settings.aliyun?.templateCode ?? "",
    region: settings.aliyun?.region ?? "cn-hangzhou",
  });

  // The kit has no logger of its own on purpose; this hook is where the
  // operator signal goes. Nothing here can carry a phone number or a code —
  // the observation type has no field for either.
  let logSink: SmsLogger | undefined;
  const onError = (observation: PhoneOtpObservation): void => {
    logSink?.info(
      {
        operation: observation.operation,
        code: observation.code,
        ...(observation.smsFailure === undefined ? {} : { smsFailure: observation.smsFailure }),
        ...(observation.bucket === undefined ? {} : { bucket: observation.bucket }),
        ...(observation.scope === undefined ? {} : { scope: observation.scope }),
      },
      "phone OTP request refused",
    );
  };

  const service = PhoneOtpService.create({
    config: {
      // "test" covers development and CI in the kit's vocabulary: both mean
      // "not production", and the only thing the value gates is whether a
      // test-only component may be wired in.
      runtime: nodeEnv === "production" ? "production" : "test",
      secret: settings.otpSecret,
      allowedPurposes: PHONE_OTP_PURPOSES,
      store,
      limiter,
      transport,
      codeLength: settings.codeLength,
      codeTtlMs: settings.codeTtlMs,
      maxVerifyAttempts: settings.maxVerifyAttempts,
      requireTrustedClient: true,
      // The resend gate is configuration; the hourly ceiling and every guess
      // budget keep the kit's defaults. Only the first phone-scope rule is
      // overridden, so a deployment can loosen "one a minute" without also
      // loosening the hourly or the verify budgets.
      limits: {
        send: {
          phone: [
            { limit: settings.sendPhoneLimit, windowMs: settings.sendPhoneWindowMs },
            { limit: 5, windowMs: 60 * 60_000 },
          ],
          client: [
            { limit: settings.sendClientLimit, windowMs: settings.sendClientWindowMs },
            { limit: 50, windowMs: 60 * 60_000 },
          ],
        },
      },
      onError,
    },
  });

  return {
    service,
    store,
    limiter,
    ...(outbox === undefined ? {} : { outbox }),
    attachLogger(log: SmsLogger): void {
      logSink = log;
      outbox?.attachLogger(log);
      transport.attachLogger?.(log);
    },
    close(): void {
      transport.close?.();
    },
  };
}
