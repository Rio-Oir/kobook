// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Local TLS fixture for the URL importer's certificate tests.
 *
 * The importer pins a connection to an already-vetted IP. That trick is
 * only safe if the *TLS identity* stays the original hostname — otherwise
 * the request would either fail against every real HTTPS site or have to
 * disable verification, which would defeat the guard entirely.
 *
 * Proving that needs three certificates and a DNS name that is not in the
 * public DNS:
 *
 *   1. a local CA, so the "trusted" case is trusted because the test told
 *      the process to trust it, not because verification was switched off;
 *   2. a leaf certificate for `fixture.test` signed by that CA — a
 *      *legitimate* certificate for the name we ask for;
 *   3. a leaf certificate for `other.test` signed by the same CA — a
 *      *valid but wrong-identity* certificate, which is what a
 *      hostname-check regression would wrongly accept.
 *
 * Everything lands under `artifacts/tls/` and is reused if already
 * present, so a run is cheap after the first. Nothing here is ever used
 * outside the test process: no production code path reads these files,
 * `NODE_EXTRA_CA_CERTS` is not set for the app, and the CA private key
 * never leaves the working tree.
 *
 * Idempotent by design: re-running the script either finds a complete,
 * still-valid set and exits, or regenerates the whole set. It never
 * mixes a half-written CA with a fresh leaf, which is the failure that
 * makes a TLS fixture flaky.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const tlsDir = join(root, "artifacts", "tls");

export const TLS_FIXTURE_PATHS = {
  dir: tlsDir,
  caCert: join(tlsDir, "ca.pem"),
  caKey: join(tlsDir, "ca.key"),
  goodCert: join(tlsDir, "fixture.test.pem"),
  goodKey: join(tlsDir, "fixture.test.key"),
  wrongCert: join(tlsDir, "other.test.pem"),
  wrongKey: join(tlsDir, "other.test.key"),
};

function openssl(args) {
  const result = spawnSync(process.env.OPENSSL_BIN || "openssl", args, { cwd: tlsDir, encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `openssl is required for the TLS fixture and could not be run: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `openssl ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/** OpenSSL's default 825-day leaf lifetime is fine; the CA outlives it. */
const DAYS = "825";

function makeLeaf(name, cn, sans, caKey, caCert, certPath, keyPath) {
  const csr = join(tlsDir, `${cn}.csr`);
  const ext = join(tlsDir, `${cn}.ext`);
  openssl([
    "req", "-new", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", csr, "-subj", `/CN=${cn}`,
  ]);
  writeFileSync(
    ext,
    [
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${sans}`,
      "",
    ].join("\n"),
  );
  openssl([
    "x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey,
    "-CAcreateserial", "-out", certPath, "-days", DAYS, "-sha256", "-extfile", ext,
  ]);
  rmSync(csr, { force: true });
  rmSync(ext, { force: true });
  void name;
}

/**
 * Generate (or reuse) the fixture. Returns the paths.
 *
 * The reuse check requires *all* files to exist together; a partial set
 * is deleted and rebuilt, because a stale leaf signed by a since-replaced
 * CA produces a verification failure that looks exactly like the bug the
 * fixture is supposed to detect.
 */
export function ensureTlsFixture() {
  const p = TLS_FIXTURE_PATHS;
  const all = [
    p.caCert, p.caKey, p.goodCert, p.goodKey, p.wrongCert, p.wrongKey,
  ];
  if (all.every((file) => existsSync(file))) return p;

  for (const file of all) rmSync(file, { force: true });
  mkdirSync(tlsDir, { recursive: true });

  // 1. Local CA.
  openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", p.caKey, "-out", p.caCert, "-days", "3650",
    "-subj", "/CN=kobook-local-tls-fixture-CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);

  // 2. A certificate for the name we will actually ask for. `localhost`
  //    and the literal address are in the SAN list too, so the fixture
  //    also covers the "ask for an IP" shape.
  makeLeaf("fixture.test", "fixture.test", "DNS:fixture.test,DNS:localhost,IP:127.0.0.1", p.caKey, p.caCert, p.goodCert, p.goodKey);

  // 3. A valid-but-wrong-identity certificate.
  makeLeaf("other.test", "other.test", "DNS:other.test", p.caKey, p.caCert, p.wrongCert, p.wrongKey);

  return p;
}

export function readCaCertificate() {
  const p = ensureTlsFixture();
  return readFileSync(p.caCert, "utf8");
}

/** `import { ensureTlsFixture } from ...` then call it, or run directly. */
if (process.argv[1] && fileURLToPath(new URL(import.meta.url)) === process.argv[1]) {
  const paths = ensureTlsFixture();
  process.stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
}
