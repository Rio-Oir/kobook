// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The settings form: AI provider/key/endpoint plus appearance.
//
// Lifted out of the old modal (`SettingsPanel`) so it can live on its own
// page (`#/settings`). The BYOK semantics are unchanged and load-bearing:
//
//   - the key stays in memory by default, is written to localStorage only
//     after an explicit "仅在此设备记住", and is only ever sent to the
//     endpoint the user confirmed here;
//   - the address commits on blur / Enter, never on every keystroke;
//   - switching the provider preset asks before moving the credential.
//
// The one behavioural change is *how* it asks: `window.confirm` is replaced
// by the in-app dialog from `useConfirmDialog`, so the question is themed
// and testable.

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
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
import { Accordion } from "@/components/ui/accordion";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/field";
import { Listbox } from "@/components/ui/listbox";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export default function SettingsView() {
  const settings = useSettings(
    useShallow((s) => ({
      provider: s.provider,
      apiKey: s.apiKey,
      baseURL: s.baseURL,
      model: s.model,
      rememberKey: s.rememberKey,
      confirmedOrigin: s.confirmedOrigin,
      legacyKeyMigrated: s.legacyKeyMigrated,
      setApiKey: s.setApiKey,
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
  const { confirm, dialog } = useConfirmDialog();
  const [showKey, setShowKey] = useState(false);
  // The address field is a draft: typing must not change the live endpoint.
  const [urlDraft, setUrlDraft] = useState(settings.baseURL);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setUrlDraft(settings.baseURL);
  }, [settings.baseURL]);

  const hasKey = settings.apiKey.trim().length > 0;
  const providerOptions = (Object.keys(PROVIDER_PRESETS) as ProviderId[]).map((id) => ({
    value: id,
    label: PROVIDER_PRESETS[id].label,
  }));

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
  async function commitUrlDraft() {
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
      const ok = await confirm({
        title: "更换接口地址？",
        description: `改为 ${origin} 后，密钥将发送给这个新域名。只有在你确认后，密钥才会随请求发出。`,
      });
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
  async function changeProvider(p: ProviderId) {
    const live = useSettings.getState();
    if (p === live.provider) return;
    const preset = PROVIDER_PRESETS[p];
    const origin = endpointOrigin(preset.baseURL);
    if (live.apiKey.trim() && origin !== live.confirmedOrigin) {
      const target = preset.baseURL || "（待填写的自定义地址）";
      const ok = await confirm({
        title: `切换到「${preset.label}」？`,
        description: `它的接口地址是 ${target}，与当前已确认的端点不同。切换后密钥将发送给这个新域名。`,
      });
      if (!ok) return;
      live.setProvider(p);
      live.confirmEndpoint(preset.baseURL);
      setNotice(null);
      return;
    }
    live.setProvider(p);
    setNotice(null);
  }

  async function toggleRememberKey(remember: boolean) {
    if (remember) {
      const ok = await confirm({
        title: "在本机记住密钥？",
        description:
          "勾选后密钥会以明文写入本机浏览器存储（localStorage）。" +
          "本浏览器的其他使用者、以及任何能在这台设备上运行脚本的攻击（XSS）都可以读取它。" +
          "只在你不与别人共用这台设备时开启。",
      });
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

  async function resetAll() {
    const ok = await confirm({
      title: "恢复默认设置？",
      description: "这会清除已保存的 API 密钥，并把服务商、地址、模型和主题恢复为默认值。",
      confirmLabel: "恢复默认",
      destructive: true,
    });
    if (ok) settings.reset();
  }

  const status = modelInfo.hasKey
    ? modelInfo.endpointConfirmed
      ? { tone: "ok" as const, text: "已配置" }
      : { tone: "warn" as const, text: "地址未确认" }
    : { tone: "demo" as const, text: "演示模式" };

  return (
    <div className="flex flex-col gap-5">
      {dialog}

      {/* Current state, stated once at the top instead of repeated in
          every section. */}
      <div className="flex items-start gap-2.5 rounded-lg border border-gloss-border/70 bg-gloss-surface2/40 px-3 py-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "mt-1 size-1.5 shrink-0 rounded-full",
            status.tone === "ok" && "bg-emerald-500",
            status.tone === "warn" && "bg-amber-500",
            status.tone === "demo" && "bg-gloss-textDim/60",
          )}
        />
        <p className="text-[11px] leading-relaxed text-gloss-textDim">
          <span className="font-medium text-gloss-text">{status.text}</span>
          {modelInfo.hasKey && modelInfo.endpointConfirmed ? (
            <>
              {" · "}
              {modelInfo.providerLabel} · {modelInfo.name}
              {modelInfo.confirmedOrigin ? (
                <span className="text-gloss-textDim/80"> · {modelInfo.confirmedOrigin}</span>
              ) : null}
            </>
          ) : modelInfo.hasKey ? (
            <> · 密钥只发送到已确认的接口地址；确认前不会发出任何请求。</>
          ) : (
            <> · 填写 API 密钥后即可使用真实模型</>
          )}
        </p>
      </div>

      {settings.legacyKeyMigrated && (
        <Alert
          tone="warning"
          title="旧版保存的密钥已做安全迁移"
          action={
            <Button size="sm" variant="secondary" onClick={settings.dismissLegacyKeyNotice}>
              知道了
            </Button>
          }
        >
          检测到旧版（勾选“记住密钥”之前）以明文保存在本机的 API 密钥。它已迁移到本次会话的内存中，
          本机存储里的明文副本已清除，不会被上传、同步或导出。若希望下次打开仍自动可用，
          请开启下面的“仅在此设备记住密钥”。
        </Alert>
      )}

      <Accordion
        title="模型服务"
        summary={`${modelInfo.providerLabel} · ${settings.model || "未设置模型"}`}
        defaultOpen
      >
        <Field label="模型服务商" htmlFor="settings-provider">
          <Listbox
            id="settings-provider"
            aria-label="模型服务商"
            value={settings.provider}
            options={providerOptions}
            onChange={(value) => void changeProvider(value)}
          />
        </Field>

        <Field
          label="API 密钥"
          htmlFor="settings-key"
          hint="默认只保存在本次会话的内存中。调用模型时只发送至下方已确认的接口地址，不经过本站服务器，也不进入同步、导出或日志。"
        >
          <div className="relative">
            <Input
              id="settings-key"
              type={showKey ? "text" : "password"}
              value={settings.apiKey}
              onChange={(e) => settings.setApiKey(e.target.value)}
              onBlur={confirmCurrentEndpoint}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              className="pr-10 font-mono text-[13px]"
            />
            <button
              type="button"
              onClick={() => setShowKey((value) => !value)}
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
              title={showKey ? "隐藏密钥" : "显示密钥"}
              className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-gloss-textDim transition-colors duration-150 hover:bg-gloss-text/[0.06] hover:text-gloss-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40"
            >
              {showKey ? (
                <EyeOff className="size-3.5" aria-hidden="true" />
              ) : (
                <Eye className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        </Field>

        <Switch
          checked={settings.rememberKey}
          onChange={(checked) => void toggleRememberKey(checked)}
          label="仅在此设备记住密钥"
          description="以明文写入浏览器 localStorage；共用这台设备时不要开启。"
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="接口地址" htmlFor="settings-endpoint" error={urlError}>
            <Input
              id="settings-endpoint"
              type="text"
              value={urlDraft}
              onChange={(e) => {
                setUrlDraft(e.target.value);
                setUrlError(null);
              }}
              onBlur={() => void commitUrlDraft()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitUrlDraft();
                }
              }}
              placeholder={
                settings.provider === "custom"
                  ? "https://your-provider.com/v1"
                  : PROVIDER_PRESETS[settings.provider].baseURL
              }
              spellCheck={false}
              className="font-mono text-[13px]"
            />
          </Field>
          <Field label="模型名称" htmlFor="settings-model">
            <Input
              id="settings-model"
              type="text"
              value={settings.model}
              onChange={(e) => settings.setModel(e.target.value)}
              placeholder={
                settings.provider === "custom"
                  ? "your-model-name"
                  : PROVIDER_PRESETS[settings.provider].model
              }
              spellCheck={false}
              className="font-mono text-[13px]"
            />
          </Field>
        </div>

        {notice && (
          <p className="text-[11px] leading-relaxed text-gloss-textDim">{notice}</p>
        )}

        {/* Endpoint confirmation: the key is held back until this is pressed */}
        {hasKey && !modelInfo.endpointConfirmed && (
          <Alert
            tone="warning"
            title="端点未确认"
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  settings.confirmEndpoint(settings.baseURL);
                  setNotice(null);
                }}
              >
                确认使用此端点
              </Button>
            }
          >
            密钥只会发送到已确认的接口地址。确认将把密钥发送给{" "}
            <span className="font-mono text-gloss-text">
              {endpointOrigin(settings.baseURL) ?? "（当前地址无效）"}
            </span>
            。
          </Alert>
        )}

        <p className="text-[11px] leading-relaxed text-gloss-textDim/75">
          选择服务商会自动填写接口地址和模型名称。如使用 Ollama、vLLM、LM Studio 等兼容 OpenAI
          的服务，请选择「自定义」；更换接口地址的域名需要重新确认，密钥不会自动跟随。
        </p>
      </Accordion>

      <Accordion title="外观" summary={THEME_LABEL[theme]}>
        <Segmented
          label="主题"
          value={theme}
          onChange={(next) => setTheme(next)}
          options={THEMES.map((t) => ({
            value: t,
            label: THEME_LABEL[t],
            preview: <ThemePreview theme={t} />,
          }))}
        />
        <p className="text-[11px] leading-relaxed text-gloss-textDim/75">
          「跟随系统」会随操作系统的深浅色设置切换；手动选择日间或夜间后则不再跟随。
        </p>
      </Accordion>

      <div className="flex items-center justify-between gap-4 border-t border-gloss-border/60 pt-4">
        <p className="text-[11px] leading-relaxed text-gloss-textDim/75">
          设置会保存在这台设备上；密钥是否保存由上面的开关决定。
        </p>
        <Button variant="ghost" size="sm" onClick={() => void resetAll()}>
          恢复默认设置
        </Button>
      </div>
    </div>
  );
}

/**
 * One swatch in the theme picker. Renders the actual paper colour of the
 * mode it represents, so a glance is enough to know what is being picked;
 * `system` renders the day/night split to make the meta nature obvious.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  const swatch = THEME_SWATCH[theme];
  const preview: React.CSSProperties = swatch.split
    ? {
        background:
          "linear-gradient(90deg, rgb(255 255 255) 0%, rgb(255 255 255) 50%, rgb(0 0 0) 50%, rgb(0 0 0) 100%)",
        color: "rgb(128 128 128)",
      }
    : {
        background: `linear-gradient(180deg, ${swatch.bg} 0%, ${swatch.bg} 68%, ${swatch.surface} 68%, ${swatch.surface} 100%)`,
        color: swatch.text,
      };
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-full items-center justify-center rounded-md font-mono text-[10px]"
      style={{
        ...preview,
        // A ring that works on both polarities: the swatch may be near-black
        // or near-white, so a fixed dark ring disappears on one of them.
        boxShadow: "inset 0 0 0 1px rgb(var(--outline) / 0.45)",
      }}
    >
      Aa
    </span>
  );
}
