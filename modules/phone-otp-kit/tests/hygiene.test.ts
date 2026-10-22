// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Structural hygiene, checked rather than asserted in prose.
 *
 * Four properties that a review cannot practically verify by reading:
 *
 * 1. **The two entries stay separate.** The browser entry's import graph reaches
 *    no `node:` builtin; the server entry's reaches no React. One careless
 *    re-export and a browser bundle starts shipping `node:crypto`, which fails
 *    at runtime rather than at build time in some bundler configurations.
 * 2. **No dependency was added.** Every bare specifier in `src/` is `react`,
 *    `react-dom` or a `node:` builtin, and the module has no manifest of its own.
 * 3. **The module does not read the environment or log.** No source file touches
 *    `process.env`, the filesystem, `eval` or a console: every decision comes
 *    from the injected configuration, and every log line belongs to the
 *    integrator's `onError` hook. The core additionally holds no ambient clock
 *    or scheduler — time arrives as a parameter.
 * 4. **The view layer has no side effects available to it.** A source scan for
 *    the network and browser-state APIs, with positive controls, so a pattern
 *    that matches nothing cannot pass as a clean result.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const moduleRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcRoot = join(moduleRoot, "src");
const coreRoot = join(srcRoot, "otp");
const viewRoot = join(srcRoot, "ui");
const testsRoot = join(moduleRoot, "tests");

const BROWSER_ENTRY = join(srcRoot, "browser.ts");
const SERVER_ENTRY = join(srcRoot, "server.ts");

/** Paths are always written with `/`, even on Windows, for readable messages. */
function display(absolute: string): string {
  return relative(moduleRoot, absolute).split(sep).join("/");
}

/**
 * Comments are stripped before every scan, and that is not a nicety.
 *
 * The module documents what it refuses to do — "no `process.env`", "this is what
 * replaces interpolating the vendor's `err.message`", "the caller is about to be
 * told *wrong code*" — so a scanner reading raw text reports the documentation as
 * the violation. Stripping is what keeps these tests about the code.
 *
 * The over-stripping guard below matters as much as the stripping: a pattern that
 * ate half of every file would report a clean source tree.
 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//gu;
/** Line comments, but only where they start a line — never `https://`. */
const LINE_COMMENT = /(^|\n)([ \t]*)\/\/[^\n]*/gu;

function stripComments(source: string): string {
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "$1$2");
}

function readSource(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

function listFiles(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path);
  }
  return found;
}

const STATIC_FROM = /\bfrom\s*["']([^"']+)["']/gu;
const SIDE_EFFECT = /\bimport\s*["']([^"']+)["']/gu;
const DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [STATIC_FROM, SIDE_EFFECT, DYNAMIC]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Resolve a relative specifier the way the module's toolchain does. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface Graph {
  readonly files: ReadonlyMap<string, string>;
  readonly external: readonly string[];
}

/** Follow relative imports from `entry`, collecting sources and bare specifiers. */
function walk(entry: string): Graph {
  const files = new Map<string, string>();
  const external: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || files.has(file)) continue;

    const source = readSource(file);
    files.set(file, source);

    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveSpecifier(file, specifier);
        assert.ok(resolved !== null, `${display(file)} imports "${specifier}", which does not resolve`);
        queue.push(resolved);
      } else {
        external.push(specifier);
      }
    }
  }

  return { files, external };
}

/* ──────────────────────── the entries stay separate ──────────────────────── */

test("the browser entry reaches no node builtin", () => {
  const shell = walk(BROWSER_ENTRY);
  assert.ok(shell.files.size >= 6, `expected a real graph, walked ${shell.files.size} files`);

  for (const [file, source] of shell.files) {
    for (const specifier of importSpecifiers(source)) {
      assert.ok(
        !specifier.startsWith("node:"),
        `${display(file)} imports ${specifier}, so the browser entry can reach a server-only module`,
      );
    }
    assert.ok(!/\brequire\s*\(/u.test(source), `${display(file)} uses a CommonJS require`);
  }
  assert.deepEqual(
    [...new Set(shell.external)].sort(),
    ["react"],
    "the browser half depends on React and nothing else",
  );
});

test("the browser entry includes the panel and none of the server implementation", () => {
  const paths = [...walk(BROWSER_ENTRY).files.keys()].map(display);

  assert.ok(paths.includes("src/ui/PhoneOtpPanel.tsx"));
  assert.ok(paths.includes("src/ui/messages.ts"));
  assert.ok(paths.includes("src/shared/phone.ts"));
  assert.ok(paths.includes("src/shared/errors.ts"));
  for (const path of paths) {
    assert.ok(!path.startsWith("src/otp/"), `${path} must not be reachable from the browser entry`);
  }
});

test("the server entry includes the implementation and none of the view layer", () => {
  const paths = [...walk(SERVER_ENTRY).files.keys()].map(display);

  assert.ok(paths.includes("src/otp/service.ts"));
  assert.ok(paths.includes("src/otp/memory-store.ts"));
  assert.ok(paths.includes("src/otp/store.ts"));
  for (const path of paths) {
    assert.ok(!path.startsWith("src/ui/"), `${path} must not be reachable from the server entry`);
  }
});

test("the server entry reaches no browser-only module", () => {
  const { files, external } = walk(SERVER_ENTRY);
  for (const [file, source] of files) {
    for (const specifier of importSpecifiers(source)) {
      assert.ok(
        specifier !== "react" && specifier !== "react-dom" && !specifier.startsWith("react/"),
        `${display(file)} imports ${specifier}`,
      );
    }
  }
  assert.deepEqual(
    [...new Set(external)].sort(),
    ["node:crypto"],
    "the server half needs the CSPRNG and nothing else",
  );
});

/* ───────────────────────── no dependency was added ───────────────────────── */

const ALLOWED_BARE = new Set(["react", "react-dom", "node:crypto"]);

test("every bare import in src is React, React DOM or a node builtin", () => {
  for (const file of listFiles(srcRoot, [".ts", ".tsx"])) {
    for (const specifier of importSpecifiers(readSource(file))) {
      if (specifier.startsWith(".")) continue;
      assert.ok(ALLOWED_BARE.has(specifier), `${display(file)} imports "${specifier}"`);
    }
  }
});

test("every relative import in src stays inside the module", () => {
  for (const file of listFiles(srcRoot, [".ts", ".tsx"])) {
    for (const specifier of importSpecifiers(readSource(file))) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveSpecifier(file, specifier);
      assert.ok(resolved !== null, `${display(file)} imports "${specifier}", which does not resolve`);
      assert.ok(
        resolved.startsWith(`${srcRoot}${sep}`),
        `${display(file)} imports "${specifier}", which escapes src/`,
      );
    }
  }
});

test("the module has no manifest, lockfile or bundled dependency", () => {
  for (const forbidden of [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "node_modules",
  ]) {
    assert.equal(
      existsSync(join(moduleRoot, forbidden)),
      false,
      `${forbidden} would mean the module is not dependency-free`,
    );
  }
});

test("the module's tsconfig stands alone", () => {
  const tsconfig = JSON.parse(readFileSync(join(moduleRoot, "tsconfig.json"), "utf8")) as {
    extends?: string;
    references?: unknown;
    include?: string[];
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(tsconfig.extends, undefined, "it must not extend the application's tsconfig");
  assert.equal(tsconfig.references, undefined, "it must not join the application's project references");
  assert.deepEqual(tsconfig.include, [
    "src/**/*.ts",
    "src/**/*.tsx",
    "tests/**/*.ts",
    "tests/**/*.tsx",
  ]);
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
  assert.equal(tsconfig.compilerOptions.noUncheckedIndexedAccess, true);
  assert.equal(tsconfig.compilerOptions.verbatimModuleSyntax, true);
});

/* ──────────────── no environment, no filesystem, no logging ──────────────── */

interface Rule {
  readonly description: string;
  readonly pattern: RegExp;
  /** Something that does match. Without it, "no match" proves nothing. */
  readonly sample: string;
}

/** Applies to every file under `src/`. */
const SRC_RULES: readonly Rule[] = [
  { description: "reads the environment", pattern: /process\s*\.\s*env/u, sample: "process.env.OTP_SECRET" },
  { description: "touches the process object", pattern: /\bprocess\s*\./u, sample: "process.pid" },
  {
    description: "reads the filesystem",
    pattern: /node:fs|readFileSync|createReadStream/u,
    sample: 'import { readFileSync } from "node:fs";',
  },
  { description: "imports dotenv", pattern: /\bdotenv\b/u, sample: 'import "dotenv/config";' },
  {
    description: "logs",
    pattern: /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)/u,
    sample: "console.error(error)",
  },
  { description: "evaluates a string", pattern: /\beval\s*\(|new\s+Function\s*\(/u, sample: "eval(code)" },
];

/**
 * Applies to the core only.
 *
 * The core takes the clock as a parameter and never schedules anything, which is
 * what makes every timing behaviour in the suite deterministic. The view layer is
 * allowed a timer — it is a countdown — and it is separately checked for the
 * things it must not do. `Date.now` is handled by the pinned test below rather
 * than by a rule, because the service has exactly one legitimate use of it.
 */
const CORE_RULES: readonly Rule[] = [
  {
    description: "uses a scheduler",
    pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(/u,
    sample: "setInterval(fn, 250)",
  },
  { description: "constructs a Date", pattern: /new\s+Date\s*\(/u, sample: "new Date().toISOString()" },
];

function assertClean(dir: string, rules: readonly Rule[]): number {
  const files = listFiles(dir, [".ts", ".tsx"]);
  for (const file of files) {
    const source = readSource(file);
    for (const rule of rules) {
      assert.ok(!rule.pattern.test(source), `${display(file)} ${rule.description}`);
    }
  }
  return files.length;
}

test("stripping comments does not eat the code", () => {
  // The guard that makes every other assertion in this file mean something: a
  // pattern that ate half of every file would report a clean source tree. The
  // ratio is deliberately loose — `otp/limiter.ts` is mostly contract
  // documentation — so the real check is that recognisable code survives.
  for (const file of listFiles(srcRoot, [".ts", ".tsx"])) {
    const raw = readFileSync(file, "utf8");
    const stripped = stripComments(raw);
    assert.ok(stripped.length >= 100, `${display(file)} stripped to ${stripped.length} characters`);
    assert.ok(stripped.includes("export"), `${display(file)} lost its exports to stripping`);
    assert.ok(stripped.length < raw.length, `${display(file)} has no comments to strip`);
  }

  // Spot checks against the code, not the prose.
  assert.ok(readSource(join(coreRoot, "service.ts")).includes("class PhoneOtpService"));
  assert.ok(readSource(join(coreRoot, "limiter.ts")).includes("interface OtpRateLimiter"));
  assert.ok(readSource(join(coreRoot, "fake-sms.ts")).includes("class FakeTransport"));
  assert.ok(readSource(join(viewRoot, "PhoneOtpPanel.tsx")).includes("function PhoneOtpPanel"));

  // And the stripper itself behaves: block comments go, line comments go only at
  // the start of a line, and a URL is left alone.
  assert.equal(stripComments('const url = "https://example.test/x";'), 'const url = "https://example.test/x";');
  assert.equal(stripComments("a\n// gone\nb"), "a\n\nb");
  assert.equal(stripComments("/* gone */kept"), "kept");
});

test("the scanner matches what it is looking for", () => {
  // The positive controls, so an absence means something.
  for (const rule of [...SRC_RULES, ...CORE_RULES]) {
    assert.ok(rule.pattern.test(rule.sample), `${rule.description} should match ${rule.sample}`);
  }
});

test("no source file reads the environment, the filesystem or a console", () => {
  const scanned = assertClean(srcRoot, SRC_RULES);
  assert.ok(scanned >= 15, `expected the whole source tree, saw ${scanned} files`);
});

test("the core holds no ambient clock and schedules nothing", () => {
  const scanned = assertClean(coreRoot, CORE_RULES);
  assert.ok(scanned >= 10, `expected the core, saw ${scanned} files`);
});

test("time enters the core through the service's injected clock and nowhere else", () => {
  // `PhoneOtpService.create` passes `Date.now` itself as the default clock —
  // the reference, not a call, because the clock is a function. Everything below
  // it — the store, the limiter, the transport call, the hasher — takes `now` as
  // a parameter, which is what makes the suite's timing assertions deterministic
  // rather than merely fast.
  const ambientClock = /\bDate\s*\.\s*now\b/u;
  // A separate global copy for counting: `test()` on a sticky `g` regex advances
  // `lastIndex`, which would silently skip matches in the next file.
  const ambientClockAll = /\bDate\s*\.\s*now\b/gu;
  const offenders: string[] = [];
  let service = "";

  for (const file of listFiles(coreRoot, [".ts", ".tsx"])) {
    const source = readSource(file);
    if (file === join(coreRoot, "service.ts")) service = source;
    else if (ambientClock.test(source)) offenders.push(display(file));
  }

  assert.deepEqual(offenders, [], "only the service may reach for the clock");
  assert.equal(service.match(ambientClockAll)?.length, 1);
  assert.ok(
    service.includes("options.now ?? Date.now"),
    "the single use must be the documented injectable default",
  );
});

/* ─────────────── the view layer has no side effects available ─────────────── */

const VIEW_RULES: readonly Rule[] = [
  { description: "performs a network request", pattern: /\bfetch\s*\(/u, sample: "await fetch('/api')" },
  { description: "constructs an XHR", pattern: /\bXMLHttpRequest\b/u, sample: "new XMLHttpRequest()" },
  { description: "uses a beacon", pattern: /\bsendBeacon\b/u, sample: "navigator.sendBeacon('/x', body)" },
  { description: "reads or writes a cookie", pattern: /document\s*\.\s*cookie/u, sample: "document.cookie = 'a=1'" },
  {
    description: "uses browser storage",
    pattern: /\b(localStorage|sessionStorage|indexedDB)\b/u,
    sample: "localStorage.setItem('a', 'b')",
  },
  {
    description: "navigates",
    pattern: /location\s*\.\s*(href|assign|replace)/u,
    sample: "location.href = '/next'",
  },
  { description: "imports a router", pattern: /\breact-router\b/u, sample: 'from "react-router"' },
  { description: "imports an auth client", pattern: /\bauth-client\b/u, sample: 'from "@/lib/auth-client"' },
];

test("the view layer reaches for no network or browser-state API", () => {
  for (const rule of VIEW_RULES) {
    assert.ok(rule.pattern.test(rule.sample), `${rule.description} should match ${rule.sample}`);
  }
  const scanned = assertClean(viewRoot, VIEW_RULES);
  assert.ok(scanned >= 2, `expected the view layer, saw ${scanned} files`);
});

/* ─────────────────────── documentation matches reality ─────────────────────── */

test("the README names the two entries the code actually has", () => {
  const readme = readFileSync(join(moduleRoot, "README.md"), "utf8");
  assert.ok(readme.includes("src/server.ts"), "the README must name the server entry");
  assert.ok(readme.includes("src/browser.ts"), "the README must name the browser entry");
  assert.ok(existsSync(BROWSER_ENTRY) && existsSync(SERVER_ENTRY));
});

test("the tests directory is the only place that may know about tests", () => {
  // A `src/` file that imported a helper from `tests/` would make the shipped
  // module depend on its own test scaffolding.
  for (const file of listFiles(srcRoot, [".ts", ".tsx"])) {
    for (const specifier of importSpecifiers(readSource(file))) {
      assert.ok(!specifier.includes("tests/"), `${display(file)} imports "${specifier}"`);
    }
  }
  assert.ok(
    listFiles(testsRoot, [".test.ts", ".test.tsx"]).length >= 8,
    "the suites are present",
  );
});
