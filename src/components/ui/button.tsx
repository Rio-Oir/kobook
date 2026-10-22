// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * One button, three weights.
 *
 * `primary` is ink on paper (the same pair the reader uses), `secondary` is
 * a surface with a hairline, `ghost` is text-only for the quiet actions that
 * sit next to the primary one. Press feedback is a 2% scale — small enough
 * to read as a physical button rather than a bounce.
 */
const button = cva(
  [
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium",
    "transition-[transform,background-color,border-color,color,box-shadow] duration-150 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40 focus-visible:ring-offset-0",
    "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      variant: {
        primary: "bg-gloss-text text-gloss-bg hover:bg-gloss-text/90",
        secondary:
          "border border-gloss-border bg-gloss-surface2/70 text-gloss-text hover:bg-gloss-surface2",
        ghost:
          "text-gloss-textDim hover:bg-gloss-text/[0.05] hover:text-gloss-text",
        danger: "bg-red-500/90 text-white hover:bg-red-500",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size }), className)} {...props} />;
}
