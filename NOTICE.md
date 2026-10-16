# Notices

kobook's own source and documentation are offered under MPL-2.0; see `LICENSE`.
Third-party dependencies retain their respective licenses and notices. See
`THIRD_PARTY_NOTICES.md` for the full inventory and the verbatim files under
`licenses/`.

## Licenses the packages do not ship themselves

Some published packages contain no license text: their tarball holds only code,
`package.json` and a README. `licenses/supplemental/` records one of three
dispositions for each such package, with the evidence:

* **`upstream-text`** — a text the project publishes, stored here with the URL
  it came from, the revision, and the byte count and SHA-256 of exactly what was
  retrieved. This covers both a license file committed in the project's own
  repository at the release revision, and a license endpoint the package's own
  README links to. Where a text is rendered by a service rather than committed,
  the entry says so, pins the service's configuration, and states that the
  notice's year is a retrieval snapshot rather than a publication date.
* **`project-text-covers-package`** — a platform-specific package built from the
  same revision of the same project as its core package, whose text is already
  vendored under `licenses/`. The evidence is the matching `gitHead` plus a
  byte-for-byte comparison, and `npm run notices` recomputes the SHA-256 and byte
  length of the covering text against the recorded upstream values on every run.
* **`declared-only`** — a license is declared and no text was *retrieved*. The
  entry lists exactly which places were checked — the tarball, the repository at
  the published revision, the default branch, and any link the package documents
  — and says which of them yielded nothing. **Nothing is vendored for these.**
  That is deliberate: writing a copyright notice the publisher did not issue
  would be fabrication, and a failed retrieval is a fact about the search, not
  proof that no text exists. They are reported as open gaps.

A declared SPDX identifier alone does not supply missing copyright or license
text. **`npm run notices` succeeding means every lockfile entry has a
disposition — it does not mean every license text is present.** The two
`declared-only` entries are real licensing gaps: resolve them, or accept them
knowingly, before distributing.

## Platform-specific packages that are not installed here

The inventory also covers every platform-specific optional dependency named in
`package-lock.json`, including those not installed on the machine it was
generated on. "Not installed here" is not "not distributed": an install on a
matching platform pulls in exactly the version and integrity pinned in the
lockfile. The set is a snapshot of one machine's platform, and each record is
pinned by its exact `node_modules/...` path, version, integrity, and target OS
and CPU, so the inventory fails rather than drifting if any of that changes.
Declared licenses come from the official registry's per-version documents and
are attributed by project, since a platform package is licensed by its project
rather than per platform.

## Identifiers and the name

Existing `gloss-*` and `local-free:v1` data identifiers are retained for
compatibility: they are on users' machines and are not the product brand.

The `kobook` name has **not** undergone trademark or domain clearance, and a
dated search found it already in use by unrelated parties, including the
registrants of `.com` and `.app`. MPL-2.0 grants no trademark rights. The
queries, responses and limits are in `docs/NAME-SEARCH.md`; provenance
observations and their limits are in `README.md`.
