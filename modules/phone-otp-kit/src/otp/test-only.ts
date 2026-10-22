// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The test-only brand.
 *
 * Memory stores, the in-process limiter and the fake SMS transport exist so the
 * module can be tested without a database, a network or a paid provider. The
 * failure mode to design against is not "someone imports the memory store" —
 * it is "a production process starts with it wired in because a config value
 * was missing and a default filled the gap".
 *
 * So the marker is *on the component*, not on the configuration, and the
 * configuration is what declares the runtime. `createPhoneOtpService` refuses
 * `runtime: "production"` if any wired component carries the brand. There is no
 * override flag: the only way to get a production service is to supply
 * production components.
 *
 * `Symbol.for` is used rather than `Symbol()` so the brand survives two copies
 * of this module being loaded in one process (a bundler edge case); a duck-typed
 * string key would be forgeable by accident through object spread.
 */

export const TEST_ONLY_BRAND = Symbol.for("phone-otp-kit.test-only");

export interface TestOnlyComponent {
  readonly [TEST_ONLY_BRAND]: true;
}

/** The runtime this kit is constructed for. There is no default. */
export type PhoneOtpRuntime = "production" | "test";

/**
 * Mark a component as usable only outside production. Called by the factories
 * in this module; an integrator writing their own adapter must not call it —
 * their adapter needs to work in production, which is the point of it.
 */
export function brandTestOnly<T extends object>(component: T): T & TestOnlyComponent {
  Object.defineProperty(component, TEST_ONLY_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return component as T & TestOnlyComponent;
}

export function isTestOnlyComponent(value: unknown): value is TestOnlyComponent {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<symbol, unknown>)[TEST_ONLY_BRAND] === true;
}
