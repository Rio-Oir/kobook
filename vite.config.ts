// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * 规范入口（Caddy）与它背后的 API 端口。
 *
 * 两个值都从服务端读的同一份环境里取，端口改了也不会两边失配；单独跑 vite
 * （没有 scripts/dev.mjs 去 loadEnvFile）时退回文档里的默认值。
 */
const authOrigin = (process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const apiTarget = `http://127.0.0.1:${process.env.SERVER_PORT ?? "8787"}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    // `/api` is proxied so that this port is not a trap.
    //
    // 5173 renders the SPA and nothing else. Without this proxy a page opened
    // here loads fine and then fails every request that matters — import,
    // session, notes, sign-in — and `POST /api/...` is answered with an empty
    // 404 that the account client used to report as "资源不存在。", i.e. as a
    // missing *record* rather than a missing *backend*. That cost a real
    // sign-in attempt to diagnose. Proxying removes the trap; the canonical
    // entry is still Caddy on 8080 (see `open` below).
    //
    // Origin/Host are rewritten to the canonical origin because the auth layer
    // trusts `BETTER_AUTH_URL` and its loopback alias only. The session cookie
    // carries no `Domain`, so it belongs to `127.0.0.1` regardless of port and
    // travels with the proxied request.
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", authOrigin);
            proxyReq.setHeader("host", new URL(authOrigin).host);
          });
        },
      },
    },
    // Open the Caddy entry (dev/Caddyfile), not this port.
    //
    // A string is resolved against the server URL (`new URL(open, url)`), so
    // an absolute URL here opens 8080 — the one origin `BETTER_AUTH_URL`,
    // cookies and the `/api` proxy all agree on.
    open: `${authOrigin}/`,
  },
});
