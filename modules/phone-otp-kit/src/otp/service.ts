// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The service: the only place the pieces are put in an order.
 *
 * ## What it does not do
 *
 * It does not create a user, look one up, update one, or issue a session. A
 * successful `verifyCode` returns `{ ok: true }` and nothing else. Deciding that
 * "whoever can read this number's SMS is the account owner" is a product
 * decision made by the integrator, in the integrator's own transaction, against
 * the integrator's own tables. Keeping that out is what makes this kit usable for
 * sign-in, sign-up, binding a number to an existing account, and account
 * recovery without a rewrite — and it is why the kit can be tested with no
 * database at all.
 *
 * ## The order of operations, and why
 *
 * `requestCode`:
 *
 * 1. purpose → 2. trusted client → 3. phone → 4. **charge the send budget** →
 * 5. generate the code → 6. reserve a challenge → 7. call the transport →
 * 8. publish or roll back.
 *
 * The budget is charged before the code exists and before the provider is
 * called, so a request that will be refused costs nothing and, more importantly,
 * a provider outage cannot be turned into free attempts.
 *
 * `verifyCode`:
 *
 * 1. purpose → 2. trusted client → 3. phone → 4. code shape → 5. **charge the
 * guess budget** → 6. one atomic store operation that compares and consumes.
 *
 * The guess budget is charged *before* the challenge is examined. Doing it after
 * would mean a caller could probe for which phones have a live challenge without
 * spending anything — the reference implementation's own comment explains why it
 * charges first ("a flood of forged challenge ids would spend the target phone's
 * budget for free", which turns a brute-force defence into a denial of service).
 * The cost of charging first is real and is recorded in the module README: a
 * caller who knows a victim's number can exhaust the victim's *verify* budget for
 * one window. That trade is deliberate — the per-challenge allowance is only
 * meaningful if a new code does not grant a fresh one.
 *
 * ## Failure is data
 *
 * Every expected failure is a returned `{ ok: false, code }` from the allowlist,
 * never an exception and never a message. Unexpected failures (a limiter that
 * cannot reach its store, a store that throws) become `INTERNAL`: the request is
 * denied, the provider is not called, and the original error is dropped rather
 * than attached. Nothing in this file reads a raw error's `message`.
 */

import { MAX_CODE_INPUT_LENGTH } from "../shared/constants";
import type { PhoneOtpResponseCode } from "../shared/errors";
import { assessPhone, type PhoneAssessment } from "../shared/phone";
import type {
  PhoneOtpFailure,
  PhoneOtpRequestResult,
  PhoneOtpVerifyResult,
} from "../shared/types";
import {
  describeResolvedConfig,
  resolvePhoneOtpConfig,
  type PhoneOtpConfig,
  type PhoneOtpObservation,
  type ResolvedPhoneOtpConfig,
} from "./config";
import { generateOtpCode } from "./crypto";
import type { OtpRateBucket, OtpRateScope } from "./limiter";
import {
  interpretSmsSendResult,
  isSmsFailureCode,
  toSafeSmsFailure,
  type SmsFailureCode,
  type SmsSendRequest,
} from "./sms";
import { codeHashFor } from "./store";

/**
 * Stand-in client reference used only when `requireTrustedClient` is explicitly
 * disabled and no reference was supplied. Every such request shares one bucket,
 * which is the conservative reading of "we cannot tell these callers apart".
 */
const SHARED_CLIENT_REF = "shared-untrusted-client";

export interface PhoneOtpServiceOptions {
  readonly config: PhoneOtpConfig;
  /**
   * The clock, in epoch milliseconds. Injectable so tests can advance time
   * without waiting; there is no other source of time in the module.
   */
  readonly now?: () => number;
}

export interface RequestCodeInput {
  readonly phone: string;
  /** Server-derived. `null`/`undefined` fails closed unless configured otherwise. */
  readonly clientRef: string | null | undefined;
  readonly purpose: string;
}

export interface VerifyCodeInput {
  readonly phone: string;
  readonly code: string;
  readonly clientRef: string | null | undefined;
  readonly purpose: string;
}

interface FailureExtras {
  readonly retryAfterMs?: number;
  readonly attemptsRemaining?: number;
  readonly smsFailure?: SmsFailureCode;
  readonly bucket?: OtpRateBucket;
  readonly scope?: OtpRateScope;
}

type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: SmsFailureCode };

export class PhoneOtpService {
  readonly #config: ResolvedPhoneOtpConfig;

  readonly #now: () => number;

  private constructor(config: ResolvedPhoneOtpConfig, now: () => number) {
    this.#config = config;
    this.#now = now;
  }

  /**
   * Validate the configuration and build the service.
   *
   * Throws `PhoneOtpKitError` for a bad configuration, including a test-only
   * component in a production runtime. There is no other way to build one: the
   * constructor is private, so a caller cannot skip validation.
   */
  static create(options: PhoneOtpServiceOptions): PhoneOtpService {
    const resolved = resolvePhoneOtpConfig(options.config);
    return new PhoneOtpService(resolved, options.now ?? Date.now);
  }

  /** `"production"` or `"test"`, as declared at construction. */
  get runtime(): ResolvedPhoneOtpConfig["runtime"] {
    return this.#config.runtime;
  }

  /** Redacted configuration summary for a startup log line. Contains no secret. */
  describe(): Record<string, unknown> {
    return describeResolvedConfig(this.#config);
  }

  /**
   * Issue a code for `purpose` to `phone`.
   *
   * The result never contains the code, the challenge id, or the full phone
   * number.
   */
  async requestCode(input: RequestCodeInput): Promise<PhoneOtpRequestResult> {
    try {
      return await this.#requestCode(input);
    } catch {
      return this.#internal("request-code");
    }
  }

  /**
   * Check a code and consume it.
   *
   * Success means "this caller could read `purpose`-scoped SMS for this phone".
   * It says nothing about accounts, and no session is issued.
   */
  async verifyCode(input: VerifyCodeInput): Promise<PhoneOtpVerifyResult> {
    try {
      return await this.#verifyCode(input);
    } catch {
      return this.#internal("verify-code");
    }
  }

  async #requestCode(input: RequestCodeInput): Promise<PhoneOtpRequestResult> {
    const config = this.#config;

    if (!config.allowedPurposes.has(input.purpose)) {
      return this.#fail("request-code", "INVALID_PURPOSE");
    }

    const clientValue = this.#clientValue(input.clientRef);
    if (clientValue === null) return this.#fail("request-code", "UNTRUSTED_CLIENT");

    const phone = assessPhone(input.phone);
    if (!phone.ok) return this.#phoneFailure("request-code", phone);

    const startedAt = this.#now();
    const phoneRef = config.hasher.phoneRef(phone.e164);
    const clientRef = config.hasher.clientRef(clientValue);

    const charged = await config.limiter.consume({
      bucket: "send",
      phoneRef,
      clientRef,
      now: startedAt,
      rules: config.limits,
    });
    if (!charged.allowed) {
      return this.#fail("request-code", "SEND_LIMITED", {
        retryAfterMs: charged.retryAfterMs,
        bucket: "send",
        ...(charged.scope === undefined ? {} : { scope: charged.scope }),
      });
    }

    const code = generateOtpCode(config.codeLength);
    const reservation = await config.store.beginChallenge({
      purpose: input.purpose,
      phoneRef,
      codeHash: codeHashFor(config.hasher, { purpose: input.purpose, phoneRef, code }),
      now: startedAt,
      ttlMs: config.codeTtlMs,
      maxAttempts: config.maxVerifyAttempts,
    });

    const send = await this.#send({
      toE164: phone.e164,
      maskedTo: phone.masked,
      code,
      purpose: input.purpose,
      ttlSeconds: Math.ceil(config.codeTtlMs / 1000),
      ...(config.smsTemplateId === undefined ? {} : { templateId: config.smsTemplateId }),
    });

    if (!send.ok) {
      // Roll back exactly this reservation. A revoke only ever removes its own
      // *pending* challenge, so it cannot reach a challenge another send has
      // already published.
      await this.#revokeQuietly(reservation.id, reservation.generation);
      // The budget is charged either way by default: an unrefunded failure is
      // what bounds how often a caller can make the kit talk to the provider.
      if (config.refundFailedSend) await this.#releaseQuietly({ phoneRef, clientRef, at: startedAt });
      return this.#fail("request-code", "SMS_SEND_FAILED", { smsFailure: send.failure });
    }

    // Read the clock again: publishing happens after the provider call, so a
    // reservation whose lifetime elapsed during that call must not go live.
    const published = await config.store.activateChallenge({
      id: reservation.id,
      generation: reservation.generation,
      now: this.#now(),
    });

    if (!published.activated) {
      await this.#revokeQuietly(reservation.id, reservation.generation);
      // Not `SMS_SEND_FAILED`: the provider accepted the message. What failed is
      // the reservation, so the delivered code is already dead. Reporting a
      // transport failure would be a lie, and reporting success would hand the
      // caller a code that cannot work.
      return this.#internal("request-code");
    }

    return {
      ok: true,
      maskedPhone: phone.masked,
      purpose: input.purpose,
      expiresAt: reservation.expiresAt,
      expiresInSeconds: Math.max(0, Math.ceil((reservation.expiresAt - startedAt) / 1000)),
      cooldownSeconds: Math.max(0, Math.ceil(config.sendCooldownMs / 1000)),
    };
  }

  async #verifyCode(input: VerifyCodeInput): Promise<PhoneOtpVerifyResult> {
    const config = this.#config;

    if (!config.allowedPurposes.has(input.purpose)) {
      return this.#fail("verify-code", "INVALID_PURPOSE");
    }

    const clientValue = this.#clientValue(input.clientRef);
    if (clientValue === null) return this.#fail("verify-code", "UNTRUSTED_CLIENT");

    const phone = assessPhone(input.phone);
    if (!phone.ok) return this.#phoneFailure("verify-code", phone);

    // Shape check before charging: a malformed code cannot match anything, and
    // rejecting it should not cost the user a guess. It costs the caller
    // nothing, but a caller probing shapes learns nothing either way — every
    // shape but the configured one is refused identically.
    const shape = new RegExp(`^\\d{${config.codeLength}}$`);
    if (
      typeof input.code !== "string" ||
      input.code.length > MAX_CODE_INPUT_LENGTH ||
      !shape.test(input.code)
    ) {
      return this.#fail("verify-code", "CODE_INVALID");
    }

    const now = this.#now();
    const phoneRef = config.hasher.phoneRef(phone.e164);
    const clientRef = config.hasher.clientRef(clientValue);

    const charged = await config.limiter.consume({
      bucket: "verify",
      phoneRef,
      clientRef,
      now,
      rules: config.limits,
    });
    if (!charged.allowed) {
      return this.#fail("verify-code", "VERIFY_LIMITED", {
        retryAfterMs: charged.retryAfterMs,
        bucket: "verify",
        ...(charged.scope === undefined ? {} : { scope: charged.scope }),
      });
    }

    const outcome = await config.store.consumeChallenge({
      purpose: input.purpose,
      phoneRef,
      codeHash: codeHashFor(config.hasher, {
        purpose: input.purpose,
        phoneRef,
        code: input.code,
      }),
      now,
    });

    switch (outcome.status) {
      case "consumed":
        return { ok: true, maskedPhone: phone.masked, purpose: input.purpose };
      case "mismatch":
        return this.#fail("verify-code", "CODE_INVALID", {
          attemptsRemaining: outcome.attemptsRemaining,
        });
      case "too_many_attempts":
        return this.#fail("verify-code", "TOO_MANY_ATTEMPTS", { attemptsRemaining: 0 });
      case "expired":
        return this.#fail("verify-code", "CODE_EXPIRED");
      case "absent":
        // Merged with a wrong code on purpose. Distinguishing "no challenge"
        // from "wrong code" is the challenge-existence oracle the reference
        // implementation exposed by returning a challenge id to the client and
        // reporting `OTP_NOT_FOUND` separately; here the id never leaves the
        // store and both cases are one answer.
        return this.#fail("verify-code", "CODE_INVALID");
    }
  }

  #phoneFailure(
    operation: PhoneOtpObservation["operation"],
    phone: Extract<PhoneAssessment, { ok: false }>,
  ): PhoneOtpFailure {
    const code: PhoneOtpResponseCode =
      phone.reason === "EMPTY" || phone.reason === "MALFORMED"
        ? "INVALID_PHONE"
        : "UNSUPPORTED_PHONE";
    return this.#fail(operation, code);
  }

  /**
   * Resolve the client reference, or `null` when the request must be refused.
   *
   * The default (`requireTrustedClient: true`) refuses a missing or malformed
   * reference before anything is read or written — no budget charged, no
   * challenge reserved, no provider call. The kit cannot tell whether a value it
   * was handed is trustworthy, so "I do not have one" has to mean "refuse",
   * otherwise the client scope silently degrades to a shared bucket while the
   * caller believes they are limiting per client.
   */
  #clientValue(raw: string | null | undefined): string | null {
    const config = this.#config;
    if (typeof raw === "string" && config.clientRefPattern.test(raw)) return raw;
    return config.requireTrustedClient ? null : SHARED_CLIENT_REF;
  }

  async #send(request: SmsSendRequest): Promise<SendOutcome> {
    let value: unknown;
    try {
      value = await this.#config.transport.send(request);
    } catch (error) {
      // Classification only. The thrown value is never read for text, never
      // attached and never logged: `toSafeSmsFailure` does not look inside it.
      return { ok: false, failure: toSafeSmsFailure(error) };
    }
    // The transport is external code, so its *result* is checked rather than
    // trusted: `ok` must be exactly `true` and `failure` must be a known code.
    return interpretSmsSendResult(value);
  }

  async #revokeQuietly(id: string, generation: number): Promise<void> {
    try {
      await this.#config.store.revokeChallenge({ id, generation, now: this.#now() });
    } catch {
      // The challenge is `pending`, so it is unusable and will expire on its
      // own. Failing the rollback must not replace the real error with a
      // bookkeeping one.
    }
  }

  async #releaseQuietly(input: {
    readonly phoneRef: string;
    readonly clientRef: string;
    readonly at: number;
  }): Promise<void> {
    try {
      await this.#config.limiter.release({ bucket: "send", ...input });
    } catch {
      // Same rule as the revoke: a bookkeeping failure must not change which
      // error the caller sees. The cost is one unrefunded budget slot.
    }
  }

  #fail(
    operation: PhoneOtpObservation["operation"],
    code: PhoneOtpResponseCode,
    extras: FailureExtras = {},
  ): PhoneOtpFailure {
    this.#observe({
      operation,
      code,
      ...(extras.smsFailure === undefined ? {} : { smsFailure: extras.smsFailure }),
      ...(extras.bucket === undefined ? {} : { bucket: extras.bucket }),
      ...(extras.scope === undefined ? {} : { scope: extras.scope }),
    });
    // The *returned* failure carries no bucket or scope: which budget refused a
    // request is operator information, not something a client should be handed.
    return {
      ok: false,
      code,
      ...(extras.retryAfterMs === undefined ? {} : { retryAfterMs: extras.retryAfterMs }),
      ...(extras.attemptsRemaining === undefined
        ? {}
        : { attemptsRemaining: extras.attemptsRemaining }),
    };
  }

  #internal(operation: PhoneOtpObservation["operation"]): PhoneOtpFailure {
    this.#observe({ operation, code: "INTERNAL" });
    return { ok: false, code: "INTERNAL" };
  }

  /**
   * The single sink for the operator hook, and the reason it is a sink.
   *
   * Everything passed in here is re-checked against the allowlists rather than
   * assumed to be safe because the caller is this file. The observation is the
   * one value an integrator is invited to log, so the check belongs at the point
   * it is handed over, not at each of the call sites that build one.
   */
  #observe(observation: PhoneOtpObservation): void {
    const hook = this.#config.onError;
    if (hook === undefined) return;
    try {
      hook({
        operation: observation.operation,
        code: observation.code,
        ...(isSmsFailureCode(observation.smsFailure) ? { smsFailure: observation.smsFailure } : {}),
        ...(observation.bucket === undefined ? {} : { bucket: observation.bucket }),
        ...(observation.scope === undefined ? {} : { scope: observation.scope }),
      });
    } catch {
      // An operator hook that throws must not change a request's outcome.
    }
  }
}
