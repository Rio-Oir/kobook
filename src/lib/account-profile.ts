// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The account service's own profile fields, read by the account page.
 *
 * ## Why this exists instead of a field on the session
 *
 * Base deliberately narrowed the session shape that crosses the seam
 * (`CloudSessionUser`: id, email, verification, role) — "anything else is the
 * adapter's business and must not leak into base types". The display name is
 * exactly that: it is the account page's business, it is not needed to stamp a
 * cache or render a header, and widening a base-owned contract for it would
 * make every future merge from `codex/base` conflict on that line.
 *
 * So the one screen that shows it asks for it, once, through the same account
 * API the rest of this line uses. Nothing is cached beyond the component's own
 * state, so a rename is visible on the next visit and no stale name survives a
 * sign-out.
 *
 * The request carries no credential: it is a same-origin `GET /api/me` whose
 * authorisation is the session cookie, exactly like every other account call.
 * A BYOK key is never read here and never attached to a request built here.
 */

import { ROUTES, type MeResponse } from "./cloud/contracts";
import { apiRequest } from "./api-error";

export interface AccountProfile {
  /** The account's display name, non-empty and trimmed. */
  name: string;
  /**
   * The bound phone number, or null. Also "the adapter's business": base's
   * session shape does not carry it, and this page is the only screen that
   * shows it. The server only ever reports a number that a verification code
   * proved, so it is safe to render.
   */
  phoneNumber: string | null;
}

/**
 * Fetch the signed-in account's profile, or `null`.
 *
 * Degrades to `null` on any failure — a 401, a 500, a malformed body — because
 * the caller uses it for a label and a missing label must never turn into an
 * error state on a page that otherwise works.
 */
export async function fetchAccountProfile(): Promise<AccountProfile | null> {
  let body: MeResponse;
  try {
    body = await apiRequest<MeResponse>(ROUTES.me);
  } catch {
    return null;
  }
  const name = body?.user?.name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const phone = body?.user?.phoneNumber;
  return {
    name: trimmed,
    phoneNumber: typeof phone === "string" && phone.length > 0 ? phone : null,
  };
}
