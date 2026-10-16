// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Fetch a URL pinned to a *specific, already-vetted* IP address, while
 * keeping TLS validation pointed at the original hostname.
 *
 * Why not `fetch()` with a rewritten hostname? Because that is what the
 * importer used to do, and it silently broke the one property the SSRF
 * design depends on being intact:
 *
 *   `new URL("https://example.com/"); url.hostname = "93.184.216.34"`
 *   gives `https://93.184.216.34/`, and undici then performs the TLS
 *   handshake with SNI = `93.184.216.34` and validates the certificate
 *   against that IP. Every correctly-configured HTTPS site fails, and
 *   the only way to make the request succeed is to stop verifying the
 *   certificate — which is exactly what must never happen here. The `Host:`
 *   header does not feed TLS; it only feeds the HTTP request line.
 *
 * The honest fix is to separate the two names, which is what `node:https`
 * already lets us do and `fetch` does not:
 *
 *   - `host`              → the address we already resolved and gated, so
 *                          no second DNS lookup can return a different
 *                          (and possibly internal) answer;
 *   - `servername`        → the original hostname, which is what SNI
 *                          carries and what the certificate is checked
 *                          against. `rejectUnauthorized` is left at its
 *                          default `true` and is never exposed as an
 *                          option, so no test fixture and no future
 *                          caller can turn verification off.
 *
 * Four bounds are enforced, and each one is a way a hostile or broken
 * upstream could otherwise hold a server socket:
 *
 *   - a single deadline covering the whole exchange (connect, headers and
 *     body), not just the first byte;
 *   - a byte cap applied *while streaming*, so a server that declares a
 *     small `Content-Length` and then sends forever is cut off at the cap
 *     instead of after it has been buffered;
 *   - a redirect is reported without its body being read at all, and the
 *     connection is torn down rather than drained — a `resume()` would
 *     leave an unbounded amount of data to arrive while the response was
 *     already "finished";
 *   - a premature close (the peer aborted mid-body) rejects immediately
 *     instead of leaving the promise to hang until the deadline.
 */

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

export interface PinnedFetchOptions {
  /** The original URL. Its hostname is the SNI / certificate identity. */
  url: URL;
  /** The vetted IP to connect to. */
  address: string;
  headers?: Record<string, string>;
  /** Deadline for the whole exchange: connect, headers and body. */
  timeoutMs: number;
  /** Hard cap on bytes read from the body. */
  maxBytes: number;
  signal?: AbortSignal;
  method?: string;
  /**
   * Additional trusted CA bundle (PEM), for a deployment whose egress
   * goes through a privately-signed TLS terminator, and for the test
   * fixture that proves certificate validation is actually running.
   *
   * This *adds* a trust anchor. It cannot turn verification off:
   * `rejectUnauthorized` is not exposed anywhere in this module and stays
   * at its default `true`, so a request signed by anything outside the
   * system store plus these bytes still fails.
   */
  ca?: string;
}

export interface PinnedResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  /** `Location` when the response is a redirect. */
  location: string | null;
  body: string;
  bytesRead: number;
  /** The cap fired: the body is a prefix, and the connection was destroyed. */
  truncated: boolean;
}

export class PinnedTimeoutError extends Error {
  readonly statusCode = 504;
  constructor(message = "抓取超时。") {
    super(message);
    this.name = "PinnedTimeoutError";
  }
}

export class PinnedTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`响应超过 ${maxBytes} 字节上限。`);
    this.name = "PinnedTooLargeError";
  }
}

/**
 * The peer closed the connection before the message was complete.
 *
 * Distinct from a timeout on purpose: a truncated body is a *response*
 * problem the operator can see in an upstream's logs, whereas a timeout
 * may be local congestion. Reporting them as one thing makes both harder
 * to diagnose.
 */
export class PinnedAbortedError extends Error {
  readonly statusCode = 502;
  constructor(message = "上游在响应完成前关闭了连接。") {
    super(message);
    this.name = "PinnedAbortedError";
  }
}

/**
 * One HTTP(S) request against `address`, presenting `url.hostname` as the
 * TLS identity and the HTTP `Host`.
 *
 * Redirects are **not** followed: the caller re-gates each `Location`
 * through the SSRF guard, which is the whole reason this returns the
 * status and `Location` rather than a decoded body for a 3xx.
 */
export function pinnedRequest(options: PinnedFetchOptions): Promise<PinnedResponse> {
  const { url, address } = options;
  const isHttps = url.protocol === "https:";
  const port = url.port ? Number.parseInt(url.port, 10) : isHttps ? 443 : 80;

  const requestFn = isHttps ? httpsRequest : httpRequest;

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    let bytesRead = 0;
    const chunks: Buffer[] = [];
    let truncated = false;
    let timer: NodeJS.Timeout | undefined;
    let gotResponse = false;

    const onAbort = (): void => {
      req.destroy(new PinnedTimeoutError("请求已取消。"));
    };

    /**
     * Settle exactly once, and undo every subscription that was made on
     * the way in.
     *
     * The `removeEventListener` is not decoration: the caller's
     * `AbortSignal` outlives this request (the anonymous route's budget
     * covers a whole import, which may be several hops), so a listener
     * left attached would accumulate one entry per hop per import and
     * keep this promise's closure — and the buffers it holds — reachable
     * for the lifetime of the signal.
     */
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const req = requestFn({
      // `host` is the IP literal we vetted. Passing it here (rather than
      // resolving a name) is what makes the pin real.
      host: address,
      port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers: {
        host: url.host,
        ...options.headers,
      },
      // SNI + certificate identity. For an `http:` URL this is ignored.
      ...(isHttps ? { servername: url.hostname } : {}),
      // No `rejectUnauthorized` here on purpose: the default is `true`,
      // and leaving it unset is what keeps "do not weaken TLS" a
      // structural property instead of a convention.
      ...(isHttps && options.ca ? { ca: options.ca } : {}),
      family: address.includes(":") ? 6 : 4,
    });

    timer = setTimeout(() => {
      req.destroy(new PinnedTimeoutError());
    }, options.timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    req.on("error", (err: Error) => {
      finish(() => reject(err));
    });

    // A socket that closes without ever producing a response (a reset, a
    // peer that hangs up after the request line) must not leave the
    // caller waiting for the deadline. Once a response has arrived,
    // `close` is normal teardown and `res`'s own handlers decide the
    // outcome.
    req.on("close", () => {
      if (gotResponse) return;
      finish(() => reject(new PinnedAbortedError()));
    });

    req.on("response", (res) => {
      gotResponse = true;
      const status = res.statusCode ?? 0;
      const isRedirect = status >= 300 && status < 400;

      if (isRedirect) {
        // A redirect body is not needed and may be arbitrarily large.
        // Resolve first, then tear the connection down — `resume()` here
        // would drain an unbounded body in the background, which is the
        // exact resource the cap exists to bound.
        finish(() =>
          resolve({
            status,
            statusText: res.statusMessage ?? "",
            headers: res.headers,
            location: res.headers.location ?? null,
            body: "",
            bytesRead: 0,
            truncated: false,
          }),
        );
        res.destroy();
        req.destroy();
        return;
      }

      res.on("data", (chunk: Buffer) => {
        bytesRead += chunk.byteLength;
        if (bytesRead > options.maxBytes) {
          truncated = true;
          // Over budget: stop reading immediately rather than buffering
          // the rest and checking afterwards.
          finish(() => reject(new PinnedTooLargeError(options.maxBytes)));
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        finish(() =>
          resolve({
            status,
            statusText: res.statusMessage ?? "",
            headers: res.headers,
            location: res.headers.location ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
            bytesRead,
            truncated,
          }),
        );
      });

      res.on("aborted", () => {
        finish(() => reject(new PinnedAbortedError()));
      });

      res.on("error", (err: Error) => {
        finish(() => reject(err));
      });

      // `close` fires for both a clean end and an aborted stream.
      // `res.complete` is the only reliable way to tell them apart when
      // the abort surfaces as a close rather than an `aborted` event
      // (Node emits both, in an order that differs by version).
      res.on("close", () => {
        if (!res.complete) finish(() => reject(new PinnedAbortedError()));
      });
    });

    req.end();
  });
}
