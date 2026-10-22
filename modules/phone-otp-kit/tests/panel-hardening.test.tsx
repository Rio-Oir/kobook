// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The panel's hardening: what it refuses to trust from a callback.
 *
 * A response is data from outside the component — the host's own code, but also
 * whatever that code passed through from its server. These tests pin the three
 * things the panel validates rather than consumes:
 *
 * - `ok` must be **exactly `true`**; a truthy value is a malformed response, not
 *   a confirmation.
 * - The number shown is always the panel's own mask over the value it sent. The
 *   peer's `maskedPhone` is not read at all, because "contains a `*`" is not a
 *   property a full number cannot have.
 * - `cooldownSeconds` and `attemptsRemaining` are bounded finite numbers before
 *   they become a timer or a sentence.
 *
 * Plus two structural properties: one `useId` per panel, so two panels on a page
 * do not fight over input ids, and a `codeLength` prop so a 6–8 digit
 * configuration is reflected in the form instead of hard-coded at 6.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";

import {
  DEFAULT_LABELS,
  PHONE_OTP_ERROR_MESSAGES_ZH,
  PhoneOtpPanel,
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
  readonly onRequestCode: (input: { phone: string; purpose: string }) => Promise<PhoneOtpRequestResult>;
  readonly onVerifyCode: (input: {
    phone: string;
    code: string;
    purpose: string;
  }) => Promise<PhoneOtpVerifyResult>;
}

function spies(overrides: {
  readonly request?: () => Promise<PhoneOtpRequestResult>;
  readonly verify?: () => Promise<PhoneOtpVerifyResult>;
}): Spies {
  const requests: Spies["requests"] = [];
  return {
    requests,
    onRequestCode: (input) => {
      requests.push(input);
      return overrides.request?.() ?? Promise.reject(new Error("no scripted response"));
    },
    onVerifyCode: (input) => {
      void input;
      return overrides.verify?.() ?? Promise.reject(new Error("no scripted response"));
    },
  };
}

function sentWith(overrides: Record<string, unknown>): PhoneOtpRequestResult {
  return {
    ok: true,
    maskedPhone: "138****8000",
    purpose: PURPOSE,
    expiresAt: 0,
    expiresInSeconds: 300,
    cooldownSeconds: 60,
    ...overrides,
  } as unknown as PhoneOtpRequestResult;
}

async function render(
  options: {
    readonly request?: () => Promise<PhoneOtpRequestResult>;
    readonly verify?: () => Promise<PhoneOtpVerifyResult>;
    readonly codeLength?: number;
    readonly clock?: () => number;
  } = {},
): Promise<Mounted & { readonly spies: Spies }> {
  const callbacks = spies(options);
  const element = createElement(PhoneOtpPanel, {
    purpose: PURPOSE,
    onRequestCode: callbacks.onRequestCode,
    onVerifyCode: callbacks.onVerifyCode,
    codeLength: options.codeLength,
    now: options.clock,
  });
  return Object.assign(await mount(element), { spies: callbacks });
}

async function fillPhone(mounted: Mounted, digits: string = PHONE_LOCAL): Promise<void> {
  await mounted.type(mounted.q("phone-input"), digits);
}

/* ──────────────── the peer's masked number is never rendered ──────────────── */

test("the notice shows the panel's own mask, whatever the callback returns", async () => {
  // Three values a "does it look masked?" check would get wrong. All three are
  // refused the same way: the component masks the number it sent, and nothing
  // from the response reaches the DOM.
  const hostile: readonly string[] = [PHONE_E164, `${PHONE_LOCAL}*`, "+86138****8000*"];

  for (const maskedPhone of hostile) {
    const mounted = await render({ request: () => Promise.resolve(sentWith({ maskedPhone })) });
    try {
      await fillPhone(mounted);
      await mounted.click(mounted.q("send"));

      assert.equal(mounted.q("notice").textContent, DEFAULT_LABELS.sentTo("138****8000"));
      const text = mounted.visibleText();
      assert.ok(!text.includes(PHONE_LOCAL), `the full number reached the DOM for ${maskedPhone}`);
      assert.ok(!text.includes(PHONE_E164));
      assert.ok(!text.includes(maskedPhone), `the peer value itself was rendered: ${text}`);
    } finally {
      await mounted.unmount();
    }
  }
});

/* ──────────────────────── `ok` must be exactly true ──────────────────────── */

test("a callback whose ok is merely truthy is treated as a failure", async () => {
  for (const ok of [1, "yes", {}]) {
    const mounted = await render({ request: () => Promise.resolve(sentWith({ ok })) });
    try {
      await fillPhone(mounted);
      await mounted.click(mounted.q("send"));

      assert.equal(mounted.q("notice").textContent, PHONE_OTP_ERROR_MESSAGES_ZH.INTERNAL, String(ok));
      assert.equal(mounted.q("notice").getAttribute("data-notice-kind"), "error");
      // No countdown started for a response the component did not believe.
      assert.equal((mounted.q("send") as HTMLButtonElement).disabled, false, String(ok));
    } finally {
      await mounted.unmount();
    }
  }
});

/* ────────────────────────── bounded display values ────────────────────────── */

test("a nonsensical cooldown is ignored rather than trusted", async () => {
  for (const cooldownSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -5, 1e12]) {
    const mounted = await render({
      request: () => Promise.resolve(sentWith({ cooldownSeconds })),
    });
    try {
      await fillPhone(mounted);
      await mounted.click(mounted.q("send"));

      const send = mounted.q("send") as HTMLButtonElement;
      assert.equal(send.disabled, false, `${cooldownSeconds} must not lock the control`);
      assert.equal(send.textContent, DEFAULT_LABELS.sendCode, String(cooldownSeconds));
      assert.equal(mounted.q("notice").textContent, DEFAULT_LABELS.sentTo("138****8000"));
    } finally {
      await mounted.unmount();
    }
  }
});

test("a cooldown beyond the cap is treated as unknown, not as a day-long lock", async () => {
  // Clamping would be worse than ignoring: it disables the control for a day on
  // the strength of a number nobody meant. The panel stays usable, and the
  // server's next refusal supplies the real figure.
  const mounted = await render({
    clock: () => 1_700_000_000_000,
    request: () => Promise.resolve(sentWith({ cooldownSeconds: 86_401 })),
  });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));
    const send = mounted.q("send") as HTMLButtonElement;
    assert.equal(send.textContent, DEFAULT_LABELS.sendCode);
    assert.equal(send.disabled, false);
  } finally {
    await mounted.unmount();
  }
});

test("a cooldown at the cap is still honoured", async () => {
  const mounted = await render({
    clock: () => 1_700_000_000_000,
    request: () => Promise.resolve(sentWith({ cooldownSeconds: 86_400 })),
  });
  try {
    await fillPhone(mounted);
    await mounted.click(mounted.q("send"));
    const send = mounted.q("send") as HTMLButtonElement;
    assert.equal(send.textContent, DEFAULT_LABELS.resendIn(86_400));
    assert.equal(send.disabled, true);
  } finally {
    await mounted.unmount();
  }
});

test("an attemptsRemaining that is not a usable number is not rendered as one", async () => {
  for (const attemptsRemaining of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    const mounted = await render({
      verify: () => Promise.resolve({ ok: false, code: "CODE_INVALID", attemptsRemaining }),
    });
    try {
      await fillPhone(mounted);
      await mounted.type(mounted.q("code-input"), CODE);
      await mounted.click(mounted.q("verify"));
      assert.equal(
        mounted.q("notice").textContent,
        PHONE_OTP_ERROR_MESSAGES_ZH.CODE_INVALID,
        String(attemptsRemaining),
      );
    } finally {
      await mounted.unmount();
    }
  }
});

/* ──────────────────────────────── two panels ──────────────────────────────── */

test("two panels on one page keep their fields and callbacks apart", async () => {
  const first = spies({ request: () => Promise.resolve(sentWith({})) });
  const second = spies({ request: () => Promise.resolve(sentWith({})) });
  const element = createElement(
    "div",
    null,
    createElement(PhoneOtpPanel, {
      purpose: PURPOSE,
      onRequestCode: first.onRequestCode,
      onVerifyCode: first.onVerifyCode,
    }),
    createElement(PhoneOtpPanel, {
      purpose: "bind-phone",
      onRequestCode: second.onRequestCode,
      onVerifyCode: second.onVerifyCode,
    }),
  );

  const mounted = await mount(element);
  try {
    const panels = [...mounted.container.querySelectorAll<HTMLElement>('[data-phone-otp="panel"]')];
    assert.equal(panels.length, 2);

    // `useId` gives each panel its own ids, so no two fields collide.
    const ids = [...mounted.container.querySelectorAll("input")].map((input) => input.id);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, `input ids must be unique, saw ${ids.join(", ")}`);

    // Every label points at a field inside its own panel — the failure a fixed id
    // would produce is a label driving the other panel's input.
    for (const panel of panels) {
      const labels = [...panel.querySelectorAll("label")];
      assert.equal(labels.length, 2);
      for (const label of labels) {
        // React renders `htmlFor` as the `for` attribute.
        const target = label.getAttribute("for");
        assert.ok(target !== null && target.length > 0, "every label must target a field");
        const field = mounted.document.getElementById(target);
        assert.ok(field !== null, `${target} must exist`);
        assert.ok(panel.contains(field), `${target} belongs to the other panel`);
      }
    }

    const phoneInputs = [
      ...mounted.container.querySelectorAll<HTMLInputElement>('[data-phone-otp-role="phone-input"]'),
    ];
    const firstInput = phoneInputs[0];
    const secondInput = phoneInputs[1];
    if (firstInput === undefined || secondInput === undefined) throw new Error("expected two phone inputs");

    await mounted.type(firstInput, PHONE_LOCAL);
    assert.equal(firstInput.value, PHONE_LOCAL);
    assert.equal(secondInput.value, "", "typing in one panel must not fill the other");

    const firstSend = panels[0]?.querySelector('[data-phone-otp-role="send"]');
    if (firstSend === null || firstSend === undefined) throw new Error("expected a send button");
    await mounted.click(firstSend);

    assert.equal(first.requests.length, 1);
    assert.deepEqual(
      second.requests,
      [],
      "the click must reach only its own panel's callback",
    );
  } finally {
    await mounted.unmount();
  }
});

/* ──────────────────────────────── code length ──────────────────────────────── */

test("a non-default code length drives the input and the verify gate", async () => {
  const mounted = await render({ codeLength: 8 });
  try {
    const codeInput = mounted.q("code-input") as HTMLInputElement;
    assert.equal(codeInput.maxLength, 8);

    await fillPhone(mounted);
    const verifyButton = mounted.q("verify") as HTMLButtonElement;
    assert.equal(verifyButton.disabled, true);

    await mounted.type(codeInput, CODE);
    assert.equal(verifyButton.disabled, true, "six digits is not a code for this configuration");
    assert.equal(codeInput.value, CODE);

    await mounted.type(codeInput, "12345678");
    assert.equal(verifyButton.disabled, false);
    await mounted.click(verifyButton);
  } finally {
    await mounted.unmount();
  }
});

test("an out-of-range code length falls back to the default", async () => {
  const lengths: readonly (number | undefined)[] = [4, 12, 6.5, Number.NaN, undefined];
  for (const codeLength of lengths) {
    const mounted = await render({ codeLength });
    try {
      assert.equal(
        (mounted.q("code-input") as HTMLInputElement).maxLength,
        6,
        `codeLength=${String(codeLength)} must fall back`,
      );
    } finally {
      await mounted.unmount();
    }
  }
});

test("the supported range is accepted at both ends", async () => {
  for (const codeLength of [6, 7, 8]) {
    const mounted = await render({ codeLength });
    try {
      assert.equal((mounted.q("code-input") as HTMLInputElement).maxLength, codeLength);
    } finally {
      await mounted.unmount();
    }
  }
});

/* ───────────────────────── a Renderable sanity check ───────────────────────── */

test("the element under test is the component, not a wrapper", () => {
  const element: ReactElement = createElement(PhoneOtpPanel, {
    purpose: PURPOSE,
    onRequestCode: spies({}).onRequestCode,
    onVerifyCode: spies({}).onVerifyCode,
  });
  assert.equal(element.type, PhoneOtpPanel);
});
