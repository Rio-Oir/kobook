// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Hashing, randomness and constant-time comparison.
 *
 * Four decisions worth stating, because each one is a place the reference
 * design could have been copied and should not have been:
 *
 * 1. **HMAC, not a bare digest.** A six-digit code has 1e6 possible values; an
 *    unsalted SHA-256 of one is recoverable by hashing all of them, and the
 *    result is then usable against every deployment that shares the digest. The
 *    same argument applies to the phone number, which is {country code} +
 *    {a few million live numbers}.
 * 2. **Domain separation, via an intermediate key.** Each purpose gets its own
 *    derived key (`HMAC(secret, "phone-otp-kit/v1/" + domain)`) rather than
 *    reusing one key with a prefix string glued into the message. A prefix is
 *    only separation if no two prefixes can produce the same message, which
 *    requires the caller to be careful forever; a derived key makes it
 *    structural.
 * 3. **The code is bound to purpose *and* phone.** The message is
 *    `purpose \0 phoneRef \0 code`, so a code issued for one purpose on one
 *    number cannot be presented for another, and a challenge row cannot be moved
 *    between them by an adapter mistake. The digest is *not* additionally bound
 *    to a per-challenge nonce — see the note on `codeHash` for what that does and
 *    does not leave open.
 * 4. **Randomness comes from `node:crypto`.** `randomInt` is rejection-sampled
 *    and unbiased; `Math.random` is neither. Challenge ids are 144 bits from
 *    `randomBytes`, with a readable prefix so they are recognisable in a log.
 *
 * Nothing here reads the environment or the clock. The secret arrives as a
 * constructor argument; time arrives as a parameter.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { MIN_SECRET_BYTES, OTP_CODE_LENGTH } from "../shared/constants";
import { PhoneOtpKitError } from "../shared/errors";

/** The independent-key domains this kit uses. Adding one changes no existing hash. */
export const HASH_DOMAINS = ["phone-ref", "client-ref", "otp-code"] as const;

export type HashDomain = (typeof HASH_DOMAINS)[number];

const KIT_DOMAIN_TAG = "phone-otp-kit/v1";

/**
 * Normalise and check secret material.
 *
 * The 32-byte minimum is a **policy**, not a finding: it selects a 256-bit key length
 * for this module. Length does not establish entropy. Shorter keys are
 * refused because a deployment that picked one by accident has no way to notice,
 * not because this module has measured a boundary below which a key falls.
 *
 * Length is the only property checked. Whether the bytes are actually secret and
 * unguessable is the deployment's responsibility — this function cannot tell a
 * generated key from a memorable phrase.
 */
export function toSecretBytes(secret: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (typeof secret === "string") {
    bytes = new TextEncoder().encode(secret);
  } else if (secret instanceof Uint8Array) {
    bytes = Uint8Array.from(secret);
  } else {
    throw new PhoneOtpKitError("WEAK_SECRET", { field: "secret", minBytes: MIN_SECRET_BYTES });
  }

  if (bytes.length < MIN_SECRET_BYTES) {
    throw new PhoneOtpKitError("WEAK_SECRET", { field: "secret", minBytes: MIN_SECRET_BYTES });
  }
  return bytes;
}

export interface OtpHasher {
  /** `+8613800138000` → opaque reference. What stores and limiters ever see. */
  phoneRef(e164: string): string;
  /** A trusted client identifier → opaque reference. */
  clientRef(clientRef: string): string;
  /** Hash of a code, bound to the purpose and phone it was issued for. */
  codeHash(input: { readonly purpose: string; readonly phoneRef: string; readonly code: string }): string;
}

function hash(secret: Uint8Array, domain: HashDomain, message: string): string {
  const derivedKey = createHmac("sha256", secret)
    .update(`${KIT_DOMAIN_TAG}/${domain}`)
    .digest();
  return createHmac("sha256", derivedKey).update(message, "utf8").digest("hex");
}

/**
 * Build the hasher for a validated secret. Call `toSecretBytes` first.
 *
 * ## What `codeHash` binds, and what it does not
 *
 * The message is `purpose \0 phoneRef \0 code`. It is **not** bound to the
 * challenge instance: two challenges for the same purpose and number that happen
 * to receive the same random code produce the **same digest**. With a 6-digit
 * code and independent draws that is a 1-in-10^6 coincidence, and it is worth
 * being precise about what follows from it:
 *
 * - It is **not** a replay: the previous challenge is deleted when the new one is
 *   activated (`activateChallenge` supersedes), so there is no older row holding
 *   that digest to be matched against. Only the live challenge can be consumed.
 * - It is **not** an amplification: an attacker who learned the earlier code
 *   gains nothing they would not gain by learning the current one, which is the
 *   same string in this case.
 * - What it does mean is that a resend is **not guaranteed** to invalidate a code
 *   the user already read, only the *challenge* that issued it. A deployment that
 *   needs "the code always changes" has to bind a per-challenge nonce, which
 *   would also require looking the nonce up before verification — a store call
 *   this module deliberately does not make.
 */
export function createOtpHasher(secret: unknown): OtpHasher {
  const bytes = toSecretBytes(secret);
  return {
    phoneRef: (e164) => hash(bytes, "phone-ref", e164),
    clientRef: (clientRef) => hash(bytes, "client-ref", clientRef),
    codeHash: ({ purpose, phoneRef, code }) =>
      hash(bytes, "otp-code", `${purpose}\u0000${phoneRef}\u0000${code}`),
  };
}

/**
 * A uniformly distributed decimal code.
 *
 * `randomInt(0, 10 ** length)` is rejection-sampled by Node's CSPRNG, then
 * zero-padded so every code is exactly `length` characters — a code with
 * leading zeros is still a code, and `parseInt`-shaped storage would silently
 * shorten it.
 *
 * Each call is an independent draw, so **consecutive codes are not guaranteed to
 * differ**: with a 6-digit code the chance of a repeat across a resend is 1 in
 * 10^6. Nothing here relies on them differing; `createOtpHasher` records why that
 * is acceptable and what it rules out.
 */
export function generateOtpCode(length: number = OTP_CODE_LENGTH): string {
  if (!Number.isSafeInteger(length) || length < 4 || length > 10) {
    throw new PhoneOtpKitError("INVALID_CONFIG", { field: "codeLength" });
  }
  return randomInt(0, 10 ** length).toString().padStart(length, "0");
}

/** 144 bits of randomness with a readable prefix. Never derived from time or a counter. */
export function generateChallengeId(): string {
  return `oc_${randomBytes(18).toString("base64url")}`;
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * Length mismatch returns `false` without comparing, and an unparseable or
 * empty digest never compares equal — a malformed stored hash must fail closed,
 * not accidentally match an empty probe.
 */
export function constantTimeEqualHex(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || a.length !== b.length) return false;
  if (a.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
