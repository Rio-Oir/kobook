// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Install the value-added cloud implementation.
 *
 * Called once from `src/main.tsx`, before the app renders — that is the whole
 * of the coupling between this line and the base product's entry point. Base
 * never imports this file, and nothing here is reachable when it is not called,
 * which is what keeps "the base release has no accounts" a property of the
 * module graph rather than of a runtime flag.
 *
 * The function returns the registered adapter so a caller that needs to reason
 * about it (or unregister it) can; production ignores the return value.
 */

import { registerCloudAdapter, type CloudAdapter } from "./contract";
import { createGlossCloudAdapter } from "./adapter";

export function installCloudAdapter(): CloudAdapter {
  const adapter = createGlossCloudAdapter();
  registerCloudAdapter(adapter);
  return adapter;
}
