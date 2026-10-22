// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createMemoryChallengeStore, createMemoryRateLimiter } from "../src/server";
import { registerAdapterConformance } from "./conformance/adapter-conformance";

registerAdapterConformance({
  name: "memory reference conformance",
  async store() {
    const store = createMemoryChallengeStore();
    return { peers: [store, store], now: 1_700_000_000_000, async dispose() { store.clear(); } };
  },
  async limiter() {
    const limiter = createMemoryRateLimiter();
    return { peers: [limiter, limiter], now: 1_700_000_000_000, async dispose() { limiter.clear(); } };
  },
});
