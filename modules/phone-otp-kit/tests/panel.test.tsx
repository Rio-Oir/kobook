// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The panel: form behaviour, the two dropped-response cases, and the absence of
 * side effects.
 *
 * The side-effect assertions are the reason this file renders instead of calling
 * pure helpers. The panel is the one piece of the kit that runs inside a page
 * belonging to the host application, next to its session, its cookies and its
 * own network layer. "It only calls the two callbacks it was given" is a claim
 * about what happens at runtime, so it is checked at runtime: counters on the
 * network and storage entry points, and a full send-and-verify cycle, with every
 * counter asserted at zero.
 *
 * Elements are built with `createElement` rather than JSX, matching this
 * repository's existing mount helper (`tests/byok-panel-mount.tsx`): the test
 * runner transforms `.tsx` with the classic JSX factory, so JSX here would need
 * a `React` binding in scope that the component itself does not need.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";

import {
  DEFAULT_LABELS,
  GENERIC_ERROR_MESSAGE_ZH,
  messageForErrorCode,
  PHONE_OTP_ERROR_MESSAGES_ZH,
  PhoneOtpPanel,
  type PhoneOtpPanelLabels,
  type PhoneOtpRequestResult,
  type PhoneOtpVerifyResult,
} from "../src/browser";
import { mount, type Mounted } from "./support/dom";

const PURPOSE = "sign-in";
const PHONE_LOCAL = "13800138000";
const PHONE_E164 = "+8613800138000";
const CODE = "123456";

interface Spies {
  readonly requests: Array<{ phone: string; purpose: string }>;
  readonly verifications: Array<{ phone: string; code: string; purpose: string }>;
  readonly onRequestCode: (input: { phone: string; purpose: string }) => Promise<PhoneOtpRequestResult>;
  readonly onVerifyCode: (input: {
    phone: string;
    code: string;
    purpose: string;
  }) => Promise<PhoneOtpVerifyResult>;
}

interface SpyOptions {
  readonly request?: () => Promise<PhoneOtpRequestResult>;
  readonly verify?: () => Promise<PhoneOtpVerifyResult>;
}

function sent(): PhoneOtpRequestResult {
  return {
    ok: true,
    maskedPhone: "138****8000",
    purpose: PURPOSE,
    expiresAt: 0,
    expiresInSeconds: 300,
    cooldownSeconds: 60,
  };
}

function spyCallbacks(options: SpyOptions = {}): Spies {
  const requests: Spies["requests"] = [];
  const verifications: Spies["verifications"] = [];
  return {
    requests,
    verifications,
    onRequestCode: (input) => {
      requests.push(input);
      return options.request?.() ?? Promise.resolve(sent());
    },
    onVerifyCode: (input) => {
      verifications.push(input);
      return (
        options.verify?.() ??
        Promise.resolve({ ok: true, maskedPhone: "138****8000", purpose: PURPOSE })
      );
    },
  };
}

interface PanelOptions extends SpyOptions {
  readonly spies?: Spies;
  readonly purpose?: string;
  readonly clock?: () => number;
  readonly initialPhone?: string;
  readonly disabled?: boolean;
  readonly labels?: Partial<PhoneOtpPanelLabels>;
  readonly codeLength?: number;
  readonly onPendingChange?: (pending: { requesting: boolean; verifying: boolean }) => void;
}

function build(options: PanelOptions = {}): { readonly element: ReactElement; readonly spies: Spies } {
  const spies = options.spies ?? spyCallbacks(options);
  // Absent options are passed as `undefined` rather than omitted: the
  // component's own defaults are part of what these tests exercise.
  const element = createElement(PhoneOtpPanel, {
    purpose: options.purpose ?? PURPOSE,
    onRequestCode: spies.onRequestCode,
    onVerifyCode: spies.onVerifyCode,
    labels: options.labels,
    codeLength: options.codeLength,
    disabled: options.disabled,
    initialPhone: options.initialPhone,
    onPendingChange: options.onPendingChange,
    now: options.clock,
  });
  return { element, spies };
}

async function render(options: PanelOptions = {}): Promise<Mounted & { readonly spies: Spies }> {
  const { element, spies } = build(options);
  return Object.assign(await mount(element), { spies });
}

async function fillPhone(mounted: Mounted, digits: string = PHONE_LOCAL): Promise<void> {
  await mounted.type(mounted.q("phone-input"), digits);
}

/* ────────────────────────────── markup ────────────────────────────── */

test("the panel offers a +86 number field and asks for nothing else", async () => {
  const mounted = await render();
  try {
    assert.equal(mounted.q("country-code").textContent, "+86");
    const phone = mounted.q("phone-input") as HTMLInputElement;
    assert.equal(phone.getAttribute("type"), "tel");
    assert.equal(phone.getAttribute("inputmode"), "numeric");
    assert.equal(phone.getAttribute("autocomplete"), "tel-national");

    const code = mounted.q("code-input") as HTMLInputElement;
    assert.equal(code.getAttribute("autocomplete"), "one-time-code");
    assert.equal(code.getAttribute("inputmode"), "numeric");
    assert.equal(code.maxLength, 6);

    // "No forced email": there is no email affordance of any kind, and the form
    // asks for exactly two things.
    const inputs = [...mounted.container.querySelectorAll("input")];
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
      const described = [
        input.getAttribute("type"),
        input.getAttribute("name"),
        input.getAttribute("id"),
        input.getAttribute("placeholder"),
        input.getAttribute("autocomplete"),
      ]
        .join(" ")
        .toLowerCase();
      assert.ok(!described.includes("email"), described);
      assert.ok(!described.includes("password"), described);
    }
    assert.equal(mounted.q("title").textContent, DEFAULT_LABELS.title);
  } finally {
    await mounted.unmount();
  }
});

test("typing keeps digits only and stops at eleven", async () => {
  const mounted = await render();
  try {
    const input = mounted.q("phone-input") as HTMLInputElement;
    await mounted.type(input, "+86 138-0013-8000");
    assert.equal(input.value, PHONE_LOCAL);

    await mounted.type(input, "138001380001234");
    assert.equal(input.value, PHONE_LOCAL);

    await mounted.type(input, "abc");
    assert.equal(input.value, "");
  } finally {
    await mounted.unmount();
  }
});

test("an initial number is normalised the same way as typed input", async () => {
  const mounted = await render({ initialPhone: "+8613800138000" });
  try {
    assert.equal((mounted.q("phone-input") as HTMLInputElement).value, PHONE_LOCAL);
  } finally {
    await mounted.unmount();
  }
});

test("send is unavailable until the number is complete", async () => {
  const mounted = await render();
  try {
    const send = mounted.q("send") as HTMLButtonElement;
    assert.equal(send.disabled, true);

    await fillPhone(mounted, "1380013800");
    assert.equal(send.disabled, true, "ten digits is not a number");

    await fillPhone(mounted);
    assert.equal(send.disabled, false);
    assert.equal(send.textContent, DEFAULT_LABELS.sendCode);

    // And because it is disabled, a click is inert.
    await fillPhone(mounted, "1380013800");
    await mounted.click(send);
    assert.deepEqual(mounted.spies.requests, []);
  } finally {
    await mounted.unmount();
  }
});

/* ──────────────────────────────── send ──────────────────────────────── */

test("sending passes E.164 and reports a masked number, never the full one", async () => {
  const mounted = await render();
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    assert.deepEqual(mounted.spies.requests, [{ phone: PHONE_E164, purpose: PURPOSE }]);
    const text = mounted.visibleText();
    assert.ok(text.includes("138****8000"), text);
    assert.ok(!text.includes(PHONE_LOCAL), `the full number is not on screen: ${text}`);
    assert.ok(!text.includes(PHONE_E164));
  } finally {
    await mounted.unmount();
  }
});

test("a callback that returns a full number in maskedPhone cannot get it rendered", async () => {
  const mounted = await render({
    request: () =>
      Promise.resolve({
        ok: true,
        // A peer value that is a full number. The panel ignores the field
        // entirely and masks the number *it* sent, so there is no shape of peer
        // value that reaches the DOM.
        maskedPhone: PHONE_E164,
        purpose: PURPOSE,
        expiresAt: 0,
        expiresInSeconds: 300,
        cooldownSeconds: 60,
      }),
  });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    const text = mounted.visibleText();
    assert.equal(mounted.q("notice").textContent, DEFAULT_LABELS.sentTo("138****8000"));
    assert.ok(!text.includes(PHONE_LOCAL), `the full number leaked into the DOM: ${text}`);
  } finally {
    await mounted.unmount();
  }
});

test("a successful send starts the countdown and blocks a second one", async () => {
  let clock = 1_700_000_000_000;
  const mounted = await render({ clock: () => clock });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    const send = mounted.q("send") as HTMLButtonElement;
    assert.equal(send.disabled, true);
    assert.equal(send.textContent, DEFAULT_LABELS.resendIn(60));

    await mounted.click(send);
    assert.equal(mounted.spies.requests.length, 1, "a second click inside the cooldown did nothing");

    // Half a minute later the countdown reflects the injected clock.
    clock += 30_000;
    await mounted.settle(400);
    assert.equal(send.textContent, DEFAULT_LABELS.resendIn(30));

    // And when it expires the button comes back.
    clock += 30_001;
    await mounted.settle(400);
    assert.equal(send.disabled, false);
    assert.equal(send.textContent, DEFAULT_LABELS.sendCode);
  } finally {
    await mounted.unmount();
  }
});

test("a rate-limit failure starts the countdown too, from the server's figure", async () => {
  const mounted = await render({
    request: () => Promise.resolve({ ok: false, code: "SEND_LIMITED", retryAfterMs: 45_000 }),
  });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    const send = mounted.q("send") as HTMLButtonElement;
    assert.equal(send.disabled, true);
    assert.equal(send.textContent, DEFAULT_LABELS.resendIn(45));
    assert.equal(mounted.q("notice").textContent, PHONE_OTP_ERROR_MESSAGES_ZH.SEND_LIMITED);
    assert.equal(mounted.q("notice").getAttribute("data-notice-kind"), "error");
  } finally {
    await mounted.unmount();
  }
});

test("pending is reported to the parent while a request is in flight", async () => {
  const seen: Array<{ requesting: boolean; verifying: boolean }> = [];
  let release: (() => void) | undefined;
  const mounted = await render({
    onPendingChange: (pending) => seen.push({ ...pending }),
    request: () =>
      new Promise<PhoneOtpRequestResult>((resolve) => {
        release = () => resolve(sent());
      }),
  });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    const send = mounted.q("send") as HTMLButtonElement;
    assert.equal(send.disabled, true);
    assert.equal(send.textContent, DEFAULT_LABELS.sending);
    assert.equal(
      mounted.container.querySelector("[data-phone-otp]")?.getAttribute("aria-busy"),
      "true",
    );
    assert.deepEqual(seen.at(-1), { requesting: true, verifying: false });

    assert.ok(release !== undefined);
    release();
    await mounted.settle(0);
    assert.deepEqual(seen.at(-1), { requesting: false, verifying: false });
    // The in-flight label is replaced by the countdown the successful send starts.
    assert.equal(send.disabled, true);
    assert.equal(send.textContent, DEFAULT_LABELS.resendIn(60));
  } finally {
    await mounted.unmount();
  }
});

/* ─────────────────────────── dropped responses ─────────────────────────── */

test("a response for a number the user has since changed is discarded", async () => {
  let release: (() => void) | undefined;
  const mounted = await render({
    request: () =>
      new Promise<PhoneOtpRequestResult>((resolve) => {
        release = () => resolve(sent());
      }),
  });
  try {
    await fillPhone(mounted, PHONE_LOCAL);
    await mounted.click(mounted.q("send"));

    // The field stays editable while the request is in flight — otherwise a user
    // who mistyped a digit would have to wait out the request to fix it.
    await fillPhone(mounted, "13900139000");
    assert.equal((mounted.q("phone-input") as HTMLInputElement).value, "13900139000");

    assert.ok(release !== undefined);
    release();
    await mounted.settle(0);

    assert.equal(mounted.q("notice").textContent, DEFAULT_LABELS.phoneChanged);
    assert.ok(!mounted.visibleText().includes("138****8000"), "the stale mask is not shown");
    const send = mounted.q("send") as HTMLButtonElement;
    assert.equal(send.disabled, false, "no countdown was started for the discarded response");
  } finally {
    await mounted.unmount();
  }
});

test("a response for a purpose the parent has since changed is discarded", async () => {
  let release: (() => void) | undefined;
  const spies = spyCallbacks({
    request: () =>
      new Promise<PhoneOtpRequestResult>((resolve) => {
        release = () => resolve(sent());
      }),
  });

  const mounted = await mount(build({ spies }).element);
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    await mounted.render(build({ spies, purpose: "bind-phone" }).element);
    assert.ok(release !== undefined);
    release();
    await mounted.settle(0);

    assert.equal(mounted.q("notice").textContent, DEFAULT_LABELS.phoneChanged);
  } finally {
    await mounted.unmount();
  }
});

/* ─────────────────────────────── verify ─────────────────────────────── */

test("verify is available only with a complete code, and passes it through", async () => {
  const mounted = await render();
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    const verifyButton = mounted.q("verify") as HTMLButtonElement;
    assert.equal(verifyButton.disabled, true);

    await mounted.type(mounted.q("code-input"), "12345");
    assert.equal(verifyButton.disabled, true);

    await mounted.type(mounted.q("code-input"), "12a456");
    assert.equal((mounted.q("code-input") as HTMLInputElement).value, "12456", "letters are dropped");
    assert.equal(verifyButton.disabled, true);

    await mounted.type(mounted.q("code-input"), CODE);
    assert.equal(verifyButton.disabled, false);
    await mounted.click(verifyButton);

    assert.deepEqual(mounted.spies.verifications, [
      { phone: PHONE_E164, code: CODE, purpose: PURPOSE },
    ]);
    assert.equal(mounted.q("notice").textContent, DEFAULT_LABELS.verified);
    assert.equal((mounted.q("code-input") as HTMLInputElement).value, "", "the spent code is cleared");
  } finally {
    await mounted.unmount();
  }
});

test("a failed verification renders the allowlisted sentence and the attempts left", async () => {
  const mounted = await render({
    verify: () => Promise.resolve({ ok: false, code: "CODE_INVALID", attemptsRemaining: 3 }),
  });
  try {
    await fillPhone(mounted);
    await mounted.type(mounted.q("code-input"), CODE);
    await mounted.click(mounted.q("verify"));

    assert.equal(
      mounted.q("notice").textContent,
      `${PHONE_OTP_ERROR_MESSAGES_ZH.CODE_INVALID}${DEFAULT_LABELS.attemptsRemaining(3)}`,
    );
    assert.equal(mounted.q("notice").getAttribute("data-notice-kind"), "error");
  } finally {
    await mounted.unmount();
  }
});

test("an unknown code is answered with INTERNAL instead of anything from the response", async () => {
  // The panel renders sentences only for codes on the allowlist. A code nobody
  // defined — including text smuggled in where a code belongs — is `INTERNAL`,
  // and the generic sentence exists for callers of `messageForErrorCode` that are
  // not this component.
  const mounted = await render({
    verify: () =>
      Promise.resolve({
        ok: false,
        code: "NOT_A_REAL_CODE",
        message: `raw server text mentioning ${PHONE_LOCAL} and 123456`,
      } as unknown as PhoneOtpVerifyResult),
  });
  try {
    await fillPhone(mounted);
    await mounted.type(mounted.q("code-input"), CODE);
    await mounted.click(mounted.q("verify"));

    const text = mounted.visibleText();
    assert.equal(mounted.q("notice").textContent, PHONE_OTP_ERROR_MESSAGES_ZH.INTERNAL);
    assert.ok(!text.includes("raw server text"), `response text was rendered: ${text}`);
    assert.ok(!text.includes(PHONE_LOCAL), `the number leaked through: ${text}`);
    assert.ok(!text.includes(CODE));

    // The generic sentence is still what a caller outside the allowlist gets.
    assert.equal(messageForErrorCode("NOT_A_REAL_CODE"), GENERIC_ERROR_MESSAGE_ZH);
    assert.equal(messageForErrorCode({}), GENERIC_ERROR_MESSAGE_ZH);
  } finally {
    await mounted.unmount();
  }
});

test("a known failure code carrying extra text renders only the sentence", async () => {
  const mounted = await render({
    request: () =>
      Promise.resolve({
        ok: false,
        code: "SMS_SEND_FAILED",
        message: "Aliyun: template rejected for +8613800138000",
      } as unknown as PhoneOtpRequestResult),
  });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    const text = mounted.visibleText();
    assert.ok(text.includes(PHONE_OTP_ERROR_MESSAGES_ZH.SMS_SEND_FAILED), text);
    assert.ok(!text.includes("Aliyun"));
    assert.ok(!text.includes(PHONE_LOCAL));
  } finally {
    await mounted.unmount();
  }
});

test("a callback that throws is reported as an internal failure", async () => {
  const mounted = await render({
    request: () => Promise.reject(new Error(`the host client exploded for ${PHONE_LOCAL}`)),
  });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));

    const text = mounted.visibleText();
    assert.ok(text.includes(PHONE_OTP_ERROR_MESSAGES_ZH.INTERNAL), text);
    assert.ok(!text.includes("host client exploded"));
    assert.ok(!text.includes(PHONE_LOCAL));
  } finally {
    await mounted.unmount();
  }
});

test("an incomplete number never reaches a callback", async () => {
  const mounted = await render();
  try {
    await fillPhone(mounted, "1380013800");
    await mounted.click(mounted.q("send"));
    assert.deepEqual(mounted.spies.requests, []);
    assert.equal(mounted.q("notice").textContent, "");
  } finally {
    await mounted.unmount();
  }
});

/* ───────────────────────────── no side effects ───────────────────────────── */

test("a full send-and-verify cycle touches no network, cookie or storage API", async () => {
  const mounted = await render();
  const globals = globalThis as unknown as Record<string, unknown>;
  const window = mounted.window as unknown as Record<string, unknown>;
  const counters = { fetch: 0, cookieWrites: 0, local: 0, session: 0 };

  const originalFetch = globals.fetch;
  globals.fetch = (...args: unknown[]): Promise<Response> => {
    counters.fetch += 1;
    return (originalFetch as (...inner: unknown[]) => Promise<Response>)(...args);
  };

  const storage = window.localStorage as Storage;
  const sessionStorage = window.sessionStorage as Storage;
  const originalLocal = storage.setItem.bind(storage);
  const originalSession = sessionStorage.setItem.bind(sessionStorage);
  storage.setItem = (key: string, value: string): void => {
    counters.local += 1;
    originalLocal(key, value);
  };
  sessionStorage.setItem = (key: string, value: string): void => {
    counters.session += 1;
    originalSession(key, value);
  };

  Object.defineProperty(mounted.document, "cookie", {
    configurable: true,
    get: () => "",
    set: () => {
      counters.cookieWrites += 1;
    },
  });

  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));
    await mounted.type(mounted.q("code-input"), CODE);
    await mounted.click(mounted.q("verify"));

    assert.equal(mounted.q("notice").textContent, DEFAULT_LABELS.verified);
    assert.deepEqual(counters, { fetch: 0, cookieWrites: 0, local: 0, session: 0 });
    assert.equal(mounted.spies.requests.length, 1);
    assert.equal(mounted.spies.verifications.length, 1);
  } finally {
    globals.fetch = originalFetch;
    await mounted.unmount();
  }
});

test("the countdown timer is cleared when the panel unmounts", async () => {
  const globals = globalThis as unknown as typeof globalThis;
  const originalSetInterval = globals.setInterval;
  const originalClearInterval = globals.clearInterval;
  let created = 0;
  let cleared = 0;

  globals.setInterval = ((handler: () => void, timeout?: number, ...rest: unknown[]) => {
    created += 1;
    return originalSetInterval(handler, timeout, ...rest);
  }) as typeof globals.setInterval;
  globals.clearInterval = ((handle?: Parameters<typeof originalClearInterval>[0]) => {
    cleared += 1;
    return originalClearInterval(handle);
  }) as typeof globals.clearInterval;

  const mounted = await render();
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));
    assert.equal(created, 1, "the countdown started exactly one timer");
  } finally {
    await mounted.unmount();
    globals.setInterval = originalSetInterval;
    globals.clearInterval = originalClearInterval;
  }

  assert.ok(cleared >= created, `unmount cleared every timer it started (${cleared} of ${created})`);
});

/* ─────────────────────────────── labels ─────────────────────────────── */

test("every string can be replaced by the host application", async () => {
  const mounted = await render({
    labels: {
      title: "Phone sign-in",
      sendCode: "Text me a code",
      sentTo: (masked) => `Sent to ${masked}`,
    },
  });
  try {
    assert.equal(mounted.q("title").textContent, "Phone sign-in");
    await fillPhone(mounted);
    assert.equal((mounted.q("send") as HTMLButtonElement).textContent, "Text me a code");
    await mounted.click(mounted.q("send"));
    assert.equal(mounted.q("notice").textContent, "Sent to 138****8000");
    // Untouched labels keep their defaults.
    assert.equal(mounted.q("code-label").textContent, DEFAULT_LABELS.codeLabel);
  } finally {
    await mounted.unmount();
  }
});

test("a disabled panel does nothing and says so", async () => {
  const mounted = await render({ disabled: true, initialPhone: PHONE_LOCAL });
  try {
    assert.equal((mounted.q("phone-input") as HTMLInputElement).disabled, true);
    assert.equal((mounted.q("send") as HTMLButtonElement).disabled, true);
    assert.equal((mounted.q("verify") as HTMLButtonElement).disabled, true);
    await mounted.click(mounted.q("send"));
    assert.deepEqual(mounted.spies.requests, []);
  } finally {
    await mounted.unmount();
  }
});
