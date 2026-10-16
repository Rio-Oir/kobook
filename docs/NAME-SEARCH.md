# Name search: `kobook`

**Queries performed 2026-10-16.** This is a record of what was checked and what
came back, so the name decision has dated evidence attached to it.

## What this is not

It is **not trademark clearance**, not a freedom-to-operate opinion, not a
domain-availability guarantee, and not a legal conclusion of any kind. No
claim is made here that the name is available, registrable, unique, or safe to
use — in any jurisdiction, for any class of goods or services. Only qualified
counsel can answer those questions, and no counsel has been involved.

A package endpoint returning HTTP 404 does not reserve a name or establish that registration is permitted.

## Findings

1. **The name is in active use by unrelated parties.**
   - `kobook.com` — registered since **2000-01-12** (expires 2028-01-12) and
     serving a live site: a Korean science-book and teaching-aid **publisher**.
     A commercial brand using the identical name, in the book trade.
   - `kobook.app` — registered **2026-09-07** (expires 2027-09-07), serving a
     business operations product under the same name.
   Both checked domains are held by others; one is used in the book trade.
2. **USPTO: a narrow search found no matching mark.** Searching the official
   USPTO trademark interface with the **Wordmark** field set to `kobook`, Live
   and Dead statuses, default classes, returned **"No results found"**
   (Live 0, Dead 0). This is a real result, but narrow: the entered Wordmark query, United
   States only — **not** a similar-sound/phonetic search, not class-specific,
   not a common-law, state or business-name search.
3. **No exact `kobook` title appeared in the observed US/CN App Store search responses**, but the name
   sits close to established reading brands there — the nearest matches are
   `KyBook 2/3` (ebook readers) and `Kobo Books & Audiobooks`. These nearby results are recorded for follow-up; this search does not establish consumer confusion or trademark similarity.
4. **GitHub has existing uses; package endpoints returned 404.** On GitHub
   the account `kobook` exists and a repository-name search returns 17 matching
   repositories, several in book or reading software; the authenticated result includes this private repository. Repository names confer no trademark rights by themselves. For the package registries:
   npm `kobook` and PyPI `kobook` both return HTTP 404, and a
   keyword search finds no package of that name.
5. **Most trademark registers were not searched at all.** That is the main gap
   in this record — see "Limits" below.

**Summary for the decision:** the single US Wordmark query returned zero results; the name
is nonetheless not unique, and two domains plus the principal code-host handle
are held by others. Whether that is acceptable depends on jurisdiction, class
and intended use.

## What was queried, and what came back

| Source | Query | Result |
| --- | --- | --- |
| npm registry | `https://registry.npmjs.org/kobook` | HTTP 404; availability not established |
| npm registry | keyword search `/-/v1/search?text=kobook` | 0 packages |
| PyPI | `https://pypi.org/pypi/kobook/json` (and `KoBook`, `/simple/kobook/`) | HTTP 404 |
| GitHub | repository and user search for `kobook` | the handle is taken; 17 repositories match |
| Apple App Store | official search API, `term=kobook`, US and CN storefronts | no exact title in the observed responses; fuzzy matches returned |
| Domain registries | authoritative RDAP per TLD | see the table below |
| USPTO | Wordmark `kobook`, Live + Dead | No results found (Live 0, Dead 0) |
| Web search | `"kobook" reader app software` | dominated by Kobo / KOReader |

### Domains

| Domain | Status |
| --- | --- |
| `kobook.com` | **registered** (2000-01-12 → 2028-01-12) |
| `kobook.app` | **registered** (2026-09-07 → 2027-09-07) |
| `kobook.net`, `kobook.org`, `kobook.dev`, `kobook.xyz`, `kobook.ai`, `kobook.cc`, `kobook.site`, `kobook.online` | RDAP returned no matching record at the time checked; registration availability unverified |
| `kobook.io`, `kobook.co`, `kobook.me` | **undetermined** — no RDAP service published for these TLDs |

Registrant detail is deliberately not reproduced here; status and dates are what
matter for a name decision. "Not registered" is a snapshot, not a guarantee,
and says nothing about registrability.

DNS was not used as evidence: on the machine the checks ran from, every name
queried resolved to the same link-local address, registered or not, so a DNS
answer there carried no information either way.

## Limits, stated plainly

- **Trademark registers not searched:** EUIPO (EU), WIPO Global Brand Database,
  TMview, CNIPA (China), the Korean register, and every other national register.
  This matters more than usual here, because the `.com` holder is a Korean
  company — the Korean register in particular would be worth querying.
- **The US result is narrow:** Wordmark query `kobook` only, default classes. No
  similar-sound, class-specific, common-law, state or business-name search.
- **App stores:** US and CN search responses were inspected. Google Play, F-Droid,
  Samsung, Huawei and Amazon were not checked, and an app-store search is not
  a trademark search in any case.
- **Domain checks cover the TLDs listed above** and nothing else — no country
  code domains beyond those, and no handle checks on social platforms.
- **No typosquat or confusable-name sweep** beyond literal matches: names like
  `koobook`, `kobok` or non-Latin renderings were not searched.
- **One day, one environment.** Registries, domains and app stores change
  continuously; every result here is a snapshot of 2026-10-16.

## If you want to rely on this name

Do the registry search that has not been done: the relevant jurisdictions, the
relevant classes, and similar-sound marks as well as exact ones — or instruct
counsel to. Absent that, treat clearance as outstanding, as `README.md` and
`NOTICE.md` both state.

Official entry points: [USPTO](https://tmsearch.uspto.gov/), [WIPO](https://branddb.wipo.int/), [TMview](https://www.tmdn.org/tmview/), [CNIPA](https://sbj.cnipa.gov.cn/sbj/sbcx/). WIPO presented CAPTCHA/blocked access, TMview timed out, CNIPA returned 403; these were entry checks, not completed name searches.
