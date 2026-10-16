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
 *      into `licenses/`, and
 *   2. writes `THIRD_PARTY_NOTICES.md`, the human-readable inventory that
 *      names every package, its version, whether it is a runtime or a
 *      development dependency, the license it declares, and where its text
 *      was copied from.
 *
 * Why the whole tree rather than the direct dependencies: attribution
 * obligations attach to what is actually distributed, and a transitive
 * dependency's license is not covered by its parent's. Why the text is copied
 * rather than merely named: several of the licenses in this tree (MIT, BSD,
 * ISC, Apache-2.0) require the copyright notice and the license text to
 * travel with the distribution.
 *
 * The source of every file is recorded — package name, version, the file it
 * came from, and the tarball integrity `package-lock.json` pins it to — so an
 * auditor can check the text against the artifact rather than trusting this
 * directory.
 *
 * A package with no license file at all is reported rather than skipped: it
 * is exactly the case an audit needs to see.
 *
 * Usage, from the repository root (after `npm ci`):
 *   node scripts/third-party-notices.mjs
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { root } from "./process.mjs";

const LOCK = path.join(root, "package-lock.json");
const PACKAGE = path.join(root, "package.json");
const OUT_DIR = path.join(root, "licenses");
const NOTICES = path.join(root, "THIRD_PARTY_NOTICES.md");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

/** Matches the filenames projects actually use for license/notice text. */
const NOTICE_FILE = /^(licen[cs]e|notice|copying|unlicense)([-._].*)?$/i;

const licenseJson = JSON.parse(await readFile(LOCK, "utf8"));
const packageJson = JSON.parse(await readFile(PACKAGE, "utf8"));

const runtimeNames = new Set(Object.keys(packageJson.dependencies ?? {}));
const devNames = new Set(Object.keys(packageJson.devDependencies ?? {}));

/** Every installed package, keyed by its `node_modules/...` path. */
const installed = [];
for (const [key, entry] of Object.entries(licenseJson.packages ?? {})) {
  if (!key.startsWith("node_modules/")) continue;
  const name = entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  installed.push({ key, name, version: entry.version, integrity: entry.integrity ?? null });
}
installed.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));

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

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const records = [];
const missing = [];
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
    // platform-specific package for another OS, or a partial install. It is
    // not part of what this machine distributes, so it gets no notice entry —
    // but it is recorded, because "the lockfile names it" is a fact an
    // auditor should see rather than have silently dropped.
    notInstalled.push({ package: pkg.name, version: pkg.version, lockfileKey: pkg.key, resolvedIntegrity: pkg.integrity });
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

  const record = {
    package: pkg.name,
    version: pkg.version,
    scope,
    declaredLicense: declared,
    resolvedIntegrity: pkg.integrity,
    notices: copied,
  };
  records.push(record);
  if (copied.length === 0) missing.push(record);
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
      packagesNotInstalledOnThisPlatform: notInstalled.length,
      noticeFileCount: fileIndex.size,
      noticeFiles: Object.fromEntries(
        [...fileIndex.entries()].map(([file, info]) => [file, { sha256: info.sha256, sources: info.sources }]),
      ),
      packages: records,
      notInstalledOnThisPlatform: notInstalled,
    },
    null,
    2,
  )}\n`,
);

// Self-check: the manifest claims a file count, so it should be the count on
// disk. A mismatch means two packages' notices collided on the same target
// name and one silently replaced the other.
const written = (await readdir(OUT_DIR)).filter((f) => f !== "manifest.json");
if (written.length !== fileIndex.size) {
  throw new Error(
    `notice directory holds ${written.length} files but ${fileIndex.size} were recorded — ` +
      `two packages collided on one target name`,
  );
}

const byScope = (scope) => records.filter((r) => r.scope === scope).sort((a, b) => a.package.localeCompare(b.package));

const lines = [
  "# Third-party notices",
  "",
  "This file lists every npm package installed from `package-lock.json` — the",
  "direct dependencies and everything they pull in — together with the license",
  "each one declares and where its own license text was copied to.",
  "",
  "The texts are in `licenses/`, copied verbatim from the installed package with",
  "their SHA-256 recorded in `licenses/manifest.json`. Several of the licenses",
  "here (MIT, ISC, BSD, Apache-2.0) require the copyright notice and the license",
  "text to travel with a distribution, which is what this directory is for.",
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
  `Generated by \`npm run notices\`. ${records.length} installed packages: ` +
    `${byScope("runtime").length} runtime, ${byScope("development").length} development, ` +
    `${byScope("transitive").length} transitive. ` +
    `${notInstalled.length} further platform-specific lockfile entries are not installed on this machine ` +
    `(listed in \`licenses/manifest.json\`).`,
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
    const text =
      record.notices.length > 0
        ? record.notices.map((n) => `[\`${n.file}\`](licenses/${n.file})`).join("<br>")
        : "**none found in package**";
    lines.push(`| \`${record.package}\` | ${record.version} | ${record.declaredLicense ?? "_not declared_"} | ${text} |`);
  }
  lines.push("");
}

if (missing.length > 0) {
  lines.push(
    "## Packages with no license text in their tarball",
    "",
    "These declared a license but shipped no LICENSE/NOTICE/COPYING file. Their",
    "declared license identifier and pinned integrity are in",
    "`licenses/manifest.json`; the text is not vendored here because the package",
    "does not contain it.",
    "",
  );
  for (const record of missing) {
    lines.push(`- \`${record.package}@${record.version}\` — ${record.declaredLicense ?? "_not declared_"}`);
  }
  lines.push("");
}

await writeFile(NOTICES, `${lines.join("\n").trimEnd()}\n`);

console.log(
  `Inventoried ${records.length} installed packages ` +
    `(${byScope("runtime").length} runtime, ${byScope("development").length} development, ` +
    `${byScope("transitive").length} transitive); ` +
    `${fileIndex.size} notice files in licenses/ covering ${records.length - missing.length} packages, ` +
    `${missing.length} packages ship none; ` +
    `${notInstalled.length} lockfile entries not installed here.`,
);
if (missing.length > 0) {
  console.log("No notice file in package:", missing.map((r) => `${r.package}@${r.version}`).join(", "));
}
await stat(NOTICES);
