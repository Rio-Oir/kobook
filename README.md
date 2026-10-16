# kobook

A local-first reader. Import an article from a link, a file or a paste, read it
with the layout and theme you like, select any passage to get an explanation or
ask a follow-up question, keep highlights and notes, back everything up to a
file, and keep reading when the network is gone.

The local reading features require **no account and no API key of ours**.
Explanation and question-answering use *your* model key (bring your own key),
which the application sends directly from your browser to the endpoint you
configure — never through this project's server.

This project's own source is licensed under the **Mozilla Public License,
version 2.0** (MPL-2.0) — see [License](#license). The name has not been
trademark-cleared, and the source still carries `gloss*` identifiers for
compatibility; both are explained under
[Name, provenance and rights](#name-provenance-and-rights).

---

## What is in this repository

| Area | Where | Notes |
| --- | --- | --- |
| Reading UI | `src/` | React 19 + Vite + Zustand. Home, Library, Reader. |
| Local data | `src/lib/store.ts` | Articles, notes, highlights in `localStorage`, versioned and migrated. |
| Import | `src/lib/local-import*.ts` (text/Markdown), `src/lib/browser-extract*.ts` (URL) | Pasted text never touches the network. |
| Notes & highlights | `src/lib/highlight.ts`, `src/lib/note-lifecycle.ts`, `src/lib/text-offset.ts` | Anchored by block id plus character offsets. |
| BYOK model access | `src/lib/ai.ts`, `src/lib/settings.ts`, `src/components/SettingsPanel.tsx` | OpenAI-compatible HTTP; the key stays in the browser. |
| Backup / restore | `src/lib/local-backup.ts` | A single JSON file. |
| Offline shell | `src/sw-register.ts` + generated `sw.js` | Same-origin GETs only. |
| Extraction service | `server/src/`, `apps/reader-release/server.ts` | Fastify. One unauthenticated route. |
| Shared contract | `shared/contracts/` | The wire vocabulary, used by both sides. |
| Verification | `tests/`, `apps/reader-release/tests/`, `apps/reader-release/acceptance-base.mjs` | Unit, service and real-browser suites. |

There is **no** account system, session handling, database, sync, billing or
server-side model access anywhere in this tree. The HTTP surface is two routes:

```
GET  /api/health/live        liveness only; no dependencies touched
POST /api/anonymous/extract  text | html | url -> a parsed document; writes nothing
```

Anything else answers with the shared 404 envelope. `shared/contracts/api.ts`
is the complete route table, and the build asserts that the emitted bundle
names no `/api/` path that is not in it.

---

## Quickstart

Requires **Node 24.12.0** and **npm 11.6.2** (see `.nvmrc`, `.node-version`,
and the `engines` field). No environment file is needed; `.env.example`
documents every variable and all of them have working defaults.

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

### 1. Development server (fastest way to look at it)

```bash
npm run dev          # http://localhost:5173
```

Reads and writes on this machine only. Paste text, drop a `.md`/`.txt` file, or
paste a link. There is **no backend on this port**, so a URL import can only use
its browser-direct channel; the server fallback answers 404 and the UI reports
that it could not fetch the page.

Two things differ from the deployable build, and both are visible on the wire:

* **This entry point loads Google Fonts** (`index.html` links
  `fonts.googleapis.com`), so a default page load makes a cross-origin request.
  The deployable build in step 3 strips those links, and its CSS font stack then
  resolves to locally installed families and system fallbacks.
* **Its `connect-src` is a fixed list** of `'self'`, `r.jina.ai`, the four BYOK
  provider presets and loopback. A *custom* model endpoint is blocked by that
  policy in this mode. The deployable build's policy allows `https:` for
  `connect-src`, which is what a self-hosted or gateway endpoint needs.

### 2. Static build

```bash
npm run build        # typecheck + vite build -> dist/ (served from /)
npm run preview      # serve dist/ locally
```

`dist/` is plain static files. Serve them from any static host. Like the dev
server, this build keeps the Google Fonts links and the fixed `connect-src`
list. It has no service worker and no `/api/*` behind it, so URL import is
browser-direct only and offline reading is whatever your browser cache gives
you.

### 3. Deployable build + anonymous extraction service

The shippable variant builds under a path (`/reader/`), strips the remote font
links so a default page load makes no cross-origin request, applies a stricter
CSP, and emits a content-versioned service worker over the emitted file list.

```bash
npm run build:release                       # -> apps/reader-release/dist
node --import tsx apps/reader-release/server.ts
# http://127.0.0.1:8790/reader/  (SERVICE_PORT, SERVER_HOST)
```

One process then serves both the shell and `/api/anonymous/extract`. Behind a
reverse proxy, set `TRUST_LOOPBACK_PROXY=1` only if that proxy overwrites
`X-Forwarded-For` — otherwise a caller can choose its own rate-limit bucket.

Rate limits default to enabled in `production` and disabled elsewhere: 20
requests per 60 s per client, 4 concurrent per client, 16 concurrent
process-wide. The counters live in memory, so more than one replica means each
replica gets its own budget.

### 4. Verification

```bash
npm run typecheck            # frontend + tests
npm run test:unit            # unit suites
npm run browser:install      # one-time: Chromium for Playwright
npm run acceptance:base      # types, units, production build, service, real browser
```

`acceptance:base` is the full gate: it typechecks, runs the unit suites, builds
the production bundle, boots the extraction service and drives a real Chromium
against the built artifact. Its logs, screenshots and fixtures go to
`artifacts/base-acceptance/`, which is gitignored; set `EVIDENCE_DIR` to write
them somewhere else instead.

---

## What the reader does, and what it does not

### Import

* **Paste text or Markdown** — parsed in the browser. There is no network call
  on this path at all: no fetch, no base URL, no transport. Works offline.
* **Drop a `.md` / `.markdown` / `.txt` file** — read locally with `File.text()`.
* **Paste a URL** — see below.

### URL import, and the third-party service it uses by default

For a URL, the browser **first asks `r.jina.ai`** — a third-party reader service
— directly, and parses what it returns locally. That means:

* the target URL, and your IP address, are visible to that third party;
* nothing about you is sent with the request (no cookies, `credentials: "omit"`),
  and there is no way to configure a different reader address — the constant is
  not a parameter, so a page cannot be tricked into naming its own proxy;
* a response is capped at 10 s and 5 MB, enforced while streaming.

If that fails, the browser falls back to `POST /api/anonymous/extract` on the
origin serving the app, which fetches the page over controlled HTTP and extracts
it with Readability. **The server never calls a reader service**, and no
environment value can make it; its own protections are DNS pinning to a
pre-resolved public address, TLS verification that is never disabled, per-hop
re-validation of every redirect, a streaming byte cap and a hard deadline.

If both fail you get a message naming both reasons and are asked to paste the
text. Cancelling never triggers the fallback.

**X (Twitter) links are best effort.** `x.com` and `twitter.com` (and their
subdomains) skip the browser-direct attempt entirely, because a plain fetch gets
a JavaScript shell or a login wall and the attempt would only waste a request.
They go straight to the server, which fetches over plain HTTP — so a post that
needs JavaScript or a session will still fail. Paste the text instead. There is
no logged-in scraping, no API credential and no plan to add one.

### Reading, notes and highlights

Full-text view with an outline, four themes (dark, sepia, paper, light) plus a
follow-system option, and four highlight colours with three styles. A
highlight is an *anchor*: block id plus character offsets into the normalised
paragraph text. A note is a question and a streamed answer, with each follow-up
kept as its own turn. Notes from a previous version of the same document stay
reachable rather than disappearing.

### Bring your own key (BYOK)

Explanation and question-answering call an OpenAI-compatible endpoint that
**you** configure. Read `SECURITY.md` before using a key you care about. In
short:

* the key lives in memory by default; it is written to `localStorage` **only**
  after you tick "remember on this device", which is plaintext and readable by
  anyone who can run script on this origin — including another person using the
  same browser profile;
* the key is sent only to the origin you explicitly confirmed in the settings
  panel. Changing the address or the provider asks first, and an unconfirmed
  origin is refused rather than silently used;
* the key is excluded from backups, exports, application logs and requests to
  this project's extraction service; the confirmed model request carries it;
* with no key configured, the app runs in a clearly-labelled demo mode instead
  of pretending a real model answered.

### Backup and restore

The Library offers **download backup** and **restore backup** over a single JSON
file (`format: "gloss-local-backup"`, version 1) holding articles, notes and
highlights. Validation is strict and restore is additive: it refuses any
collision that would overwrite a differing local record rather than merging and
hoping. **Credentials are never in a backup**, and neither is your provider,
model or endpoint configuration.

Local data has no version control and no server copy. If it matters, download a
backup — and note that clearing site data for this origin deletes it.

### Offline

The offline shell is a service worker that caches **only same-origin GET
responses** for the app under its deployed path, and it deliberately never
caches anything under `/api/`. Cross-origin traffic — the reader service, your
model endpoint — is never intercepted, because a cached model response would be
both wrong and a privacy surprise.

Prerequisites: a **secure context** (HTTPS, or `localhost`/`127.0.0.1`) and a
browser with service workers. On plain `http://` from a non-loopback host, or
without service-worker support, registration is a no-op and the app still works
online.

---

## Repository layout

```
src/                     application: UI, local stores, import, notes, BYOK
server/src/              extraction service: parser, SSRF guard, pinned fetch, limiter
apps/reader-release/     the deployable build, its service entry and its browser gate
shared/contracts/        wire contract shared by both sides
tests/                   unit suites and their fixtures
scripts/                 notice inventory, TLS fixture, shared process helpers
licenses/                third-party license texts (generated)
LICENSE                  MPL-2.0, covering this project's own source
```

## Verification, honestly described

* `npm run typecheck`, `npm run test:unit` — 358 unit tests over the parser,
  offset maths, storage migration, backup validation, the SSRF address rules,
  the rate limiter, BYOK settings and the cloud seam's absent-adapter behaviour.
* `npm run acceptance:base` — adds the production build, the service boundary
  tests (in-process inject plus one real child process) and a real Chromium run
  against `apps/reader-release/dist`.
* `npm run test:browser:byok` — a real browser against fake OpenAI-compatible
  vendors; the point is that the `Authorization` header is observed on the wire
  only at the endpoint that was confirmed.
* `npm run notices` — regenerates `THIRD_PARTY_NOTICES.md` and `licenses/` from
  the installed tree.

What is **not** verified here: no external network is contacted by any suite,
so nothing exercises a real reader service, a real model provider, a real DNS
resolver or a real TLS chain from the internet. The service suites use an
in-process fake upstream with a locally generated CA. Load, multi-replica
behaviour and long-running memory use are untested.

## License

This project's own source is licensed under the **Mozilla Public License,
version 2.0** (MPL-2.0). The operative terms are in [`LICENSE`](LICENSE); each
first-party source file carries an SPDX identifier naming the same license:

```
// SPDX-License-Identifier: MPL-2.0
```

What that means, in outline — the license text governs, not this summary:

* MPL-2.0 is a **file-based** copyleft license. You may use, modify and
  redistribute this source, including in commercial and proprietary products.
  If you distribute a modified version of one of these files, that file's
  modifications stay under MPL-2.0; other files you combine with it need not
  be. It also includes a patent grant from contributors.
* **It grants no trademark rights.** Nothing here licenses the project name as
  a brand.
* **The notices name no copyright holder.** That line has not been settled, and
  it has deliberately not been filled in with a name nobody authorised.

The license covers this repository's own source and documentation. It does
**not** cover the third-party packages this project depends on: those remain
under their own licenses, listed in `THIRD_PARTY_NOTICES.md` with available
texts vendored under `licenses/` and missing texts identified. See `NOTICE.md`. Those texts are other people's documents and
carry no SPDX header from this project.

**Where the identifier appears.** First-party `.ts`, `.tsx`, `.mjs`, `.js` and
`.css` files carry it. It is deliberately absent from `index.html`, Markdown,
JSON manifests (which state the license in `package.json`), test fixture data
(parsed and asserted on, so a header would change what the tests measure), and
everything under `licenses/`.

## Name, provenance and rights

### The name

The product name is **kobook**. It appears in the UI header, the page title and
the package metadata.

The name has **not been trademark-cleared**. No trademark registry, domain
availability, app-store, business-name or jurisdiction/class search has been
carried out, and unrelated uses of the name have not been assessed. MPL-2.0
grants no trademark rights. Anyone intending to distribute under this name
should treat clearance as outstanding.

### Why `gloss*` appears in the source

The storage keys `gloss-storage`, `gloss-settings` and `gloss-theme`, the
`gloss-*` CSS class names, and the backup format identifier
`gloss-local-backup` predate the name decision, and they are **persisted
identifiers**: articles, notes, highlights, settings and backup files a reader
already has on disk refer to them, and renaming one would orphan that data.
They are therefore preserved exactly as they are; changing any of them would
require a migration. The same applies to the `local-free:v1` storage space an
earlier standalone version used, which this application reads and never
rewrites.

### Provenance

The author describes this implementation as original work informed by reader
products' behaviour, layout and interaction design. Functional inspiration and
copying source or assets are separate questions. This statement records the
author's account; it is not an independent determination of ownership.

A comparison against one reference checkout found no exact normalized-source
match and no match above the chosen five-token similarity threshold. That
limited observation does not establish authorship, rule out every form of
copying, or resolve rights. The inventory found no standalone image or font
assets in the exported source. npm dependencies, including icon libraries, keep
their own licenses in `THIRD_PARTY_NOTICES.md` and `licenses/`; development and
static entry points also reference remote fonts as documented above.

The author's account is that this implementation predates the publication of a
same-category project that informed its behaviour. That account is context, not
proof — in either direction.

One file, `src/lib/article.ts`, is superseded and unreferenced; it is marked as
such rather than deleted, because removing a file from an exported snapshot is
a packaging decision rather than a code edit.

## Contributing and reporting

Contributions are accepted under MPL-2.0, the same license this project is
released under — see `CONTRIBUTING.md` for how to run things, what a change
needs to include, and where the SPDX header convention is applied. See
`SECURITY.md` for the threat model, the BYOK risk in full, and how to report a
vulnerability privately.
