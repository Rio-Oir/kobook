// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A promise-chain mutex.
 *
 * The in-memory store and limiter have to behave like the atomic primitives
 * they stand in for (a Redis Lua script, a `SELECT … FOR UPDATE`). JavaScript
 * gives no atomicity across an `await`: two `consume` calls can both read
 * `attempts: 4`, both decide "not exhausted", and both write back — the exact
 * race the reference implementation's Lua script exists to close.
 *
 * So every mutating entry point runs its whole read-decide-write sequence
 * inside `run()`. Calls are serialised in arrival order, and a rejection does
 * not poison the chain — the next caller still gets to run.
 *
 * This is a *test-only* implementation strategy. It serialises one process, so
 * it says nothing about two processes sharing a database, which is exactly why
 * the production adapters have to be written against a real atomic primitive
 * rather than pretending this one scales.
 */

export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  /** Run `task` once every previously queued task has settled. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    // Keep the chain alive regardless of this task's outcome; callers see the
    // rejection through `result`.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
