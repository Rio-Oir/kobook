# Contributing

Contributions are accepted under **MPL-2.0**, the license this project is
released under: submitting a change means agreeing that it may be distributed
under those terms. There is no separate contributor agreement and no copyright
assignment.

Everything below describes how this repository is worked on, so a reviewer can
reproduce a change and check it independently.

## Getting set up

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run browser:install     # Chromium, needed only for the browser suites
```

Node 24.12.0 and npm 11.6.2. The local reader needs no environment file; the
optional service reads the variables documented in `.env.example` (all of them
have working local defaults).

## What to run before calling a change done

```bash
npm run typecheck           # frontend, server and tests (generates the Prisma client first)
npm run test:unit
npm run acceptance:base     # adds the production build, the service tests, a real browser
```

`acceptance:base` is the gate that matters: it builds the artifact that would
ship and then drives it. Its logs, screenshots and fixture output land in
`docs/evidence/base-reproducibility/`, which is gitignored.

The database-backed suites need the local database and proxy first:

```bash
npm run db:up && npm run caddy:setup
npm run test:phase1         # or test:integration for all three
npm run verify              # the whole serial gate
```

`verify -- --all` keeps going after a failing step so you get every exit code
instead of a fail-fast stop.

Touch these areas and a run should also include `npm run test:browser:byok`:

* `src/lib/ai.ts`, `src/lib/settings.ts`, `src/components/SettingsView.tsx`
* anything that builds or mutates a request body

## What a change needs to include

1. **A test that fails without it.** Every suite in this repository is written
   so that the assertion would have caught the defect it was added for. A
   change to the parser, the offset maths, the storage format, the backup
   validator, the SSRF address rules, the limiter or the BYOK send path without
   one is not reviewable.
2. **A reason in the comment, not just a description.** This codebase explains
   *why* a rule exists and what goes wrong without it. Match that; a comment
   that restates the code adds a line to review and nothing else.
3. **No second implementation of something that already exists.** There is one
   Markdown parser per environment (browser and server) and the two are held
   equal by a test that parses the same fixtures with both. Adding a third, or
   a "simplified" copy, is the failure mode the structure exists to prevent.
4. **Proof that the change did not reach further than intended.** If you touch
   the build, the CSP, route mounting or the module graph, the build's own
   assertions should be the evidence — they read the emitted bytes rather than
   the config, and there is a positive control so an empty bundle cannot pass.

## Hard rules

These are not style preferences. A change that breaks one of them should be
rejected regardless of what else it improves.

* **Local first.** Reading, saving, highlighting, annotating, backing up and
  restoring must keep working with no account, no network and no database. A
  feature must not wait on a remote call to complete.
* **Accounts stay optional on the read path.** Signing in adds sync, but the
  reader must work with the service down and no session; nothing that renders an
  article may block on `/api`.
* **No credential anywhere but the browser.** A key must not reach a build, a
  log, a backup, an export, or a request body built by this application's own
  code.
* **Do not weaken the extraction guards.** SSRF address rules, DNS pinning, TLS
  verification, per-hop redirect gating, byte caps, deadlines and rate limits
  each exist for a reason a test pins. Loosening one needs the security
  consequences argued explicitly.
* **Do not respell a persisted identifier.** Storage keys, the backup format
  string, block ids, article ids and the extractor version stamp are on users'
  machines. Changing one needs a migration and a compatibility test, not a
  find-and-replace.
* **No new runtime dependency without a reason.** The dependency surface is
  deliberately small (the SSRF address rules are hand-written rather than
  pulling a library, so the rules stay reviewable in one file). A new
  dependency should be justified in the change description, and it changes the
  license inventory — run `npm run notices` and include the regenerated files.
* **Do not relabel third-party material.** `licenses/` holds other projects'
  license and notice texts exactly as they were published, and
  `THIRD_PARTY_NOTICES.md` is generated from the installed tree. Neither is
  ours to relicense or to edit by hand.

## House style

* TypeScript, strict, no `any` in new code.
* Prefer returning a result value over throwing for an expected outcome; the
  extraction and parsing layers do this so callers cannot forget a case.
* Exhaustiveness matters: a `switch` over a closed union ends with an
  `assertNever`-style default so adding a variant is a compile error.
* User-facing copy is Simplified Chinese, as is the rest of the UI. Code
  comments and documentation are English.
* Two-space indent, trailing commas, double quotes in `src/` and `shared/`,
  single quotes in `tests/` and `scripts/`. Match the file you are in.
* **SPDX header.** Every first-party `.ts`, `.tsx`, `.mjs`, `.js` and `.css`
  file begins with `// SPDX-License-Identifier: MPL-2.0` and the Mozilla
  notice below it. A new file needs the same header. Deliberately **not**
  applied to third-party texts under `licenses/`, to Markdown, to `index.html`,
  to JSON manifests (which carry the license through `package.json`), or to
  test fixture data — see the scope note in `README.md`.

## Reporting a security issue

Report it privately through GitHub's private vulnerability reporting — see
`SECURITY.md`. Do not open a public issue containing exploit details.
