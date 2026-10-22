// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ArrowLeft } from "lucide-react";
import SettingsView from "@/components/SettingsView";
import { navigate } from "@/lib/navigate";

/**
 * The settings page reached from the header menu.
 *
 * It is a page, not a modal: the form is tall enough that a centered
 * overlay ended up nearly full-height and had to scroll inside itself,
 * which is worse than just scrolling the page.
 *
 * Back uses real history when there is any, so opening settings from a
 * reader returns to that reader; a deep link falls back to the home page.
 */
export default function Settings() {
  function goBack() {
    if (window.history.length > 1) window.history.back();
    else navigate("#/");
  }

  return (
    <div className="min-h-screen bg-gloss-bg text-gloss-text">
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <header className="mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            aria-label="返回"
            className="grid size-8 place-items-center rounded-lg text-gloss-textDim transition-colors hover:bg-gloss-text/[0.06] hover:text-gloss-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
          <h1 className="font-serif text-2xl leading-tight">设置</h1>
        </header>

        <SettingsView />
      </div>
    </div>
  );
}
