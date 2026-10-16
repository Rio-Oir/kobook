# Security

## Reporting a vulnerability

Please report suspected vulnerabilities **privately, by email**, to:

**`a1458367843@gmail.com`** — <mailto:a1458367843@gmail.com>

This mailbox is the reporting channel for this project. Two honest caveats:

* **Delivery has not been tested and no response time is promised.** No
  acknowledgement schedule, triage window or fix deadline is stated here,
  because none has been agreed. Treat a report as received only when you get a
  reply.
* The address is a contact for security reports about *this project*. Please do
  not send credentials, personal data or third-party confidential material with
  a report.

The source is currently in a private GitHub repository, and reporting through
GitHub is not available yet:

* GitHub's *private vulnerability reporting* is a feature of **public**
  repositories. For this repository the REST endpoint answers `404 Not Found`:
  `GET /repos/Rio-Oir/kobook/private-vulnerability-reporting`. The same endpoint
  returns `{"enabled": false}` for a public repository that has not switched the
  feature on, and `{"enabled": true}` for one that has — so this is the feature
  not applying to a private repository, not a permissions or token problem.
* Issues are enabled on the repository, so an issue *can* be opened — but issues
  are visible to everyone with access, which is the wrong place for exploit
  details. Use the mailbox instead.

**Once the repository is public**, turning on private vulnerability reporting
would add a second, in-GitHub channel alongside the mailbox — Settings → Code
security, or `PUT /repos/Rio-Oir/kobook/private-vulnerability-reporting` with
`{"enabled": true}` (repository admin required). GitHub then shows a "Report a
vulnerability" button under Security → Advisories, and reports through it stay
private until an advisory is published. That is an option for later, not a
channel that exists now, and enabling it is a repository-settings change that
this project has not made.

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
  it is not in an export, and it is not in a log. The one request this
  application builds that carries the key is the call to the model endpoint the
  reader confirmed — that call *is* the feature, and its destination is pinned to
  the confirmed origin.

  The application builds exactly two other kinds of outbound request, and
  neither involves the key:

  * **The server-extraction request** (`POST /api/anonymous/extract`, used by
    the fallback channel only) is built by `pickExtractFields` in
    `src/lib/browser-extract-server.ts`, which names the fields it forwards —
    `kind`, `content`, `title` — and *throws* on any other own property. A
    settings object spread into that call fails loudly rather than leaking a
    credential once and never being noticed.
  * **The reader-service request** (browser → `r.jina.ai`, used first for most
    hosts) is built in `src/lib/browser-extract-jina.ts`, which is a separate
    module and does **not** go through `pickExtractFields`: it builds its URL
    from the module's own constant plus the target, and sends fixed headers
    (a content type and a return-format hint) with `credentials: "omit"`. No
    settings value, and no credential, reaches it — the whitelist above guards
    the server route, not this one, and the two are described separately here
    for that reason.
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

* **Paste an ordinary URL** → the browser asks `r.jina.ai` — a third-party
  reader service — **directly, before this project's server is involved**. The
  target URL and the reader's IP address are visible to that third party. The
  request carries no cookies (`credentials: "omit"`) and cannot be aimed at a
  different reader service, because the address is a module constant rather than
  a parameter: **a page cannot choose its own proxy.**
* **Paste an `x.com` or `twitter.com` URL** → the browser does **not** contact
  the third-party service. Those hosts answer a plain fetch with a JavaScript
  shell or a login wall, so the attempt would burn a round trip to learn
  nothing; the request goes straight to `POST /api/anonymous/extract` instead.
  The match is on the parsed hostname — those two hosts and their DNS
  subdomains only, so `evilx.com` and `x.com.evil.test` are not caught. This is
  a best-effort path, not an access grant: a post that needs JavaScript or a
  session still fails, and the reader is asked to paste the text.
* **The server fallback** → for any other host, only after the direct channel
  fails, and never after a cancellation. The body is the target URL and, when
  supplied, a title — built field by field from a fixed whitelist, so nothing
  else can ride along.
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

## Known dependency advisories

As of 2026-10-16, `npm audit --omit=dev` reports **0** known vulnerabilities in the production dependency set. The findings below are in the development build toolchain; a zero audit count is not a proof of absence of vulnerabilities.

`npm audit` over the full tree reports **7**. Those are **two advisories** —
npm counts one entry for each package it flags, and five of the seven are
propagation entries for packages that merely depend on an affected one. They are
real, so they are recorded here rather than left for a reader to discover. All
of them are in the **development build toolchain**, reached through
`tailwindcss@3.4.19`, and none can be fixed without a breaking change:

| Advisory | Severity | Affects | Patched release |
| --- | --- | --- | --- |
| [`GHSA-vfj7-8cjw-p6xm`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) — `braces`, stack-exhaustion denial of service on deeply nested patterns | high | `braces@3.0.3` directly, and then `micromatch`, `chokidar`, `fast-glob` and `tailwindcss` as propagation entries | **None exists.** The advisory records no patched version, and `3.0.3` is the newest published release of `braces`: every published version is inside the vulnerable range. Upgrading within 3.x does not fix it, because there is nothing newer to upgrade to. |
| [`GHSA-rj75-hqrm-r3gf`](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) — `postcss-selector-parser`, quadratic-complexity CPU exhaustion | moderate | `postcss-selector-parser@6.1.4` directly, and then `postcss-nested` and `tailwindcss` (the Tailwind propagation entry is shared with the other chain) | `7.1.6`. `tailwindcss@3` and `postcss-nested@6` both require `^6.1.x`, so reaching it means a major bump of those first. |

`npm audit fix` without `--force` proposes no change — there is no
non-breaking upgrade that resolves any of them. `--force` offers
`tailwindcss@4.3.3`, a major upgrade of the whole CSS toolchain; that is a
migration decision with its own regression surface, not a security patch, and it
has deliberately not been applied here. It is the remediation to evaluate.

Both advisories are denial-of-service issues triggered by hostile *input* to a
parser. Both parsers here are fed this project's own CSS and JavaScript during a
local build — not attacker-controlled selectors on a request path — which lowers
the practical exposure without removing it. Anyone running `npm ci` and a build
in a context where those inputs are untrusted should treat these as live.

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
