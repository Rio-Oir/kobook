// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The fake SMS transport.
 *
 * Records what would have been sent and returns success. It is the only
 * transport this module contains, it performs no I/O of any kind, and it is
 * branded test-only so `runtime: "production"` refuses it. A development
 * deployment runs it with `runtime: "test"`; a production deployment must supply
 * the integrator's real adapter or fail at construction.
 *
 * The outbox holds plaintext codes, because a test that cannot read the code
 * cannot test verification. That is also why `outbox` is the only place in the
 * kit where a plaintext code is retained: it exists to be asserted against and
 * then thrown away, not to be read at runtime.
 */

import { brandTestOnly, TEST_ONLY_BRAND, type TestOnlyComponent } from "./test-only";
import type { SmsFailureCode, SmsSendRequest, SmsSendResult, SmsTransport } from "./sms";

export interface FakeSmsOutboxEntry {
  readonly toE164: string;
  readonly maskedTo: string;
  readonly code: string;
  readonly purpose: string;
  readonly sentAt: number;
  readonly templateId?: string;
  /** `false` when the scripted outcome was a refusal. */
  readonly delivered: boolean;
  readonly failure?: SmsFailureCode;
}

export interface FakeSmsTransportOptions {
  /**
   * Scripted outcome per call. Return `undefined` (or nothing) to accept.
   * Returning `{ ok: false, failure }` simulates a provider refusal that did not
   * throw; throwing simulates a provider whose error the adapter let escape.
   */
  readonly onSend?: (
    request: SmsSendRequest,
    callIndex: number,
  ) => SmsSendResult | undefined | Promise<SmsSendResult | undefined>;
  /**
   * The clock for `sentAt`. There is deliberately no default: the fake never
   * reads the wall clock, so a test that asserts on `sentAt` has to say what
   * time it is. Entries are stamped `0` otherwise, which is obviously not a
   * real timestamp rather than plausibly one.
   */
  readonly now?: () => number;
}

export interface FakeSmsTransport extends SmsTransport, TestOnlyComponent {
  readonly outbox: readonly FakeSmsOutboxEntry[];
  /** The most recent attempt, delivered or not. */
  latest(): FakeSmsOutboxEntry | undefined;
  /** Remove and return everything recorded so far. */
  drain(): readonly FakeSmsOutboxEntry[];
  clear(): void;
}

class FakeTransport implements FakeSmsTransport {
  declare readonly [TEST_ONLY_BRAND]: true;

  readonly kind = "fake";

  #entries: FakeSmsOutboxEntry[] = [];

  readonly #options: FakeSmsTransportOptions;

  constructor(options: FakeSmsTransportOptions) {
    this.#options = options;
  }

  async send(request: SmsSendRequest): Promise<SmsSendResult> {
    const callIndex = this.#entries.length;
    const scripted = await this.#options.onSend?.(request, callIndex);
    const at = this.#options.now?.() ?? 0;

    if (scripted !== undefined && !scripted.ok) {
      this.#record(request, at, scripted.failure);
      return scripted;
    }

    this.#record(request, at, undefined);
    return { ok: true };
  }

  get outbox(): readonly FakeSmsOutboxEntry[] {
    return this.#entries;
  }

  latest(): FakeSmsOutboxEntry | undefined {
    return this.#entries.at(-1);
  }

  drain(): readonly FakeSmsOutboxEntry[] {
    const drained = this.#entries;
    this.#entries = [];
    return drained;
  }

  clear(): void {
    this.#entries = [];
  }

  #record(request: SmsSendRequest, at: number, failure: SmsFailureCode | undefined): void {
    this.#entries.push({
      toE164: request.toE164,
      maskedTo: request.maskedTo,
      code: request.code,
      purpose: request.purpose,
      sentAt: at,
      ...(request.templateId === undefined ? {} : { templateId: request.templateId }),
      delivered: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
    });
  }
}

/** Create the fake transport. Test-only; refused by a `production` configuration. */
export function createFakeSmsTransport(options: FakeSmsTransportOptions = {}): FakeSmsTransport {
  return brandTestOnly(new FakeTransport(options));
}
