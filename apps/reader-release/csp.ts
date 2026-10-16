// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The service's Content-Security-Policy, in one place.
 *
 * It is applied twice, deliberately:
 *   - as a `<meta http-equiv>` tag by the build (`vite.config.ts` transforms
 *     the repo's `index.html`), so it travels with the HTML, and
 *   - as a response header by the service (`server.ts`), so a deployment that
 *     serves the shell through Fastify gets the same policy even if the tag
 *     were ever stripped.
 *
 * Both copies come from this constant, so they cannot drift.
 *
 * `connect-src` is the one line that is deliberately wide: a BYOK key is sent
 * to whatever OpenAI-compatible endpoint the user configures, and a
 * self-hosted or gateway endpoint cannot be enumerated. A BYOK feature that
 * silently fails on the user's own endpoint is not a feature. `script-src`
 * stays `'self'` — no inline script except the theme bootstrap, pinned by
 * hash — so no third-party or injected script can load, which is what an
 * exfiltration attempt would need.
 */
export const BASE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-xYmS6mAtB1OWovAIr+wv2n4QAusyOHeSiiVO5gUXluw='",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Deployed path prefix. Kept here so the server and the build agree. */
export const DEPLOY_BASE = "/reader/";
