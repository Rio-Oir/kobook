// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The base line's Content-Security-Policy, in one place.
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
 * silently fails on the user's own endpoint is not a feature.
 *
 * `script-src` is `'self'` plus the one reviewed theme-bootstrap hash: no
 * third-party host can load script, so an injected script has nowhere to run
 * from.
 */
export const FREE_CSP = [
  "default-src 'self'",
  // The only inline script allowed to run: the theme bootstrap in
  // `index.html`. The hash is over that script's text with CRLF normalised
  // to LF, which is exactly what `build.mjs` recomputes and asserts before
  // it will emit a release — so editing the bootstrap without updating this
  // line fails the release build instead of silently shipping a page whose
  // first paint is the wrong mode.
  //
  //   node -e "const c=require('crypto'),f=require('fs');\
  //     const m=[...f.readFileSync('index.html','utf8')\
  //       .matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];\
  //     console.log('sha256-'+c.createHash('sha256')\
  //       .update(m[0][1].replace(/\r\n/g,'\n')).digest('base64'))"
  "script-src 'self' 'sha256-JH64qEcQdnyKWIySiRF5lWGf1sv7q29DrvPCWKKT2SA='",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  // Article images live wherever the article lives — GitHub's camo, WeChat's
  // `mmbiz.qpic.cn`, Zhihu's `pic1.zhimg.com`. The extractor keeps their
  // absolute URLs, so `'self' data:` alone meant every illustration in every
  // imported article rendered as a broken image, with a CSP violation in the
  // console. This is the same trade-off as `connect-src`: the set of hosts is
  // the open web and cannot be enumerated. Loading an image does reveal the
  // reader's IP to that host, which is what any browser does with a normal
  // article page; `script-src` stays `'self'`, so an image still cannot run
  // anything.
  "img-src 'self' data: https:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The policy as it is safe to deliver through `<meta http-equiv>`, which is
 * what `vite.config.ts` writes into the shell.
 *
 * `frame-ancestors` is header-only: a meta copy is ignored and logs
 * `The Content Security Policy directive 'frame-ancestors' is ignored when
 * delivered via a <meta> element.` on every load. The directive is therefore
 * dropped from the meta copy and kept in the header copy, where it is
 * enforced — nginx and `server.ts` both send this constant verbatim.
 */
export const META_CSP = FREE_CSP.split("; ")
  .filter((directive) => !directive.startsWith("frame-ancestors"))
  .join("; ");

/** Deployed path prefix. Kept here so the server and the build agree. */
export const DEPLOY_BASE = "/reader/";
