// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `phone-otp-kit/server` — the server half of the kit.
 *
 * Importing this entry pulls in `node:crypto`. It must not be reachable from a
 * browser bundle: `browser.ts` is the entry for that, and the two share only the
 * pure modules under `src/shared/`. The split is enforced by a test
 * (`tests/hygiene.test.ts`) that walks this module's import graph and fails if a
 * browser entry can reach a `node:` builtin, or a server entry can reach React.
 */

export * from "./shared/constants";
export * from "./shared/errors";
export * from "./shared/phone";
export * from "./shared/types";

export * from "./otp/config";
export * from "./otp/crypto";
export * from "./otp/fake-sms";
export * from "./otp/limiter";
export * from "./otp/memory-limiter";
export * from "./otp/memory-store";
export * from "./otp/service";
export * from "./otp/sms";
export * from "./otp/store";
export * from "./otp/test-only";
