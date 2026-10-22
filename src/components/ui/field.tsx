// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ChevronDown } from "lucide-react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Form primitives for the settings surfaces.
 *
 * `Select` keeps a native `<select>` for simple cases; the provider picker
 * does not use it because the OS popup cannot be styled — see `Listbox`,
 * which shares the same control skin and the dropdown motion.
 */

export const controlClass = cn(
  "h-9 w-full rounded-lg border border-gloss-outline/70 bg-gloss-surface2/60 px-3 text-sm text-gloss-text",
  "placeholder:text-gloss-textDim/60",
  "transition-[border-color,box-shadow,background-color] duration-150 ease-out",
  "hover:border-gloss-outline focus:border-gloss-accent focus:bg-gloss-surface2 focus:outline-none",
  "focus:ring-2 focus:ring-gloss-accent/15 disabled:opacity-50",
);

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        className={cn(controlClass, "cursor-pointer appearance-none pr-9", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-gloss-textDim"
      />
    </div>
  );
}

/** A label, an optional hint, and the control. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const fallbackId = useId();
  const id = htmlFor ?? fallbackId;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-gloss-textDim">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[11px] leading-relaxed text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-[11px] leading-relaxed text-gloss-textDim/80">{hint}</p>
      ) : null}
    </div>
  );
}
