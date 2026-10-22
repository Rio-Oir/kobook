// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useId } from "react";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A switch built on a real `<input type="checkbox">`.
 *
 * The native control stays in the DOM (transparent, covering the whole
 * track) instead of a `role="switch"` button: it keeps label-click, keyboard
 * and form semantics for free, and it is what the BYOK browser suite
 * asserts on. The track and thumb are decoration on top of it.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
  className,
  testId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  /**
   * Passed to the native checkbox, not the wrapper: the browser suites drive
   * these by test id, and the input is the element that actually carries the
   * state being asserted.
   */
  testId?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <label htmlFor={inputId} className="cursor-pointer select-none">
        <span className="block text-xs font-medium text-gloss-text">{label}</span>
        {description ? (
          <span className="mt-1 block text-[11px] leading-relaxed text-gloss-textDim/80">
            {description}
          </span>
        ) : null}
      </label>
      <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          data-testid={testId}
          className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden="true"
          className={cn(
            "h-5 w-9 rounded-full bg-gloss-outline/60 transition-colors duration-200 ease-out",
            "peer-checked:bg-gloss-accent peer-focus-visible:ring-2 peer-focus-visible:ring-gloss-accent/40",
            "peer-disabled:opacity-50",
          )}
        />
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm"
          animate={{ x: checked ? 16 : 0 }}
          transition={spring.fast}
        />
      </span>
    </div>
  );
}
