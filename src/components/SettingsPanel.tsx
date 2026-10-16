// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Settings panel for the user's AI provider, API key, and model.
// Pops up from the gear button in the top bar. BYOK (Bring Your Own Key):
// the key stays in memory by default, is only written to localStorage after
// an explicit "仅在此设备记住", and is only ever sent to the endpoint the
// user has confirmed here.
//
// Two behaviours are deliberately *not* wired to `onChange`:
//
//   - the interface address is committed on blur / Enter. The previous
//     version ran the "you are about to send your key to a new domain"
//     dialog inside `onChange`, so a typed URL popped a `confirm()` per
//     keystroke — and a `confirm()` that fired mid-typing was usually
//     dismissed, silently accepting the new origin.
//   - the provider `<select>` used to swap the base URL with no prompt at
//     all, which was the same bypass with one click.
//
// Both now route through `confirmEndpoint`, which is what actually binds the
// key to an origin, and the send path refuses any origin that has not been
// confirmed — so this panel can only ever *offer* a change, never smuggle
// one past the gate.

import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useSettings,
  PROVIDER_PRESETS,
  endpointOrigin,
  validateBaseURL,
  type ProviderId,
} from "@/lib/settings";
import { useModelInfo } from "@/lib/ai";
import {
  useTheme,
  THEMES,
  THEME_LABEL,
  THEME_SWATCH,
  type Theme,
} from "@/lib/theme";

export default function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const settings = useSettings(
    useShallow((s) => ({
      provider: s.provider,
      apiKey: s.apiKey,
      baseURL: s.baseURL,
      model: s.model,
      rememberKey: s.rememberKey,
      confirmedOrigin: s.confirmedOrigin,
      legacyKeyMigrated: s.legacyKeyMigrated,
      setProvider: s.setProvider,
      setApiKey: s.setApiKey,
      setBaseURL: s.setBaseURL,
      setModel: s.setModel,
      setRememberKey: s.setRememberKey,
      confirmEndpoint: s.confirmEndpoint,
      dismissLegacyKeyNotice: s.dismissLegacyKeyNotice,
      reset: s.reset,
    })),
  );
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const modelInfo = useModelInfo();
  const [showKey, setShowKey] = useState(false);
  // The address field is a draft: typing must not change the live endpoint.
  const [urlDraft, setUrlDraft] = useState(settings.baseURL);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setUrlDraft(settings.baseURL);
  }, [settings.baseURL]);

  const hasKey = settings.apiKey.trim().length > 0;

  /**
   * Confirm the endpoint currently shown to the user as the destination for
   * the key. Called when a key is entered or kept while that address is on
   * screen — that is the moment the user can see, and consent to, where the
   * credential goes.
   *
   * Reads the live store rather than the rendered snapshot: a handler that
   * both changes the address and then binds it would otherwise bind the
   * *previous* address back (zustand hands out a new state object per write,
   * so the snapshot in this closure is one render behind).
   */
  function confirmCurrentEndpoint() {
    const live = useSettings.getState();
    if (live.apiKey.trim().length === 0) return;
    live.confirmEndpoint(live.baseURL);
  }

  /** Commit the address draft, asking first when the origin would move. */
  function commitUrlDraft() {
    const live = useSettings.getState();
    const next = urlDraft.trim();
    if (next === live.baseURL) return;
    try {
      validateBaseURL(next);
    } catch (err) {
      setUrlError((err as Error).message);
      return;
    }
    const origin = endpointOrigin(next);
    if (live.apiKey.trim() && origin !== live.confirmedOrigin) {
      const ok = window.confirm(
        `把接口地址改为 ${origin} 后，密钥将发送给这个新域名。确定继续吗？`,
      );
      if (!ok) {
        setUrlDraft(live.baseURL);
        setUrlError(null);
        return;
      }
      live.confirmEndpoint(next);
    } else {
      live.setBaseURL(next);
    }
    setUrlError(null);
    setNotice(null);
  }

  /** Switch provider presets — same origin question, asked up front. */
  function changeProvider(p: ProviderId) {
    const live = useSettings.getState();
    if (p === live.provider) return;
    const preset = PROVIDER_PRESETS[p];
    const origin = endpointOrigin(preset.baseURL);
    if (live.apiKey.trim() && origin !== live.confirmedOrigin) {
      const target = preset.baseURL || "（待填写的自定义地址）";
      const ok = window.confirm(
        `「${preset.label}」的接口地址是 ${target}，与当前已确认的端点不同。\n密钥将发送给这个新域名，确定切换吗？`,
      );
      if (!ok) return;
      live.setProvider(p);
      live.confirmEndpoint(preset.baseURL);
      setNotice(null);
      return;
    }
    live.setProvider(p);
    setNotice(null);
  }

  function toggleRememberKey(remember: boolean) {
    if (remember) {
      const ok = window.confirm(
        "勾选后密钥会以明文写入本机浏览器存储（localStorage）。\n" +
          "本浏览器的其他使用者、以及任何能在这台设备上运行脚本的攻击（XSS）都可以读取它。\n" +
          "只在你不与别人共用这台设备时勾选。确定吗？",
      );
      if (!ok) return;
      settings.setRememberKey(true);
      confirmCurrentEndpoint();
      return;
    }
    settings.setRememberKey(false);
    setNotice(
      useSettings.getState().apiKey.trim()
        ? "已停止在本机保存密钥：密钥仍保留在本次会话的内存中，关闭标签页即消失。"
        : null,
    );
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />
      {/* Panel */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[480px] max-w-[92vw] max-h-[92vh] overflow-y-auto bg-gloss-surface border border-gloss-border rounded-xl shadow-2xl p-6 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-serif text-xl">设置</h2>
          <button
            onClick={onClose}
            className="text-gloss-textDim hover:text-gloss-text p-1 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Status */}
        <div className="mb-5 flex items-center gap-2 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              modelInfo.hasKey && modelInfo.endpointConfirmed
                ? "bg-green-500"
                : modelInfo.hasKey
                  ? "bg-amber-500"
                  : "bg-gloss-accent"
            }`}
          />
          {modelInfo.hasKey && modelInfo.endpointConfirmed ? (
            <span className="text-gloss-text">
              已配置 · {modelInfo.providerLabel} · {modelInfo.name}
              {modelInfo.confirmedOrigin ? ` · ${modelInfo.confirmedOrigin}` : ""}
            </span>
          ) : modelInfo.hasKey ? (
            <span className="text-amber-600">
              已填写密钥，但尚未确认发送到 {modelInfo.endpointOrigin ?? "有效地址"}
              ；未确认前不会发送密钥
            </span>
          ) : (
            <span className="text-gloss-textDim">
              演示模式 · 填写 API 密钥后即可使用真实模型
            </span>
          )}
        </div>

        {/* Legacy plaintext key migrated out of localStorage */}
        {settings.legacyKeyMigrated && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-gloss-text">
            <div className="mb-1 font-medium">旧版保存的密钥已做安全迁移</div>
            <div className="text-gloss-textDim">
              检测到旧版（勾选“记住密钥”之前）以明文保存在本机的 API 密钥。
              它已迁移到本次会话的内存中，本机存储里的明文副本已清除，不会被上传、同步或导出。
              若希望下次打开仍自动可用，请勾选下面的“仅在此设备记住密钥”。
            </div>
            <button
              onClick={() => settings.dismissLegacyKeyNotice()}
              className="mt-2 text-gloss-textDim underline hover:text-gloss-text"
            >
              知道了
            </button>
          </div>
        )}

        {/* Provider */}
        <label className="block mb-3">
          <div className="text-xs text-gloss-textDim mb-1.5">模型服务商</div>
          <select
            value={settings.provider}
            onChange={(e) => changeProvider(e.target.value as ProviderId)}
            className="w-full bg-gloss-surface2 border border-gloss-outline rounded px-3 py-2 text-sm outline-none focus:border-gloss-accent"
          >
            {(Object.keys(PROVIDER_PRESETS) as ProviderId[]).map((id) => (
              <option key={id} value={id}>
                {PROVIDER_PRESETS[id].label}
              </option>
            ))}
          </select>
        </label>

        {/* API Key */}
        <label className="block mb-3">
          <div className="text-xs text-gloss-textDim mb-1.5">API 密钥</div>
          <div className="flex items-center gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={settings.apiKey}
              onChange={(e) => settings.setApiKey(e.target.value)}
              onBlur={confirmCurrentEndpoint}
              placeholder="sk-..."
              className="flex-1 bg-gloss-surface2 border border-gloss-outline rounded px-3 py-2 text-sm font-mono outline-none focus:border-gloss-accent"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="text-gloss-textDim hover:text-gloss-text p-2 text-xs"
              title={showKey ? "隐藏密钥" : "显示密钥"}
            >
              {showKey ? "🙈" : "👁"}
            </button>
          </div>
          <div className="text-[10px] text-gloss-textDim mt-1">
            密钥默认只保留在本次会话的内存中；勾选“仅在此设备记住”后才会写入本机浏览器存储。
            调用模型时只发送至下方已确认的接口地址，不经过本站服务器，也不进入同步、导出或日志。
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-gloss-textDim">
            <input
              type="checkbox"
              checked={settings.rememberKey}
              onChange={(e) => toggleRememberKey(e.target.checked)}
            />
            仅在此设备记住密钥
          </label>
        </label>

        {/* Base URL + Model row */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <div className="text-xs text-gloss-textDim mb-1.5">接口地址</div>
            <input
              type="text"
              value={urlDraft}
              onChange={(e) => {
                setUrlDraft(e.target.value);
                setUrlError(null);
              }}
              onBlur={commitUrlDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitUrlDraft();
                }
              }}
              placeholder={
                settings.provider === "custom"
                  ? "https://your-provider.com/v1"
                  : PROVIDER_PRESETS[settings.provider].baseURL
              }
              className="w-full bg-gloss-surface2 border border-gloss-outline rounded px-3 py-2 text-sm font-mono outline-none focus:border-gloss-accent"
            />
          </label>
          <label className="block">
            <div className="text-xs text-gloss-textDim mb-1.5">模型名称</div>
            <input
              type="text"
              value={settings.model}
              onChange={(e) => settings.setModel(e.target.value)}
              placeholder={
                settings.provider === "custom"
                  ? "your-model-name"
                  : PROVIDER_PRESETS[settings.provider].model
              }
              className="w-full bg-gloss-surface2 border border-gloss-outline rounded px-3 py-2 text-sm font-mono outline-none focus:border-gloss-accent"
            />
          </label>
        </div>

        {urlError && (
          <div className="mb-3 text-[11px] text-red-500">{urlError}</div>
        )}
        {notice && (
          <div className="mb-3 text-[11px] text-gloss-textDim">{notice}</div>
        )}

        {/* Endpoint confirmation: the key is held back until this is pressed */}
        {hasKey && !modelInfo.endpointConfirmed && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] leading-relaxed">
            <div className="mb-1 font-medium text-gloss-text">端点未确认</div>
            <div className="text-gloss-textDim">
              密钥只会发送到已确认的接口地址。确认将把密钥发送给{" "}
              <span className="font-mono">
                {endpointOrigin(settings.baseURL) ?? "（当前地址无效）"}
              </span>
              。
            </div>
            <button
              onClick={() => {
                settings.confirmEndpoint(settings.baseURL);
                setNotice(null);
              }}
              className="mt-2 rounded bg-gloss-text px-3 py-1 text-gloss-bg"
            >
              确认使用此端点
            </button>
          </div>
        )}

        <div className="text-[10px] text-gloss-textDim/70 mb-5 leading-relaxed">
          选择服务商后会自动填写接口地址和模型名称。如使用 Ollama、vLLM、LM Studio 等兼容 OpenAI 的服务，请选择“自定义”。
          更换接口地址的域名需要重新确认，密钥不会自动跟随。
        </div>

        {/* Theme — single axis, four palettes plus a "follow
            system" meta option. Each swatch shows the actual
            background colour so the choice is preview-able
            without committing. */}
        <div className="mb-5 rounded-lg border border-gloss-border bg-gloss-surface2/50 p-3">
          <div className="text-xs text-gloss-textDim mb-2">主题</div>
          <div className="grid grid-cols-5 gap-2">
            {THEMES.map((t) => (
              <ThemeSwatch
                key={t}
                theme={t}
                active={theme === t}
                onClick={() => setTheme(t)}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={() => {
              if (
                confirm(
                  "确定恢复默认设置吗？这将清除已保存的 API 密钥。",
                )
              ) {
                settings.reset();
              }
            }}
            className="text-xs text-gloss-textDim hover:text-gloss-accent"
          >
            恢复默认设置
          </button>
          <button
            onClick={() => {
              // Closing the panel is the last chance to bind a key that was
              // typed but never blurred (clicking a button does blur the
              // input, but a keyboard-only close would not).
              commitUrlDraft();
              confirmCurrentEndpoint();
              onClose();
            }}
            className="px-4 py-1.5 text-sm bg-gloss-text text-gloss-bg rounded font-medium hover:bg-gloss-text/85"
          >
            完成
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * One swatch in the settings theme row. Renders the actual
 * background colour of the theme it represents so a glance is
 * enough to know what the user is picking. `system` renders
 * half-light / half-dark to make the meta nature obvious.
 */
function ThemeSwatch({
  theme,
  active,
  onClick,
}: {
  theme: Theme;
  active: boolean;
  onClick: () => void;
}) {
  const swatch = THEME_SWATCH[theme];
  // The `Aa` sits on the theme's *reading surface* with a thin strip of
  // its chrome at the bottom, so the swatch previews the two planes a
  // user actually looks at rather than just one flat colour.
  const preview: React.CSSProperties = swatch.split
    ? {
        background:
          "linear-gradient(90deg, rgb(251 250 247) 0%, rgb(251 250 247) 50%, rgb(12 12 12) 50%, rgb(12 12 12) 100%)",
        color: "rgb(120 120 120)",
      }
    : {
        background: `linear-gradient(180deg, ${swatch.bg} 0%, ${swatch.bg} 68%, ${swatch.surface} 68%, ${swatch.surface} 100%)`,
        color: swatch.text,
      };
  return (
    <button
      type="button"
      onClick={onClick}
      title={THEME_LABEL[theme]}
      aria-pressed={active}
      className={`flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2 transition-colors ${
        active
          ? "border-gloss-accent bg-gloss-surface2"
          : "border-gloss-border bg-gloss-surface hover:border-gloss-outline"
      }`}
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-full items-center justify-center rounded text-[10px] font-mono"
        style={{
          ...preview,
          // A ring that works on both polarities: the swatch may be
          // near-black or near-white, so a fixed dark ring disappears
          // on one of them.
          boxShadow: "inset 0 0 0 1px rgb(var(--outline) / 0.45)",
        }}
      >
        Aa
      </span>
      <span className="text-[10px] text-gloss-textDim">{THEME_LABEL[theme]}</span>
    </button>
  );
}
