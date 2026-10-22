// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Auth surface primitives — the card layout used by #/login, #/register and
 * #/forgot.
 *
 * The layout (centred card, mark, title, full-width action, footer switch)
 * follows the EasyUI reference the product owner picked; the colours,
 * typography and every word are KoBook's. No component library is imported:
 * the card is a bordered sheet on a slightly darker desk, which is the
 * hierarchy the page needs on a pure-black night palette.
 */
import {
  useEffect,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import ThemeToggle from "../ThemeToggle";
import AuthBackdrop from "./AuthBackdrop";
import CodeSlots, { type CodeSlotsStatus } from "./CodeSlots";

/* ── Card shell ───────────────────────────────────────────────────── */

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-shell">
      <AuthBackdrop />
      <header className="auth-topbar">
        <a href="#/" className="auth-back" aria-label="返回 KoBook 首页">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          返回首页
        </a>
        <ThemeToggle />
      </header>

      <main className="auth-center">
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-glow" aria-hidden="true" />
          <div className="auth-head">
            <div className="auth-mark" aria-hidden="true">
              +
            </div>
            <h1 id="auth-title" className="auth-title">
              {title}
            </h1>
            {subtitle ? <p className="auth-sub">{subtitle}</p> : null}
          </div>
          {children}
          {footer ? <div className="auth-footer">{footer}</div> : null}
        </section>
      </main>
    </div>
  );
}

/* ── Field ────────────────────────────────────────────────────────── */

interface AuthFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label: string;
  hint?: ReactNode;
  error?: string;
  password?: boolean;
  /** Prefix rendered inside the control, e.g. "+86". */
  prefix?: string;
  /** Secondary control aligned with the label, e.g. the resend countdown. */
  aside?: ReactNode;
  /** Rendered between the control and its hint, e.g. a strength meter. */
  afterInput?: ReactNode;
  /** Wide, centred, letter-spaced rendering for a one-time code. */
  otp?: boolean;
}

export function AuthField({
  label,
  hint,
  error,
  password,
  prefix,
  aside,
  afterInput,
  otp,
  id,
  ...input
}: AuthFieldProps) {
  const autoId = useId();
  const inputId = id ?? (input.name ? `auth-${input.name}` : autoId);
  const messageId = `${inputId}-msg`;
  const [revealed, setRevealed] = useState(false);
  const message = error ?? hint;

  return (
    <div
      className={"auth-field" + (error ? " is-invalid" : "")}
      data-auth-field={input.name}
    >
      <div className="auth-label-row">
        <label className="auth-label" htmlFor={inputId}>
          {label}
        </label>
        {aside}
      </div>

      <div className="auth-control">
        {prefix ? (
          <span className="auth-prefix" aria-hidden="true">
            {prefix}
            <i />
          </span>
        ) : null}
        <input
          {...input}
          id={inputId}
          type={password ? (revealed ? "text" : "password") : input.type}
          className={
            "auth-input" +
            (prefix ? " has-prefix" : "") +
            (password ? " has-eye" : "") +
            (otp ? " is-otp" : "")
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
        />
        {password ? (
          <button
            type="button"
            className="auth-eye"
            aria-label={revealed ? "隐藏密码" : "显示密码"}
            aria-pressed={revealed}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3l18 18" />
                <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                <path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1M6.2 6.2A16.7 16.7 0 0 0 2 12s3.5 7 10 7a10.7 10.7 0 0 0 4.2-.9" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        ) : null}
      </div>

      {afterInput}

      {message ? (
        <p
          id={messageId}
          className={error ? "auth-error" : "auth-hint"}
          role={error ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/* ── Code field (six slots) ───────────────────────────────────────── */

/**
 * The one-time-code control. Six discrete slots instead of one wide input:
 * the code is a shape the eye can count, and the fill animation confirms each
 * digit landed without a helper line saying so.
 *
 * The hidden input inside `CodeSlots` is the real form control — keyboard,
 * clipboard, `autocomplete="one-time-code"` and the label all point at it — so
 * this wrapper only supplies the label row, the resend slot and the message.
 */
export function AuthCodeField({
  value,
  onChange,
  onComplete,
  status = "idle",
  error,
  hint,
  aside,
  autoFocus,
}: {
  value: string;
  onChange: (code: string) => void;
  /** Fired once the last hole is filled; used to verify without a button. */
  onComplete?: (code: string) => void;
  status?: CodeSlotsStatus;
  error?: string;
  hint?: ReactNode;
  aside?: ReactNode;
  autoFocus?: boolean;
}) {
  const inputId = "auth-otp";
  const { slotSize, gap } = useCodeMetrics();
  const message = error ?? hint;

  return (
    <div
      className={"auth-field auth-code" + (error ? " is-invalid" : "")}
      data-auth-field="otp"
    >
      <div className="auth-label-row">
        <label className="auth-label" htmlFor={inputId}>
          验证码
        </label>
        {aside}
      </div>

      <CodeSlots
        length={6}
        value={value}
        onChange={onChange}
        onComplete={onComplete}
        status={status}
        inputId={inputId}
        autoFocus={autoFocus}
        slotSize={slotSize}
        gap={gap}
        radius={10}
        accentColor="rgb(var(--text))"
        inkColor="rgb(var(--text))"
        slotColor="rgb(var(--auth-input))"
        digitColor="rgb(var(--bg))"
        dangerColor="rgb(var(--accent))"
        ariaLabel="验证码"
      />

      {message ? (
        <p
          id={`${inputId}-msg`}
          className={error ? "auth-error" : "auth-hint"}
          role={error ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Slot geometry for the card width. Six 44px slots no longer fit once the
 * card is 360px wide, and the caret is positioned from pixel offsets, so the
 * sizes are chosen here rather than squeezed with a CSS transform.
 */
function useCodeMetrics(): { slotSize: number; gap: number } {
  const read = () => {
    if (typeof window === "undefined") return { slotSize: 44, gap: 8 };
    const width = window.innerWidth;
    if (width <= 340) return { slotSize: 30, gap: 5 };
    if (width <= 420) return { slotSize: 36, gap: 6 };
    return { slotSize: 44, gap: 8 };
  };
  const [metrics, setMetrics] = useState(read);
  useEffect(() => {
    const onResize = () => setMetrics(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return metrics;
}

/* ── Actions ──────────────────────────────────────────────────────── */

export function AuthSubmit({
  children,
  loading,
  loadingText = "处理中…",
  disabled,
}: {
  children: ReactNode;
  loading?: boolean;
  loadingText?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      className="auth-primary"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      <span>{loading ? loadingText : children}</span>
      {loading ? (
        <span className="auth-spinner" aria-hidden="true" />
      ) : (
        <span className="auth-arrow" aria-hidden="true">
          →
        </span>
      )}
    </button>
  );
}

/** Field-scoped "send code" action, before a code exists. */
export function SendCodeButton({
  onClick,
  sending,
  disabled,
}: {
  onClick: () => void;
  sending?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="auth-link"
      onClick={onClick}
      disabled={sending || disabled}
      data-auth-send
    >
      {sending ? "发送中…" : "发送验证码"}
    </button>
  );
}

/** Countdown / resend control shown once a code has been requested. */
export function ResendCode({
  until,
  onResend,
  busy,
}: {
  until: number;
  onResend: () => void;
  busy?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (until <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);

  const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  if (remaining > 0) {
    return (
      <span className="auth-countdown" aria-live="off">
        {remaining}s 后可重发
      </span>
    );
  }
  return (
    <button type="button" className="auth-link" onClick={onResend} disabled={busy}>
      {busy ? "发送中…" : "重新发送"}
    </button>
  );
}

export function AuthBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="auth-banner" role="alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5M12 16.2v.3" />
      </svg>
      <span>{message}</span>
    </div>
  );
}


export function StrengthMeter({ password }: { password: string }) {
  const score =
    (password.length >= 8 ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);
  return (
    <div className="auth-strength" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={i < score ? "on" : ""} />
      ))}
    </div>
  );
}


