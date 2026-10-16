// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Third-party notice inventory.
 *
 * Walks the *installed* dependency tree — every package entry in
 * `package-lock.json`, not just the ones named in `package.json` — and:
 *
 *   1. copies each package's own LICENSE / NOTICE / COPYING file, verbatim,
 *      into `licenses/`,
 *   2. applies the hand-maintained supplement in `licenses/supplemental/` to
 *      packages whose own tarball ships no text, and
 *   3. writes `THIRD_PARTY_NOTICES.md`, the human-readable inventory that
 *      names every package, its version, its dependency class, the license it
 *      declares, and where its text was copied from.
 *
 * Why the whole tree rather than the direct dependencies: attribution
 * obligations attach to what is actually distributed, and a transitive
 * dependency's license is not covered by its parent's. Why the text is copied
 * rather than merely named: several of the licenses in this tree (MIT, BSD,
 * ISC, Apache-2.0) require the copyright notice and the license text to
 * travel with the distribution.
 *
 * ## The supplement, and why it exists
 *
 * Some published packages contain no license text at all — their tarball has
 * only code, `package.json` and a README. For those, `licenses/supplemental/`
 * records one of three dispositions, with the evidence for each:
 *
 *   - `upstream-text` — the project publishes a text; it is stored in that
 *     directory with the API URL, revision and SHA-256 it was fetched from.
 *   - `project-text-covers-package` — a platform-specific package is built
 *     from the same revision of the same project as its core package, whose
 *     text is already vendored. The recorded evidence is the matching
 *     `gitHead` plus a byte-for-byte comparison.
 *   - `declared-only` — a license is declared, but text was not retrieved
 *     from the package, repository and linked locations checked. These remain
 *     gaps; the search does not prove that no notice was ever published.
 *
 * The supplement is **verified on every run**: each recorded SHA-256 is
 * recomputed, each `project-text-covers-package` target must exist, and every
 * package in `optional-dependencies.json` must still match `package-lock.json`
 * on version *and* integrity. Any drift fails the run instead of silently
 * producing a notices file that no longer describes this tree.
 *
 * `licenses/supplemental/` is source-controlled and is never deleted by a
 * regeneration; only the generated files beside it are.
 *
 * Usage, from the repository root (after `npm ci`):
 *   node scripts/third-party-notices.mjs
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { root } from "./process.mjs";

const LOCK = path.join(root, "package-lock.json");
const PACKAGE = path.join(root, "package.json");
const OUT_DIR = path.join(root, "licenses");
const SUPPLEMENT_DIR = path.join(OUT_DIR, "supplemental");
const SUPPLEMENT_SOURCES = path.join(SUPPLEMENT_DIR, "SOURCES.json");
const SUPPLEMENT_OPTIONAL = path.join(SUPPLEMENT_DIR, "optional-dependencies.json");
const NOTICES = path.join(root, "THIRD_PARTY_NOTICES.md");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

/** Matches the filenames projects actually use for license/notice text. */
const NOTICE_FILE = /^(licen[cs]e|notice|copying|unlicense)([-._].*)?$/i;

const licenseJson = JSON.parse(await readFile(LOCK, "utf8"));
const packageJson = JSON.parse(await readFile(PACKAGE, "utf8"));

const runtimeNames = new Set(Object.keys(packageJson.dependencies ?? {}));
const devNames = new Set(Object.keys(packageJson.devDependencies ?? {}));

/** Every package the lockfile names, installed or not. */
const locked = [];
for (const [key, entry] of Object.entries(licenseJson.packages ?? {})) {
  if (!key.startsWith("node_modules/")) continue;
  const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  locked.push({ key, name, version: entry.version, integrity: entry.integrity ?? null });
}
const lockedByKey = new Map(locked.map((p) => [`${p.name}@${p.version}`, p]));
/** The same entries keyed by their exact `node_modules/...` path. */
const lockedByPath = new Map(locked.map((p) => [p.key, p]));

const installed = [...locked];
installed.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));

/**
 * Load and verify the supplement. Throws on anything inconsistent, because a
 * supplement that no longer matches the tree is worse than none: it would let
 * the notices claim coverage that does not hold.
 */
async function loadSupplement() {
  const sources = JSON.parse(await readFile(SUPPLEMENT_SOURCES, "utf8"));
  const coverage = new Map();
  const byDisposition = { "upstream-text": [], "project-text-covers-package": [], "declared-only": [] };
  /**
   * Hash/byte checks that can only run once generation has produced the target
   * — a `project-text-covers-package` entry is verified against the file the
   * generator copies out of the core package's tarball.
   */
  const deferredTextChecks = [];

  /**
   * Compare a text file against what the supplement records. Byte length and
   * SHA-256 are both checked: a hash without the length still catches content
   * drift, but the length is what a reader can confirm by hand, and stating a
   * length the file does not have is its own defect.
   */
  async function verifyText(file, expected, label) {
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      throw new Error(`${label}: ${path.relative(root, file)} does not exist`);
    }
    if (typeof expected.bytes === "number" && bytes.length !== expected.bytes) {
      throw new Error(`${label}: recorded ${expected.bytes} bytes, found ${bytes.length}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected.sha256) {
      throw new Error(`${label}: recorded sha256 ${expected.sha256}, found ${sha256}`);
    }
    return { bytes: bytes.length, sha256 };
  }

  for (const entry of sources.entries ?? []) {
    const disposition = entry.disposition;
    if (!(disposition in byDisposition)) throw new Error(`unknown supplement disposition: ${disposition}`);
    const label = `supplement entry for ${(entry.packages ?? []).map((p) => p.name).join(", ") || "(no packages)"}`;

    if (disposition === "upstream-text") {
      if (!entry.textFile) throw new Error(`${label}: upstream-text entry has no textFile`);
      await verifyText(path.join(SUPPLEMENT_DIR, entry.textFile), entry, label);
    }

    if (disposition === "project-text-covers-package") {
      if (!entry.coveredByText) throw new Error(`${label}: no coveredByText`);
      const expected = entry.upstream ?? {};
      if (!expected.sha256) throw new Error(`${label}: project-text entry records no upstream.sha256 to check against`);
      deferredTextChecks.push({
        file: path.join(root, entry.coveredByText),
        expected,
        label: `${label} (via ${entry.coveredByText})`,
      });
    }

    for (const pkg of entry.packages ?? []) {
      const id = `${pkg.name}@${pkg.version}`;
      if (!lockedByKey.has(id)) throw new Error(`supplement covers ${id}, which the lockfile does not name`);
      if (coverage.has(id)) throw new Error(`supplement covers ${id} twice`);
      coverage.set(id, entry);
      byDisposition[disposition].push(id);
    }
  }

  // ── The optional-dependency set ─────────────────────────────────────────
  //
  // Checked against the lockfile by *exact path*, not by name: the same
  // name@version can legitimately appear at more than one tree path (a nested
  // duplicate), and name matching is what let an earlier version of this file
  // attribute one tree's package to another tree's dependents. Missing,
  // duplicated and drifted records are all hard failures, because each of them
  // would leave the notices claiming coverage that does not hold.
  const optional = JSON.parse(await readFile(SUPPLEMENT_OPTIONAL, "utf8"));
  if (optional.schemaVersion !== 2) {
    throw new Error(`optional-dependencies.json schemaVersion ${optional.schemaVersion}: this generator expects 2`);
  }
  const optionalRecords = optional.packages ?? [];
  if (optional.reviewedCount !== optionalRecords.length) {
    throw new Error(`optional-dependencies.json claims ${optional.reviewedCount} records but holds ${optionalRecords.length}`);
  }
  const optionalByLockfileKey = new Map();
  const seenNameVersion = new Map();
  for (const record of optionalRecords) {
    if (!record.lockfileKey) throw new Error(`optional record ${record.name}@${record.version} has no lockfileKey`);
    const lockedEntry = lockedByPath.get(record.lockfileKey);
    if (!lockedEntry) {
      throw new Error(`optional record key ${record.lockfileKey} is not in the lockfile`);
    }
    if (lockedEntry.name !== record.name || lockedEntry.version !== record.version) {
      throw new Error(
        `optional record ${record.lockfileKey} says ${record.name}@${record.version} but the lockfile says ` +
          `${lockedEntry.name}@${lockedEntry.version}`,
      );
    }
    if (!record.integrity) throw new Error(`optional record ${record.lockfileKey} records no integrity`);
    if (record.integrity !== lockedEntry.integrity) {
      throw new Error(
        `integrity drift for ${record.lockfileKey}: lockfile ${lockedEntry.integrity}, supplement ${record.integrity}`,
      );
    }
    if (record.registryIntegrity && record.registryIntegrity !== record.integrity) {
      throw new Error(
        `registry/lockfile integrity disagree for ${record.lockfileKey}: ${record.registryIntegrity} vs ${record.integrity}`,
      );
    }
    if (!Array.isArray(record.requiredBy) || record.requiredBy.length === 0) {
      throw new Error(`optional record ${record.lockfileKey} names no dependent`);
    }
    if (optionalByLockfileKey.has(record.lockfileKey)) {
      throw new Error(`optional record ${record.lockfileKey} appears twice`);
    }
    const id = `${record.name}@${record.version}`;
    if (seenNameVersion.has(id)) {
      throw new Error(
        `optional records ${seenNameVersion.get(id)} and ${record.lockfileKey} are both ${id}; ` +
          `match on the lockfile key instead`,
      );
    }
    seenNameVersion.set(id, record.lockfileKey);
    optionalByLockfileKey.set(record.lockfileKey, record);
  }

  // Reconstruct the reviewed Windows/x64 platform set from the lock itself.
  // Removing a record and decrementing its count must not conceal a gap.
  const permits = (values, value) => !values?.length ||
    (!values.includes(`!${value}`) && (values.every((v) => v.startsWith("!")) || values.includes(value)));
  const expectedKeys = Object.entries(licenseJson.packages).filter(([key, entry]) =>
    key.startsWith("node_modules/") && entry.optional &&
    (!permits(entry.os, "win32") || !permits(entry.cpu, "x64"))).map(([key]) => key);
  if (expectedKeys.length !== optionalRecords.length || expectedKeys.some((key) => !optionalByLockfileKey.has(key))) {
    throw new Error("optional reviewed set does not match the lockfile Windows/x64 platform snapshot");
  }
  const normalized = (value) => JSON.stringify([...(value ?? [])].sort());
  for (const record of optionalRecords) {
    const entry = licenseJson.packages[record.lockfileKey];
    if (record.optional !== entry.optional || normalized(record.os) !== normalized(entry.os) || normalized(record.cpu) !== normalized(entry.cpu)) {
      throw new Error(`optional platform metadata drift for ${record.lockfileKey}`);
    }
    const expectedParents = [];
    for (const parent of locked) {
      const range = licenseJson.packages[parent.key].optionalDependencies?.[record.name];
      if (!range) continue;
      let directory = parent.key;
      let resolved;
      // Resolve from the dependent's location, as a Node installation does.
      for (;;) {
        const key = directory ? `${directory}/node_modules/${record.name}` : `node_modules/${record.name}`;
        if (lockedByPath.has(key)) { resolved = key; break; }
        if (!directory) break;
        const next = path.posix.dirname(directory);
        directory = next === "." ? "" : next;
      }
      if (resolved === record.lockfileKey) expectedParents.push({by: `${parent.name}@${parent.version}`, byLockfileKey: parent.key, kind: "optionalDependencies", range});
    }
    const canonical = (items) => JSON.stringify(items.map((item) => JSON.stringify([item.by, item.byLockfileKey, item.kind, item.range])).sort());
    if (canonical(record.requiredBy) !== canonical(expectedParents)) {
      throw new Error(`optional dependent metadata drift for ${record.lockfileKey}`);
    }
  }

  return { sources, optional, coverage, byDisposition, optionalByLockfileKey, deferredTextChecks, verifyText };
}

const supplement = await loadSupplement();
/** Exact lockfile path -> the supplement's registry record, if reviewed. */
const optionalByLockfileKey = supplement.optionalByLockfileKey;

async function noticeFilesIn(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const direct = entries
    .filter((e) => e.isFile() && NOTICE_FILE.test(e.name))
    .map((e) => e.name);
  // A few older packages keep their texts in a `licenses/` subdirectory.
  const fromSubdir = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^licen[cs]es$/i.test(entry.name)) continue;
    for (const inner of await readdir(path.join(dir, entry.name), { withFileTypes: true })) {
      if (inner.isFile()) fromSubdir.push(path.join(entry.name, inner.name));
    }
  }
  return [...direct.sort(), ...fromSubdir.sort()];
}

function safeName(value) {
  return value.replaceAll("/", "-").replaceAll("@", "");
}

// Clean only what this script generates. `licenses/supplemental/` is
// source-controlled input rather than output, so it survives regeneration.
await mkdir(OUT_DIR, { recursive: true });
for (const entry of await readdir(OUT_DIR, { withFileTypes: true })) {
  if (entry.name === "supplemental") continue;
  await rm(path.join(OUT_DIR, entry.name), { recursive: true, force: true });
}

const records = [];
const missing = [];
const declaredOnly = [];
const notInstalled = [];
/** Target filename -> the text's hash and every source path that produced it. */
const fileIndex = new Map();

for (const pkg of installed) {
  const dir = path.join(root, pkg.key);
  let meta;
  try {
    meta = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    // Present in the lockfile but not in `node_modules`: an optional
    // platform-specific package built for another OS. It is *not* evidence
    // that the package is undistributed — an install on the matching platform
    // pulls it in — so its declared license and its coverage are recorded
    // from the supplement rather than assumed.
    notInstalled.push({
      package: pkg.name,
      version: pkg.version,
      lockfileKey: pkg.key,
      resolvedIntegrity: pkg.integrity,
      declaredLicense: optionalByLockfileKey.get(pkg.key)?.declaredLicense ?? null,
      licenseEvidence: "registry per-version document (see licenses/supplemental/optional-dependencies.json)",
      repository: optionalByLockfileKey.get(pkg.key)?.repository ?? null,
      gitHead: optionalByLockfileKey.get(pkg.key)?.gitHead ?? null,
      os: optionalByLockfileKey.get(pkg.key)?.os ?? [],
      cpu: optionalByLockfileKey.get(pkg.key)?.cpu ?? [],
      requiredBy: (optionalByLockfileKey.get(pkg.key)?.requiredBy ?? []).map((r) => `${r.by} (${r.kind}, ${r.range})`),
      reviewed: optionalByLockfileKey.has(pkg.key),
      coverage: supplement.coverage.get(`${pkg.name}@${pkg.version}`)?.disposition ?? null,
      coveredBy: supplement.coverage.get(`${pkg.name}@${pkg.version}`)?.coveredByText ?? null,
      coveredByText: supplement.coverage.get(`${pkg.name}@${pkg.version}`)?.textFile
        ? `licenses/supplemental/${supplement.coverage.get(`${pkg.name}@${pkg.version}`).textFile}`
        : null,
    });
    continue;
  }

  const declared =
    typeof meta.license === "string"
      ? meta.license
      : (meta.license?.type ?? (Array.isArray(meta.licenses) ? meta.licenses.map((l) => l.type).join(" OR ") : null));

  const files = await noticeFilesIn(dir);
  const copied = [];
  for (const file of files) {
    const target = `${safeName(pkg.name)}-${pkg.version}-${file.replaceAll(path.sep, "-").replaceAll("/", "-")}`;
    const source = `${pkg.key}/${file}`;
    const existing = fileIndex.get(target);
    if (existing) {
      const sourceHash = createHash("sha256").update(await readFile(path.join(dir, file))).digest("hex");
      if (sourceHash !== existing.sha256) {
        throw new Error(`different notice bytes collide at ${target}`);
      }
      // The same package at the same version is installed at more than one
      // path when npm cannot hoist it (a nested copy under two different
      // dependents). Its license text is the same bytes, so the file is
      // written once and every source path is recorded as an alias — which is
      // what keeps the manifest's file count equal to what is on disk.
      existing.sources.push(source);
      copied.push({ file: target, source, sha256: existing.sha256 });
      continue;
    }
    await copyFile(path.join(dir, file), path.join(OUT_DIR, target));
    const bytes = await readFile(path.join(OUT_DIR, target));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    fileIndex.set(target, { sha256, sources: [source] });
    copied.push({ file: target, source, sha256 });
  }

  let scope = "transitive";
  if (runtimeNames.has(pkg.name)) scope = "runtime";
  else if (devNames.has(pkg.name)) scope = "development";

  const coverage = supplement.coverage.get(`${pkg.name}@${pkg.version}`) ?? null;

  const record = {
    package: pkg.name,
    version: pkg.version,
    scope,
    declaredLicense: declared,
    resolvedIntegrity: pkg.integrity,
    notices: copied,
    ...(coverage
      ? {
          coverage: {
            disposition: coverage.disposition,
            declaredLicense: coverage.declaredLicense ?? declared,
            text: coverage.textFile
              ? `licenses/supplemental/${coverage.textFile}`
              : (coverage.coveredByText ?? null),
            upstream: coverage.upstream ?? null,
          },
        }
      : {}),
  };
  records.push(record);
  if (copied.length === 0 && coverage === null) missing.push(record);
  if (coverage?.disposition === "declared-only") declaredOnly.push(record);
}

// `project-text-covers-package` entries point at a text this script has just
// copied out of a core package's tarball, so they can only be checked now that
// generation has run. The check is the recorded upstream SHA-256 *and* byte
// length — not existence. A text that exists but is not the bytes upstream
// publishes is not coverage, and saying so in the document while only testing
// for existence would be the kind of claim that looks like verification and is
// not.
for (const check of supplement.deferredTextChecks) {
  await supplement.verifyText(check.file, check.expected, check.label);
}

await writeFile(
  MANIFEST,
  `${JSON.stringify(
    {
      generatedFrom: "package-lock.json (installed tree) via scripts/third-party-notices.mjs",
      lockfilePackageCount: installed.length,
      installedPackageCount: records.length,
      countsByScope: records.reduce((acc, r) => ({ ...acc, [r.scope]: (acc[r.scope] ?? 0) + 1 }), {}),
      packagesWithoutNoticeFile: missing.length,
      packagesCoveredBySupplement: supplement.coverage.size,
      countsBySupplementDisposition: Object.fromEntries(
        Object.entries(supplement.byDisposition).map(([k, v]) => [k, v.length]),
      ),
      packagesNotInstalledOnThisPlatform: notInstalled.length,
      noticeFileCount: fileIndex.size,
      noticeFiles: Object.fromEntries(
        [...fileIndex.entries()].map(([file, info]) => [file, { sha256: info.sha256, sources: info.sources }]),
      ),
      supplement: {
        source: "licenses/supplemental/SOURCES.json",
        entries: (supplement.sources.entries ?? []).map((entry) => ({
          disposition: entry.disposition,
          packages: entry.packages,
          declaredLicense: entry.declaredLicense ?? null,
          text: entry.textFile ? `licenses/supplemental/${entry.textFile}` : (entry.coveredByText ?? null),
          sha256: entry.sha256 ?? null,
          upstream: entry.upstream ?? null,
          evidence: entry.evidence ?? [],
        })),
      },
      optionalDependencyLicenses: {
        source: "licenses/supplemental/optional-dependencies.json",
        packages: supplement.optional.packages ?? [],
      },
      packages: records,
      notInstalledOnThisPlatform: notInstalled,
    },
    null,
    2,
  )}\n`,
);

// Self-check: the manifest claims a file count, so it should be the count on
// disk. A mismatch means two packages' notices collided on the same target
// name and one silently replaced the other. `supplemental/` is input, not
// generated output, and is not counted here.
const written = (await readdir(OUT_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== "manifest.json")
  .map((entry) => entry.name);
if (written.length !== fileIndex.size) {
  throw new Error(
    `notice directory holds ${written.length} files but ${fileIndex.size} were recorded — ` +
      `two packages collided on one target name`,
  );
}

const byScope = (scope) => records.filter((r) => r.scope === scope).sort((a, b) => a.package.localeCompare(b.package));

/** The "License text" cell for an installed package. */
function textCell(record) {
  if (record.notices.length > 0) {
    return record.notices.map((n) => `[\`${n.file}\`](licenses/${n.file})`).join("<br>");
  }
  if (record.coverage?.disposition === "upstream-text") {
    const file = path.basename(record.coverage.text);
    const linked = record.coverage.upstream?.kind === "linked-license-endpoint";
    return `[\`${file}\`](licenses/supplemental/${file}) <br>*(upstream ${linked ? "linked " : ""}text)*`;
  }
  if (record.coverage?.disposition === "project-text-covers-package") {
    return `\`${path.basename(record.coverage.text)}\` <br>*(same project revision)*`;
  }
  if (record.coverage?.disposition === "declared-only") return "**no text retrieved — see below**";
  return "**none in package — see below**";
}

const lines = [
  "# Third-party notices",
  "",
  "This file lists every package `package-lock.json` names — the direct",
  "dependencies and everything they pull in — together with the license each",
  "one declares and where its text is.",
  "",
  "Texts shipped by their own package are in `licenses/`, copied verbatim, with",
  "their SHA-256 recorded in `licenses/manifest.json`. Several of the licenses",
  "here (MIT, ISC, BSD, Apache-2.0) require the copyright notice and the license",
  "text to travel with a distribution, which is what this directory is for.",
  "",
  "Some packages ship no text of their own. Those are handled by the supplement",
  "in `licenses/supplemental/`, which records one of three dispositions with its",
  "evidence: the project's text at a pinned revision (either a file in the",
  "project's repository or the license endpoint its own README links to),",
  "coverage by the text of the project a platform package is built from, or a",
  "declaration for which no text was retrieved. The last case is an open gap and",
  "is reported as one below — no copyright notice has been invented for it.",
  "",
  "**Reading the gaps.** This inventory enumerates the dependency tree and",
  "records where each license text is. It is not a statement that every",
  "obligation is discharged: the gaps are listed by name at the end, and",
  "\"every entry accounted for\" is not the same as \"every license present\".",
  "",
  "**Scope.** `runtime` means the package is a direct dependency and can be part",
  "of a deployed build. `development` means it is a devDependency and is not",
  "shipped. `transitive` means it was pulled in by another dependency; it may be",
  "in either part of the graph.",
  "",
  "**This inventory covers npm dependencies only.** It says nothing about this",
  "repository's own source, which is licensed separately under MPL-2.0 — see",
  "`LICENSE`. Nothing in `licenses/` carries an SPDX header from this project:",
  "those are other people's documents, reproduced as published.",
  "",
  `Generated by \`npm run notices\`. ${records.length} packages installed where the`,
  `inventory was generated: ${byScope("runtime").length} runtime, ` +
    `${byScope("development").length} development, ${byScope("transitive").length} transitive. ` +
    `${notInstalled.length} further platform-specific entries are in the lockfile`,
  "but were not installed on that machine — they are listed below, because",
  "\"not installed here\" is not the same as \"not distributed\".",
  "",
];

for (const [scope, heading] of [
  ["runtime", "Runtime dependencies (direct)"],
  ["development", "Development dependencies (direct)"],
  ["transitive", "Transitive dependencies"],
]) {
  const rows = byScope(scope);
  if (rows.length === 0) continue;
  lines.push(`## ${heading}`, "", "| Package | Version | Declared license | License text |", "| --- | --- | --- | --- |");
  for (const record of rows) {
    lines.push(`| \`${record.package}\` | ${record.version} | ${record.declaredLicense ?? "_not declared_"} | ${textCell(record)} |`);
  }
  lines.push("");
}

// ── Supplement provenance ──────────────────────────────────────────────────
lines.push(
  "## Licenses not shipped by the package itself",
  "",
  "Each entry below covers packages whose own npm tarball contains no license",
  "file. The disposition and its evidence come from `licenses/supplemental/`.",
  "`npm run notices` re-verifies, on every run: the byte length and SHA-256 of",
  "each stored text; the byte length and SHA-256 of each project text against the",
  "`upstream.sha256` the entry records; and every optional-dependency record",
  "against `package-lock.json`. Any drift fails the run rather than being",
  "reported as coverage.",
  "",
);

const DISPOSITION_HEADING = {
  "upstream-text": "Text obtained upstream",
  "project-text-covers-package": "Covered by the text of the project it is built from",
  "declared-only": "Declared, with no text retrieved (an open gap)",
};
for (const entry of supplement.sources.entries ?? []) {
  const packages = (entry.packages ?? []).map((p) => `\`${p.name}@${p.version}\``);
  // A discriminator keeps repeated dispositions distinguishable in the table of
  // contents: several projects are each "covered by the text of the project".
  const discriminator = entry.coveredByPackage ?? (entry.packages ?? [])[0]?.name ?? "";
  lines.push(`### ${DISPOSITION_HEADING[entry.disposition]}${discriminator ? ` — ${discriminator}` : ""}`, "");
  lines.push(`Covers ${packages.length} package${packages.length === 1 ? "" : "s"}: ${packages.join(", ")}.`, "");
  lines.push(`Declared license: \`${entry.declaredLicense ?? "unknown"}\`.`, "");
  if (entry.textFile) {
    lines.push(
      `Text: [\`${entry.textFile}\`](licenses/supplemental/${entry.textFile}) — ` +
        `${entry.bytes ? `${entry.bytes} bytes, ` : ""}SHA-256 \`${entry.sha256}\`.`,
      "",
    );
  } else if (entry.coveredByText) {
    lines.push(
      `Text: \`${entry.coveredByText}\` — already in \`licenses/\`, verified against the recorded upstream ` +
        `SHA-256 \`${entry.upstream?.sha256}\`${entry.upstream?.bytes ? ` and ${entry.upstream.bytes} bytes` : ""}.`,
      "",
    );
  }
  if (entry.upstream) {
    const upstream = entry.upstream;
    if (upstream.kind === "linked-license-endpoint") {
      lines.push(
        `Source: \`${upstream.url}\` (HTTP ${upstream.httpStatus} ${upstream.contentType}, retrieved ` +
          `${upstream.retrievedAt}) — the license endpoint linked from ` +
          `\`${upstream.linkedFrom?.file}\` in \`${upstream.linkedFrom?.repository}\` at ` +
          `\`${upstream.linkedFrom?.revision}\`.`,
        "",
      );
      if (upstream.serviceConfig) {
        lines.push(
          `That endpoint renders from a pinned per-author config — \`${upstream.serviceConfig.repository}\` at ` +
            `\`${upstream.serviceConfig.revision}\`, path \`${upstream.serviceConfig.path}\` ` +
            `(blob \`${upstream.serviceConfig.blobSha}\`) — which names the copyright holder. The year in the ` +
            `rendered notice is produced when it is requested, so the copy here is a retrieval snapshot, ` +
            `not a publication date of the package.`,
          "",
        );
      }
    } else {
      lines.push(
        `Source: \`${upstream.repository}\` at \`${upstream.revision}\`, path \`${upstream.path}\` ` +
          `(retrieved ${upstream.retrievedAt}).`,
        "",
      );
    }
  }
  for (const note of entry.evidence ?? []) lines.push(`- ${note}`);
  lines.push("");
}

// ── Platform-specific optional dependencies ────────────────────────────────
if (notInstalled.length > 0) {
  const projects = new Map();
  for (const record of notInstalled) {
    const key = `${record.repository ?? "unknown"}@${record.gitHead ?? "unknown"}`;
    if (!projects.has(key)) projects.set(key, { repository: record.repository, gitHead: record.gitHead, members: [] });
    projects.get(key).members.push(record);
  }

  lines.push(
    "## Platform-specific optional dependencies (not installed here)",
    "",
    "These are optional dependencies of packages in this tree, built for a",
    "platform the inventory was not generated on: a native binary for Linux, macOS",
    "or another architecture. They are in `package-lock.json`, so an `npm ci` on a",
    "matching platform installs exactly the version and integrity pinned here.",
    "They are **not** part of the built artifact — the tools that use them (esbuild,",
    "Rollup, and Rollup's optional compressor) run at build time and are not",
    "shipped.",
    "",
    `**Which entries.** The list is the set that was absent from \`node_modules\` on ` +
      `\`${supplement.optional.platformSnapshot?.platform ?? "one platform"}\`, which is a snapshot of one machine, ` +
      "not a property of the dependency graph: an install elsewhere pulls in the",
    "entries matching its own OS and CPU and skips the rest. Each record is pinned",
    "by its exact `node_modules/...` path, its version, its integrity, and the OS",
    "and CPU it targets; `npm run notices` fails if any of that drifts from",
    "`package-lock.json`, or if a record is missing or duplicated.",
    "",
    "Each package's declared license comes from the official registry's per-version",
    "document, recorded in `licenses/supplemental/optional-dependencies.json` with",
    "the revision its version was built from and the dependents whose declared",
    "range accepts it. Read together, they resolve to a handful of projects, which",
    "is what the coverage by project below reflects: a platform package is",
    "licensed by its project, not per platform.",
    "",
  );
  for (const project of projects.values()) {
    const licenses = [...new Set(project.members.map((m) => m.declaredLicense ?? "unknown"))].join(", ");
    lines.push(
      `- \`${project.repository ?? "unknown repository"}\` at \`${(project.gitHead ?? "unknown").slice(0, 12)}…\` — ` +
        `${project.members.length} package(s), declared ${licenses}`,
    );
  }
  lines.push("");

  lines.push(
    "| Package | Version | OS / CPU | Required by | Declared license | Coverage |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const record of notInstalled) {
    const requiredBy = (record.requiredBy ?? []).join("<br>") || "_not stated_";
    const platform = `${(record.os ?? []).join(" ") || "any"} / ${(record.cpu ?? []).join(" ") || "any"}`;
    const coverage = record.coverage
      ? record.coverage === "declared-only"
        ? "**no text retrieved — see above**"
        : `via \`${path.basename(record.coveredByText ?? record.coveredBy ?? "supplement")}\``
      : "_none recorded_";
    lines.push(
      `| \`${record.package}\` | ${record.version} | ${platform} | ${requiredBy} | ` +
        `${record.declaredLicense ?? "_not declared_"} | ${coverage} |`,
    );
  }
  lines.push("");
}

if (missing.length > 0) {
  lines.push(
    "## Packages with no license text and no recorded disposition",
    "",
    "These are installed, declare a license, ship no LICENSE/NOTICE/COPYING file,",
    "and are not covered by `licenses/supplemental/`. That is an unaccounted gap:",
    "add an entry to the supplement recording where the text is, or that none was",
    "retrieved. Until then the inventory does not say what applies to them.",
    "",
  );
  for (const record of missing) {
    lines.push(`- \`${record.package}@${record.version}\` — ${record.declaredLicense ?? "_not declared_"}`);
  }
  lines.push("");
}

await writeFile(NOTICES, `${lines.join("\n").trimEnd()}\n`);

// The count below is a statement about *bookkeeping*: every package the
// lockfile names has an entry and a disposition. It is deliberately not worded
// as "licenses complete", because it is not one — the `declared-only` entries
// have no text, and that is a licensing gap however tidy the inventory is.
console.log(
  `Inventoried ${records.length} installed packages ` +
    `(${byScope("runtime").length} runtime, ${byScope("development").length} development, ` +
    `${byScope("transitive").length} transitive); ` +
    `${fileIndex.size} notice files in licenses/; ` +
    `${supplement.coverage.size} packages covered by the supplement ` +
    `(${supplement.byDisposition["upstream-text"].length} upstream text, ` +
    `${supplement.byDisposition["project-text-covers-package"].length} project text, ` +
    `${supplement.byDisposition["declared-only"].length} declared-only); ` +
    `${missing.length} packages with no disposition at all; ` +
    `${notInstalled.length} lockfile entries not installed here.`,
);
if (missing.length > 0) {
  console.log("No disposition recorded:", missing.map((r) => `${r.package}@${r.version}`).join(", "));
}
const openGaps = [
  ...declaredOnly.map((r) => `${r.package}@${r.version}`),
  ...(supplement.sources.entries ?? [])
    .filter((e) => e.disposition === "declared-only")
    .flatMap((e) => (e.packages ?? []).map((p) => `${p.name}@${p.version}`))
    .filter((id) => !declaredOnly.some((r) => `${r.package}@${r.version}` === id)),
];
if (openGaps.length > 0) {
  console.log(`OPEN LICENSE GAPS (declared, no text retrieved): ${openGaps.join(", ")}`);
}
