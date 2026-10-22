// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `phone-otp-kit/browser` — the browser half of the kit.
 *
 * Everything reachable from here is DOM-safe and dependency-light: the shared
 * pure modules (phone normalisation, the error allowlist, the response types)
 * plus the React panel and its copy. No `node:` import is reachable — a test
 * walks the graph to prove it, because "we were careful" is not a property that
 * survives the next refactor.
 *
 * The kit ships no network client by design. `onRequestCode` and `onVerifyCode`
 * are supplied by the host application and are where its own transport lives.
 */

export * from "./shared/constants";
export * from "./shared/errors";
export * from "./shared/phone";
export * from "./shared/types";

export {
  PhoneOtpPanel,
  type PhoneOtpPanelProps,
  type PhoneOtpPanelRequestInput,
  type PhoneOtpPanelVerifyInput,
} from "./ui/PhoneOtpPanel";
export * from "./ui/messages";
