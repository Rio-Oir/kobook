// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fetch a URL through an operator-configured HTTP(S) egress proxy.
 *
 * ## Why this exists
 *
 * `pinned-fetch.ts` connects straight to an address it resolved itself, which
 * is the right default: it is what makes the SSRF pin real. But on a network
 * where direct egress is tampered with or blocked, "connect to the address the
 * system resolver returned" is not *unreliable*, it is *consistently wrong* —
 * and the importer then looks flaky rather than broken. Measured on this
 * machine (2026-10-22):
 *
 *   - `kevinkelly.substack.com` → the system resolver answered
 *     `108.160.170.44` (a Dropbox address), while public DNS answers
 *     `104.18.37.200` / `172.64.150.56` (Cloudflare). TCP to the fake address
 *     hangs; TCP to the real ones connects, but the TLS handshake is reset
 *     within ~80 ms even with an unrelated SNI.
 *   - The same URL through the machine's local proxy (`127.0.0.1:6789`)
 *     returned 200 / 176 KB in ~0.3 s.
 *   - `medium.com` and `www.nytimes.com` resolve to Twitter and Facebook
 *     addresses respectively; domestic sites (`ruanyifeng.com`) are fine.
 *
 * So a deployment like this needs a way out through its proxy. Two rules keep
 * that from becoming a hole:
 *
 *   1. **Config-only.** The proxy URL comes from the server environment
 *      (`EXTRACT_PROXY_URL`, else `HTTPS_PROXY` / `HTTP_PROXY`). No request
 *      body can name one — the same rule the anonymous route already enforces
 *      for the retired per-request proxy field.
 *   2. **Fallback-only.** `url-import.ts` tries the pinned direct request
 *      first. A proxy is used only after that failed at the network level, so a
 *      reachable site never loses the pin.
 *
 * TLS is still verified against the target hostname: the tunnel is opened with
 * `CONNECT`, then a TLS handshake is made *through* it with
 * `servername = hostname` and `rejectUnauthorized` left at its default. The
 * proxy sees a `CONNECT` and opaque bytes; it cannot weaken the check.
 *
 * What a proxy does cost is the **address pin**: the proxy resolves the name,
 * so this module cannot promise the connection lands on an address the SSRF
 * guard vetted. That is stated here rather than hidden, and it is why the
 * fallback is opt-in and why the URL-level gate (scheme, credentials, private
 * or single-label hostnames) still runs before either path.
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { PinnedResponse } from "./pinned-fetch.js";

export interface ProxyFetchOptions {
  url: URL;
  /** `http://host:port`, optionally with credentials. */
  proxyUrl: URL;
  headers?: Record<string, string>;
  /** Deadline for the whole exchange: CONNECT, TLS, headers and body. */
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  method?: string;
}

/** A failure on the proxied path. Message text is operator-facing. */
export class ProxyFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyFetchError";
  }
}

/**
 * The proxy from the environment, or `null` when none is configured.
 *
 * Read per call rather than at module load so a test is not stuck with the
 * first value it saw.
 */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): URL | null {
  for (const name of ["EXTRACT_PROXY_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url;
    } catch {
      return null;
    }
  }
  return null;
}

function portOf(url: URL, fallback: number): number {
  return url.port ? Number.parseInt(url.port, 10) : fallback;
}

function basicAuth(url: URL): string | null {
  if (!url.username && !url.password) return null;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/**
 * One request through the proxy, with the same response contract as
 * `pinnedRequest` so callers do not branch on which path produced a response.
 */
export function proxiedRequest(options: ProxyFetchOptions): Promise<PinnedResponse> {
  const { url, proxyUrl } = options;
  const isHttps = url.protocol === "https:";
  const port = portOf(url, isHttps ? 443 : 80);
  const authority = `${url.hostname}:${port}`;
  const authHeader = basicAuth(proxyUrl);

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let tunnelSocket: TLSSocket | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (err: Error): void => {
      finish(() => reject(err));
      tunnelSocket?.destroy();
    };
    const done = (res: PinnedResponse): void => {
      finish(() => resolve(res));
    };
    const onAbort = (): void => fail(new ProxyFetchError("请求已取消。"));

    timer = setTimeout(() => fail(new ProxyFetchError("代理抓取超时。")), options.timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Plain `http:` targets need no tunnel: the proxy takes an absolute-form
    // request line, which is what `path: url.toString()` produces.
    if (!isHttps) {
      const req = httpRequest(
        {
          host: proxyUrl.hostname,
          port: portOf(proxyUrl, proxyUrl.protocol === "https:" ? 443 : 80),
          method: options.method ?? "GET",
          path: url.toString(),
          headers: {
            host: url.host,
            ...(authHeader === null ? {} : { "proxy-authorization": authHeader }),
            ...options.headers,
          },
        },
        (res) => readResponse(res, options, done, fail),
      );
      req.on("error", (err: Error) => fail(err));
      req.end();
      return;
    }

    const connectReq = httpRequest({
      host: proxyUrl.hostname,
      port: portOf(proxyUrl, proxyUrl.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: authority,
      headers: {
        host: authority,
        ...(authHeader === null ? {} : { "proxy-authorization": authHeader }),
      },
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new ProxyFetchError(`代理拒绝连接：HTTP ${res.statusCode ?? 0}`));
        return;
      }
      // Certificate identity stays the target hostname; verification is not
      // weakened anywhere in this module.
      const tlsSocket = tlsConnect({ socket, servername: url.hostname });
      tunnelSocket = tlsSocket;
      tlsSocket.on("error", (err: Error) => fail(err));
      tlsSocket.on("secureConnect", () => {
        const req = httpRequest(
          {
            // The tunnel is already established, so the agent is bypassed and
            // Node still parses the response for us.
            createConnection: () => tlsSocket,
            host: url.hostname,
            port,
            path: `${url.pathname}${url.search}`,
            method: options.method ?? "GET",
            headers: { host: url.host, ...options.headers },
          },
          (res) => readResponse(res, options, done, fail),
        );
        req.on("error", (err: Error) => fail(err));
        req.end();
      });
    });
    connectReq.on("error", (err: Error) => fail(err));
    connectReq.end();
  });
}

/** Same byte cap and redirect contract as `pinned-fetch.ts`. */
function readResponse(
  res: IncomingMessage,
  options: ProxyFetchOptions,
  done: (value: PinnedResponse) => void,
  fail: (err: Error) => void,
): void {
  const status = res.statusCode ?? 0;
  const base = {
    status,
    statusText: res.statusMessage ?? "",
    headers: res.headers,
    location: res.headers.location ?? null,
  };

  if (status >= 300 && status < 400) {
    // The caller re-gates every hop; the body is not wanted and may be large.
    done({ ...base, body: "", bytesRead: 0, truncated: false });
    res.destroy();
    return;
  }

  let bytesRead = 0;
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => {
    bytesRead += chunk.byteLength;
    if (bytesRead > options.maxBytes) {
      fail(new ProxyFetchError(`响应超过 ${options.maxBytes} 字节上限。`));
      res.destroy();
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    done({ ...base, body: Buffer.concat(chunks).toString("utf8"), bytesRead, truncated: false });
  });
  res.on("error", (err: Error) => fail(err));
  res.on("aborted", () => fail(new ProxyFetchError("上游在响应完成前关闭了连接。")));
}
