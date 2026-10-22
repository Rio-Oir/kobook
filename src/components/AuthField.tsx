// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reusable form field matching the project's visual conventions.
 *
 * `label.block.mb-3 > div.text-xs.text-gloss-textDim.mb-1.5 +
 * input.w-full.bg-gloss-surface2.border.border-gloss-outline.rounded.px-3.py-2.text-sm`.
 *
 * The fill is `surface2` and the boundary is `outline`, not `bg` +
 * `border`: an input sits inside a `surface` panel, so a `bg` fill
 * would be *brighter* than its own panel and read as a hole punched
 * through to the page. `outline` is the control-boundary token held
 * to WCAG 1.4.11's 3:1; `border` is the ~1.3:1 hairline used for
 * decorative dividers.
 */
import { useState, type InputHTMLAttributes, type ReactNode } from "react";

interface AuthFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label: string;
  /** Hint rendered beneath the input. */
  hint?: ReactNode;
  /** If true, the input is rendered as a password field with a reveal toggle. */
  password?: boolean;
}

export function AuthField({ label, hint, password, type, ...input }: AuthFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const inputType = password ? (revealed ? "text" : "password") : type;

  return (
    <label className="block mb-3">
      <div className="text-xs text-gloss-textDim mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <input
          {...input}
          type={inputType}
          className="w-full bg-gloss-surface2 border border-gloss-outline rounded px-3 py-2 text-sm outline-none focus:border-gloss-accent"
        />
        {password ? (
          <button
            type="button"
            onClick={() => setRevealed(!revealed)}
            className="text-gloss-textDim hover:text-gloss-text p-2 text-xs"
            title={revealed ? "隐藏" : "显示"}
          >
            {revealed ? "🙈" : "👁"}
          </button>
        ) : null}
      </div>
      {hint ? <div className="text-[10px] text-gloss-textDim mt-1">{hint}</div> : null}
    </label>
  );
}

/** Standard "提交中" / "X中" disabled primary button used by every auth screen. */
export function AuthPrimaryButton({
  children,
  loading,
  className = "",
  type = "submit",
  disabled,
  onClick,
}: {
  children: ReactNode;
  loading?: boolean;
  className?: string;
  type?: "submit" | "button";
  disabled?: boolean;
  onClick?: () => void | Promise<void>;
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      className={
        "px-4 py-1.5 text-sm bg-gloss-text text-gloss-bg rounded font-medium hover:bg-gloss-text/85 transition-colors disabled:opacity-40 " +
        className
      }
    >
      {loading ? "处理中…" : children}
    </button>
  );
}

export function AuthErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-4 px-4 py-3 rounded-lg bg-gloss-accent/10 border border-gloss-accent/30 text-sm text-gloss-accent">
      {message}
    </div>
  );
}
