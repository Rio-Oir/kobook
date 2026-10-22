// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Who the header shows, and what they look like.
 *
 * Two things live here on purpose, both of them temporary seams:
 *
 *   1. `avatarFor` — until the account profile ships an avatar library, a
 *      reader gets one of six bundled placeholder SVGs. The pick is stable
 *      per identity (a hash of id → email → phone), so the avatar does not
 *      change on every render. Replacing this function's body with the real
 *      library is the whole migration; call sites stay put.
 *
 *   2. `shortName` — the header has room for a few characters, not an email
 *      address. The account page is still being built (nickname, profile),
 *      so this derives the best short label available today and falls back
 *      to 读者 for phone-only accounts. When the profile lands, pass the
 *      nickname in and the same call sites get it.
 */

import avatar01 from "@/assets/avatars/avatar-01.svg";
import avatar02 from "@/assets/avatars/avatar-02.svg";
import avatar03 from "@/assets/avatars/avatar-03.svg";
import avatar04 from "@/assets/avatars/avatar-04.svg";
import avatar05 from "@/assets/avatars/avatar-05.svg";
import avatar06 from "@/assets/avatars/avatar-06.svg";

const AVATARS = [avatar01, avatar02, avatar03, avatar04, avatar05, avatar06];

export interface ProfileSeed {
  id?: string | null;
  email?: string | null;
  phone?: string | null;
  nickname?: string | null;
}

/** FNV-1a. Tiny, deterministic, good enough to spread 6 buckets. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function identityKey(seed: ProfileSeed): string {
  return seed.id || seed.nickname || seed.email || seed.phone || "anonymous";
}

/** A stable placeholder avatar for whoever is signed in. */
export function avatarFor(seed: ProfileSeed): string {
  return AVATARS[hash(identityKey(seed)) % AVATARS.length];
}

const CJK = /[\u3400-\u9fff]/;

/** Trim a label to what the header can hold without ellipsis. */
function clip(value: string): string {
  const chars = Array.from(value.trim());
  const limit = CJK.test(value) ? 4 : 8;
  return chars.slice(0, limit).join("");
}

/**
 * The few characters shown beside the avatar.
 *
 * Order: explicit nickname → email local part (unless it is a phone number
 * in disguise) → 读者. A phone-only account's synthetic email local part is
 * all digits or starts with `+`, which would read as a number rather than a
 * name, so it falls through to the sane default.
 */
export function shortName(seed: ProfileSeed): string {
  const nickname = seed.nickname?.trim();
  if (nickname) return clip(nickname);

  const local = seed.email?.split("@")[0]?.trim();
  if (local && !/^[+\d]/.test(local)) return clip(local);

  return "读者";
}
