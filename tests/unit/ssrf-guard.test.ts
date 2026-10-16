// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SSRF defense unit tests.
 *
 * The `isPublicAddress` function is the contract that keeps a malicious
 * URL from making the server hit `127.0.0.1` / `169.254.169.254` / its
 * own intranet. A regression here is a critical-severity bug, and the
 * rule list must be exhaustive enough that a missing case fails a
 * test, not production.
 *
 * `resolvePublicAddress` is harder to test in isolation because it actually
 * calls DNS; the relevant coverage is in
 * `apps/reader-release/tests/server-inject.mjs`, which exercises the URL path
 * against an in-process fake upstream and therefore sees the same DNS path
 * the route handler sees.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicAddress, parseUrlOrThrow, SsrfBlockedError } from "../../server/src/lib/ssrf-guard.js";

test("every public IPv4 we expect to allow is allowed", () => {
  for (const addr of [
    "1.1.1.1", // Cloudflare DNS
    "8.8.8.8", // Google DNS
    "9.9.9.9", // Quad9
    "93.184.216.34", // example.com
    "140.82.114.3", // GitHub
    "104.21.0.0", // Cloudflare range
  ]) {
    assert.equal(isPublicAddress(addr), true, `public ${addr} must be allowed`);
  }
});

test("loopback / private / link-local IPv4 is always refused", () => {
  for (const addr of [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.255.254",
    "169.254.169.254", // AWS / GCP / Azure metadata
    "100.64.0.1", // CGN lower bound
    "100.127.255.254", // CGN upper bound
    "0.0.0.0",
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
  ]) {
    assert.equal(isPublicAddress(addr), false, `private ${addr} must be refused`);
  }
});

test("172.16.0.0/12 lower and upper boundaries are covered", () => {
  // The 172.16.0.0/12 range runs 172.16.x.x .. 172.31.x.x. Just outside
  // is 172.15.x.x and 172.32.x.x, which must stay public.
  assert.equal(isPublicAddress("172.15.255.255"), true);
  assert.equal(isPublicAddress("172.16.0.0"), false);
  assert.equal(isPublicAddress("172.31.255.255"), false);
  assert.equal(isPublicAddress("172.32.0.0"), true);
});

test("IPv6 loopback, link-local, ULA, and 6to4 wrappers are refused", () => {
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("::"), false);
  assert.equal(isPublicAddress("fe80::1"), false);
  assert.equal(isPublicAddress("fc00::1"), false);
  assert.equal(isPublicAddress("fd00::1"), false);
  // 6to4 wrapping 127.0.0.1: 2002:7f00:0001::/48
  assert.equal(isPublicAddress("2002:7f00:0001::1"), false);
  // 6to4 wrapping a public address: 2002:0808:0808::/48 (8.8.8.8)
  assert.equal(isPublicAddress("2002:0808:0808::1"), true);
});

test("a malformed IP is refused, not silently allowed", () => {
  assert.equal(isPublicAddress("999.999.999.999"), false);
  assert.equal(isPublicAddress("not-an-ip"), false);
  assert.equal(isPublicAddress(""), false);
});

test("parseUrlOrThrow refuses non-http(s) schemes with a user-readable message", () => {
  for (const bad of [
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_FLUSHALL",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/post",
    "ldap://internal.example.com",
  ]) {
    assert.throws(
      () => parseUrlOrThrow(bad),
      (err: unknown) => err instanceof SsrfBlockedError,
      `must refuse ${bad}`,
    );
  }
});

test("parseUrlOrThrow accepts http and https", () => {
  const https = parseUrlOrThrow("https://example.com/post");
  assert.equal(https.protocol, "https:");
  assert.equal(https.hostname, "example.com");
  const http = parseUrlOrThrow("http://example.com/post");
  assert.equal(http.protocol, "http:");
});

test("parseUrlOrThrow reports a malformed URL as 422 SsrfBlockedError", () => {
  assert.throws(
    () => parseUrlOrThrow("not a url"),
    (err: unknown) => err instanceof SsrfBlockedError && err.statusCode === 422,
  );
});
