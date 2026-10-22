// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Narrowing helpers for the result unions.
 *
 * `assert.equal(result.ok, true)` does not narrow in TypeScript, and a cast to
 * the success branch at every call site is how a test ends up reading
 * `result.maskedPhone` off a failure. These throw with the whole result, so a
 * failing assertion reports what actually came back.
 */

export function ok<T extends { ok: boolean }>(value: T): Extract<T, { ok: true }> {
  if (!value.ok) {
    throw new Error(`expected a success result, received: ${JSON.stringify(value)}`);
  }
  return value as Extract<T, { ok: true }>;
}

export function notOk<T extends { ok: boolean }>(value: T): Extract<T, { ok: false }> {
  if (value.ok) {
    throw new Error(`expected a failure result, received: ${JSON.stringify(value)}`);
  }
  return value as Extract<T, { ok: false }>;
}
