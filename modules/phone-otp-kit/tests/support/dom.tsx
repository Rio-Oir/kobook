// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A minimal jsdom mount harness: no testing library, no new dependency.
 *
 * `react-dom/client` is imported *after* the DOM globals exist, which is why the
 * imports are dynamic. The repository's convention for DOM work is a direct
 * `JSDOM` instance (see `tests/unit/blocks.test.ts`), and React 19 exposes `act`
 * itself, so a renderer dependency would be one more thing to audit for no extra
 * coverage.
 */

import { JSDOM } from "jsdom";
import type { ReactElement } from "react";

interface ReactModules {
  readonly act: (callback: () => Promise<void> | void) => Promise<void>;
  readonly createRoot: (container: Element) => {
    render(element: ReactElement): void;
    unmount(): void;
  };
}

let dom: JSDOM | undefined;
let modules: ReactModules | undefined;

/** Install the DOM once per process; later mounts share the document. */
function ensureDom(): JSDOM {
  if (dom !== undefined) return dom;

  const instance = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "https://reader.test/",
  });

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = instance.window;
  globals.document = instance.window.document;
  globals.HTMLElement = instance.window.HTMLElement;
  globals.HTMLInputElement = instance.window.HTMLInputElement;
  globals.HTMLButtonElement = instance.window.HTMLButtonElement;
  globals.Element = instance.window.Element;
  globals.Node = instance.window.Node;
  globals.Event = instance.window.Event;
  globals.MouseEvent = instance.window.MouseEvent;
  globals.getComputedStyle = instance.window.getComputedStyle.bind(instance.window);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  // Node 24 exposes `navigator` as a getter-only global, so it is replaced
  // through a descriptor rather than by assignment.
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: instance.window.navigator,
      configurable: true,
      writable: true,
    });
  } catch {
    // Not worth failing a test over: React reads the user agent defensively.
  }

  dom = instance;
  return instance;
}

/**
 * Resolve a named export from a dynamic import, tolerating the two shapes Node
 * can produce for a package whose entry is CommonJS: a real named export when
 * the lexer recognises it, or `default` carrying the whole `module.exports`.
 */
function named(mod: Record<string, unknown>, name: string): unknown {
  const direct = mod[name];
  if (direct !== undefined) return direct;
  const fallback = mod.default;
  if (typeof fallback === "object" && fallback !== null && name in fallback) {
    return (fallback as Record<string, unknown>)[name];
  }
  throw new Error(`could not resolve the "${name}" export from a dynamic import`);
}

async function reactModules(): Promise<ReactModules> {
  if (modules !== undefined) return modules;
  const [react, reactDom] = await Promise.all([import("react"), import("react-dom/client")]);
  modules = {
    act: named(react as Record<string, unknown>, "act") as ReactModules["act"],
    createRoot: named(reactDom as Record<string, unknown>, "createRoot") as unknown as ReactModules["createRoot"],
  };
  return modules;
}

export interface Mounted {
  readonly document: Document;
  /** jsdom's own window type; it is not assignable to the DOM lib's `Window`. */
  readonly window: JSDOM["window"];
  readonly container: HTMLElement;
  render(element: ReactElement): Promise<void>;
  unmount(): Promise<void>;
  /** The element carrying `data-phone-otp-role="<role>"`. */
  q(role: string): HTMLElement;
  click(element: Element): Promise<void>;
  type(input: Element, value: string): Promise<void>;
  visibleText(): string;
  /** Wait out the real timer the countdown uses. */
  settle(ms: number): Promise<void>;
}

export async function mount(initial: ReactElement): Promise<Mounted> {
  const instance = ensureDom();
  const { act, createRoot } = await reactModules();

  const container = instance.window.document.createElement("div");
  instance.window.document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(initial);
  });

  const htmlInputPrototype = instance.window.HTMLInputElement.prototype;

  return {
    document: instance.window.document,
    window: instance.window,
    container,
    async render(element: ReactElement): Promise<void> {
      await act(async () => {
        root.render(element);
      });
    },
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
    q(role: string): HTMLElement {
      const found = container.querySelector(`[data-phone-otp-role="${role}"]`);
      if (found === null) throw new Error(`no element with data-phone-otp-role="${role}"`);
      return found as HTMLElement;
    },
    async click(element: Element): Promise<void> {
      await act(async () => {
        (element as HTMLElement).click();
      });
    },
    async type(input: Element, value: string): Promise<void> {
      const setter = Object.getOwnPropertyDescriptor(htmlInputPrototype, "value")?.set;
      await act(async () => {
        // React tracks the previous value on the node, so the native setter has
        // to be used for the change to be observed.
        setter?.call(input, value);
        input.dispatchEvent(new instance.window.Event("input", { bubbles: true }));
      });
    },
    visibleText(): string {
      return container.textContent ?? "";
    },
    async settle(ms: number): Promise<void> {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
  };
}
