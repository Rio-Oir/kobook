// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Motion tokens.
 *
 * Three spring speeds, borrowed from the Fluid Functionalism system: the
 * bigger the surface that moves, the slower it should settle. A dialog is a
 * large surface, so it uses `moderate`; a switch thumb or a segmented
 * indicator is small and uses `fast`.
 *
 * Exits are deliberately *not* springs. A spring replaying backwards reads
 * as "undo"; a short tween reads as "gone". Every dismissible surface pairs
 * its spring entrance with `exit`.
 *
 * `MotionConfig reducedMotion="user"` (mounted in `App.tsx`) turns the
 * transforms off for people who ask the OS for reduced motion while leaving
 * the opacity fades, which still aid comprehension.
 */

import type { Transition } from "motion/react";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const spring: Record<"fast" | "moderate" | "slow", Transition> = {
  fast: { type: "spring", stiffness: 520, damping: 36, mass: 0.6 },
  moderate: { type: "spring", stiffness: 380, damping: 32, mass: 0.9 },
  slow: { type: "spring", stiffness: 260, damping: 30, mass: 1 },
};

/** Entering surfaces: opacity + transform, settled by a spring. */
export const enterFade: Transition = { duration: 0.2, ease: EASE_OUT };

/** Leaving surfaces: short, linear-ish, so a close never feels replayed. */
export const exitFade: Transition = { duration: 0.13, ease: [0.4, 0, 1, 1] };
