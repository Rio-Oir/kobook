// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * BYOK settings gate: credential custody, endpoint consent, owner switching.
 *
 * Three defects this covers:
 *
 *   1. `settings.ts` seeded `apiKey` from `VITE_OPENAI_API_KEY`. A key baked
 *      into the bundle is a *platform* key — one secret shared by every
 *      visitor, and exactly what BYOK replaces. There is no such path now.
 *   2. the key was written to `gloss-settings` unconditionally. It is now
 *      memory-only until "仅在此设备记住" is ticked.
 *   3. changing the endpoint did not bind the key to the endpoint the user
 *      agreed to. `confirmedOrigin` does, and `endpointStatus` /
 *      `assertEndpointConfirmed` are what `ai.ts` enforces.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, before, beforeEach } from "node:test";
import {
  installLocalStorage,
  readPersistedSettings,
} from "./byok-fake-provider.js";

const memory = installLocalStorage();

let settings: typeof import("../../src/lib/settings.js");

before(async () => {
  settings = await import("../../src/lib/settings.js");
});

beforeEach(() => {
  memory.clear();
  settings.useSettings.getState().reset();
});

const state = () => settings.useSettings.getState();

// ── no build-time platform key ────────────────────────────────────────────

test("no VITE key is injected: the module has no VITE_OPENAI_API_KEY path", () => {
  // Comments are stripped first so the header can keep explaining *why*
  // there is no such seeding without tripping the guard.
  const source = readFileSync("src/lib/settings.ts", "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.equal(
    /VITE_OPENAI_API_KEY/.test(code),
    false,
    "a build-time key would ship one platform secret to every visitor",
  );
  assert.equal(state().apiKey, "", "a fresh store starts with no key at all");
  assert.equal(state().rememberKey, false);
});

// ── endpoint validation ───────────────────────────────────────────────────

test("validateBaseURL accepts HTTPS and loopback HTTP only", () => {
  assert.equal(settings.validateBaseURL("https://api.example.com/v1").origin, "https://api.example.com");
  for (const local of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:1234/v1",
  ]) {
    assert.equal(settings.validateBaseURL(local).protocol, "http:", local);
  }
  assert.throws(
    () => settings.validateBaseURL("http://api.example.com/v1"),
    /HTTPS/,
    "plain HTTP off loopback would leak the key in transit",
  );
});

test("validateBaseURL rejects embedded credentials and non-HTTP schemes", () => {
  assert.throws(() => settings.validateBaseURL("https://user:pw@api.example.com/v1"), /用户名或密码/);
  assert.throws(() => settings.validateBaseURL("javascript:alert(1)"), /HTTPS|URL/);
  assert.throws(() => settings.validateBaseURL("file:///etc/passwd"), /HTTPS|URL/);
  assert.throws(() => settings.validateBaseURL("data:text/html,<b>x</b>"), /HTTPS|URL/);
  assert.throws(() => settings.validateBaseURL("not a url"), /URL/);
  assert.throws(() => settings.validateBaseURL(""), /URL/);
});

test("validateSettings requires a model, an address and a key", () => {
  assert.throws(
    () => settings.validateSettings({ baseURL: "https://a.example/v1", model: "", apiKey: "k" }),
    /模型/,
  );
  assert.throws(
    () => settings.validateSettings({ baseURL: "https://a.example/v1", model: "m", apiKey: "  " }),
    /密钥/,
  );
  settings.validateSettings({ baseURL: "https://a.example/v1", model: "m", apiKey: "k" });
});

// ── endpoint consent ──────────────────────────────────────────────────────

test("a key is only usable once its endpoint is confirmed", () => {
  const s = state();
  assert.equal(settings.endpointStatus(s).hasKey, false);

  s.setApiKey("sk-x");
  assert.equal(settings.endpointStatus(s).confirmed, false, "a key alone confirms nothing");
  assert.throws(() => settings.assertEndpointConfirmed(state()), /确认/);

  s.confirmEndpoint();
  assert.equal(settings.endpointStatus(state()).confirmed, true);
  settings.assertEndpointConfirmed(state());
});

test("the same origin on another path keeps its consent; a new origin does not", () => {
  const s = state();
  s.setApiKey("sk-x");
  s.setBaseURL("https://api.deepseek.com/v1");
  s.confirmEndpoint();

  s.setBaseURL("https://api.deepseek.com/v2");
  assert.equal(
    settings.endpointStatus(state()).confirmed,
    true,
    "same scheme+host+port is the same credential destination",
  );

  s.setBaseURL("https://attacker.example/v1");
  assert.equal(settings.endpointStatus(state()).confirmed, false);
  assert.throws(() => settings.assertEndpointConfirmed(state()), /attacker\.example/);
});

test("changing the provider preset does not silently carry the confirmation", () => {
  const s = state();
  s.setApiKey("sk-x");
  s.setBaseURL(settings.PROVIDER_PRESETS.deepseek.baseURL);
  s.confirmEndpoint();

  s.setProvider("openai");
  assert.equal(state().baseURL, settings.PROVIDER_PRESETS.openai.baseURL);
  assert.equal(
    settings.endpointStatus(state()).confirmed,
    false,
    "the preset swap moves the endpoint, so the key must be held back until the user confirms",
  );
  assert.throws(() => settings.assertEndpointConfirmed(state()), /确认/);
});

test("a key with an unusable address is refused rather than sent somewhere", () => {
  const s = state();
  s.setApiKey("sk-x");
  s.setBaseURL("https://ok.example/v1");
  s.confirmEndpoint();
  s.setBaseURL("");
  const status = settings.endpointStatus(state());
  assert.equal(status.origin, null);
  assert.equal(status.confirmed, false);
  assert.throws(() => settings.assertEndpointConfirmed(state()), /无效/);
});

// ── memory by default, persistence on request ─────────────────────────────

test("the key stays in memory unless '仅在此设备记住' is ticked", async () => {
  const s = state();
  s.setApiKey("sk-memory-only");
  s.setBaseURL("https://api.deepseek.com/v1");
  s.confirmEndpoint();

  // Any other state change also triggers a write; the key must stay out of
  // every one of them.
  s.setModel("another-model");
  assert.equal(state().apiKey, "sk-memory-only", "still usable this session");
  assert.equal(readPersistedSettings(memory).state.apiKey, "", "but not on disk");

  s.setRememberKey(true);
  assert.equal(readPersistedSettings(memory).state.apiKey, "sk-memory-only");

  s.setRememberKey(false);
  assert.equal(
    readPersistedSettings(memory).state.apiKey,
    "",
    "unticking must remove the stored copy, not just stop updating it",
  );
  assert.equal(state().apiKey, "sk-memory-only", "while the session keeps working");
});

test("reset() drops the key and the endpoint consent", () => {
  const s = state();
  s.setApiKey("sk-x");
  s.setBaseURL("https://api.deepseek.com/v1");
  s.confirmEndpoint();
  s.setRememberKey(true);

  s.reset();
  assert.equal(state().apiKey, "");
  assert.equal(state().confirmedOrigin, "");
  assert.equal(state().rememberKey, false);
  assert.equal(readPersistedSettings(memory).state.apiKey, "");
});

// ── owner switching ───────────────────────────────────────────────────────

test("changing owner clears the key by default, including on sign-in", () => {
  const s = state();
  s.setApiKey("sk-anon");
  s.setOwner("user-1");
  assert.equal(
    state().apiKey,
    "",
    "carrying a local key into an account is the user's decision, not a default",
  );

  s.setApiKey("sk-account");
  s.setOwner("user-2");
  assert.equal(state().apiKey, "", "an account credential never travels to another identity");

  s.setApiKey("sk-account-2");
  s.setOwner("anonymous");
  assert.equal(state().apiKey, "", "sign-out drops the account's key");
});

test("the anonymous key survives only when the caller says the user agreed", () => {
  const s = state();
  s.setApiKey("sk-anon-kept");
  s.setOwner("user-1", { keepAnonymousKey: true });
  assert.equal(
    state().apiKey,
    "sk-anon-kept",
    "an explicit, in-scope consent keeps the local key working on this device",
  );

  // The flag is a licence for one transition only; it is not a general
  // "never clear the key" switch.
  s.setApiKey("sk-account-a");
  s.setOwner("user-2", { keepAnonymousKey: true });
  assert.equal(state().apiKey, "", "account → another account clears regardless");

  s.setApiKey("sk-account-b");
  s.setOwner("anonymous", { keepAnonymousKey: true });
  assert.equal(state().apiKey, "", "signing out clears regardless");

  // And it does not become a blanket "never clear": named → another named
  // owner is still ignored, because the transition the flag names is not the
  // one happening.
  s.setOwner("user-3");
  s.setApiKey("sk-account-c");
  s.setOwner("user-4", { keepAnonymousKey: true });
  assert.equal(state().apiKey, "", "user-3 → user-4 still clears");
});

test("re-stamping the same owner is a no-op", () => {
  const s = state();
  s.setOwner("user-7");
  s.setApiKey("sk-7");
  s.setOwner("user-7");
  assert.equal(state().apiKey, "sk-7", "no change of owner, no credential change");
  s.setOwner("user-7", { keepAnonymousKey: true });
  assert.equal(state().apiKey, "sk-7");
});

// ── upgrades from older payloads ──────────────────────────────────────────

test("a legacy plaintext key moves to memory and is scrubbed from localStorage", async () => {
  memory.set(
    "gloss-settings",
    JSON.stringify({
      state: {
        provider: "openai",
        apiKey: "sk-legacy-plaintext",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      version: 1,
    }),
  );
  await settings.useSettings.persist.rehydrate();
  const s = state();

  assert.equal(s.apiKey, "sk-legacy-plaintext", "the user's key keeps working this session");
  assert.equal(s.rememberKey, false, "it is not silently promoted to 'remembered'");
  assert.equal(
    s.legacyKeyMigrated,
    true,
    "and the user is told rather than having it disappear without a word",
  );
  assert.equal(s.provider, "openai", "preferences survive");
  assert.equal(s.ownerUserId, "anonymous");
  assert.equal(s.confirmedOrigin, "", "a pre-consent key carries no endpoint confirmation");

  const blob = readPersistedSettings(memory);
  assert.equal(blob.version, 4);
  assert.equal(
    blob.state.apiKey,
    "",
    "the plaintext copy is removed from this machine",
  );
  assert.equal(blob.state.legacyKeyMigrated, false, "the one-shot notice is not persisted");

  s.dismissLegacyKeyNotice();
  assert.equal(state().legacyKeyMigrated, false);
});

test("a v3 payload that remembered its key keeps it and carries the consent forward", async () => {
  memory.set(
    "gloss-settings",
    JSON.stringify({
      state: {
        ownerUserId: "anonymous",
        provider: "deepseek",
        apiKey: "sk-remembered",
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        rememberKey: true,
      },
      version: 3,
    }),
  );
  await settings.useSettings.persist.rehydrate();
  const s = state();

  assert.equal(s.apiKey, "sk-remembered");
  assert.equal(s.rememberKey, true);
  assert.equal(
    s.confirmedOrigin,
    "https://api.deepseek.com",
    "a key the user explicitly asked to remember was already going to this endpoint",
  );
  assert.equal(s.legacyKeyMigrated, false);
  assert.equal(settings.endpointStatus(state()).confirmed, true);
  assert.equal(
    readPersistedSettings(memory).state.apiKey,
    "sk-remembered",
    "an explicit 'remember' is honoured across the upgrade",
  );
});

test("a payload with no key never gains one, and its owner is stamped", async () => {
  memory.set(
    "gloss-settings",
    JSON.stringify({
      state: { provider: "together", baseURL: "https://api.together.xyz/v1", model: "m" },
      version: 1,
    }),
  );
  await settings.useSettings.persist.rehydrate();
  const s = state();
  assert.equal(s.apiKey, "");
  assert.equal(s.ownerUserId, "anonymous");
  assert.equal(s.provider, "together");
  assert.equal(s.legacyKeyMigrated, false);
  assert.equal(s.confirmedOrigin, "");
});
