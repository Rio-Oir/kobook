// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A settings group that grows and shrinks in height.
 *
 * The height animation is CSS-only (`grid-template-rows: 0fr ↔ 1fr` from
 * the transitions.dev accordion snippet), so there is no `scrollHeight`
 * measuring and content of any size animates cleanly. The chevron is an SVG
 * that flips vertically; the snippet's rule lives in `index.css`.
 *
 * `inert` on the collapsed panel matters for keyboard users: without it,
 * Tab still walks into fields that are visually clipped to zero height.
 */
export function Accordion({
  title,
  summary,
  defaultOpen = false,
  children,
  className,
}: {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div
      className={cn(
        "t-acc overflow-hidden rounded-xl border border-gloss-border bg-gloss-surface",
        className,
      )}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="t-acc-head flex w-full items-center justify-between gap-4 px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gloss-accent/40"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-gloss-text">{title}</span>
          {summary ? (
            <span className="mt-0.5 block truncate text-[11px] text-gloss-textDim">
              {summary}
            </span>
          ) : null}
        </span>
        <span className="t-acc-chevron text-gloss-textDim" aria-hidden="true">
          <svg viewBox="0 0 16 16" className="size-4">
            <path
              d="M4 6.5L8 10.5L12 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div className="t-acc-panel" id={`${id}-panel`} aria-hidden={!open} inert={!open}>
        <div className="t-acc-panel-inner">
          <div className="flex flex-col gap-4 px-5 pb-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
