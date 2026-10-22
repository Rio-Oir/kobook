// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pinned fetching: TLS identity, per-hop SSRF re-gating, size and time
 * bounds.
 *
 * This is the file that pins the phase-3 fix for
 *
 *   "修 HTTPS 抓取锁定 IP 时的原域名 SNI/证书校验（不得关闭 TLS 校验）"
 *
 * The bug it replaces was silent, which is why the assertions here are
 * about *identity* rather than about "the request succeeded". Pinning a
 * connection by rewriting the URL's hostname to an IP means the TLS
 * handshake carries SNI = the IP and the certificate is checked against
 * the IP — so every correctly-configured HTTPS origin fails, and the
 * only way to make the feature work is to stop verifying certificates.
 * A test that merely asserted "fetching a local HTTPS server works"
 * would pass against that broken implementation as long as the fixture
 * disabled verification.
 *
 * So the fixture is a *real* TLS chain: a local CA, a leaf for
 * `fixture.test`, and a valid-but-wrong-identity leaf for `other.test`.
 * Nothing in the test process disables verification, and the case that
 * proves it is `the wrong certificate identity is refused`.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { getEventListeners } from "node:events";
import {
  PinnedAbortedError,
  PinnedTimeoutError,
  PinnedTooLargeError,
  pinnedRequest,
} from "../../server/src/lib/pinned-fetch.js";
import { ensureTlsFixture, readCaCertificate } from "../../scripts/tls-fixture.mjs";

const fixture = ensureTlsFixture();
const ca = readCaCertificate();

interface Upstream {
  origin: string;
  port: number;
  /** SNI values the TLS server saw, in connection order. */
  servernames: string[];
  close(): Promise<void>;
}

/**
 * A local HTTPS server presenting `cert`/`key` on a loopback port.
 *
 * `servername` is recorded from the `secureConnection` event: if SNI
 * were being dropped (the bug this file exists for) that list would be
 * empty, and Node would not have had a name to validate against either.
 */
async function startHttps(certPath: string, keyPath: string, name: string): Promise<Upstream> {
  const servernames: string[] = [];
  const server = createHttpsServer(
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    (req, res) => {
      if (req.url === "/slow") return; // never responds
      if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "text/html" });
        // Well past the 512-byte cap the tests pass in.
        res.end("<html><body>" + "x".repeat(4_000) + "</body></html>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><p>hello from ${name}</p></body></html>`);
    },
  );
  server.on("secureConnection", (socket) => {
    const sni = (socket as unknown as { servername?: string }).servername;
    servernames.push(sni ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `https://fixture.test:${port}`,
    port,
    servernames,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function startHttp(): Promise<Upstream> {
  const server = createHttpServer((req, res) => {
    if (req.url === "/slow") return;
    if (req.url === "/huge") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("y".repeat(4_000));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><p>hello over plain http</p></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    servernames: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

let good: Upstream;
let wrong: Upstream;
let plain: Upstream;

before(async () => {
  good = await startHttps(fixture.goodCert, fixture.goodKey, "fixture.test");
  wrong = await startHttps(fixture.wrongCert, fixture.wrongKey, "other.test");
  plain = await startHttp();
});

after(async () => {
  await Promise.all([good?.close(), wrong?.close(), plain?.close()]);
});

test("a legitimate certificate for the original hostname is accepted", async () => {
  const response = await pinnedRequest({
    url: new URL(`${good.origin}/`),
    address: "127.0.0.1",
    timeoutMs: 5_000,
    maxBytes: 1_000_000,
    ca,
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /hello from fixture\.test/);
});

test("SNI carries the hostname, not the pinned IP", () => {
  // The property the whole design rests on. If this list held
  // "127.0.0.1", a real HTTPS origin would reject the handshake and the
  // feature would only work with verification off.
  assert.deepEqual(
    good.servernames.filter((name) => name.length > 0),
    ["fixture.test"],
    "the TLS server must observe the original hostname as SNI",
  );
  assert.ok(
    !good.servernames.includes("127.0.0.1"),
    "the pinned IP must never reach the TLS layer as an identity",
  );
});

test("the HTTP Host header stays the original host", async () => {
  // Virtual hosting breaks if pinning overwrites `Host` with the IP.
  let seenHost = "";
  const server = createHttpServer((req, res) => {
    seenHost = req.headers.host ?? "";
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const response = await pinnedRequest({
    url: new URL(`http://example.test:${port}/`),
    address: "127.0.0.1",
    timeoutMs: 5_000,
    maxBytes: 1_000,
  });
  assert.equal(response.status, 200);
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  assert.equal(seenHost, `example.test:${port}`, "virtual hosting must still work");
});

test("an untrusted certificate is refused, because verification is on", async () => {
  await assert.rejects(
    () =>
      pinnedRequest({
        url: new URL(`${good.origin}/`),
        address: "127.0.0.1",
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
        // No `ca`: the fixture's CA is not in the system store, so the
        // chain cannot validate. This is the assertion that catches a
        // future edit adding `rejectUnauthorized: false`.
      }),
    (err: unknown) => {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      assert.match(
        message,
        /self-signed|unable to verify|self signed|UNABLE_TO_VERIFY|CERT/i,
        `expected a certificate failure, got: ${message}`,
      );
      return true;
    },
  );
});

test("the wrong certificate identity is refused even when the chain is trusted", async () => {
  // `other.test` is a valid certificate signed by the same CA we trust,
  // so this can only fail on hostname verification. A regression that
  // stopped passing `servername` would surface here.
  await assert.rejects(
    () =>
      pinnedRequest({
        // Ask for `fixture.test` but connect to the port serving
        // `other.test`.
        url: new URL(`https://fixture.test:${wrong.port}/`),
        address: "127.0.0.1",
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
        ca,
      }),
    (err: unknown) => {
      const code = (err as { code?: string }).code ?? "";
      assert.equal(
        code,
        "ERR_TLS_CERT_ALTNAME_INVALID",
        `expected a hostname mismatch, got ${code} ${String(err)}`,
      );
      return true;
    },
  );
});

test("plain HTTP is fetched without a TLS identity", async () => {
  const response = await pinnedRequest({
    url: new URL(`${plain.origin}/`),
    address: "127.0.0.1",
    timeoutMs: 5_000,
    maxBytes: 1_000_000,
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /plain http/);
});

test("a body over the cap is refused while streaming, not after buffering", async () => {
  const server = await startHttp();
  await assert.rejects(
    () =>
      pinnedRequest({
        url: new URL(`${server.origin}/huge`),
        address: "127.0.0.1",
        timeoutMs: 5_000,
        maxBytes: 512,
      }),
    PinnedTooLargeError,
  );
  await server.close();
});

test("a slow upstream times out with a distinguishable error", async () => {
  const server = await startHttp();
  await assert.rejects(
    () =>
      pinnedRequest({
        url: new URL(`${server.origin}/slow`),
        address: "127.0.0.1",
        timeoutMs: 150,
        maxBytes: 1_000,
      }),
    PinnedTimeoutError,
  );
  await server.close();
});

test("an aborted signal stops the request", async () => {
  const server = await startHttp();
  const controller = new AbortController();
  const promise = pinnedRequest({
    url: new URL(`${server.origin}/slow`),
    address: "127.0.0.1",
    timeoutMs: 10_000,
    maxBytes: 1_000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(() => promise, PinnedTimeoutError);
  await server.close();
});

test("a redirect is reported, not followed", async () => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const response = await pinnedRequest({
    url: new URL(`http://example.test:${port}/`),
    address: "127.0.0.1",
    timeoutMs: 5_000,
    maxBytes: 1_000,
  });
  assert.equal(response.status, 302);
  assert.equal(response.location, "http://127.0.0.1:1/elsewhere");
  assert.equal(response.body, "", "a redirect body is not read");
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

test("a redirect body is not drained, and the connection is torn down", async () => {
  // The regression this guards: `res.resume()` clears the deadline while
  // an unbounded body keeps arriving. The server here sends a 302 and
  // then writes forever; the call must return promptly with an empty
  // body, and the socket must be closed rather than left draining in the
  // background.
  let closed = false;
  const server = createHttpServer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
    // Headers are flushed, then an endless body follows.
    res.write("z".repeat(1_024));
    const pump = setInterval(() => res.write("z".repeat(1_024)), 5);
    res.on("close", () => {
      closed = true;
      clearInterval(pump);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const started = Date.now();
  const response = await pinnedRequest({
    url: new URL(`http://example.test:${port}/`),
    address: "127.0.0.1",
    timeoutMs: 30_000,
    maxBytes: 512,
  });
  const elapsed = Date.now() - started;

  assert.equal(response.status, 302);
  assert.equal(response.body, "", "a redirect body must not be read");
  assert.equal(response.bytesRead, 0);
  assert.ok(elapsed < 5_000, `a redirect must resolve promptly, took ${elapsed}ms`);
  // Give the destroy a tick to reach the server.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, true, "the redirect connection must be torn down, not left draining");

  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

test("a body that ends early rejects instead of hanging until the deadline", async () => {
  const server = createHttpServer((_req, res) => {
    // Promise far more than we send, then hang up mid-body.
    res.writeHead(200, { "content-type": "text/html", "content-length": "10000" });
    res.write("<html><body>partial");
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const started = Date.now();
  await assert.rejects(
    () =>
      pinnedRequest({
        url: new URL(`http://example.test:${port}/`),
        address: "127.0.0.1",
        // Long enough that a hang would be obvious: the rejection has to
        // come from the premature close, not from this deadline.
        timeoutMs: 30_000,
        maxBytes: 1_000_000,
      }),
    PinnedAbortedError,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `a premature close must reject promptly, took ${elapsed}ms`);

  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

test("a socket that closes before any response rejects as aborted", async () => {
  const server = createHttpServer((req, res) => {
    req.socket.destroy();
    void res;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  await assert.rejects(
    () =>
      pinnedRequest({
        url: new URL(`http://example.test:${port}/`),
        address: "127.0.0.1",
        timeoutMs: 30_000,
        maxBytes: 1_000,
      }),
    (err: unknown) => {
      assert.ok(
        err instanceof PinnedAbortedError || (err as { code?: string }).code === "ECONNRESET",
        `expected an abort-style failure, got ${String(err)}`,
      );
      return true;
    },
  );

  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

test("the abort listener is removed when the request settles", async () => {
  // The caller's signal outlives one request (the anonymous route's
  // budget spans a whole import), so a listener left attached would grow
  // by one entry per hop and keep every settled promise reachable.
  const controller = new AbortController();
  for (let i = 0; i < 25; i += 1) {
    await pinnedRequest({
      url: new URL(`${plain.origin}/`),
      address: "127.0.0.1",
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      signal: controller.signal,
    });
  }
  assert.equal(
    getEventListeners(controller.signal, "abort").length,
    0,
    "no abort listener may outlive its request",
  );
});

test("a signal that is already aborted fails without opening a socket", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      pinnedRequest({
        url: new URL(`${plain.origin}/`),
        address: "127.0.0.1",
        timeoutMs: 5_000,
        maxBytes: 1_000,
        signal: controller.signal,
      }),
    PinnedTimeoutError,
  );
});
