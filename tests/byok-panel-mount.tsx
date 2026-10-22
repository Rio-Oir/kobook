// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Mount hook for the BYOK browser suite.
 *
 * The settings form's *behaviour* — when it asks before moving the
 * credential to a new origin, and what it does with the answer — is only
 * observable in a real DOM, so `tests/byok-browser.mjs` renders the real
 * component here instead of re-implementing its logic. Vite serves this file
 * and transforms its JSX like any other module in the project; nothing in
 * `src/` imports it, so it is not part of the app bundle.
 *
 * It mounts `SettingsView` (the form), not the page chrome: the page adds a
 * header and a back button that have nothing to do with credential
 * behaviour, and the harness only ever drives fields.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import SettingsView from "@/components/SettingsView";

export function mountSettingsPanel(): { unmount: () => void } {
  const host = document.createElement("div");
  host.id = "byok-settings-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(SettingsView));
  return {
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
