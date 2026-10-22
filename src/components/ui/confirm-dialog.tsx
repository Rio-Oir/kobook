// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Modal } from "./modal";

interface ConfirmOptions {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paint the confirm button red — for resets and destructive actions. */
  destructive?: boolean;
}

/**
 * An in-app replacement for `window.confirm`.
 *
 * The browser dialog is unthemed chrome that breaks the surface it appears
 * over (and, on Windows, it is the most dated-looking thing on screen).
 * This keeps the same shape — one question, two answers, no way to dismiss
 * into a third state — while living inside the app's own modal component,
 * so it inherits the focus trap, Escape and the spring.
 *
 * The hook returns the promise-returning `confirm` plus the dialog element;
 * render the element once and await `confirm(...)` at each call site.
 */
export function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOptions(null);
    resolve?.(value);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOptions(next);
    });
  }, []);

  const dialog = (
    <Modal
      open={options !== null}
      onClose={() => settle(false)}
      title={options?.title ?? ""}
      className="max-w-[420px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)}>
            {options?.cancelLabel ?? "取消"}
          </Button>
          <Button
            variant={options?.destructive ? "danger" : "primary"}
            onClick={() => settle(true)}
          >
            {options?.confirmLabel ?? "确定"}
          </Button>
        </>
      }
    >
      {options ? (
        <p className="text-sm leading-relaxed text-gloss-textDim">{options.description}</p>
      ) : null}
    </Modal>
  );

  return { confirm, dialog };
}
