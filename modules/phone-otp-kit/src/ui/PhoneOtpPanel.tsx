// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** @jsx createElement */
/**
 * The optional phone-OTP form.
 *
 * ## Why the factory pragma above
 *
 * This module's test runner compiles `.tsx` with the **classic** JSX factory and
 * ignores the `jsx` setting in `tsconfig.json` (verified in
 * `docs/evidence/phone-otp-kit/probe-jsx.tsx`). React 19's types no longer
 * declare a global `JSX` namespace, so matching that by switching the module to
 * `jsx: "react"` is not an option either — TypeScript then reports
 * `JSX.IntrinsicElements` missing on every element.
 *
 * Naming the factory satisfies both compilers: `tsx` resolves `createElement`
 * because the pragma says so, and `tsc` type-checks the same JSX through React
 * 19's automatic runtime. The `void createElement;` below is the reference that
 * stops TypeScript reading the import as dead code, since from its point of view
 * the JSX does not consume it.
 *
 * ## What it is allowed to do
 *
 * Show a +86 input, a code input, a countdown, and a sentence from the error
 * table. Call the two callbacks it was given. Nothing else. In particular it
 * does not: perform a network request, touch a cookie or any browser storage,
 * read or write a session, navigate, or import the application's auth client.
 * The parent owns all of that inside its own `onRequestCode` / `onVerifyCode`,
 * which is what lets the same component be reused for sign-in, sign-up, binding
 * and recovery without carrying an opinion about any of them.
 *
 * ## Three behaviours that are easy to get wrong
 *
 * **Stale responses.** The phone field stays editable while a request is in
 * flight — otherwise a user who mistyped a digit would have to wait out the
 * request to fix it. So a response can arrive after the number it was about has
 * changed. Applying it would print "code sent to 138****A" next to an input
 * holding B, and start a countdown for a send the user no longer wants. Each
 * request therefore captures `{ phone, purpose }` and a response is discarded if
 * either has moved on. A monotonic sequence number covers the other ordering:
 * two in-flight requests can only happen if a parent re-enables the control, and
 * the earlier reply must not overwrite the later one.
 *
 * **Masked-by-construction display.** The number shown in a notice comes from
 * {@link maskPhoneE164} over the value this component sent. The `maskedPhone` a
 * callback returns is used only if it visibly contains a `*`; a callback that
 * returns a full number cannot get it into the DOM.
 *
 * **No forced email.** There is no email field, no email validation and no
 * "or continue with" branch. A user who picks this path sees only this path.
 *
 * ## Styling
 *
 * The markup is unstyled and semantic, with `data-phone-otp-role` hooks and a
 * `className` on the root, so the host application styles it with whatever it
 * already uses. The kit deliberately ships no CSS: a component that assumed
 * Tailwind would drag a dependency into every consumer.
 */

import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

void createElement;

import {
  MAINLAND_MOBILE_DIGIT_COUNT,
  MAX_CODE_LENGTH,
  MIN_CODE_LENGTH,
  OTP_CODE_LENGTH,
} from "../shared/constants";
import {
  DEFAULT_SENDING_COUNTRY_CODE,
  isCompleteMainlandMobileInput,
  maskPhoneE164,
  normalizeMainlandMobileInput,
  toE164FromMainlandDigits,
} from "../shared/phone";
import type {
  PhoneOtpPanelPendingState,
  PhoneOtpRequestResult,
  PhoneOtpVerifyResult,
} from "../shared/types";
import { messageForErrorCode, resolveLabels, type PhoneOtpPanelLabels } from "./messages";
import { isPhoneOtpResponseCode, type PhoneOtpResponseCode } from "../shared/errors";

export interface PhoneOtpPanelRequestInput {
  /** `+86` followed by 11 digits. */
  readonly phone: string;
  readonly purpose: string;
}

export interface PhoneOtpPanelVerifyInput {
  readonly phone: string;
  readonly code: string;
  readonly purpose: string;
}

export interface PhoneOtpPanelProps {
  /** Passed through verbatim to both callbacks. Never interpreted here. */
  readonly purpose: string;
  readonly onRequestCode: (
    input: PhoneOtpPanelRequestInput,
  ) => Promise<PhoneOtpRequestResult>;
  readonly onVerifyCode: (input: PhoneOtpPanelVerifyInput) => Promise<PhoneOtpVerifyResult>;
  readonly labels?: Partial<PhoneOtpPanelLabels>;
  readonly disabled?: boolean;
  /**
   * Digits the code has, matching `PhoneOtpConfig.codeLength`. Values outside
   * 6–8, or non-integers, fall back to 6 rather than being trusted: an
   * out-of-range length would make the verify button unusable or the input
   * accept a code the server will never accept.
   */
  readonly codeLength?: number;
  /** Pre-fills the field, normalised the same way as typed input. */
  readonly initialPhone?: string;
  /** Called when either in-flight flag changes, for a parent that disables its own UI. */
  readonly onPendingChange?: (pending: PhoneOtpPanelPendingState) => void;
  /** Clock injection for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  readonly className?: string;
}

type Notice = {
  readonly kind: "info" | "success" | "error";
  readonly text: string;
};

/** How often the countdown re-renders. Small enough to look continuous. */
const TICK_MS = 250;

/**
 * The longest cooldown this component will honour, in seconds.
 *
 * A response is data from outside the component, so `cooldownSeconds` is bounded
 * before it becomes a timer. Anything that is not a finite number in
 * `(0, MAX]` — `NaN`, `Infinity`, a negative, or a figure beyond the cap — is
 * treated as "no countdown": the control stays usable and the server's next
 * refusal supplies the real figure through `retryAfterMs`. Clamping a nonsense
 * figure to the cap would be worse than ignoring it, because it would disable the
 * control for a day on the strength of a number nobody meant.
 */
const MAX_COOLDOWN_SECONDS = 24 * 60 * 60;

function secondsUntil(target: number, at: number): number {
  return Math.max(0, Math.ceil((target - at) / 1000));
}

/** A peer-supplied cooldown, accepted only when it is a bounded finite number. */
function boundedCooldownSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0 || value > MAX_COOLDOWN_SECONDS) return 0;
  return Math.floor(value);
}

/**
 * The code to render a sentence for.
 *
 * A response's `code` is only trusted as far as the allowlist. Anything else —
 * missing, a number, a string nobody defined, text from a server — becomes
 * `INTERNAL`, so the panel never has to fall back to rendering something it did
 * not recognise, and there is exactly one answer for "we cannot describe this
 * failure".
 */
function failureCodeOf(result: unknown): PhoneOtpResponseCode {
  if (typeof result !== "object" || result === null) return "INTERNAL";
  let code: unknown;
  try {
    code = (result as { readonly code?: unknown }).code;
  } catch {
    return "INTERNAL";
  }
  return isPhoneOtpResponseCode(code) ? code : "INTERNAL";
}

/** A code length the input can actually be used with. */
function resolveCodeLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return OTP_CODE_LENGTH;
  if (value < MIN_CODE_LENGTH || value > MAX_CODE_LENGTH) return OTP_CODE_LENGTH;
  return value;
}

function safeCallbackResult(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, code: "INTERNAL" };
    const record = value as Record<string, unknown>;
    return {
      ok: record.ok === true,
      code: record.code,
      cooldownSeconds: record.cooldownSeconds,
      retryAfterMs: record.retryAfterMs,
      attemptsRemaining: record.attemptsRemaining,
    };
  } catch {
    return { ok: false, code: "INTERNAL" };
  }
}

export function PhoneOtpPanel(props: PhoneOtpPanelProps): ReactElement {
  const {
    purpose,
    onRequestCode,
    onVerifyCode,
    labels: labelOverrides,
    disabled = false,
    codeLength: requestedCodeLength,
    initialPhone,
    onPendingChange,
    now,
    className,
  } = props;

  const labels = useMemo(() => resolveLabels(labelOverrides), [labelOverrides]);
  const codeLength = resolveCodeLength(requestedCodeLength);
  // `useId` rather than a fixed id: two panels on one page would otherwise share
  // input ids, and the second label would point at the first panel's field.
  const fieldId = useId();
  const phoneFieldId = `${fieldId}-phone`;
  const codeFieldId = `${fieldId}-code`;

  const [phoneDigits, setPhoneDigits] = useState(() =>
    normalizeMainlandMobileInput(initialPhone ?? ""),
  );
  const [code, setCode] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [, setTick] = useState(0);

  // A stable reader that always calls the latest injected clock. Without the
  // indirection, an inline `now={() => …}` prop would rebuild every callback and
  // restart the countdown timer on every render.
  const nowRef = useRef(now);
  nowRef.current = now;
  const readNow = useCallback((): number => {
    const source = nowRef.current;
    return source === undefined ? Date.now() : source();
  }, []);

  const phoneE164 = toE164FromMainlandDigits(phoneDigits);
  const phoneComplete = isCompleteMainlandMobileInput(phoneDigits);

  // Read inside async handlers, so a response is judged against the *current*
  // input rather than the render it was issued from.
  const identity = useRef({ phone: phoneE164, purpose });
  identity.current = { phone: phoneE164, purpose };

  const requestSeq = useRef(0);
  const verifySeq = useRef(0);

  const cooldownSeconds = secondsUntil(cooldownUntil, readNow());

  const lastPending = useRef<PhoneOtpPanelPendingState | null>(null);
  useEffect(() => {
    const previous = lastPending.current;
    if (previous !== null && previous.requesting === requesting && previous.verifying === verifying) {
      return;
    }
    lastPending.current = { requesting, verifying };
    onPendingChange?.({ requesting, verifying });
  }, [onPendingChange, requesting, verifying]);

  useEffect(() => {
    if (cooldownUntil === 0) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    timer = setInterval(() => {
      // Stop on the tick that reaches zero rather than leaving a timer running
      // for the lifetime of the component.
      if (readNow() >= cooldownUntil) stop();
      setTick((value) => value + 1);
    }, TICK_MS);
    return stop;
  }, [cooldownUntil, readNow]);

  const handleRequest = useCallback(async (): Promise<void> => {
    if (disabled || requesting) return;
    if (secondsUntil(cooldownUntil, readNow()) > 0) return;

    const phone = toE164FromMainlandDigits(phoneDigits);
    if (phone === null) {
      setNotice({ kind: "error", text: messageForErrorCode("INVALID_PHONE") });
      return;
    }

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const issuedFor = { phone, purpose };
    setRequesting(true);
    setNotice(null);

    let result: Record<string, unknown>;
    try {
      result = safeCallbackResult(await onRequestCode({ phone, purpose }));
    } catch {
      // A callback that throws is the callback's problem to report; from here it
      // is an unexplained failure, and the allowlist has a code for that.
      result = { ok: false, code: "INTERNAL" };
    }

    if (seq !== requestSeq.current) return; // a later request owns the state now
    const live = identity.current;
    if (live.phone !== issuedFor.phone || live.purpose !== issuedFor.purpose) {
      setRequesting(false);
      setNotice({ kind: "info", text: labels.phoneChanged });
      return;
    }

    setRequesting(false);

    if (result.ok === true) {
      const at = readNow();
      setCooldownUntil(at + boundedCooldownSeconds(result.cooldownSeconds) * 1000);
      // The number shown is always this component's own mask over the value it
      // sent. A peer's `maskedPhone` is not used at all: "contains a `*`" is not
      // a property a full number cannot have, so there is no version of trusting
      // it that is safe.
      setNotice({ kind: "info", text: labels.sentTo(maskPhoneE164(phone)) });
      return;
    }

    const code = failureCodeOf(result);
    if (code === "SEND_LIMITED" && typeof result.retryAfterMs === "number") {
      setCooldownUntil(readNow() + boundedCooldownSeconds(result.retryAfterMs / 1000) * 1000);
    }
    setNotice({ kind: "error", text: messageForErrorCode(code) });
  }, [
    cooldownUntil,
    disabled,
    labels,
    onRequestCode,
    phoneDigits,
    purpose,
    readNow,
    requesting,
  ]);

  const handleVerify = useCallback(async (): Promise<void> => {
    if (disabled || verifying) return;
    if (code.length !== codeLength) return;

    const phone = toE164FromMainlandDigits(phoneDigits);
    if (phone === null) {
      setNotice({ kind: "error", text: messageForErrorCode("INVALID_PHONE") });
      return;
    }

    const seq = verifySeq.current + 1;
    verifySeq.current = seq;
    const issuedFor = { phone, purpose };
    setVerifying(true);
    setNotice(null);

    let result: Record<string, unknown>;
    try {
      result = safeCallbackResult(await onVerifyCode({ phone, code, purpose }));
    } catch {
      result = { ok: false, code: "INTERNAL" };
    }

    if (seq !== verifySeq.current) return;
    const live = identity.current;
    if (live.phone !== issuedFor.phone || live.purpose !== issuedFor.purpose) {
      setVerifying(false);
      setNotice({ kind: "info", text: labels.phoneChanged });
      return;
    }

    setVerifying(false);

    if (result.ok === true) {
      setCode("");
      setCooldownUntil(0);
      setNotice({ kind: "success", text: labels.verified });
      return;
    }

    // Bounded like the cooldown: a peer-supplied count is display data, and
    // `NaN`/`Infinity`/a negative would read as nonsense in a sentence.
    const failure = failureCodeOf(result);
    const remaining = result.attemptsRemaining;
    const suffix =
      failure === "CODE_INVALID" &&
      typeof remaining === "number" &&
      Number.isFinite(remaining) &&
      remaining <= 20 &&
      remaining > 0
        ? labels.attemptsRemaining(Math.floor(remaining))
        : "";
    setNotice({ kind: "error", text: `${messageForErrorCode(failure)}${suffix}` });
  }, [code, codeLength, disabled, labels, onVerifyCode, phoneDigits, purpose, verifying]);

  const sendDisabled = disabled || requesting || cooldownSeconds > 0 || !phoneComplete;
  const verifyDisabled = disabled || verifying || code.length !== codeLength;
  const busy = requesting || verifying;

  const sendLabel = requesting
    ? labels.sending
    : cooldownSeconds > 0
      ? labels.resendIn(cooldownSeconds)
      : labels.sendCode;

  return (
    <section
      className={className}
      data-phone-otp="panel"
      data-pending={busy ? "true" : "false"}
      aria-busy={busy}
    >
      <h2 data-phone-otp-role="title">{labels.title}</h2>

      <div>
        <label htmlFor={phoneFieldId} data-phone-otp-role="phone-label">
          {labels.phoneLabel}
        </label>
        <div data-phone-otp-role="phone-field">
          <span aria-hidden="true" data-phone-otp-role="country-code">
            +{DEFAULT_SENDING_COUNTRY_CODE}
          </span>
          <input
            id={phoneFieldId}
            name="phone"
            data-phone-otp-role="phone-input"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={MAINLAND_MOBILE_DIGIT_COUNT}
            placeholder={labels.phonePlaceholder}
            value={phoneDigits}
            disabled={disabled}
            onChange={(event) => {
              setPhoneDigits(normalizeMainlandMobileInput(event.target.value));
            }}
          />
        </div>
        <button
          type="button"
          data-phone-otp-role="send"
          disabled={sendDisabled}
          onClick={() => {
            void handleRequest();
          }}
        >
          {sendLabel}
        </button>
      </div>

      <div>
        <label htmlFor={codeFieldId} data-phone-otp-role="code-label">
          {labels.codeLabel}
        </label>
        <input
          id={codeFieldId}
          name="code"
          data-phone-otp-role="code-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={codeLength}
          placeholder={labels.codePlaceholder}
          value={code}
          disabled={disabled}
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/gu, "").slice(0, codeLength));
          }}
        />
        <button
          type="button"
          data-phone-otp-role="verify"
          disabled={verifyDisabled}
          onClick={() => {
            void handleVerify();
          }}
        >
          {verifying ? labels.verifying : labels.verify}
        </button>
      </div>

      <p
        data-phone-otp-role="notice"
        data-notice-kind={notice?.kind ?? "none"}
        role={notice?.kind === "error" ? "alert" : undefined}
        aria-live="polite"
      >
        {notice?.text ?? ""}
      </p>
    </section>
  );
}

export default PhoneOtpPanel;
