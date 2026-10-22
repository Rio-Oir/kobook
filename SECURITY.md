# Security

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**:

- Prefer [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  once it is enabled on the repository (Security → Advisories → "Report a
  vulnerability"). Reports filed that way stay private until an advisory is
  published.
- If that channel is not available, email **`a1458367843@gmail.com`**
  (<mailto:a1458367843@gmail.com>).

Two honest caveats:

- **No response time is promised.** No acknowledgement schedule, triage window
  or fix deadline is stated here, because none has been agreed. Treat a report
  as received only when you get a reply.
- Do not include credentials, personal data or third-party confidential
  material. A reproduction with synthetic data is enough.

## What this application is trusted with

1. **The reader's model API key (BYOK).** A bearer credential for a paid
   service, held in the browser.
2. **The reader's articles, notes and highlights.** Private by default; stored
   in the browser, and uploaded only when the reader signs in and chooses to
   sync.
3. **Account credentials and sessions, when the optional service is used.**
   Password hashes, session cookies and the synced content belong to the
   operator of the deployment.

Everything below follows from those three.

## BYOK in full

The single highest-impact issue in a reader like this is losing someone's model
key.

- **Memory by default.** A key typed into the settings panel lives in the
  in-memory store and disappears when the tab closes.
- **Opt-in persistence, in plaintext.** Ticking "remember on this device" writes
  the key to `localStorage` under `gloss-settings`, with a confirmation that says
  so. Local storage is **not encrypted**. Anyone who can run script on this
  origin — an injected script, a malicious extension, another person using the
  same browser profile — can read it. Do not tick that box on a shared machine,
  and prefer a key you can rotate.
- **Bound to one origin.** The key is sent only to the origin the reader
  explicitly confirmed: `confirmedOrigin` is recorded when a key is entered or
  kept, and the send path refuses any request whose endpoint origin differs.
  Changing the provider preset, editing the address field, or editing storage
  from devtools produces a refusal with an explicit message, not a silent send
  to a new destination.
- **Never leaves through anything else.** It is not part of the backup format,
  not part of an export, not part of the sync payload and not in a log. The one
  request this application builds that carries the key is the call to the model
  endpoint the reader confirmed — that call *is* the feature, and its destination
  is pinned to the confirmed origin.
- **Redacted from errors.** `redactSecrets` in `src/lib/ai.ts` strips
  `Bearer …` and `sk-…` shapes from any provider error before it is shown or
  kept, and the retained `Error` carries no `cause`, headers or request body.
- **No build-time key, ever.** There is no `VITE_*_API_KEY` variable and none
  will be added. A key baked into a bundle is a key shared with every visitor.

## What the browser talks to, and when

The deployable build (`apps/reader-release`) loads no third-party resource: no
analytics, no remote fonts. The only request made on load is a **same-origin**
session probe that decides whether to show the account entry. `npm run dev` and
the plain `npm run build` entry point differ only in this respect (Vite serves
the app directly); they still contain no third-party tag.

Requests happen only when the reader asks for them:

- **Paste an ordinary URL** → the browser asks `r.jina.ai` — a third-party
  reader service — **directly, before this project's server is involved**. The
  target URL and the reader's IP address are visible to that third party. The
  request carries no cookies (`credentials: "omit"`) and cannot be aimed at a
  different reader service, because the address is a module constant rather than
  a parameter: **a page cannot choose its own proxy.**
- **Paste an `x.com` or `twitter.com` URL** → the browser does **not** contact
  the third-party service. Those hosts answer a plain fetch with a JavaScript
  shell or a login wall, so the attempt would burn a round trip to learn nothing;
  the request goes straight to `POST /api/anonymous/extract` instead. The match
  is on the parsed hostname — those two hosts and their DNS subdomains only, so
  `evilx.com` and `x.com.evil.test` are not caught. This is a best-effort path,
  not an access grant: a post that needs JavaScript or a session still fails, and
  the reader is asked to paste the text.
- **The server fallback** → for any other host, only after the direct channel
  fails, and never after a cancellation. The body is the target URL and, when
  supplied, a title — built field by field from a fixed whitelist, so nothing
  else can ride along.
- **Ask or explain** → the browser calls the reader's own configured model
  endpoint, with the reader's own key. Never through this project's server.
- **Sign in, sync** → requests go to the deployment's own `/api`, with the
  session cookie the server sets. Nothing leaves for a third party.

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
process-wide ceiling — because a rate limit alone does not stop five slow fetches
held open at once. Addresses come from the socket peer, not from a header, unless
`TRUST_LOOPBACK_PROXY=1` is set for a reverse proxy that overwrites
`X-Forwarded-For`. Counters are per-process.

**Strict bodies.** The route's schema declares `additionalProperties: false` and
the service disables AJV's default `removeAdditional` behaviour, so a request
that tries to name a proxy gets a 400 rather than a silent strip.
`tests/unit/route-body-strictness.test.ts` pins this, because the default would
have made the schema advisory.

**Error disclosure.** 5xx responses are replaced with a fixed message and the
detail is logged against the same request id the caller is given. Upstream error
text is never echoed verbatim, since it can carry a resolved IP, a port or a
driver message.

**Nothing is written by this route.** It creates no article, no version, no
paragraph and no user row. The process also serves accounts, so the boundary is
tested per route rather than per process: the inject suite asserts that the
extract route writes nothing and that account, admin and cloud routes refuse an
anonymous caller.

## The browser surface

- **No `innerHTML`, no `dangerouslySetInnerHTML`, no `eval`, no `new Function`**
  anywhere in `src/`, `server/`, `shared/` or `apps/`. Article content is
  rendered as React elements, and link targets are allowlisted to
  `http`/`https`/`mailto` with relative targets dropped.
- **CSP.** The shippable build applies `script-src 'self'` with exactly one
  hashed inline script (the theme bootstrap) and no `unsafe-inline` for scripts;
  `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`. `connect-src` is deliberately wide (`https:`) because a
  BYOK endpoint cannot be enumerated — that is the one place the policy trades
  tightness for the feature working on a self-hosted endpoint. The build
  *asserts* the policy is applied and that only the reviewed bootstrap is hashed.
- **Accounts are optional.** Anonymous use sets no cookie and needs no database.
  Signing in sets the session cookie issued by the deployment (HttpOnly); the
  read path never blocks on a session check.
- **Backups exclude credentials.** The backup schema names its fields
  explicitly; provider, model, endpoint and key are not among them, and a restore
  validates strictly and refuses any collision instead of overwriting.

## Known dependency advisories

As of **2026-10-22**, against the official registry:

- `npm audit --omit=dev` reports **4 high** findings, all in the Prisma toolchain
  (`prisma@7.10.0` → `@prisma/config` → `deepmerge-ts`, and `prisma` → `mysql2`).
  There is no non-breaking fix at the pinned version; the remediation is a major
  upgrade of Prisma.
- `npm audit` over the full tree reports **12** (9 high, 3 moderate). The extra
  entries are the Tailwind 3 build toolchain (`tailwindcss` → `micromatch` →
  `braces`, and `postcss-selector-parser`), again without a non-breaking fix.
- The Prisma and Tailwind packages involved are build- or CLI-time here. The
  application does not mount `mysql2`; the advisory is recorded because it is in
  the dependency graph, not because it is reachable at runtime.

A zero audit count is not proof of absence of vulnerabilities, and these numbers
are a snapshot; run `npm audit --registry=https://registry.npmjs.org` yourself.

## Known limitations

- **Rate-limit state is per process.** Multiple replicas each get their own
  budget.
- **No external network is exercised by the tests.** The service suites use an
  in-process fake with a locally generated CA, so a real DNS, TLS or
  upstream-behaviour change would not be caught here.
- **The offline shell caches same-origin GETs under the deployed path** and never
  `/api/`. A shared browser profile still shares this origin's storage, which is
  the same trust boundary as any local-first web app.
- **BYOK on a shared device is the residual risk.** Everything else in this
  document is a mitigation; "remember this key" is a deliberate trade the reader
  makes.
- **Deployment configuration is the operator's responsibility.** SMTP/SMS
  transports, secrets, the database and the reverse proxy are configured by
  whoever runs the instance; this repository only refuses to start a production
  service with a missing or unsafe transport.
- **This code has not been through an independent security review.** The
  guarantees above are properties of the implementation and are covered by
  tests, not by a third-party assessment.
