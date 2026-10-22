// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Serving the built reader shell from the API process.
 *
 * A deployment of this product is one process: it answers `/api/*` and it
 * serves the single-page app that calls those routes. Keeping the shell in the
 * same process is not a convenience — it is what makes "the same origin" true,
 * which is what the session cookie needs.
 *
 * It is an *option* on `buildApp` rather than something always on, because two
 * of the three ways this server runs do not want it:
 *
 *   - the acceptance suites (`tests/phase*.ts`) drive the API and nothing else;
 *   - `npm run dev:server` sits behind Vite (and, for the full local stack,
 *     Caddy), which already serves `index.html` with hot reload.
 *
 * ## The extension allowlist is the allowlist
 *
 * `resolveStaticFile` refuses anything whose extension is not in
 * {@link CONTENT_TYPES}, and a refusal is not a 404 — it falls through to the
 * SPA fallback and comes back as `index.html`. For a module script that
 * surfaces as "failed to fetch dynamically imported module", and for pdf.js's
 * cmaps and font data it is quieter still: pdf.js treats a failed table as a
 * missing one, and a Chinese PDF renders as garbage. Every extension the build
 * can emit therefore has to be listed, and `apps/reader-release/build.mjs` is
 * where the emitted set is decided.
 *
 * ## Containment, not filtering
 *
 * The path check compares *resolved* paths against the resolved root, so `..`,
 * percent-encoded dots and absolute paths all fail the same way. Filtering
 * suspicious-looking input is the approach that misses a spelling.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface ShellOptions {
  /** Directory the built shell lives in. */
  root: string;
  /** URL prefix, with a trailing slash. */
  base: string;
  /** Policy for the shell document. The build emits the same one as a meta tag. */
  csp: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  // pdf.js assets, staged into `public/pdfjs/` by `scripts/pdfjs-assets.mjs`.
  ".mjs": "application/javascript; charset=utf-8",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
};

/** Resolve a request path to a file inside the shell root, or `null`. */
async function resolveStaticFile(
  options: ShellOptions,
  pathname: string,
): Promise<{ file: string; ext: string } | null> {
  if (!pathname.startsWith(options.base)) return null;
  const rest = pathname.slice(options.base.length);
  if (rest.includes("\0")) return null;

  const rootResolved = path.resolve(options.root);
  const candidate = rest.length === 0 ? "index.html" : decodeURIComponent(rest);
  const resolved = path.resolve(rootResolved, candidate);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;

  const ext = path.extname(resolved);
  if (!Object.prototype.hasOwnProperty.call(CONTENT_TYPES, ext)) return null;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  return { file: resolved, ext };
}

function sendFile(
  reply: FastifyReply,
  options: ShellOptions,
  file: string,
  ext: string,
  isShell: boolean,
): FastifyReply {
  reply.header("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream");
  if (isShell) {
    // The shell must never be cached: it names the hashed assets, and a stale
    // shell pointing at deleted hashes is a blank page.
    reply.header("cache-control", "no-cache");
    reply.header("content-security-policy", options.csp);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  } else {
    reply.header(
      "cache-control",
      file.endsWith("sw.js") ? "no-cache" : "public, max-age=31536000, immutable",
    );
  }
  return reply.send(createReadStream(file));
}

/** Mount the shell routes. Call before `app.ready()`. */
export function registerShellRoutes(app: FastifyInstance, options: ShellOptions): void {
  const base = options.base;
  // `/reader` (no trailing slash) must not be resolved as a file relative to
  // the root, or every relative asset reference in the shell would resolve one
  // level too high.
  const bare = base.replace(/\/$/, "");
  if (bare.length > 0) {
    app.get(bare, async (_req, reply) => reply.redirect(base, 308));
  }

  app.get(`${base}*`, async (req, reply) => {
    const url = new URL(req.url, "http://localhost");
    const resolved = await resolveStaticFile(options, url.pathname);
    if (!resolved) {
      // SPA fallback: a client-side hash route never reaches the server, but a
      // hand-typed `/reader/somewhere` should render the app rather than a 404
      // with an API envelope.
      const shell = await resolveStaticFile(options, `${base}index.html`);
      if (!shell) return reply.code(404).send("Not found");
      return sendFile(reply, options, shell.file, shell.ext, true);
    }
    return sendFile(reply, options, resolved.file, resolved.ext, resolved.ext === ".html");
  });
}
