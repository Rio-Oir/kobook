# Security

## Reporting a vulnerability

**There is no published private reporting channel yet.** The project is licensed
(MPL-2.0 — see `LICENSE`) but it has no release, no published home and therefore
no security contact to put here. Inventing an address would be worse than saying
so.

Before this is published, the maintainer needs to add one — a private advisory
route, a dedicated address, or both. Until then: do not open a public issue
containing exploit details, and do not assume a report has been received.

## What this application is trusted with

Reading is local. The two things worth protecting are:

1. **The reader's model API key (BYOK).** A bearer credential for a paid
   service, held in the browser.
2. **The reader's articles, notes and highlights.** Private by default — they
   are not uploaded anywhere, because there is nowhere in this tree to upload
   them to.

Everything below follows from those two.

## BYOK in full

The single highest-impact issue in a reader like this is losing someone's model
key. The design is laid out here completely, including the parts that are
genuinely risky.

* **Memory by default.** A key typed into the settings panel lives in the
  in-memory store and disappears when the tab closes.
* **Opt-in persistence, in plaintext.** Ticking "remember on this device" writes
  the key to `localStorage` under `gloss-settings`, with a confirmation that
  says so. Local storage is **not encrypted**. Anyone who can run script on
  this origin — an injected script, a malicious extension, another person using
  the same browser profile — can read it. Do not tick that box on a shared
  machine, and prefer a key you can rotate.
* **Bound to one origin.** The key is sent only to the origin the reader
  explicitly confirmed: `confirmedOrigin` is recorded when a key is entered or
  kept, and the send path refuses any request whose endpoint origin differs.
  Changing the provider preset, editing the address field, or editing storage
  from devtools produces a refusal with an explicit message, not a silent send
  to a new destination.
* **Never leaves through anything else.** It is not part of the backup format,
  not in an export, not in a log, and not in any request this application's own
  code builds. `pickExtractFields` in `src/lib/browser-extract-server.ts`
  builds the one outbound request body by name and *throws* on an unexpected
  key, so a settings object spread into it fails loudly rather than leaking a
  credential once and never being noticed.
* **Redacted from errors.** `redactSecrets` in `src/lib/ai.ts` strips
  `Bearer …` and `sk-…` shapes from any provider error before it is shown or
  kept, and the retained `Error` carries no `cause`, headers or request body.
* **No build-time key, ever.** There is no `VITE_*_API_KEY` variable and none
  will be added. A key baked into a bundle is a key shared with every visitor.

## What the browser talks to, and when

Load the **deployable** build and it makes **no** request off-origin: no
analytics, no session probe, and no fonts, because that build strips the Google
Fonts `<link>`s and the shipping font stack resolves to locally installed
families and system fallbacks. (`npm run dev` and the plain `npm run build`
entry point do load Google Fonts — see the two-builds note in `README.md`.)
This is asserted in `apps/reader-release/tests/base-browser.mjs` by observing
the wire.

Requests happen only when the reader asks for them:

* **Paste a URL** → the browser asks `r.jina.ai` **directly**, before anything
  else. The target URL and the reader's IP address are visible to that third
  party. The request carries no cookies (`credentials: "omit"`) and cannot be
  redirected to a different reader service, because the address is a module
  constant rather than a parameter. **A page cannot choose its own proxy.**
* **The fallback fires** → only after the direct channel fails, and never after
  a cancellation, the browser calls `POST /api/anonymous/extract` on the origin
  serving the app. The body is the target URL and nothing else.
* **Ask or explain** → the browser calls the reader's own configured model
  endpoint, with the reader's own key. Never through this project's server.

## The extraction service

`POST /api/anonymous/extract` is the only unauthenticated route that makes the
server do real work, and for `kind: "url"` it is the only unauthenticated egress
the service has. One request makes it resolve a hostname, open a socket and read
a bounded body, so it is treated as hostile input by default.

**SSRF.** `server/src/lib/ssrf-guard.ts` refuses any scheme but `http`/`https`,
refuses credentials embedded in the URL, and requires every resolved address to
be public — rejecting loopback, RFC 1918, link-local (including
`169.254.169.254`), carrier-grade NAT, `0.0.0.0/8`, multicast and reserved
ranges, and the IPv6 equivalents including IPv4-mapped and 6to4 spellings. A
hostname that resolves to *any* non-public address is refused wholesale. Every
redirect hop is re-gated, so a `302` into the intranet fails mid-chain.

**DNS rebinding.** The hostname is resolved once and the connection is pinned to
that address (`server/src/lib/pinned-fetch.ts`), so the second lookup `fetch`
would perform cannot return a different answer. The pin keeps SNI and the
certificate check pointed at the original hostname, and `rejectUnauthorized` is
not exposed anywhere in the module — TLS verification cannot be switched off by
a caller, a fixture or a future edit.

**Resource bounds.** 5 s connect timeout, 15 s total, 5 maximum redirects, a
5 MB body cap enforced *while streaming* so an upstream that declares a small
`Content-Length` and then streams forever is cut off rather than buffered. The
route adds its own 20 s whole-request deadline, and the whole service caps
request bodies at 3 MB and the extract route's `content` field at 2 MB.

**Rate limiting.** `server/src/lib/rate-limit-store.ts` enforces two independent
gates — a fixed window per client and an in-flight ceiling per client plus a
process-wide ceiling — because a rate limit alone does not stop five slow
fetches held open at once. Addresses come from the socket peer, not from a
header, unless `TRUST_LOOPBACK_PROXY=1` is set for a reverse proxy that
overwrites `X-Forwarded-For`. Counters are per-process.

**Strict bodies.** The route's schema declares
`additionalProperties: false` and the service disables AJV's default
`removeAdditional` behaviour, so a request that tries to name a proxy gets a
400 rather than a silent strip. `tests/unit/route-body-strictness.test.ts` pins
this, because the default would have made the schema advisory.

**Error disclosure.** 5xx responses are replaced with a fixed message and the
detail is logged against the same request id the caller is given. Upstream
error text is never echoed verbatim, since it can carry a resolved IP, a port or
a driver message.

**Nothing is written.** The route creates no article, no version, no paragraph
and no user row. There is no database in this process at all — the boundary
tests boot it with every credential-shaped environment variable removed, and
assert that an account, admin or cloud route answers 404.

## The browser surface

* **No `innerHTML`, no `dangerouslySetInnerHTML`, no `eval`, no `new Function`**
  anywhere in `src/`, `server/`, `shared/` or `apps/`. Article content is
  rendered as React elements, and link targets are allowlisted to
  `http`/`https`/`mailto` with relative targets dropped.
* **CSP.** The shippable build applies `script-src 'self'` with exactly one
  hashed inline script (the theme bootstrap) and no `unsafe-inline` for
  scripts; `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`. `connect-src` is deliberately wide (`https:`) because a
  BYOK endpoint cannot be enumerated — that is the one place the policy trades
  tightness for the feature working on a self-hosted endpoint. The build
  *asserts* the policy is applied and that only the reviewed bootstrap is
  hashed, so a change to the inline script fails the build rather than silently
  widening the policy.
* **No accounts means no session surface.** No cookie is set, no auth route is
  mounted, and any account-shaped deep link lands on Home.
* **Backups exclude credentials.** The backup schema names its fields
  explicitly; provider, model, endpoint and key are not among them, and a
  restore validates strictly and refuses any collision instead of overwriting.

## Known limitations

* **Rate-limit state is per process.** Multiple replicas each get their own
  budget.
* **No external network is exercised by any test.** The service suites use an
  in-process fake with a locally generated CA, so a real DNS, TLS or
  upstream-behaviour change would not be caught here.
* **The offline shell caches same-origin GETs under the deployed path** and
  never `/api/`. A shared browser profile still shares this origin's storage,
  which is the same trust boundary as any local-first web app.
* **BYOK on a shared device is the residual risk.** Everything else in this
  document is a mitigation; "remember this key" is a deliberate trade the reader
  makes, and it is the thing to check first on a machine you do not own.
* **This code has not been through an independent security review.** The
  guarantees above are properties of the implementation and are covered by
  tests, not by a third-party assessment.
