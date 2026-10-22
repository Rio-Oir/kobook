// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Optional visual preview rendered above the label. */
  preview?: ReactNode;
};

/**
 * A segmented control whose selection is one gliding pill.
 *
 * The pill is a `layoutId` element shared by the three buttons, so switching
 * moves the highlight instead of blinking it off and on. The buttons keep
 * `aria-pressed`, so this is still a group of toggle buttons to assistive
 * tech rather than a fake radio group.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  className?: string;
}) {
  const layoutId = useId();
  return (
    <div
      role="group"
      aria-label={label}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      className={cn(
        "grid gap-1 rounded-xl border border-gloss-border bg-gloss-surface2/50 p-1",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex flex-col items-center gap-1.5 rounded-lg px-2 py-2 text-[11px]",
              "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40",
              active ? "text-gloss-text" : "text-gloss-textDim hover:text-gloss-text",
            )}
          >
            {active ? (
              <motion.span
                aria-hidden="true"
                layoutId={layoutId}
                initial={false}
                transition={spring.moderate}
                className="absolute inset-0 rounded-lg border border-gloss-border bg-gloss-surface shadow-sm"
              />
            ) : null}
            <span className="relative z-10 flex w-full flex-col items-center gap-1.5">
              {option.preview}
              <span className={active ? "font-medium" : undefined}>{option.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
