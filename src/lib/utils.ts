// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tiny utilities shared across pages.

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names and let the last Tailwind utility win.
 *
 * This is the one place class strings are composed: `components/ui/*` take a
 * `className` prop and run it through here, so a caller can pass layout
 * (`mt-4`, `w-full`) without worrying about specificity, and a variant's
 * colour never ends up fighting a passed `bg-*`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "invalid";
  }
}
