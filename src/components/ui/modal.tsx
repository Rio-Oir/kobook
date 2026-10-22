// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal surface with a real focus trap.
 *
 * The previous settings panel was a `fixed` div: no dialog role, no focus
 * move, no Escape, no scroll lock, and it unmounted the instant `open`
 * flipped — which is why closing felt like a cut rather than a dismiss.
 *
 * This one is a component so every overlay gets the same behaviour, and it
 * animates both ways: a spring on the way in, a 130ms tween on the way out.
 * It deliberately does **not** portal: the panel is rendered where it is
 * used, which keeps it inside its host subtree (the BYOK browser suite
 * scopes its queries to the mount host) and avoids stacking-context
 * surprises with the reader's own overlays.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const descId = useId();

  // Only `open` re-runs this. Reading the callback through a ref keeps an
  // inline `onClose` from re-arming the trap (and yanking focus back to the
  // panel) on every keystroke the panel causes.
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Lock the page only when this actually renders as an overlay. The BYOK
    // browser suite mounts the panel on a deliberately stylesheet-free blank
    // page; there the dialog is in normal flow, so freezing the body would
    // make its own fields unreachable by the page scroll the harness uses.
    const isOverlay =
      getComputedStyle(wrapperRef.current ?? panelRef.current ?? document.body).position ===
      "fixed";
    const bodyOverflow = document.body.style.overflow;
    if (isOverlay) document.body.style.overflow = "hidden";

    // Focus the panel itself rather than the first input: a dialog that
    // starts with the caret inside a password field is a trap of its own.
    const frame = requestAnimationFrame(() => panelRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const nodes = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.getClientRects().length > 0);
      if (nodes.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (isOverlay) document.body.style.overflow = bodyOverflow;
      previous?.focus();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings-backdrop"
          className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.13, ease: [0.4, 0, 1, 1] } }}
          onClick={() => closeRef.current()}
        />
      )}
      {open && (
        <motion.div
          key="settings-panel"
          ref={wrapperRef}
          className="pointer-events-none fixed inset-0 z-[71] flex items-center justify-center p-4"
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.13, ease: [0.4, 0, 1, 1] } }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            className={cn(
              "pointer-events-auto flex max-h-[min(88vh,780px)] w-full max-w-[560px] flex-col",
              "overflow-hidden rounded-2xl border border-gloss-border",
              "bg-gloss-surface text-gloss-text shadow-[0_28px_90px_-18px_rgb(0_0_0/0.62)] outline-none",
              className,
            )}
            initial={{ opacity: 0, scale: 0.965, y: 12 }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: { type: "spring", stiffness: 380, damping: 32, mass: 0.9 },
            }}
            exit={{ opacity: 0, scale: 0.985, y: 6, transition: { duration: 0.13, ease: [0.4, 0, 1, 1] } }}
          >
            <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
              <div className="min-w-0">
                <h2 id={titleId} className="font-serif text-lg leading-tight">
                  {title}
                </h2>
                {description ? (
                  <p id={descId} className="mt-1 text-xs leading-relaxed text-gloss-textDim">
                    {description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => closeRef.current()}
                aria-label="关闭"
                className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-gloss-textDim transition-colors duration-150 hover:bg-gloss-text/[0.06] hover:text-gloss-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40"
              >
                <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>

            {footer ? (
              <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-gloss-border/80 px-6 py-3">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
