// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sign-in / register / forgot-password.
 *
 * Two shapes, one set of primitives:
 *
 *   - password: email + password (login), email + nickname + password
 *     (register);
 *   - code:     destination → [获取验证码] → code screen → [登录].
 *
 * The code flow is deliberately shared by both identities. Email and phone
 * differ only in the transport (mail vs SMS) and in what the server does after
 * verification: a phone number is signed in *or registered* by the same code,
 * while an email code only signs in an account that already exists (email
 * registration still proves itself with a password and a verification letter).
 * That is why the phone surface never asks for a password, and why there is no
 * "用手机号注册" any more — one number, one code, one action.
 *
 * The code screen is a second step inside the same card rather than a second
 * route: the destination is already in memory, a refresh cannot resurrect a
 * code that has been consumed, and the card's own back link is the only "back"
 * a reader needs. Email/password and the two code paths therefore all read as
 * one page with one primary action.
 *
 * Every credential call lives in `lib/auth-client.ts`; this file only owns the
 * state machine, field validation and copy. Field errors are local and focus
 * moves to the first invalid field; `banner` is reserved for credentials,
 * rate limits and the network.
 */
import { useEffect, useRef, useState } from "react";
import {
  signUp,
  signIn,
  sendSignInOtp,
  signInWithEmailOtp,
  requestPasswordReset,
  sendPhoneCode,
  signInOrSignUpWithPhone,
  resetPasswordWithPhone,
  type PhoneCodePurpose,
} from "../lib/auth-client";
import { ApiRequestError } from "../lib/api-error";
import { useSession } from "../lib/session";
import {
  AuthBanner,
  AuthCard,
  AuthCodeField,
  AuthField,
  AuthSubmit,
  ResendCode,
  SendCodeButton,
  StrengthMeter,
} from "../components/auth/AuthUI";
import type { CodeSlotsStatus } from "../components/auth/CodeSlots";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_RE = /^\d{6}$/;
/** Mainland mobile national number: 1, then 3-9, then nine digits. */
const PHONE_RE = /^1[3-9]\d{9}$/;

type Mode = "login" | "register" | "forgot";
type Channel = "email" | "phone";
type Method = "password" | "code";
type Step = "identity" | "code";
type Field = "name" | "email" | "phone" | "password" | "confirm" | "otp";
type Errors = Partial<Record<Field, string>>;
type Success = "verify-email" | "reset-email" | "reset-phone";

interface SentCode {
  /** Display form, e.g. `138****8000` or `ab****@example.com`. */
  masked: string;
  /** When the resend countdown ends. */
  until: number;
  /** Lifetime the server reported, for the "N 分钟内有效" sentence. */
  validForSeconds: number;
}

interface AuthProps {
  mode: Mode;
}

const TITLE: Record<Mode, string> = {
  login: "欢迎回来",
  register: "开始使用 KoBook",
  forgot: "找回密码",
};

function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!domain) return value;
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(2, local.length - head.length))}@${domain}`;
}

function messageFor(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "操作失败，请稍后再试。";
}

function minutesOf(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

export default function Auth({ mode }: AuthProps) {
  const [channel, setChannel] = useState<Channel>("email");
  const [method, setMethod] = useState<Method>("password");
  const [step, setStep] = useState<Step>("identity");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [otp, setOtp] = useState("");
  const [codeStatus, setCodeStatus] = useState<CodeSlotsStatus>("idle");
  const [sent, setSent] = useState<SentCode | null>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [success, setSuccess] = useState<Success | null>(null);
  const refreshSession = useSession((s) => s.refresh);
  // One code, one verification: the sixth digit triggers the check, and a
  // click landing in the same breath must not send a second one.
  const verifyingRef = useRef(false);
  const autoVerifyTimer = useRef<number | undefined>(undefined);

  const isPhone = channel === "phone";
  /** Login by code: the two-step surface. */
  const codeLogin = mode === "login" && method === "code";
  /** Forgot-password on a number: the code sits inline with the new password. */
  const inlineCode = mode === "forgot" && isPhone;
  const onCodeStep = codeLogin && step === "code";

  // A route change remounts the page (App keys on mode), but keep the reset
  // here too so a future in-place switch cannot leak a code across modes.
  useEffect(() => {
    setBanner(null);
    setErrors({});
    setSent(null);
    setStep("identity");
    setOtp("");
    setCodeStatus("idle");
    setSuccess(null);
    setSubmitting(false);
    setSending(false);
  }, [mode]);

  const clearError = (field: Field) => {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
    setBanner(null);
  };

  const focusField = (field: Field) => {
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLElement>(`[data-auth-field="${field}"] input`);
      input?.focus();
      input?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    });
  };

  const focusCode = () => {
    window.setTimeout(() => {
      document.getElementById("auth-otp")?.focus();
    }, 0);
  };

  // Editing the code clears the field error but not the banner: the banner is
  // where a rejected code is explained, and the slots' drain fires an onChange
  // of its own — reusing `clearError` here would wipe the sentence mid-read.
  const clearCodeError = () => {
    setErrors((prev) => (prev.otp ? { ...prev, otp: undefined } : prev));
  };

  const resetFlow = () => {
    setStep("identity");
    setSent(null);
    setOtp("");
    setCodeStatus("idle");
    setErrors({});
    setBanner(null);
  };

  const switchChannel = () => {
    const next: Channel = isPhone ? "email" : "phone";
    setChannel(next);
    // The phone surface is passwordless by design; going back to email keeps
    // the code method already selected, so the two switches cannot fight.
    if (next === "phone") setMethod("code");
    resetFlow();
  };

  const switchMethod = () => {
    setMethod(method === "password" ? "code" : "password");
    resetFlow();
  };

  const identityErrors = (): Errors => {
    const next: Errors = {};
    if (isPhone) {
      if (!PHONE_RE.test(phone)) next.phone = "请输入 11 位手机号。";
    } else if (!EMAIL_RE.test(email)) {
      next.email = "邮箱格式不正确。";
    }
    return next;
  };

  const validate = (): Errors => {
    if (onCodeStep) {
      return OTP_RE.test(otp) ? {} : { otp: "请输入 6 位数字验证码。" };
    }
    if (codeLogin) {
      return identityErrors();
    }

    const next = identityErrors();

    if (mode === "login") {
      if (password.length === 0) next.password = "请输入密码。";
    }

    if (mode === "register") {
      if (name.trim().length === 0) next.name = "请输入昵称。";
      if (password.length < 8) next.password = "密码至少 8 位。";
      if (password !== confirm) next.confirm = "两次输入的密码不一致。";
    }

    if (inlineCode) {
      if (!OTP_RE.test(otp)) next.otp = "请输入 6 位数字验证码。";
      if (password.length < 8) next.password = "密码至少 8 位。";
      if (password !== confirm) next.confirm = "两次输入的密码不一致。";
    }

    return next;
  };

  const sendCode = async () => {
    if (sending) return;
    setBanner(null);

    const invalid = identityErrors();
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      focusField(isPhone ? "phone" : "email");
      return;
    }

    setErrors({});
    setSending(true);
    try {
      if (isPhone) {
        const purpose: PhoneCodePurpose =
          mode === "login" ? "sign-in-or-up" : "reset-password";
        const response = await sendPhoneCode({ phoneNumber: phone, purpose });
        setSent({
          masked: response.maskedPhone,
          until: Date.now() + response.cooldownSeconds * 1000,
          validForSeconds: response.expiresInSeconds,
        });
      } else {
        await sendSignInOtp(email);
        setSent({
          masked: maskEmail(email),
          until: Date.now() + 60_000,
          validForSeconds: 600,
        });
      }
      setOtp("");
      setCodeStatus("idle");
      if (codeLogin) setStep("code");
      focusCode();
    } catch (error) {
      setBanner(messageFor(error));
    } finally {
      setSending(false);
    }
  };

  /**
   * Verify the six digits and sign in. Shared by the auto-trigger (the last
   * digit) and the button, so the two paths cannot drift apart.
   */
  const completeCode = async (code: string) => {
    if (verifyingRef.current || !OTP_RE.test(code)) return;
    verifyingRef.current = true;
    setErrors({});
    setBanner(null);
    setSubmitting(true);
    try {
      if (isPhone) {
        await signInOrSignUpWithPhone({ phoneNumber: phone, code });
      } else {
        await signInWithEmailOtp({ email, otp: code });
      }
      // The slots merge into a tick, then the reader replaces the card.
      // Without the beat the only "accepted" signal is the page swapping.
      setCodeStatus("success");
      await new Promise((resolve) => window.setTimeout(resolve, 520));
      await refreshSession();
      window.location.hash = "#/";
    } catch (error) {
      // A rejected code drains out of the slots so the next attempt starts
      // from six empty holes; a network failure keeps the digits where they
      // are, because retyping would not fix the connection.
      if (error instanceof ApiRequestError && error.status === 400) {
        setCodeStatus("error");
      }
      setBanner(messageFor(error));
      document.querySelector<HTMLElement>(".auth-banner")?.scrollIntoView?.({
        block: "center",
        behavior: "smooth",
      });
    } finally {
      verifyingRef.current = false;
      setSubmitting(false);
    }
  };

  const scheduleVerify = (code: string) => {
    window.clearTimeout(autoVerifyTimer.current);
    // Give the last digit its landing beat before the button turns into a
    // spinner; submitting on the same frame cuts the animation in half.
    autoVerifyTimer.current = window.setTimeout(() => void completeCode(code), 180);
  };

  useEffect(() => () => window.clearTimeout(autoVerifyTimer.current), []);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || sending) return;

    // Identity screen of the code flow: the primary action *is* sending.
    if (codeLogin && step === "identity") {
      await sendCode();
      return;
    }

    // The inline reset can only be attempted once a code exists; say so
    // instead of failing validation on a field that is not on screen yet.
    if (inlineCode && !sent) {
      const invalid = identityErrors();
      if (Object.keys(invalid).length > 0) {
        setErrors(invalid);
        focusField("phone");
        return;
      }
      setBanner("请先获取验证码。");
      document.querySelector<HTMLButtonElement>("[data-auth-send]")?.focus();
      return;
    }

    const next = validate();
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setBanner(null);
      const order: Field[] = ["name", "email", "phone", "otp", "password", "confirm"];
      const first = order.find((field) => next[field]);
      if (first) focusField(first);
      return;
    }

    // The code screen verifies on its own once the sixth digit lands; the
    // button stays as the keyboard/assistive fallback.
    if (codeLogin) {
      await completeCode(otp);
      return;
    }

    setErrors({});
    setBanner(null);
    setSubmitting(true);
    try {
      if (mode === "login") {
        await signIn({ email, password });
        await refreshSession();
        window.location.hash = "#/";
        return;
      }

      if (mode === "register") {
        await signUp({
          email,
          password,
          name: name.trim(),
          callbackURL: "/#/verify-email",
        });
        // Sign-up auto-signs-in server-side; reflect that in the shell while
        // the success panel asks the user to verify.
        await refreshSession().catch(() => undefined);
        setSuccess("verify-email");
        return;
      }

      if (isPhone) {
        await resetPasswordWithPhone({ phoneNumber: phone, code: otp, newPassword: password });
        setSuccess("reset-phone");
      } else {
        await requestPasswordReset({ email, redirectTo: "/#/reset-password" });
        setSuccess("reset-email");
      }
    } catch (error) {
      setBanner(messageFor(error));
      document.querySelector<HTMLElement>(".auth-banner")?.scrollIntoView?.({
        block: "center",
        behavior: "smooth",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const successTitle =
    success === "verify-email"
      ? "注册成功"
      : success === "reset-email"
        ? "重置链接已发送"
        : success === "reset-phone"
          ? "密码已重置"
          : null;

  const subtitle = success
    ? success === "verify-email"
      ? "查收验证信，还差一步。"
      : success === "reset-email"
        ? "查收邮件，30 分钟内有效。"
        : "该账号此前的登录状态已全部失效。"
    : onCodeStep && sent
      ? `${isPhone ? "手机号" : "邮箱"} ${sent.masked}，验证码 ${minutesOf(sent.validForSeconds)} 分钟内有效。`
      : mode === "login"
        ? codeLogin
          ? isPhone
            ? "未注册的手机号，验证后自动创建账号。"
            : "验证码登录，无需记住密码。"
          : "登录 KoBook，继续你的阅读。"
        : mode === "register"
          ? "创建账号，把想法留在页边。"
          : isPhone
            ? "输入注册手机号，验证后设置新密码。"
            : "输入注册邮箱，我们会发送重置链接。";

  const primaryLabel = onCodeStep
    ? "登录"
    : codeLogin
      ? "获取验证码"
      : mode === "login"
        ? "登录"
        : mode === "register"
          ? "注册"
          : isPhone
            ? "重置密码"
            : "发送重置链接";

  const loadingText = onCodeStep
    ? "正在登录…"
    : codeLogin
      ? "正在发送…"
      : mode === "login"
        ? "正在登录…"
        : mode === "register"
          ? "正在注册…"
          : "正在发送…";

  const footer = success ? undefined : (
    <>
      <span>
        {mode === "login" ? (
          codeLogin && isPhone ? (
            // A number registers itself, so "创建账号" would be a detour.
            "手机号验证后自动创建账号。"
          ) : (
            <>
              还没有账号？<a href="#/register">创建账号</a>
            </>
          )
        ) : mode === "register" ? (
          <>
            已经有账号？<a href="#/login">登录</a>
          </>
        ) : (
          <>
            想起密码了？<a href="#/login">登录</a>
          </>
        )}
      </span>
      {mode === "register" ? null : (
        <button type="button" className="auth-quiet" onClick={switchChannel}>
          {mode === "login"
            ? isPhone
              ? "用邮箱登录"
              : "用手机号登录"
            : isPhone
              ? "用邮箱找回"
              : "用手机号找回"}
        </button>
      )}
    </>
  );

  return (
    <AuthCard
      title={successTitle ?? (onCodeStep ? "输入验证码" : TITLE[mode])}
      subtitle={subtitle}
      footer={footer}
    >
      {success ? (
        <div className="auth-success">
          <p>
            {success === "verify-email" ? (
              <>
                一封验证信已寄往 <span className="auth-accent">{email}</span>，1 小时内有效。
                没收到？看看垃圾邮件，或者重新寄一封。
              </>
            ) : success === "reset-email" ? (
              <>
                如果 <span className="auth-accent">{email}</span> 已经在 KoBook 注册，
                我们已经发送了重置链接。请在 30 分钟内点击邮件中的链接完成设置。
              </>
            ) : (
              <>
                <span className="auth-accent">
                  {phone.slice(0, 3)}****{phone.slice(-4)}
                </span>{" "}
                的密码已重置，请用新密码登录。
              </>
            )}
          </p>
          <div className="auth-success-actions">
            <a href="#/login">去登录</a>
            <a href="#/">回到首页</a>
          </div>
        </div>
      ) : (
        <>
          <AuthBanner message={banner} />
          <form onSubmit={onSubmit} noValidate>
            <div className="auth-fields">
              {onCodeStep ? (
                <>
                  <AuthCodeField
                    value={otp}
                    status={codeStatus}
                    autoFocus
                    onComplete={scheduleVerify}
                    onChange={(code) => {
                      setOtp(code);
                      clearCodeError();
                      if (codeStatus === "error") setCodeStatus("idle");
                    }}
                    error={errors.otp}
                    aside={
                      sent ? (
                        <ResendCode
                          until={sent.until}
                          onResend={() => void sendCode()}
                          busy={sending}
                        />
                      ) : undefined
                    }
                  />

                  <AuthSubmit loading={submitting} loadingText={loadingText}>
                    {primaryLabel}
                  </AuthSubmit>

                  <div className="auth-method">
                    <button type="button" className="auth-link" onClick={resetFlow}>
                      ← 重新输入{isPhone ? "手机号" : "邮箱"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {mode === "register" ? (
                    <AuthField
                      label="昵称"
                      name="name"
                      autoComplete="nickname"
                      value={name}
                      placeholder="怎么称呼你"
                      onChange={(e) => {
                        setName(e.target.value);
                        clearError("name");
                      }}
                      error={errors.name}
                      required
                    />
                  ) : null}

                  {isPhone ? (
                    <AuthField
                      label="手机号"
                      name="phone"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      maxLength={11}
                      pattern="[0-9]*"
                      prefix="+86"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value.replace(/\D/g, "").slice(0, 11));
                        setSent(null);
                        setOtp("");
                        clearError("phone");
                      }}
                      error={errors.phone}
                      placeholder="138 0000 0000"
                      aside={
                        inlineCode && !sent ? (
                          <SendCodeButton onClick={() => void sendCode()} sending={sending} />
                        ) : undefined
                      }
                      required
                    />
                  ) : (
                    <AuthField
                      label="邮箱"
                      name="email"
                      type="email"
                      autoComplete="username"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={email}
                      placeholder="you@example.com"
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (sent) {
                          setSent(null);
                          setOtp("");
                        }
                        clearError("email");
                      }}
                      error={errors.email}
                      required
                    />
                  )}

                  {inlineCode && sent ? (
                    <AuthCodeField
                      value={otp}
                      status="idle"
                      onChange={(code) => {
                        setOtp(code);
                        clearCodeError();
                      }}
                      error={errors.otp}
                      hint={`已发送至 ${sent.masked}`}
                      aside={
                        <ResendCode
                          until={sent.until}
                          onResend={() => void sendCode()}
                          busy={sending}
                        />
                      }
                    />
                  ) : null}

                  {mode === "login" && method === "password" ? (
                    <AuthField
                      label="密码"
                      name="password"
                      autoComplete="current-password"
                      password
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        clearError("password");
                      }}
                      error={errors.password}
                      required
                      minLength={1}
                    />
                  ) : null}

                  {mode === "register" ? (
                    <>
                      <AuthField
                        label="密码"
                        name="password"
                        autoComplete="new-password"
                        password
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          clearError("password");
                        }}
                        error={errors.password}
                        hint="至少 8 位"
                        afterInput={
                          password.length > 0 ? <StrengthMeter password={password} /> : undefined
                        }
                        required
                        minLength={8}
                      />
                      <AuthField
                        label="再次输入密码"
                        name="confirm"
                        autoComplete="new-password"
                        password
                        value={confirm}
                        onChange={(e) => {
                          setConfirm(e.target.value);
                          clearError("confirm");
                        }}
                        error={errors.confirm}
                        required
                        minLength={8}
                      />
                    </>
                  ) : null}

                  {inlineCode ? (
                    <>
                      <AuthField
                        label="新密码"
                        name="password"
                        autoComplete="new-password"
                        password
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          clearError("password");
                        }}
                        error={errors.password}
                        hint="至少 8 位"
                        required
                        minLength={8}
                      />
                      <AuthField
                        label="再次输入密码"
                        name="confirm"
                        autoComplete="new-password"
                        password
                        value={confirm}
                        onChange={(e) => {
                          setConfirm(e.target.value);
                          clearError("confirm");
                        }}
                        error={errors.confirm}
                        required
                        minLength={8}
                      />
                    </>
                  ) : null}

                  {mode === "login" && !isPhone ? (
                    <div className="auth-method">
                      <button type="button" className="auth-link" onClick={switchMethod}>
                        {method === "password" ? "改用验证码登录" : "改用密码登录"}
                        <span aria-hidden="true"> →</span>
                      </button>
                    </div>
                  ) : null}

                  {codeLogin ? (
                    <AuthSubmit loading={sending} loadingText={loadingText} disabled={sending}>
                      {primaryLabel}
                    </AuthSubmit>
                  ) : (
                    <AuthSubmit loading={submitting} loadingText={loadingText}>
                      {primaryLabel}
                    </AuthSubmit>
                  )}
                </>
              )}
            </div>
          </form>
        </>
      )}
    </AuthCard>
  );
}
