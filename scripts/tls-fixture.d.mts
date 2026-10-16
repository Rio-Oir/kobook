/**
 * Types for the local TLS fixture generator.
 *
 * The generator is a `.mjs` script because it is also runnable standalone
 * (`npm run tls:fixture`) and shells out to `openssl`; this declaration is
 * what lets the test import it with real types instead of `any`.
 */

export interface TlsFixturePaths {
  dir: string;
  caCert: string;
  caKey: string;
  goodCert: string;
  goodKey: string;
  wrongCert: string;
  wrongKey: string;
}

export declare const tlsDir: string;
export declare const TLS_FIXTURE_PATHS: TlsFixturePaths;

/** Generate (or reuse) the fixture and return the paths. */
export declare function ensureTlsFixture(): TlsFixturePaths;

/** The PEM body of the fixture CA, for a request's extra trust anchors. */
export declare function readCaCertificate(): string;
