// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SSRF defense for the URL importer.
 *
 * The URL import path is the only place the server fetches an
 * attacker-influenced URL. Every step that resolves a hostname — the
 * initial request, every redirect hop, and the A / AAAA records behind
 * the hostname — has to pass the same gate, because a 302 to
 * `http://127.0.0.1:6379` is just as much an SSRF as the original
 * request.
 *
 * What we block, with the reason each rule is in the list:
 *   - any non-`http(s)` scheme: file://, gopher://, javascript:,
 *     data:, ftp://, dict://, ldap://, etc. are all either file reads,
 *     SSRF amplifiers, or browser-side attacks. The plan says "http /
 *     https only".
 *   - 127.0.0.0/8, ::1: loopback. The attacker can read anything bound
 *     to localhost on the server (Redis, internal admin pages, debug
 *     ports). Always 127.0.0.0/8, not just "127.0.0.1".
 *   - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16: RFC 1918 private
 *     space. The data centre is on one of these; reading it is reading
 *     the host's intranet.
 *   - 169.254.0.0/16: link-local. The single most important block is
 *     169.254.169.254 — the AWS / GCP / Azure metadata service. A
 *     single GET there is enough to lift cloud credentials.
 *   - 100.64.0.0/10: carrier-grade NAT. Same problem as RFC 1918
 *     from the attacker's perspective.
 *   - 0.0.0.0/8 and :: — unspecified / wildcard; a service that listens
 *     on 0.0.0.0 can be reached on 0.0.0.0 too.
 *   - IPv6 fc00::/7 (unique local) and fe80::/10 (link-local): same
 *     reasons as their IPv4 counterparts.
 *   - 6to4 / teredo: 2002::/16 wraps an IPv4 address; reject any
 *     embedded address that fails the IPv4 rules.
 *
 * What we explicitly do not block:
 *   - 8.8.8.8 or any public IP. A public IP is the only kind the
 *     importer is supposed to reach.
 *   - userinfo in the URL (`http://user:pass@host/`). The attacker
 *     cannot leverage it because the host part is still validated.
 *
 * DNS rebinding is mitigated by resolving the hostname exactly once,
 * passing the resulting address into the request, and never letting
 * `fetch` re-resolve. Node's `fetch` (undici) does its own DNS lookup
 * by default; we use a custom `lookup` on an `http.Agent` to force a
 * specific address for the first hop, and a manual redirect handler
 * that re-resolves each `Location:` through the same gate.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Maximum number of `Location:` hops we will follow. */
export const MAX_REDIRECTS = 5;

/** Per-fetch connect timeout. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** Total time budget for the whole import (initial fetch + redirects). */
export const TOTAL_TIMEOUT_MS = 15_000;

/** Hard cap on the response body the importer will read. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class SsrfBlockedError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export class SsrfTimeoutError extends Error {
  readonly statusCode = 504;
  constructor(message: string) {
    super(message);
    this.name = "SsrfTimeoutError";
  }
}

/**
 * Decide whether a single IP address (IPv4 string or IPv6 string) is
 * safe to fetch. Returns `true` for "public", `false` for any kind of
 * loopback, private, link-local, or unspecified range.
 *
 * Hand-written rather than pulling `ipaddr.js` so the dependency
 * surface stays small and the rules are reviewable in one file.
 */
export function isPublicAddress(addr: string): boolean {
  if (isIP(addr) === 0) return false; // not a valid IP

  // IPv4
  if (addr.includes(".") && !addr.includes(":")) {
    const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return false;
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return false; // 0.0.0.0/8 — unspecified / wildcard
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // 127.0.0.0/8 — loopback
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 — link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 — CGN
    if (a >= 224) return false; // 224.0.0.0/4 — multicast, 240/4 — reserved
    return true;
  }

  // IPv6
  if (addr.includes(":")) {
    // Canonicalise expanded/IPv4-mapped spellings before comparing ranges.
    // A textual prefix check alone accepts e.g. 0:0:0:0:0:0:0:1.
    if (addr.includes("%")) return false;
    let lower: string;
    try { lower = new URL(`http://[${addr}]/`).hostname.slice(1, -1); }
    catch { return false; }
    if (lower === "::" || lower === "::1") return false;
    // Reject mapped/translation ranges entirely; they can hide private IPv4.
    if (lower.startsWith("::")) return false;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // fc00::/7
    if (lower.startsWith("fe80:")) return false; // fe80::/10
    if (lower.startsWith("2002:")) {
      // 6to4: extract the embedded IPv4 (bytes 2..5) and re-check.
      const hex = lower.slice(5).split(":");
      if (hex.length >= 2) {
        const hi = Number.parseInt(hex[0]!, 16);
        const lo = Number.parseInt(hex[1]!, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          const embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isPublicAddress(embedded);
        }
      }
      return false;
    }
    // Only ordinary global-unicast addresses are eligible. Exclude special
    // protocol assignments and documentation ranges within 2000::/3.
    const first = Number.parseInt(lower.split(":")[0]!, 16);
    if (first < 0x2000 || first > 0x3fff) return false;
    if (first === 0x2001) {
      const second = Number.parseInt(lower.split(":")[1] || "0", 16);
      if (second < 0x200 || second === 0xdb8) return false;
    }
    if (first === 0x3fff) return false;
    return true;
  }

  return false;
}

function parseUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("URL 格式不正确。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(`仅支持 http / https 链接 (收到 ${parsed.protocol})。`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError("链接不能包含用户名或密码。");
  }
  return parsed;
}

/**
 * Parse and scheme-validate a URL, throwing `SsrfBlockedError` on
 * anything but `http(s)`. Exported so callers (and tests) can refuse
 * a URL before doing any DNS work.
 */
export function parseUrlOrThrow(rawUrl: string): URL {
  return parseUrl(rawUrl);
}

/**
 * Resolves a hostname to a list of A / AAAA records and refuses to
 * proceed if any of them is non-public. Returns the first public
 * address so the caller can pin the request to it (defeats DNS
 * rebinding between the check and the request).
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
  // isIP returns 4 / 6 for a literal IP; we accept those directly.
  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) {
      throw new SsrfBlockedError(`目标地址 ${hostname} 不在公网范围内。`);
    }
    return hostname;
  }
  // dnsLookup returns at least one address. We check every one of them
  // because a hostname with both a public and a private record (an
  // attacker-controlled DNS, or a misconfigured split-horizon) must
  // be refused wholesale.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SsrfBlockedError(
      `无法解析 ${hostname}：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`${hostname} 没有可用的 IP 地址。`);
  }
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new SsrfBlockedError(`目标 ${hostname} 解析到非公网地址 ${address}。`);
    }
  }
  return addresses[0]!.address;
}

/**
 * Validates a URL up front, before any fetch: parses it, checks the
 * scheme, and resolves the hostname through the public-address gate.
 * Returns the parsed URL and the resolved IP (caller pins the request
 * to this IP to defeat DNS rebinding).
 */
export async function gateUrl(rawUrl: string): Promise<{ url: URL; address: string }> {
  const parsed = parseUrl(rawUrl);
  const address = await resolvePublicAddress(parsed.hostname);
  return { url: parsed, address };
}

// ── Proxy-path gating ─────────────────────────────────────────────────────
//
// A deployment whose direct egress is tampered with cannot use the strict
// gate as an admission test for the *proxy* path: the answers it sees are
// garbage (measured here: `kevinkelly.substack.com` → a Dropbox address or a
// Teredo tunnel, `medium.com` → a Twitter address), and every one of them is
// "not public", so the strict gate refuses a perfectly ordinary article.
//
// The proxy resolves the name itself, so what still matters is only the
// question the proxy path can actually get wrong: *is this name pointing into
// the operator's own network?* That is a narrower set of ranges than
// `isPublicAddress` refuses — loopback, RFC 1918, link-local, CGNAT, ULA,
// unspecified, and IPv4-mapped/6to4 forms that hide one of those. Teredo and
// other tunnel/documentation addresses are refused as *direct destinations*
// but carry no SSRF meaning, so they do not disqualify a name here.

/** Ranges that mean "this is inside the operator's network", not "unroutable". */
export function isInternalAddress(addr: string): boolean {
  if (isIP(addr) === 0) return true;

  if (addr.includes(".") && !addr.includes(":")) {
    const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (!addr.includes(":")) return true;
  if (addr.includes("%")) return true;
  let lower: string;
  try {
    lower = new URL(`http://[${addr}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  if (lower === "::" || lower === "::1") return true;
  // IPv4-mapped / translated forms: re-check the embedded address.
  if (lower.startsWith("::ffff:")) return isInternalAddress(lower.slice("::ffff:".length));
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("2002:")) {
    const hex = lower.slice(5).split(":");
    if (hex.length >= 2) {
      const hi = Number.parseInt(hex[0]!, 16);
      const lo = Number.parseInt(hex[1]!, 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isInternalAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }
    return false;
  }
  return false;
}

/** Hostname suffixes that only ever name something inside a network. */
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"] as const;

/**
 * Throws `SsrfBlockedError` when `hostname` names a host inside the operator's
 * network — the only SSRF question the proxy path can still get wrong, since
 * the proxy resolves the name and the local answer is not trustworthy here.
 *
 * The policy is intentionally hostname-first: a literal private IP, a
 * single-label name (`redis`, `metadata`), or one of the internal suffixes is
 * refused without touching DNS, and a lookup that yields an internal address
 * refuses the name wholesale.
 */
export async function assertProxyEligibleHostname(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (isInternalAddress(host)) {
      throw new SsrfBlockedError(`目标地址 ${host} 不在公网范围内。`);
    }
    return;
  }
  if (!host.includes(".") || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new SsrfBlockedError(`目标 ${host} 看起来是内网地址，拒绝通过代理访问。`);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(host, { all: true, verbatim: true });
  } catch (err) {
    // Unresolvable locally is not disqualifying: the proxy does its own
    // resolution, and on a tampered resolver this says nothing about the name.
    return;
  }
  for (const { address } of addresses) {
    if (isInternalAddress(address)) {
      throw new SsrfBlockedError(`目标 ${host} 解析到内网地址 ${address}。`);
    }
  }
}
