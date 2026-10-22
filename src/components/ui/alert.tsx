// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A message about the current state, not decoration.
 *
 * `warning` is for something the user must decide (an unconfirmed endpoint,
 * a key that was migrated); `info` is for a statement of fact; `danger` is
 * reserved for failures. The icon is the only colour-bearing part, so a
 * panel with two alerts stays calm.
 */
export function Alert({
  tone = "warning",
  title,
  children,
  action,
  className,
}: {
  tone?: "warning" | "info" | "danger";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = tone === "warning" ? TriangleAlert : tone === "danger" ? CircleAlert : Info;
  return (
    <div
      role="status"
      className={cn(
        "flex gap-2.5 rounded-lg border p-3 text-[11px] leading-relaxed",
        tone === "warning" && "border-amber-500/30 bg-amber-500/[0.07]",
        tone === "info" && "border-gloss-border bg-gloss-surface2/50",
        tone === "danger" && "border-red-500/30 bg-red-500/[0.07]",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "warning" && "text-amber-500",
          tone === "info" && "text-gloss-textDim",
          tone === "danger" && "text-red-400",
        )}
      />
      <div className="min-w-0 flex-1">
        {title ? <div className="mb-0.5 font-medium text-gloss-text">{title}</div> : null}
        {children ? <div className="text-gloss-textDim">{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
