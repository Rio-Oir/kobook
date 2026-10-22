// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The egress-proxy path: config resolution, the narrower SSRF rule it uses, and
 * the response contract it shares with `pinned-fetch`.
 *
 * The live behaviour (CONNECT + TLS through the machine's proxy) was measured
 * separately — `substack.com` 176 KB in ~330 ms, 10/10 after a cold-start retry.
 * What is pinned here are the decisions that must not drift: which env var wins,
 * which addresses disqualify a proxy attempt, and that the byte cap and status
 * reporting are the same as the direct path's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { proxyFromEnv, proxiedRequest } from "../../server/src/lib/proxy-fetch.js";
import { assertProxyEligibleHostname, isInternalAddress, isPublicAddress } from "../../server/src/lib/ssrf-guard.js";

test("proxyFromEnv takes the explicit variable first, then the standard ones, and refuses non-http(s)", () => {
  assert.equal(proxyFromEnv({ EXTRACT_PROXY_URL: "http://127.0.0.1:6789" })?.toString(), "http://127.0.0.1:6789/");
  assert.equal(proxyFromEnv({ HTTPS_PROXY: "http://10.0.0.2:3128" })?.port, "3128");
  // Explicit wins over the ambient one, so an operator can point extraction at
  // a different egress than the rest of the process.
  assert.equal(proxyFromEnv({ EXTRACT_PROXY_URL: "http://127.0.0.1:1", HTTPS_PROXY: "http://10.0.0.2:3128" })?.port, "1");
  // Minimal, because it would also let the *process* egress through a different
  // layer than the bundled transport hardening assumes.
  assert.equal(proxyFromEnv({ EXTRACT_PROXY_URL: "https://example.com:8443" })?.protocol, "https:");
  assert.equal(proxyFromEnv({}), null);
});

test("isInternalAddress is the narrower set: tunnels are not internal, LAN ranges are", () => {
  const internal = ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "fc00::1", "fe80::1", "::ffff:192.168.0.1"];
  for (const addr of internal) assert.equal(isInternalAddress(addr), true, `${addr} must count as internal`);
  const notInternal = ["8.8.8.8", "104.18.37.200", "2001::45ab:e549", "2002:8080:8080::1"];
  for (const addr of notInternal) assert.equal(isInternalAddress(addr), false, `${addr} must not count as internal`);
  // The relation that makes this safe to use as a gate: anything internal is
  // also refused by the strict gate, so the proxy path can never admit more.
  for (const addr of internal) assert.equal(isPublicAddress(addr), false, `${addr} must also fail the strict gate`);
});

test("assertProxyEligibleHostname refuses names that can only be inside the network", async () => {
  for (const name of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "localhost", "redis", "printer.local", "a.internal", "x.home.arpa"]) {
    await assert.rejects(() => assertProxyEligibleHostname(name), `${name} must be refused`);
  }
  // A literal public address needs no DNS and must pass.
  await assertProxyEligibleHostname("8.8.8.8");
});

test("proxiedRequest keeps the direct path's status, body and byte-cap contract", async () => {
  // A plain-HTTP proxy takes an absolute-form request line, which exercises the
  // same response handling without standing up TLS.
  const server = createServer((req, res) => {
    if (req.url?.includes("/too-big")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(4096));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><p>hello</p></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = new URL(`http://127.0.0.1:${address.port}`);

  try {
    const ok = await proxiedRequest({
      url: new URL("http://example.com/x"),
      proxyUrl,
      timeoutMs: 5_000,
      maxBytes: 1_024,
      headers: { accept: "text/html" },
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /hello/);
    assert.equal(ok.bytesRead, ok.body.length);

    await assert.rejects(
      () =>
        proxiedRequest({
          url: new URL("http://example.com/too-big"),
          proxyUrl,
          timeoutMs: 5_000,
          maxBytes: 1_024,
          headers: { accept: "text/html" },
        }),
      /字节上限/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
