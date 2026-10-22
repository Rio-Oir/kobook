// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// User settings store. Persisted to localStorage so each user keeps their
// own model choice and base URL — and, only on explicit opt-in, their key.
//
// When the app is deployed publicly, BYOK is the only way to give the LLM a
// key: never bundle one into the build. There is deliberately no
// `VITE_OPENAI_API_KEY` seed any more — a build-time key is a *platform*
// key (one secret shared by every visitor, shipped in the JS bundle), which
// the product rules replace with per-user BYOK. `VITE_OPENAI_BASE_URL` /
// `VITE_MODEL` may still prefill the address and model for local
// development; they are not credentials.
//
// Phase 2 adds the same owner stamp as `lib/store.ts`: the persisted object
// records whose account this is, and `clearApiKey` drops the credential on
// sign-out without touching the provider/model choice, so re-login only
// needs the key.
//
// Phase 4 adds two things the earlier shape could not express:
//
//   1. `rememberKey` — the key lives in memory by default and is only
//      written to `gloss-settings` after the user ticks "仅在此设备记住";
//   2. `confirmedOrigin` — the endpoint the user has acknowledged as the
//      destination for that key. The send path refuses to attach the key to
//      any other origin, so changing the provider, the URL field, or
//      editing storage from devtools cannot quietly redirect the
//      credential: the worst case is a failed call with an explicit
//      "endpoint not confirmed" error, never a silent send.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ANONYMOUS_OWNER } from "./identity";

export type ProviderId =
  | "deepseek"
  | "openai"
  | "together"
  | "openrouter"
  | "custom";

export const PROVIDER_PRESETS: Record<
  ProviderId,
  { label: string; baseURL: string; model: string }
> = {
  deepseek: {
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  together: {
    label: "Together AI",
    baseURL: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
  },
  custom: {
    label: "自定义（兼容 OpenAI）",
    baseURL: "",
    model: "",
  },
};

export type SettingsState = {
  /**
   * The account this credential belongs to, or `"anonymous"` for the local
   * pre-sign-in case. Same owner semantics as the article store.
   */
  ownerUserId: string;
  provider: ProviderId;
  apiKey: string;
  baseURL: string;
  model: string;
  /** Explicit opt-in to writing `apiKey` to localStorage. Default: memory only. */
  rememberKey: boolean;
  /**
   * Origin (scheme + host + port) the user has confirmed as the place their
   * key may be sent. Empty means "nothing confirmed yet", and the send path
   * treats that as a refusal rather than a default.
   */
  confirmedOrigin: string;
  /**
   * Set when a pre-`rememberKey` install had a plaintext key in
   * localStorage. That key stays usable for this session but the persisted
   * copy is dropped on the migration rewrite, so the panel tells the user
   * instead of letting the credential vanish without a word.
   *
   * Never persisted: it is a one-shot notice about a write that already
   * happened.
   */
  legacyKeyMigrated: boolean;

  setProvider: (p: ProviderId) => void;
  setApiKey: (k: string) => void;
  setBaseURL: (u: string) => void;
  setModel: (m: string) => void;
  setRememberKey: (remember: boolean) => void;
  /**
   * Record the user's consent to send the key to `url`'s origin, and make
   * `url` the active endpoint. Called from the settings panel after the
   * user accepts a change, never as a side effect of typing.
   */
  confirmEndpoint: (url?: string) => void;
  dismissLegacyKeyNotice: () => void;
  reset: () => void;
  /** Drop the credential only — used on sign-out and on account switching. */
  clearApiKey: () => void;
  /**
   * Attach the resolved user id as the new owner.
   *
   * Changing owner clears the key by default — including on sign-in from an
   * anonymous session, because carrying a local key into an account is a
   * decision only the user can make. A caller that has *obtained that
   * decision* passes `{ keepAnonymousKey: true }`; it is honoured only for
   * the anonymous → named transition it names, and ignored everywhere else.
   * Re-stamping the same owner changes nothing.
   */
  setOwner: (userId: string, opts?: { keepAnonymousKey?: boolean }) => void;
};

// Prefill the address/model from Vite env vars when present (local dev
// convenience only). The optional chain keeps the import valid in Node
// (tests) and SSR, where `import.meta.env` is undefined.
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const envBaseURL = viteEnv["VITE_OPENAI_BASE_URL"] ?? "";
const envModel = viteEnv["VITE_MODEL"] ?? "";

export function validateBaseURL(value: string, allowLoopback = true): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("接口地址不是有效的 URL");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (url.username || url.password) throw new Error("接口地址不能包含用户名或密码");
  if (!allowLoopback && loopback) throw new Error("公网环境不允许使用本机地址");
  if (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && loopback)) {
    throw new Error("接口地址必须使用 HTTPS；本地开发可使用 loopback HTTP");
  }
  return url;
}

export function validateSettings(input: { baseURL: string; model: string; apiKey: string }) {
  if (!input.model.trim()) throw new Error("模型名称不能为空");
  validateBaseURL(input.baseURL);
  if (!input.apiKey.trim()) throw new Error("API 密钥不能为空");
}

/** Scheme + host + port of `value`, or `null` when it is not a URL at all. */
export function endpointOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

export type EndpointStatus = {
  /** Whether a key is configured at all (false ⇒ the demo path runs). */
  hasKey: boolean;
  /** Origin the current base URL resolves to, or null when it is not a URL. */
  origin: string | null;
  /** Origin the user confirmed, or "" when they never confirmed one. */
  confirmedOrigin: string;
  /** Whether a configured key is allowed to be sent to `origin`. */
  confirmed: boolean;
};

/**
 * Whether the configured key may be sent to the configured endpoint.
 *
 * This is the single source of truth for the "key only travels to an
 * endpoint the user confirmed" rule; both the send path (`ai.ts`) and the
 * settings panel read it, so the panel cannot advertise a state the call
 * path would refuse.
 */
export function endpointStatus(
  s: Pick<SettingsState, "apiKey" | "baseURL" | "confirmedOrigin">,
): EndpointStatus {
  const origin = endpointOrigin(s.baseURL);
  const hasKey = s.apiKey.trim().length > 0;
  return {
    hasKey,
    origin,
    confirmedOrigin: s.confirmedOrigin,
    confirmed: hasKey && origin !== null && origin === s.confirmedOrigin,
  };
}

/**
 * Throw when a key exists but must not be sent to the configured endpoint.
 *
 * Failing closed is the point: silently falling back to the demo answer
 * would look like an answer, and silently sending the key would leak it.
 */
export function assertEndpointConfirmed(
  s: Pick<SettingsState, "apiKey" | "baseURL" | "confirmedOrigin">,
): void {
  const status = endpointStatus(s);
  if (!status.hasKey) return;
  if (status.origin === null) {
    throw new Error("接口地址无效，密钥不会被发送。请在设置中填写合法的服务地址。");
  }
  if (!status.confirmed) {
    throw new Error(
      `密钥尚未确认可以发送到 ${status.origin}。请在设置中确认接口地址后重试。`,
    );
  }
}

function detectInitialProvider(): ProviderId {
  if (envBaseURL) {
    if (envBaseURL.includes("deepseek")) return "deepseek";
    if (envBaseURL.includes("openai.com")) return "openai";
    if (envBaseURL.includes("together")) return "together";
    if (envBaseURL.includes("openrouter")) return "openrouter";
    return "custom";
  }
  return "deepseek";
}

const INITIAL_BASE_URL = envBaseURL || PROVIDER_PRESETS.deepseek.baseURL;

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ownerUserId: ANONYMOUS_OWNER,
      provider: detectInitialProvider(),
      // No env seed: see the header comment. A key only ever comes from the
      // user, and only ever lives in memory until they opt in.
      apiKey: "",
      baseURL: INITIAL_BASE_URL,
      model: envModel || PROVIDER_PRESETS.deepseek.model,
      rememberKey: false,
      confirmedOrigin: "",
      legacyKeyMigrated: false,

      setProvider: (p) => {
        const preset = PROVIDER_PRESETS[p];
        // Swapping the preset also swaps the endpoint. That is *not* a
        // confirmation — `confirmEndpoint` is, and the panel asks first when
        // a key is present and the origin moves.
        set({ provider: p, baseURL: preset.baseURL, model: preset.model });
      },
      setApiKey: (k) => set({ apiKey: k }),
      setBaseURL: (u) => set({ baseURL: u }),
      setModel: (m) => set({ model: m }),
      setRememberKey: (remember) => set({ rememberKey: remember }),

      confirmEndpoint: (url) =>
        set((s) => {
          const next = url ?? s.baseURL;
          return { baseURL: next, confirmedOrigin: endpointOrigin(next) ?? "" };
        }),

      dismissLegacyKeyNotice: () => set({ legacyKeyMigrated: false }),

      reset: () =>
        set({
          provider: "deepseek",
          apiKey: "",
          baseURL: PROVIDER_PRESETS.deepseek.baseURL,
          model: PROVIDER_PRESETS.deepseek.model,
          rememberKey: false,
          confirmedOrigin: "",
          legacyKeyMigrated: false,
          ownerUserId: ANONYMOUS_OWNER,
        }),

      clearApiKey: () => set({ apiKey: "" }),

      setOwner: (userId, opts) =>
        set((s) => {
          if (s.ownerUserId === userId) return {};
          // A credential never travels between identities on its own. The
          // "anonymous key keeps working on this device" case is a real
          // product option — and therefore an explicit one: the caller has
          // to ask for it, only for the anonymous → named transition it
          // names, after the user agreed. Everything else (another account,
          // signing out, or a plain sign-in) drops the key.
          const keepAnonymousKey =
            opts?.keepAnonymousKey === true &&
            s.ownerUserId === ANONYMOUS_OWNER &&
            userId !== ANONYMOUS_OWNER;
          if (keepAnonymousKey) return { ownerUserId: userId };
          return { ownerUserId: userId, apiKey: "" };
        }),
    }),
    {
      name: "gloss-settings",
      // v4 = `confirmedOrigin`. v3 = `rememberKey`. v2 = `ownerUserId`.
      version: 4,
      partialize: (state) => ({
        ...state,
        // The credential is persisted only on explicit opt-in. Because
        // `partialize` runs on *every* write — including the one the persist
        // middleware performs right after a migration — this is also what
        // scrubs a legacy plaintext key from `gloss-settings` at upgrade
        // time while it stays usable from memory for the current session.
        apiKey: state.rememberKey ? state.apiKey : "",
        legacyKeyMigrated: false,
      }),
      migrate: (persisted, version) => {
        const state = { ...(persisted ?? {}) } as Partial<SettingsState>;
        let legacyKeyMigrated = false;

        if (version < 2) {
          state.ownerUserId = state.ownerUserId ?? ANONYMOUS_OWNER;
        }
        if (version < 3) {
          // Pre-`rememberKey` installs had no such concept, so whatever key
          // is in the blob was stored unconditionally and in plaintext. Keep
          // it usable (memory) — losing a working key silently is exactly
          // what the rule forbids — but stop persisting it, and say so.
          legacyKeyMigrated = (state.apiKey ?? "").trim().length > 0;
          state.rememberKey = false;
        }
        if (version < 4) {
          // Endpoint binding. A key that a *v3* user explicitly asked to
          // remember was already being sent to whatever endpoint they had
          // configured, so carrying that consent forward asks them to
          // re-confirm an endpoint they never changed. A legacy key (v<3,
          // no consent to anything) starts unconfirmed.
          const hadExplicitConsent = version >= 3 && state.rememberKey === true;
          state.confirmedOrigin =
            hadExplicitConsent && (state.apiKey ?? "").trim().length > 0
              ? endpointOrigin(state.baseURL ?? "") ?? ""
              : "";
        }

        return {
          ...state,
          ownerUserId: state.ownerUserId ?? ANONYMOUS_OWNER,
          legacyKeyMigrated,
        } as SettingsState;
      },
    },
  ),
);

/**
 * Snapshot helper for non-React call sites (e.g. streamChat in ai.ts).
 */
export function readSettings() {
  return useSettings.getState();
}
