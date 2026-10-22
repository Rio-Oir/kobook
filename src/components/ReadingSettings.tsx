// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reading settings — a compact popover for the article's typography and for
 * the two side rails.
 *
 * Six controls and a reset. Deliberately no explanatory paragraph, no
 * "recommended" badge and no preview pane: the reader is looking at the
 * article behind this panel, and it *is* the preview. Every change applies
 * immediately, so the panel only has to be small enough not to cover the
 * thing being judged.
 *
 * ## Why the rail switches live here
 *
 * 目录 and 笔记栏 used to be two icon buttons in the header. They are not
 * article actions, they are *view preferences* — the same kind of thing as
 * font size, and `notesOpen` is in fact a `ReadingPrefs` field already. In
 * the header they cost two slots between the account entry and the reading
 * controls, which is what made that corner read as a toolbar; here they cost
 * two rows in a panel that already exists. Both rails also still open by
 * dragging their seam, so the switches are the discoverable, keyboard-
 * reachable path rather than the only one. They are rendered at `lg` and up
 * only: below that the rails are not drawn at all, and a switch for
 * something that cannot appear is worse than no switch.
 *
 * Font selection is intentionally absent: typography preferences must not
 * replace the document's existing font family.
 */

import { useEffect, type ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import {
  FONT_SIZE_LABEL,
  FONT_SIZE_OPTIONS,
  LINE_HEIGHT_LABEL,
  LINE_HEIGHT_OPTIONS,
  MEASURE_LABEL,
  MEASURE_RANGE,
  PARAGRAPH_GAP_LABEL,
  PARAGRAPH_GAP_OPTIONS,
  type ReadingPrefs,
} from "@/lib/reading-prefs";

export default function ReadingSettings({
  open,
  prefs,
  onChange,
  onReset,
  onClose,
  rails,
}: {
  open: boolean;
  prefs: ReadingPrefs;
  /**
   * Apply one change. The Reader wraps this to capture the current reading
   * position first — a font size change reflows the whole column, and the
   * paragraph the reader was on has to stay where it was.
   */
  onChange: (patch: Partial<ReadingPrefs>) => void;
  onReset: () => void;
  onClose: () => void;
  /**
   * The two side rails. Optional so the panel still renders in isolation
   * (and in tests) without a layout to control.
   *
   * `outlineAvailable` is the article's own answer: a document with no
   * headings has nothing to list, and the switch is disabled rather than
   * hidden so the row does not appear and disappear between articles.
   */
  rails?: {
    outlineAvailable: boolean;
    outlineOpen: boolean;
    notesOpen: boolean;
    onToggleOutline: () => void;
    onToggleNotes: () => void;
  };
}) {
  // Escape closes. The click-away layer below handles the pointer, but a
  // keyboard user has no way to reach it.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  /**
   * The value shown when the reader has not chosen a size.
   *
   * `fontSizePx` is `null` for "the responsive default", which is 20px on a
   * desktop and 18px on a phone — the select has to show *something*, and
   * showing the value actually in effect is the honest option. Reading the
   * resolved size back off the rendered column means this display cannot
   * drift from what the CSS did.
   *
   * Snapped to the nearest option because the resolved size is not
   * necessarily one of them: a browser zoom or a platform text-size setting
   * can make it 18.4px, and a `<select>` whose `value` matches no `<option>`
   * renders blank.
   */
  const sizeValue = String(
    prefs.fontSizePx ?? nearestOption(resolvedFontSize(), FONT_SIZE_OPTIONS),
  );

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        role="dialog"
        aria-label="阅读设置"
        data-testid="reading-settings"
        className="fixed right-3 top-[56px] z-40 w-[268px] rounded-lg border border-gloss-border bg-gloss-surface p-3 shadow-2xl animate-slide-up"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium text-gloss-text">阅读设置</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭阅读设置"
            className="p-0.5 text-sm leading-none text-gloss-textDim hover:text-gloss-text"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2.5">
          <Field label="字号">
            <select
              value={sizeValue}
              onChange={(e) => onChange({ fontSizePx: Number(e.target.value) })}
              aria-label="字号"
              data-testid="reading-font-size"
              className={SELECT_CLASS}
            >
              {FONT_SIZE_OPTIONS.map((px) => (
                <option key={px} value={String(px)}>
                  {FONT_SIZE_LABEL(px)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="行高">
            <select
              value={String(prefs.lineHeight)}
              onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
              aria-label="行高"
              data-testid="reading-line-height"
              className={SELECT_CLASS}
            >
              {LINE_HEIGHT_OPTIONS.map((value) => (
                <option key={value} value={String(value)}>
                  {LINE_HEIGHT_LABEL(value)}
                </option>
              ))}
            </select>
          </Field>

          {/*
            A slider rather than the `<select>` the other three rows use.
            The measure is no longer a short option list: the column edge
            is draggable, so it can hold any whole number of characters in
            `MEASURE_RANGE`, and a select would have to grow an option
            every time the reader dragged somewhere new — an option list
            that changes as you use it is worse than no option list.
          */}
          <Field label="行宽">
            <div className="flex w-[104px] shrink-0 items-center gap-1.5">
              <input
                type="range"
                min={MEASURE_RANGE[0]}
                max={MEASURE_RANGE[1]}
                step={1}
                value={prefs.measure}
                onChange={(e) => onChange({ measure: Number(e.target.value) })}
                aria-label="行宽"
                data-testid="reading-measure"
                className="h-1 min-w-0 flex-1 accent-gloss-accent"
              />
              <span
                data-testid="reading-measure-value"
                className="w-9 shrink-0 text-right text-[11px] tabular-nums text-gloss-textDim"
              >
                {MEASURE_LABEL(prefs.measure)}
              </span>
            </div>
          </Field>

          <Field label="段距">
            <select
              value={String(prefs.paragraphGap)}
              onChange={(e) =>
                onChange({ paragraphGap: Number(e.target.value) })
              }
              aria-label="段距"
              data-testid="reading-paragraph-gap"
              className={SELECT_CLASS}
            >
              {PARAGRAPH_GAP_OPTIONS.map((em) => (
                <option key={em} value={String(em)}>
                  {PARAGRAPH_GAP_LABEL(em)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/*
          The two rails, in the same order as the layout draws them: left
          (目录) then right (笔记栏). `lg` is the breakpoint the rails
          themselves start at — below it there is nothing to show or hide.
        */}
        {rails ? (
          <div className="mt-3 hidden space-y-2.5 border-t border-gloss-border pt-3 lg:block">
            <Switch
              id="reading-rail-outline"
              testId="outline-toggle"
              checked={rails.outlineOpen}
              onChange={rails.onToggleOutline}
              disabled={!rails.outlineAvailable}
              label="目录"
              className="items-center"
            />
            <Switch
              id="reading-rail-notes"
              testId="notes-rail-toggle"
              checked={rails.notesOpen}
              onChange={rails.onToggleNotes}
              label="笔记栏"
              className="items-center"
            />
          </div>
        ) : null}

        <button
          type="button"
          onClick={onReset}
          data-testid="reading-reset"
          className="mt-3 w-full rounded border border-gloss-border px-2 py-1.5 text-[11px] text-gloss-textDim transition-colors hover:border-gloss-outline hover:text-gloss-text"
        >
          恢复默认
        </button>
      </div>
    </>
  );
}

const SELECT_CLASS =
  "w-[104px] shrink-0 rounded border border-gloss-outline bg-gloss-surface2 px-2 py-1 text-xs text-gloss-text outline-none focus:border-gloss-accent";

/**
 * The size actually in effect, read off the rendered article.
 *
 * Taken from the prose container rather than from a paragraph: a heading is
 * as likely to be the first block, and a heading's computed size is its own
 * multiple of the body size.
 *
 * Falls back to the desktop default when the article has not painted yet —
 * the panel can be opened before the body exists, and a NaN here would
 * blank the select.
 */
function resolvedFontSize(): number {
  const prose = document.querySelector<HTMLElement>(".gloss-prose");
  const px = prose ? parseFloat(getComputedStyle(prose).fontSize) : NaN;
  return Number.isFinite(px) ? px : 20;
}

/** The option closest to `value`, so a `<select>` never renders blank. */
function nearestOption(value: number, options: number[]): number {
  return options.reduce(
    (best, option) =>
      Math.abs(option - value) < Math.abs(best - value) ? option : best,
    options[0]!,
  );
}

/** One label + control row, kept narrow so the panel stays compact. */
function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-gloss-textDim">{label}</span>
      {children}
    </div>
  );
}
