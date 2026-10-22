// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import { controlClass } from "./field";

export interface ListboxOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A select that is not the OS select.
 *
 * The native `<select>` popup is chrome the page cannot style, which is why
 * it looked like a grey system menu inside the settings card. This keeps the
 * same control skin as `Input`, opens a `t-dropdown` panel that grows from
 * the control (the same transitions.dev snippet the header menu uses), and
 * follows the combobox/listbox keyboard model: arrows move the active
 * option, Enter picks it, Esc closes and returns focus.
 *
 * The panel stays mounted (closed = `opacity: 0`, `inert`) so the open
 * transition has a resting state to animate from; unmounting on open would
 * render the final state on the first frame.
 */
export function Listbox<T extends string>({
  value,
  options,
  onChange,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: ReadonlyArray<ListboxOption<T>>;
  onChange: (value: T) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const autoId = useId();
  const baseId = id ?? autoId;
  const listId = `${baseId}-listbox`;
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [active, setActive] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const selected = options[selectedIndex];

  function clearCloseTimer() {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  }

  function openList() {
    clearCloseTimer();
    setClosing(false);
    setActive(selectedIndex);
    setOpen(true);
  }

  function closeList(returnFocus = true) {
    if (!open && !closing) return;
    setOpen(false);
    setClosing(true);
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      setClosing(false);
      closeTimer.current = undefined;
    }, 150);
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => () => clearCloseTimer(), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeList(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // `closeList` reads the current open state; re-arming on open is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeList();
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + delta + options.length) % options.length);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else openList();
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActive(options.length - 1);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeList();
      return;
    }
    if (event.key === "Tab" && open) closeList(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={baseId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${baseId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          controlClass,
          "flex cursor-pointer items-center justify-between gap-2 text-left",
          className,
        )}
      >
        <span className="truncate">{selected?.label ?? "请选择"}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-gloss-textDim transition-transform duration-200 ease-out",
            open && "rotate-180",
          )}
        />
      </button>

      <div
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        aria-hidden={!open}
        inert={!open}
        data-origin="top-left"
        className={cn(
          "t-dropdown absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-64 overflow-auto rounded-xl border border-gloss-border bg-gloss-surface p-1 shadow-[0_18px_44px_-16px_rgb(0_0_0/0.55)]",
          open && "is-open",
          closing && "is-closing",
        )}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            id={`${baseId}-opt-${index}`}
            type="button"
            role="option"
            aria-selected={option.value === value}
            tabIndex={-1}
            onPointerEnter={() => setActive(index)}
            onClick={() => choose(index)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-100",
              index === active && "bg-gloss-text/[0.06]",
              option.value === value ? "text-gloss-text" : "text-gloss-textDim",
            )}
          >
            <span className="truncate">{option.label}</span>
            {option.value === value ? (
              <Check className="size-3.5 shrink-0" aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
