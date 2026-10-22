# Phone OTP Kit

A self-contained phone-number verification-code module: normalisation and
masking, a challenge store, two rate-limit budgets, an SMS transport seam, an
error allowlist, and an optional React form. It creates no users, issues no
sessions and reads no configuration from the environment.

Registered as an independent sub-project in
[`docs/手机号注册登录后续开发计划.md`](../../docs/手机号注册登录后续开发计划.md). It is
**not wired into the reader's authentication system** — nothing in `src/`,
`server/` or `shared/` imports it. Acceptance evidence, including what is still
unverified, is in [`docs/Phone-OTP-Kit验收报告.md`](../../docs/Phone-OTP-Kit验收报告.md).

**Provenance.** No file of the reference project `E:/无限画布` was read while
writing this module, and no code was copied from it. Every statement below about
what the reference does is a citation of the earlier read-only survey recorded in
`docs/evidence/phone-auth/` (with `file:line` references and content hashes);
`docs/evidence/phone-otp-kit/reuse-matrix.md` records which session established
what. The licence position could not be confirmed: the reference repository has no
`LICENSE`, `COPYING` or `NOTICE` file at its root, no root `package.json`, no
`license` field in `server/package.json` and no git remote, so there is no visible
grant for its authentication or SMS code — which is the reason the implementation
is an independent rewrite rather than a port.

## What it is for

The reader's accounts will offer email **or** phone + SMS. Rather than embed that
in the authentication flow, this module does the part that is reusable and
testable on its own:

- `+86` mainland-mobile normalisation, so two spellings of one number cannot
  become two identities;
- a challenge store whose contract is *atomic single use*, with a lifecycle
  (`pending` → `active`) that makes "the latest successful send replaces the old
  code" and "a failed send cannot take away a code the user already has"
  structural rather than conditional;
- a rate limiter with two independent budgets — sending costs money, guessing is
  the attack — keyed by number and by a *trusted, server-derived* client, and
  never by challenge id, so a new code cannot buy a new guess allowance;
- an SMS seam with no SDK, no HTTP client and no place to put a vendor string;
- an error allowlist with no `cause`, no provider text and no phone number;
- a React panel that only calls the two callbacks it is given.

Everything the kit refuses to do — create an account, look one up, issue a
session cookie — is the integrator's decision, made in the integrator's own
transaction against the integrator's own tables. That is what lets the same
module serve sign-in, sign-up, number binding and account recovery without a
rewrite.

## Two entries

Nothing is imported from the module root; there are two deliberate halves, and a
test walks both import graphs to keep them apart
(`tests/hygiene.test.ts`).

| Entry | Contains | Reaches |
| --- | --- | --- |
| `src/browser.ts` | the pure shared modules, the React panel, the Chinese copy | `react`, and nothing else |
| `src/server.ts` | everything plus the core: crypto, store, limiter, service, transports | `node:crypto`, and nothing else |

```ts
// Server
import {
  PhoneOtpService,
  createMemoryChallengeStore,
  createMemoryRateLimiter,
  createFakeSmsTransport,
  DEFAULT_LIMITS,
} from "./modules/phone-otp-kit/src/server";

// Browser
import { PhoneOtpPanel } from "./modules/phone-otp-kit/src/browser";
```

## Server use

```ts
const service = PhoneOtpService.create({
  config: {
    runtime: "test",                       // no default; see "Runtime" below
    secret: process.env.PHONE_OTP_SECRET!, // 32+ bytes, injected, never read here
    allowedPurposes: ["sign-in", "bind-phone"],
    store: myDurableStore,                 // see "Production adapters"
    limiter: myDurableLimiter,
    transport: mySmsAdapter,
    onError: ({ operation, code, smsFailure }) => metrics.count(operation, code, smsFailure),
  },
});

const requested = await service.requestCode({
  phone: "+8613800138000",
  clientRef: socketAddressOf(request),     // server-derived, never a request field
  purpose: "sign-in",
});
if (!requested.ok) return render(requested.code);

const verified = await service.verifyCode({
  phone: "+8613800138000",
  code: typedCode,
  clientRef: socketAddressOf(request),
  purpose: "sign-in",
});
if (verified.ok) {
  // The only thing this proves: whoever submitted it can read SMS for this
  // number, for this purpose. Creating or finding the account is *your* step,
  // in your transaction.
}
```

### Results

`requestCode` and `verifyCode` never throw for an expected failure and never
return a message. A failure is `{ ok: false, code, retryAfterMs?, attemptsRemaining? }`
where `code` is one of `INVALID_PHONE`, `UNSUPPORTED_PHONE`, `INVALID_PURPOSE`,
`UNTRUSTED_CLIENT`, `SEND_LIMITED`, `SMS_SEND_FAILED`, `VERIFY_LIMITED`,
`CODE_EXPIRED`, `CODE_INVALID`, `TOO_MANY_ATTEMPTS`, `INTERNAL`.

A success carries no code, no challenge id, no user id, no token and no full
phone number — only `maskedPhone` (`138****8000`, masked on the national part,
matching the mask rule the product selected for the reader) and the countdown
hints. The challenge id deliberately never leaves the store. The reference
project's own authentication controller returned one from its send endpoint and
answered "that id is unknown or used" differently from "that code is wrong"
(`OTP_EXPIRED` vs `UNAUTHENTICATED`, as recorded in
`docs/evidence/phone-auth/reference-sms-project.md` §8), which is an oracle for
challenge existence. That observation is from the issuer's read-only survey, not
from this module's own reading of the reference; here verification is keyed by
purpose + number and both cases are one answer.

### Runtime

`runtime` has no default and takes `"production"` or `"test"`. In production,
any component carrying the test-only brand — the memory store, the in-process
limiter, the fake transport — is refused at construction with
`TEST_ONLY_COMPONENT_IN_PRODUCTION` and the component's name. There is no flag to
skip that check, and the value must come from deployment configuration, never
from a request. `"test"` covers local development and CI.

## Production adapters

The kit ships the interface and the test-only implementations. The production
adapters are the integrator's, and the contracts are in
`src/otp/store.ts` and `src/otp/limiter.ts`. In short:

- `consumeChallenge` must be one atomic server-side operation (Lua, a
  transaction with a row lock, a conditional delete) that compares the digest in
  constant time, counts the failure *and commits the increment* before returning
  `mismatch`, enforces expiry itself, and guarantees exactly one `consumed`.
- `activateChallenge` must retire the previous active challenge in the same
  atomic step; `revokeChallenge` must be conditional on `(id, generation)` and
  must only ever remove a `pending` challenge.
- `consume` (limiter) must apply the `rules` it is handed, for the `bucket` it is
  given: an adapter holds no limits of its own, so the resolved configuration is
  the single source of policy and a mismatch is impossible rather than detected.
  It must evaluate and record in one atomic operation, keyed only by what it is
  given. `release` must remove at most one recorded attempt per scope, only one
  equal to the `at` it is given, and must never clear a window — that would turn a
  provider failure into a budget reset.
- `send` must return `{ ok: true }` or `{ ok: false, failure }` from the
  allowlist and nothing else. The service checks the shape (`ok` must be exactly
  `true`; an unknown `failure` becomes `UNKNOWN`), so a malformed result is a
  failed send, must not retry internally, and must not log the code.

## Browser use

```tsx
<PhoneOtpPanel
  purpose="sign-in"
  codeLength={6}
  onRequestCode={({ phone, purpose }) => post("/api/phone/request", { phone, purpose })}
  onVerifyCode={({ phone, code, purpose }) => post("/api/phone/verify", { phone, code, purpose })}
  onPendingChange={({ requesting, verifying }) => setBusy(requesting || verifying)}
/>
```

`codeLength` should match `PhoneOtpConfig.codeLength` (6–8; anything else falls
back to 6). The panel sends `+86` + 11 digits (an `assessPhone`-acceptable form),
renders sentences from its own table keyed by allowlisted codes, and masks the
number *it* sent — the peer's `maskedPhone` is not read, because "contains a `*`"
is not a property a full number cannot have. A callback whose `ok` is merely
truthy is treated as a failure, and `cooldownSeconds`/`attemptsRemaining` are
bounded finite numbers before they become a timer or a sentence. It performs no
network request, touches no cookie or browser storage, does not know what an
account is, and uses `useId` so several panels can share a page. Every string is
overridable through `labels`.

A response that arrives after the number or purpose it was issued for has changed
is discarded rather than applied; that is what the panel's `phoneChanged` notice
means.

The markup is unstyled and semantic with `data-phone-otp-role` hooks, so the host
application styles it with whatever it already has. No CSS ships with the module.

## Verification

```bash
# Type-check (standalone tsconfig; not part of the application's build)
npx tsc -p modules/phone-otp-kit/tsconfig.json --noEmit

# Tests (the module's own suite; independent of `npm test`)
node --import tsx --test modules/phone-otp-kit/tests/*.test.*
```

Nothing else in the repository is touched: no dependency, no lockfile entry, no
npm script, no change to the application's tsconfig or its test globs.

Facts about the toolchain worth knowing before editing:

- The test runner compiles `.tsx` with the **classic** JSX factory and ignores
  the `jsx` setting in `tsconfig.json` (verified in
  `docs/evidence/phone-otp-kit/probe-jsx.tsx`). View files therefore name their
  factory with a `/** @jsx createElement */` pragma. See the comment at the top
  of `src/ui/PhoneOtpPanel.tsx`.
- Imports are extensionless; `tsx` resolves them against
  `moduleResolution: "bundler"` (verified in
  `docs/evidence/phone-otp-kit/probe-tsx-resolution.mts`).

## Relationship to the reader's phase-5 contract

A parallel session wrote [`docs/手机号认证契约.md`](../../docs/手机号认证契约.md), which
chooses better-auth's official `phone-number` plugin as the integration route for
the reader's accounts. This module does not contest or implement that decision —
it is the *independent sub-project* registered in
`docs/手机号注册登录后续开发计划.md`, and the contract's own gap list is the
specification it fills:

| Contract gap | This module |
| --- | --- |
| G3 — no per-number send limit (the plugin's key is IP × path) | `send.phone` rules, charged before the provider is called |
| G4 — no cross-challenge guess budget (a resend resets the count) | `verify.phone` rules, keyed by number and client, never by challenge |
| G5 — no purpose isolation (`identifier` is the bare number) | `purpose` is mixed into the code digest and into the challenge key |
| G6 — no normalisation (`138…` and `+86138…` are two identities) | `assessPhone`, applied on every path |
| G10 — the code itself is stored in plaintext | the store holds an HMAC digest, never the code |

Two deliberate differences from the contract, both recorded rather than hidden:

- **The number rule is stricter.** The contract's §5.6 accepts `^\+86\d{11}$`;
  this module additionally requires the mainland-mobile shape `1[3-9]` + 9
  digits, so a `+86` landline is refused as `UNSUPPORTED_PHONE` instead of
  reaching a provider that cannot serve it. Being stricter costs nothing and
  avoids spending money on a message that cannot be delivered.
- **The refund question is answered against the contract's recommendation.** The
  contract (§5.3.4) recommends refunding a failed send; this module does **not**,
  by default, because a refund removes the only thing bounding provider calls
  during an outage. `refundFailedSend: true` implements the contract's reading for
  a deployment that bounds the retry loop elsewhere. This is a deliberate,
  recorded disagreement rather than an oversight.

The kit is *not* an adapter for the plugin: it does not speak the `verification`
table's shape and nothing in the reader's auth path uses it. Whether the reader
integrates the plugin alone, or uses this module behind a self-built endpoint
(the contract's §2.2 option B), stays an open decision for phase 5.

## Limits and residual risks

- **+86 only.** `SUPPORTED_SENDING_COUNTRY_CODES` is `["86"]` and configuration
  refuses anything else. E.164 *syntax* is checked separately, so a valid `+1`
  number is reported as unsupported rather than malformed.
- **A bare 11-digit number is read as +86.** Because exactly one country is
  supported, `13800138000` is unambiguous here. A `+1` number whose digits happen
  to be 11 digits starting `1[3-9]` — `+1 415 555 2671` — is therefore
  reinterpreted if it arrives without its `+`. Callers that accept international
  input must send E.164.
- **Per-number budgets are a denial-of-service surface.** Anyone who knows a
  number can spend its send budget and, for one window, its guess budget. The
  alternative — no per-number limit — is what allows a 6-digit code to be ground
  down, so the trade is deliberate. Refusals are *not* recorded, so hammering
  does not extend another caller's window.
- **The send budget is charged for every provider call**, refused or not
  (`refundFailedSend: false`, the default). A refund is honest cost accounting,
  but it removes the only bound on how often a caller can make the kit talk to the
  provider: during an outage, or against a number the provider rejects, every
  failure would be refunded and the budget would never fill. A budget a *failure*
  resets is not a budget. Set it to `true` only alongside your own provider-attempt
  bound; both directions are tested.
- **There is no static resend countdown for a stepped budget.** `cooldownSeconds`
  is the rule's window when a scope has exactly one rule, and `0` otherwise,
  because `1/minute + 5/hour` has no statically knowable next-allowed time — the
  smallest average (60 s) would tell the user "send again now" while the hourly
  rule is binding. `0` means "unknown": the panel shows no timer and the first
  refusal supplies the real figure through `SEND_LIMITED.retryAfterMs`.
- **A resend is not guaranteed to invalidate a code the user already read.** The
  digest binds purpose and phone, not the challenge instance, so a code that
  happens to repeat (1 in 10^6 for six digits) digests identically. It is not a
  replay — the superseded challenge is deleted, so only the live one can be
  consumed — but a deployment that needs "the code always changes" has to bind a
  per-challenge nonce, which also costs an extra store lookup before verification.
  Documented in `src/otp/store.ts` and `src/otp/crypto.ts`.
- **No production adapters ship.** The store, limiter and transport used in
  production are the integrator's, so the kit's guarantees hold only as far as
  those adapters honour the contracts above.
- **The in-memory implementations serialise one process.** They exist to make the
  atomicity contract testable, not to be deployed.
- **The kit says nothing about accounts.** It cannot tell you whether a number is
  already registered, and it deliberately does not try.
