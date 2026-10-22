// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phase 2 acceptance run.
 *
 * Exercises every gate in 多人网站后端实施规划.md §8 "阶段 2" through the
 * real HTTP + real PostgreSQL + real Caddy pipeline, the same shape as
 * `tests/phase1.ts`:
 *
 *   - fresh database per run (`gloss_phase2_test_<Date.now()>` derived from
 *     the shared test container);
 *   - `prisma migrate deploy` exactly twice to prove idempotence;
 *   - the dev outbox captures every mail, so verification and reset tokens
 *     are read off `GET /api/dev/mail/latest`;
 *   - the server log is captured to a process-local string buffer that is
 *     never written to disk, and the credential redaction gate is asserted
 *     against that buffer;
 *   - a second server on a different port (no Caddy) is started with the
 *     rate limiter forced on and small maxima, so the rate-limit gates can
 *     be observed deterministically without a 100-request storm.
 *
 * Ports deliberately avoid the phase-1 baselines: 18787 / 18080 / 15173.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { createPrismaClient } from '../server/src/db.js';

const dbName = `gloss_phase2_test_${Date.now()}`;
assert.match(dbName, /^gloss_phase2_test_\d+$/);
const baseDatabaseUrl =
  'postgresql://gloss_test:local_test_only@127.0.0.1:55433/gloss_phase2_test';
const databaseUrl = new URL(baseDatabaseUrl);
assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.equal(databaseUrl.port, '55433');
assert.equal(databaseUrl.pathname, '/gloss_phase2_test');
databaseUrl.pathname = `/${dbName}`;

const origin = 'http://127.0.0.1:18081';
const serverPort = '18788';
const rateLimitServerPort = '18789';
const rateLimitOrigin = `http://127.0.0.1:${rateLimitServerPort}`;

const evidence: Record<string, unknown> = {
  date: new Date().toISOString(),
  database: dbName,
  results: [],
};
const results = evidence.results as unknown[];
let server: ChildProcess | undefined;
let rateLimitServer: ChildProcess | undefined;
let proxy: ChildProcess | undefined;
const children: ChildProcess[] = [];

function launch(args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });
  children.push(child);
  return child;
}

// Output captured from the running server. Used by G8 to assert that no
// credential leaks into the access log; reset to empty after each
// integration phase so a leak in one phase does not contaminate the next.
let capturedLog = "";
function captureOutput(child: ChildProcess): void {
  const onData = (chunk: Buffer | string): void => {
    capturedLog += chunk.toString("utf8");
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, delay(5000).then(() => child.kill('SIGKILL'))]);
}

async function waitReady(url: string): Promise<void> {
  for (let n = 0; n < 300; n++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // server still starting
    }
    await delay(100);
  }
  throw new Error(`Not ready: ${url}`);
}

const baseEnv = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl.href,
  SERVER_HOST: '127.0.0.1',
  SERVER_PORT: serverPort,
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: 'phase2-test-only-secret-000000000000000000000000',
  SERVER_LOG_LEVEL: 'info', // exercise the log redaction gate (G8)
  AUTH_RATE_LIMIT_ENABLED: '0', // avoid the main server tripping its own limits
  // Pinned so the suite keeps using the in-memory outbox even if a developer
  // has a real SMTP account in `.env` (which `loadEnvFileOnce` also skips
  // under NODE_ENV=test, but the intent is clearer stated here).
  MAIL_TRANSPORT: 'outbox',
  // Same intent for SMS: the development sink, never a real provider.
  SMS_TRANSPORT: 'outbox',
  // The duplicate-registration gate has to request a second code for a
  // number that already registered, which the default one-a-minute resend
  // gate would refuse. Three leaves the "send budget is enforced" assertion
  // (the fourth send in G15) meaningful.
  PHONE_OTP_SEND_PHONE_LIMIT: '20',
  // The suite drives every request from one loopback address, so the per-client
  // ceiling has to be wider than the per-number one for the gates to reach the
  // per-number refusal they are about.
  PHONE_OTP_SEND_CLIENT_LIMIT: '100',
};

const rateLimitEnv = {
  ...baseEnv,
  SERVER_PORT: rateLimitServerPort,
  BETTER_AUTH_URL: rateLimitOrigin,
  AUTH_RATE_LIMIT_ENABLED: '1',
  AUTH_RATE_LIMIT_WINDOW: '60',
  AUTH_RATE_LIMIT_MAX: '100',
  AUTH_RATE_LIMIT_LOGIN_WINDOW: '60',
  AUTH_RATE_LIMIT_LOGIN_MAX: '2',
  AUTH_RATE_LIMIT_MAIL_WINDOW: '60',
  AUTH_RATE_LIMIT_MAIL_MAX: '2',
};

function startServer(): ChildProcess {
  // `baseEnv` is a snapshot of process.env taken at the top of the file. The
  // G4 path sets `process.env.ADMIN_EMAILS` after that snapshot, so re-read
  // it from the live environment on every start.
  server = launch(['--import', 'tsx', 'server/src/index.ts'], {
    ...baseEnv,
    ...(process.env['ADMIN_EMAILS'] ? { ADMIN_EMAILS: process.env['ADMIN_EMAILS'] } : {}),
  });
  captureOutput(server);
  return server;
}

function startRateLimitServer(): ChildProcess {
  rateLimitServer = launch(['--import', 'tsx', 'server/src/index.ts'], rateLimitEnv);
  captureOutput(rateLimitServer);
  return rateLimitServer;
}

async function json(
  base: string,
  path: string,
  body?: unknown,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: base,
    accept: 'application/json',
    ...extraHeaders,
    ...(cookie ? { cookie } : {}),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  assert.ok(
    cookies.some((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)),
    'HttpOnly/SameSite cookie missing',
  );
  assert.ok(
    cookies.some((c) => c.includes('session_token=')),
    'session token missing',
  );
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function latestMail(
  toEmail: string,
  purpose?: 'verify-email' | 'reset-password' | 'sign-in-otp',
): Promise<{ id: string; url: string; token: string; code: string; subject: string } | null> {
  const params = new URLSearchParams({ to: toEmail });
  if (purpose) params.set('purpose', purpose);
  // The dev outbox endpoint is the same shape as production API. Direct
  // connection to the Fastify port (no Caddy) is fine here.
  const response = await fetch(
    `http://127.0.0.1:${serverPort}/api/dev/mail/latest?${params.toString()}`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { message: unknown };
  if (body.message === null) return null;
  return body.message as {
    id: string;
    url: string;
    token: string;
    code: string;
    subject: string;
  };
}

async function listMail(): Promise<unknown[]> {
  const response = await fetch(`http://127.0.0.1:${serverPort}/api/dev/mail?limit=20`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { messages: unknown[] };
  return body.messages;
}

/** A random mainland mobile number, so gates never collide on one identity. */
function randomPhone(): string {
  const second = String(3 + Math.floor(Math.random() * 7));
  const tail = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0");
  return `1${second}${tail}`;
}

/** Read the last code the development SMS outbox captured for a number. */
async function latestSms(
  phoneE164: string,
  purpose?: 'sign-up' | 'sign-in' | 'reset-password',
): Promise<{ code: string; to: string; purpose: string; maskedTo: string } | null> {
  const params = new URLSearchParams({ to: phoneE164 });
  if (purpose) params.set('purpose', purpose);
  const response = await fetch(
    `http://127.0.0.1:${serverPort}/api/dev/sms/latest?${params.toString()}`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    message: { code: string; to: string; purpose: string; maskedTo: string } | null;
  };
  return body.message;
}

// ── Run ───────────────────────────────────────────────────────────────────

try {
  await mkdir('artifacts', { recursive: true });
  const admin = new Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  const identity = await admin.query('SELECT current_database() AS db');
  assert.equal(identity.rows[0].db, 'gloss_phase2_test');
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const empty = new Client({ connectionString: databaseUrl.href });
  await empty.connect();
  const tables = await empty.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'",
  );
  assert.equal(tables.rows[0].count, 0);
  await empty.end();

  // Migrate twice. Phase 2's migration is idempotent because every operation
  // is CREATE / ADD COLUMN / ADD CONSTRAINT, none of which are conditional
  // — `migrate deploy` against an already-applied state should be a no-op.
  const prismaBin = 'node_modules/prisma/build/index.js';
  const first = spawn(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    cwd: '.',
    env: { ...baseEnv, DATABASE_URL: databaseUrl.href },
    stdio: 'inherit',
    windowsHide: true,
  });
  assert.equal((await once(first, 'exit'))[0], 0, 'first migrate deploy failed');
  const second = spawn(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    cwd: '.',
    env: { ...baseEnv, DATABASE_URL: databaseUrl.href },
    stdio: 'inherit',
    windowsHide: true,
  });
  assert.equal((await once(second, 'exit'))[0], 0, 'second migrate deploy failed');

  // Schema sanity: the four new columns and the audit table exist.
  const prisma = createPrismaClient(databaseUrl.href);
  const { rows: columnRows } = await new Client({ connectionString: databaseUrl.href })
    .connect()
    .then(async (client) => {
      const r = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='user' AND column_name IN ('role','banned','banReason','banExpires') ORDER BY column_name",
      );
      await client.end();
      return { rows: r.rows };
    });
  assert.deepEqual(
    columnRows.map((r) => r.column_name),
    ['banExpires', 'banReason', 'banned', 'role'],
  );
  const audit = await prisma.adminAuditEvent.count();
  assert.equal(audit, 0);

  // Start the main server + Caddy proxy.
  startServer();
  await waitReady(`http://127.0.0.1:${serverPort}/api/health/ready`);
  const caddyConfig = `{ admin off
 auto_https off
 persist_config off
 storage file_system {
  root .tools/caddy/storage
 }
}
http://127.0.0.1:18081 {
 bind 127.0.0.1
 reverse_proxy 127.0.0.1:${serverPort} {
  flush_interval -1
 }
}
`;
  await writeFile('artifacts/Caddyfile-phase2', caddyConfig);
  proxy = spawn('.tools/caddy/caddy.exe', ['run', '--config', 'artifacts/Caddyfile-phase2', '--adapter', 'caddyfile'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(proxy);
  proxy.stdout?.on('data', () => {});
  proxy.stderr?.on('data', () => {});
  await waitReady(`${origin}/api/health/ready`);

  // ── G1 · 401 on every protected route for an anonymous caller ──────────
  for (const path of ['/api/me', '/api/ai/entry', '/api/admin/users']) {
    const response =
      path === '/api/ai/entry'
        ? await json(origin, path, {})
        : await json(origin, path);
    assert.equal(response.status, 401, `expected 401 on ${path}`);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
    assert.ok(body.error.requestId, 'requestId is present');
  }
  // Forging a session_token value proves the gate is not "any cookie works".
  const forged = await json(origin, '/api/me', undefined, 'session_token=not-a-real-token');
  assert.equal(forged.status, 401);
  results.push({ test: 'G1 anonymous 401 on protected routes', pass: true });

  // ── G2 · Verified email required for the AI entry ──────────────────────
  const user = {
    email: `phase2-u1-${randomUUID()}@example.test`,
    password: 'phase2-test-password-only-2026',
    name: '阶段二用户一',
  };
  const signup = await json(origin, '/api/auth/sign-up/email', {
    ...user,
    callbackURL: '/#/verify-email',
  });
  assert.equal(signup.status, 200, await signup.text());
  const u1Cookie = sessionCookie(signup);

  // An unverified account has a session, but the AI entry refuses it.
  const gated = await json(origin, '/api/ai/entry', {}, u1Cookie);
  const gatedText = await gated.text();
  assert.equal(gated.status, 403, gatedText);
  const gatedBody = JSON.parse(gatedText) as { error: { code: string; message: string } };
  assert.equal(gatedBody.error.code, 'EMAIL_NOT_VERIFIED');

  // The verification mail is in the dev outbox.
  const verifyMail = await latestMail(user.email, 'verify-email');
  assert.ok(verifyMail, 'verification mail was not queued');
  assert.ok(verifyMail.url.includes('/api/auth/verify-email'), 'verify URL shape');
  assert.ok(verifyMail.token.length > 0, 'verify token present');
  // The link stays on /api/auth, never on the SPA hash, but the library
  // appends callbackURL=%2F%23%2Fverify-email, which pins the landing route
  // to /#/verify-email. That is the contract the SPA account page relies on.
  assert.ok(
    /callbackURL=%2F%23%2Fverify-email/.test(verifyMail.url),
    'verify URL pins the SPA landing',
  );

  // Drive the verification round trip with a manual GET using
  // `redirect: 'manual'`. The library 302s into the SPA at the
  // callbackURL and sets a session cookie whose `emailVerified` has been
  // upgraded to true. Follow-redirect would land on `/` and return 404
  // because the SPA is not being served by Fastify; the cookie is what
  // we want anyway.
  const verifyResponse = await fetch(verifyMail.url, { redirect: 'manual' });
  assert.equal(verifyResponse.status, 302, await verifyResponse.text());
  const verifyLocation = verifyResponse.headers.get('location') ?? '';
  assert.ok(
    /#\/verify-email/.test(verifyLocation) || /callbackURL=/.test(verifyLocation),
    `verify redirect must pin the SPA landing, got ${JSON.stringify(verifyLocation)}`,
  );

  // With the new cookie issued via Set-Cookie on the verification
  // response, the AI entry now passes.
  const verifiedCookies = verifyResponse.headers.getSetCookie();
  const verifiedCookie =
    verifiedCookies.length > 0
      ? verifiedCookies.map((c) => c.split(';')[0]).join('; ')
      : u1Cookie;
  const aiAllowed = await json(origin, '/api/ai/entry', {}, verifiedCookie);
  const aiText = await aiAllowed.text();
  assert.equal(aiAllowed.status, 200, aiText);
  const aiBody = JSON.parse(aiText) as { allowed: true; actorUserId: string; phase: number };
  assert.equal(aiBody.allowed, true);
  assert.equal(aiBody.actorUserId.length > 0, true);
  assert.equal(aiBody.phase, 2);

  // A pre-verification cookie replay now sees emailVerified=true.
  const meAfterVerify = (await (await json(origin, '/api/me', undefined, verifiedCookie)).json()) as {
    user: { emailVerified: boolean; role: string };
  };
  assert.equal(meAfterVerify.user.emailVerified, true);
  assert.equal(meAfterVerify.user.role, 'user');
  results.push({ test: 'G2 verified email is required for the AI entry', pass: true });

  // ── G3 · Sign-out invalidates the session ───────────────────────────────
  const signout = await json(origin, '/api/auth/sign-out', {}, verifiedCookie);
  assert.equal(signout.status, 200);
  assert.equal((await json(origin, '/api/me', undefined, verifiedCookie)).status, 401);
  // The AI entry is also 401 for the now-revoked cookie.
  assert.equal((await json(origin, '/api/ai/entry', {}, verifiedCookie)).status, 401);
  // DB-side: sign-out removes the current session. With
  // `autoSignInAfterVerification: true` enabled, verify can create an
  // extra session for the same user, so we expect "fewer than before
  // verify", not strictly zero. The behavioural gate is the 401 above.
  const sessionsAfter = await prisma.session.count();
  assert.ok(
    sessionsAfter >= 0 && sessionsAfter < 2,
    `sign-out should leave at most one session row, got ${sessionsAfter}`,
  );
  results.push({ test: 'G3 sign-out invalidates the session', pass: true });

  // Re-sign in with the same credentials so the rest of the run has a
  // session to work with.
  const signin = await json(origin, '/api/auth/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  assert.equal(signin.status, 200, await signin.text());
  const u1Reauthed = sessionCookie(signin);

  // ── G4 · Disabling an account rejects protected requests immediately ───
  // Bootstrap an administrator via env, then sign in to get a session.
  const adminEmail = `phase2-admin-${randomUUID()}@example.test`;
  // Restart the server with ADMIN_EMAILS set so the bootstrap runs.
  await stop(server);
  startServer();
  await waitReady(`http://127.0.0.1:${serverPort}/api/health/ready`);
  await waitReady(`${origin}/api/health/ready`);

  // Re-sign the user in (server restart dropped the old session in
  // memory, but the cookie still resolves through the database — sign in
  // is a no-op in that case so we can re-issue).
  const userAfterRestart = await json(origin, '/api/auth/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  const u1AfterRestart = sessionCookie(userAfterRestart);
  await waitReady(`${origin}/api/health/ready`);

  // The admin account must exist (created by signing up via the API after
  // restart, then promoted by the bootstrap on the *next* restart). The
  // bootstrap only grants accounts that already exist, so sign up the
  // admin first.
  const adminSignup = await json(origin, '/api/auth/sign-up/email', {
    email: adminEmail,
    password: 'phase2-admin-password-2026',
    name: '阶段二管理员',
    callbackURL: '/#/verify-email',
  });
  assert.equal(adminSignup.status, 200, await adminSignup.text());
  const preAdminSignupCookie = sessionCookie(adminSignup);

  // Promote the admin to admin via a third restart, this time with
  // ADMIN_EMAILS pointing at the just-created admin address.
  await stop(server);
  process.env['ADMIN_EMAILS'] = adminEmail;
  startServer();
  await waitReady(`http://127.0.0.1:${serverPort}/api/health/ready`);
  await waitReady(`${origin}/api/health/ready`);

  // The admin now exists in the database with role=admin and a bootstrap
  // audit row was written. We can verify without an admin session first,
  // then sign in as the admin.
  const adminRow = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
  assert.equal(adminRow.role, 'admin', 'ADMIN_EMAILS did not promote the admin');
  const bootstrapAudit = await prisma.adminAuditEvent.findFirst({
    where: { actorUserId: 'system', targetUserId: adminRow.id },
  });
  assert.ok(bootstrapAudit, 'bootstrap audit row is missing');

  const adminSignin = await json(origin, '/api/auth/sign-in/email', {
    email: adminEmail,
    password: 'phase2-admin-password-2026',
  });
  assert.equal(adminSignin.status, 200);
  const adminCookie = sessionCookie(adminSignin);

  // Disable u1 and check the immediate rejection.
  const u1Me = (await (await json(origin, '/api/me', undefined, u1AfterRestart)).json()) as {
    user: { id: string };
  };
  const u1Id = u1Me.user.id;
  const disable = await json(
    origin,
    `/api/admin/users/${u1Id}/disable`,
    { reason: '阶段2验收' },
    adminCookie,
  );
  assert.equal(disable.status, 200);
  const disableBody = await disable.text();
  assert.ok(disableBody.includes('"auditId"'));

  // The next request with u1's cookie gets 403 ACCOUNT_DISABLED.
  const blockedMe = await json(origin, '/api/me', undefined, u1AfterRestart);
  assert.equal(blockedMe.status, 403);
  const blockedBody = (await blockedMe.json()) as { error: { code: string } };
  assert.equal(blockedBody.error.code, 'ACCOUNT_DISABLED');
  // The AI entry is also blocked.
  const blockedAi = await json(origin, '/api/ai/entry', {}, u1AfterRestart);
  assert.equal(blockedAi.status, 403);

  // A disabled account cannot create a new session: sign-in is forbidden
  // and no Set-Cookie is issued.
  const blockedSignin = await json(origin, '/api/auth/sign-in/email', {
    email: user.email,
    password: user.password,
  });
  assert.equal(blockedSignin.status, 403);
  const blockedSigninCookies = blockedSignin.headers.getSetCookie();
  const sessionCookieIssued = blockedSigninCookies.some((c) => c.includes('session_token='));
  assert.equal(sessionCookieIssued, false, 'sign-in of a disabled account must not set a cookie');

  // The disable row exists with the reason; the session count is unchanged
  // (disable does not revoke sessions by design — phase 6 may add an
  // explicit revoke action).
  const u1AfterDisable = await prisma.user.findUniqueOrThrow({ where: { id: u1Id } });
  assert.equal(u1AfterDisable.banned, true);
  assert.equal(u1AfterDisable.banReason, '阶段2验收');
  assert.ok(u1AfterDisable.banExpires === null);

  // Re-enable and confirm the original cookie works again.
  const enable = await json(
    origin,
    `/api/admin/users/${u1Id}/enable`,
    {},
    adminCookie,
  );
  assert.equal(enable.status, 200);
  const reenabledMe = await json(origin, '/api/me', undefined, u1AfterRestart);
  assert.equal(reenabledMe.status, 200);
  results.push({ test: 'G4 disabled account is rejected promptly and can be re-enabled', pass: true });

  // ── G5 · Role field is not user-writable ─────────────────────────────────
  // (a) Sign up carrying role=admin in the body. Better Auth drops
  // additionalFields on the client, so the request *succeeds* but the
  // user is created as role=user.
  const roleUserEmail = `phase2-u3-${randomUUID()}@example.test`;
  const roleSignup = await json(origin, '/api/auth/sign-up/email', {
    email: roleUserEmail,
    password: 'phase2-test-password-only-2026',
    name: '角色用户',
    role: 'admin',
    callbackURL: '/#/verify-email',
  });
  assert.equal(roleSignup.status, 200, await roleSignup.text());
  const roleUserRow = await prisma.user.findUniqueOrThrow({ where: { email: roleUserEmail } });
  assert.equal(roleUserRow.role, 'user', 'role leaked into a sign-up body');

  // (b) /api/auth/update-user with role=admin must be rejected. We sign in
  // as roleUser first, then try the update.
  const roleSignin = await json(origin, '/api/auth/sign-in/email', {
    email: roleUserEmail,
    password: 'phase2-test-password-only-2026',
  });
  const roleCookie = sessionCookie(roleSignin);
  const updateResp = await json(origin, '/api/auth/update-user', { role: 'admin' }, roleCookie);
  // Better Auth returns 400 BAD_REQUEST for "role is not allowed to be set".
  assert.equal(updateResp.status, 400, await updateResp.text());
  // And the row is still role=user in the database.
  const roleUserRowAfter = await prisma.user.findUniqueOrThrow({ where: { email: roleUserEmail } });
  assert.equal(roleUserRowAfter.role, 'user');

  // (c) A non-admin trying to call an admin route gets 403 and no audit
  // row is created.
  const auditBefore = await prisma.adminAuditEvent.count();
  const tryAdmin = await json(origin, '/api/admin/users', undefined, roleCookie);
  assert.equal(tryAdmin.status, 403);
  const auditAfter = await prisma.adminAuditEvent.count();
  assert.equal(auditAfter, auditBefore, 'a 403 admin call must not write an audit row');

  // (d) Admin promotes roleUser, then demotes them; the very next admin
  // request from roleUser reflects the new role (no cache in the way).
  const roleMe = (await (await json(origin, '/api/me', undefined, roleCookie)).json()) as {
    user: { id: string; role: string };
  };
  const promote = await json(
    origin,
    `/api/admin/users/${roleMe.user.id}/role`,
    { role: 'admin' },
    adminCookie,
  );
  assert.equal(promote.status, 200);
  // roleUser's next request must now report role=admin.
  const roleMeAfterPromote = (await (await json(origin, '/api/me', undefined, roleCookie)).json()) as {
    user: { role: string };
  };
  assert.equal(roleMeAfterPromote.user.role, 'admin');
  // And the admin surface is reachable.
  const listAsPromoted = await json(origin, '/api/admin/users', undefined, roleCookie);
  assert.equal(listAsPromoted.status, 200);
  // Demote; the very next request reports user again.
  const demote = await json(
    origin,
    `/api/admin/users/${roleMe.user.id}/role`,
    { role: 'user' },
    adminCookie,
  );
  assert.equal(demote.status, 200);
  const listAsDemoted = await json(origin, '/api/admin/users', undefined, roleCookie);
  assert.equal(listAsDemoted.status, 403);
  results.push({ test: 'G5 role is not user-writable and is re-read per request', pass: true });

  // (e) The DB-level CHECK constraint rejects values outside the
  // role union. A raw insert with role='superuser' must fail.
  let dbRejected = false;
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role) ` +
        `VALUES ('raw-test', 'raw', 'raw-${randomUUID()}@example.test', false, NOW(), NOW(), 'superuser')`,
    );
  } catch (err) {
    dbRejected = true;
  }
  assert.equal(dbRejected, true, 'CHECK constraint on role must reject superuser');

  // ── G6 · Cross-origin auth requests are refused (CSRF / Origin) ────────
  // `auth.ts` sets `advanced.disableOriginCheck: false` explicitly, which
  // is the only reason the Origin header means anything at all — Better
  // Auth skips the check under NODE_ENV=test by default. Without this
  // gate, flipping that flag back would silently turn every Origin
  // assertion in this file into a no-op.
  //
  // A foreign Origin must not be able to drive the auth endpoints: a
  // browser on another site issuing a credentialed POST to this origin
  // is the exact CSRF shape the check exists to stop.
  const csrfSignup = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://evil.example.test',
    },
    body: JSON.stringify({
      email: `phase2-csrf-${randomUUID()}@example.test`,
      password: 'phase2-csrf-password-2026',
      name: '跨站用户',
    }),
    redirect: 'manual',
  });
  assert.equal(csrfSignup.status, 403, await csrfSignup.text());
  assert.ok(
    csrfSignup.headers.getSetCookie().every((c) => !c.includes('session_token=')),
    'a cross-origin sign-up must not receive a session cookie',
  );

  // The same request with the correct Origin is accepted, so the gate is
  // rejecting the origin rather than the payload.
  const csrfControl = await json(origin, '/api/auth/sign-up/email', {
    email: `phase2-csrf-ok-${randomUUID()}@example.test`,
    password: 'phase2-csrf-password-2026',
    name: '同源用户',
    callbackURL: '/#/verify-email',
  });
  assert.equal(csrfControl.status, 200, 'the same payload with a trusted Origin must succeed');

  // A foreign Origin cannot sign an existing user in either.
  const csrfSignin = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example.test' },
    body: JSON.stringify({ email: user.email, password: user.password }),
    redirect: 'manual',
  });
  assert.equal(csrfSignin.status, 403, await csrfSignin.text());
  results.push({ test: 'G6 cross-origin auth requests are refused', pass: true });

  // ── G7 · Password reset tokens are single-use ───────────────────────────
  const resetEmail = `phase2-reset-${randomUUID()}@example.test`;
  await json(origin, '/api/auth/sign-up/email', {
    email: resetEmail,
    password: 'phase2-reset-old-2026',
    name: '重置用户',
    callbackURL: '/#/verify-email',
  });
  const requestReset = await json(origin, '/api/auth/request-password-reset', {
    email: resetEmail,
    redirectTo: '/#/reset-password',
  });
  assert.equal(requestReset.status, 200);
  const resetMail = await latestMail(resetEmail, 'reset-password');
  assert.ok(resetMail, 'reset mail not queued');
  // The reset link is a GET that 302s to ?token=…#/reset-password. The
  // SPA reads the token from location.search before posting it. We
  // observe the 302 + Location shape for the browser flow, but the
  // integration assertion is the actual POST: the dev-mail endpoint
  // already parsed the path token, which is what the SPA would extract
  // from the URL and POST back.
  const resetGet = await fetch(resetMail.url, { redirect: 'manual' });
  assert.equal(resetGet.status, 302);
  const resetLocation = resetGet.headers.get('location') ?? '';
  assert.ok(
    /token=[^&]+/.test(resetLocation),
    `reset redirect must carry ?token=, got ${JSON.stringify(resetLocation)}`,
  );
  // callbackURL=/#/reset-password puts the SPA route in the hash.
  assert.ok(/#\/reset-password/.test(resetLocation), 'reset redirect must pin the SPA route');

  // The path token from the email link is what the SPA POSTs back to
  // /api/auth/reset-password. (The GET in the browser consumes the
  // server-side record and is the part we cannot replay from this
  // script; the dev-mail endpoint surfaces the path token so the
  // assertion can still observe the API contract.)
  const resetToken = resetMail.token;
  assert.ok(resetToken && resetToken.length > 0, 'reset token parsed from mail url');

  const newPassword = 'phase2-reset-new-2026';
  const firstReset = await json(origin, '/api/auth/reset-password', {
    token: resetToken,
    newPassword,
  });
  const firstResetText = await firstReset.text();
  assert.equal(firstReset.status, 200, firstResetText);

  // Second use must fail.
  const secondReset = await json(origin, '/api/auth/reset-password', {
    token: resetToken,
    newPassword: 'phase2-reset-3rd-2026',
  });
  assert.equal(secondReset.status, 400, await secondReset.text());

  // The verification row is gone at the DB level.
  const verificationRows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM "verification" WHERE identifier = ${'reset-password:' + resetToken}
  `;
  assert.equal(verificationRows[0]?.count, 0, 'reset token must be consumed at the DB level');

  // The old password no longer signs in.
  const oldSignin = await json(origin, '/api/auth/sign-in/email', {
    email: resetEmail,
    password: 'phase2-reset-old-2026',
  });
  assert.equal(oldSignin.status, 401);

  // The new password signs in, and revokeSessionsOnPasswordReset has
  // cleared any pre-existing session for the user.
  const newSignin = await json(origin, '/api/auth/sign-in/email', {
    email: resetEmail,
    password: newPassword,
  });
  assert.equal(newSignin.status, 200);
  const newResetCookie = sessionCookie(newSignin);
  // Sign in once more with the cookie that *was* issued before the reset
  // (none here, so this branch is empty; the proof is that sessions for
  // this user are all revoked pre-reset).
  const sessionsAfterReset = await prisma.session.count({ where: { user: { email: resetEmail } } });
  // Exactly one session: the one we just created with the post-reset sign-in.
  assert.equal(sessionsAfterReset, 1);

  // Re-using the same cookie from a different pre-reset sign-in would be
  // impossible here, so we exercise the same logic differently: there is
  // no pre-reset cookie to replay. Note that as a check.
  assert.ok(newResetCookie.length > 0);
  results.push({ test: 'G7 reset token is single-use and old sessions are revoked', pass: true });

  // ── G8 · Credentials do not appear in the server log ────────────────────
  // Every credential used in the run so far is known up front: the test
  // password, the admin password, the reset passwords, the wrong password
  // tried against sign-in. The verification and reset tokens were just
  // retrieved from the dev outbox above; they are random hex strings, so
  // we cannot grep for them directly, but every URL that carried them was
  // sanitized before it hit the access log (the `sanitizeRequestUrl`
  // layer drops the query string wholesale for `/api/auth/*`).
  const secretStrings = [
    user.password,
    'phase2-admin-password-2026',
    'phase2-reset-old-2026',
    'phase2-reset-new-2026',
    'phase2-reset-3rd-2026',
    'definitely-wrong',
  ];
  for (const secret of secretStrings) {
    assert.ok(
      !capturedLog.includes(secret),
      `server log must not contain ${JSON.stringify(secret.slice(0, 12))}…`,
    );
  }
  // `/api/auth/*` is whole-query-dropped; if the redaction ever regresses,
  // the URL in the log line would contain the substring `token=`.
  assert.ok(
    !/token=[A-Za-z0-9_-]{16,}/.test(capturedLog),
    "no log line should contain a token=… query parameter",
  );
  // The reset path segment is masked, so the path `/api/auth/reset-password/<…>`
  // must not appear. (The actual test value is unknown, but the prefix
  // `/api/auth/reset-password/` followed by a non-bracket segment is
  // enough to fail if a redaction slipped.)
  assert.ok(
    !/\/api\/auth\/reset-password\/[A-Za-z0-9_-]{8,}(?!\/\[redacted])/.test(capturedLog),
    "no log line should contain a raw reset-password token in the path",
  );

  // The dev outbox / API responses are themselves free of password-shaped
  // strings, regardless of what the server log says.
  const allMail = (await listMail()) as Array<{ subject: string; url: string; to: string }>;
  for (const message of allMail) {
    assert.ok(!message.url.includes(user.password), 'password in mail url');
    assert.ok(!message.url.includes('phase2-reset-old-2026'), 'old reset password in mail url');
  }
  // Better Auth's sign-in error body must not echo the password.
  const wrongPw = await json(origin, '/api/auth/sign-in/email', {
    email: user.email,
    password: 'definitely-wrong',
  });
  const wrongText = await wrongPw.text();
  assert.ok(!wrongText.includes('definitely-wrong'), 'sign-in error must not echo the password');
  assert.ok(!wrongText.includes(user.password), 'sign-in error must not echo the original password');
  results.push({ test: 'G8 no credentials in mail URLs, sign-in error bodies, or server log', pass: true });

  // ── G9 · Rate limit fires deterministically on a dedicated server ───────
  // The main server has the limiter off; this one is started fresh with
  // a small max so a handful of requests suffices to trip it.
  startRateLimitServer();
  await waitReady(`http://127.0.0.1:${rateLimitServerPort}/api/health/ready`);

  // Reset path: 3 requests, the 3rd must be 429.
  for (const path of [
    '/api/auth/sign-in/email',
    '/api/auth/sign-in/email-otp',
    '/api/auth/sign-up/email',
    '/api/auth/send-verification-email',
    '/api/auth/request-password-reset',
    '/api/auth/email-otp/send-verification-otp',
  ]) {
    let lastStatus = 0;
    let lastBody = '';
    let lastResponse: Response | undefined;
    for (let i = 0; i < 3; i++) {
      const response = await json(rateLimitOrigin, path, {
        email: `ratelimit-${randomUUID()}@example.test`,
        ...(path === '/api/auth/sign-up/email' ? { password: 'phase2-rl-2026', name: 'rl' } : {}),
        ...(path === '/api/auth/request-password-reset' ? { redirectTo: '/#/reset-password' } : {}),
        ...(path === '/api/auth/sign-in/email-otp' ? { otp: '000000' } : {}),
        ...(path === '/api/auth/email-otp/send-verification-otp' ? { type: 'sign-in' } : {}),
      });
      lastStatus = response.status;
      lastBody = await response.text();
      lastResponse = response;
    }
    assert.equal(lastStatus, 429, `${path}: expected 429 on the 3rd request, got ${lastStatus} (${lastBody})`);
    // The X-Retry-After header is present and is a positive integer.
    const retryAfter = lastResponse!.headers.get('x-retry-after');
    assert.ok(retryAfter, `${path}: X-Retry-After header missing`);
    const parsed = Number(retryAfter);
    assert.ok(Number.isInteger(parsed) && parsed > 0, `${path}: X-Retry-After must be a positive integer`);
    assert.ok(parsed <= 60, `${path}: X-Retry-After is window-bounded (got ${parsed})`);
  }

  // The limiter is per (IP, path): a health check on the same server
  // remains reachable.
  const health = await fetch(`http://127.0.0.1:${rateLimitServerPort}/api/health/live`);
  assert.equal(health.status, 200);
  results.push({
    test: 'G9 rate limit fires on sign-in/sign-up/verification/reset/OTP send',
    pass: true,
  });

  // ── G10 · The dev mail endpoint is absent in production ────────────────
  // Build an app instance in-process with NODE_ENV=production; the
  // dev-mail routes are not registered, so the 404 comes from the
  // shared error handler.
  const { buildApp } = await import('../server/src/app.js');
  const { createAuth } = await import('../server/src/auth.js');
  const { createMailer } = await import('../server/src/lib/mail/mailer.js');
  const {
    loadAuthRateLimitConfig,
    toBetterAuthRateLimit,
  } = await import('../server/src/lib/rate-limit.js');
  const productionAuth = createAuth({
    prisma,
    secret: 'phase2-test-only-secret-000000000000000000000000',
    baseURL: 'http://127.0.0.1:9999',
    nodeEnv: 'production',
    trustedOrigins: ['http://127.0.0.1:9999'],
    mail: createMailer({
      transport: { async send() {} } as never,
      verificationExpiresInSeconds: 3600,
      resetExpiresInSeconds: 1800,
      signInOtpExpiresInSeconds: 600,
    }),
    rateLimit: toBetterAuthRateLimit(loadAuthRateLimitConfig('production')),
  });
  const prodApp = await buildApp({
    prisma,
    auth: productionAuth,
    nodeEnv: 'production',
    mail: undefined,
  });
  try {
    // The closest the SPA ever gets to a production GET on the dev
    // endpoint: it gets the shared 404 body (the X-Robots-Tag noindex
    // header is set on every /api/* response, including the 404).
    const devMailResp = await prodApp.app.inject({ method: 'GET', url: '/api/dev/mail/latest' });
    assert.equal(devMailResp.statusCode, 404);
    const body = devMailResp.json() as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(devMailResp.headers['x-robots-tag'], 'noindex');

    // Same rule for the SMS inbox: a production deployment never keeps a
    // readable copy of a live code.
    const devSmsResp = await prodApp.app.inject({ method: 'GET', url: '/api/dev/sms/latest' });
    assert.equal(devSmsResp.statusCode, 404);
    assert.equal((devSmsResp.json() as { error: { code: string } }).error.code, 'NOT_FOUND');

    const noXFFLeak = await prodApp.app.inject({
      method: 'GET',
      url: '/api/auth/verify-email?token=SECRET_TOKEN_VALUE',
    });
    assert.ok(
      !noXFFLeak.body.includes('SECRET_TOKEN_VALUE'),
      'X-Robots-Tag and req.url sanitization: token must not appear in /api/auth responses either',
    );
  } finally {
    await prodApp.app.close();
  }
  results.push({ test: 'G10 dev mail endpoint is absent in production', pass: true });

  // ── G11 · Passwordless sign-in by six-digit email code ────────────────
  // Scope: a code proves control of an already-registered mailbox. It never
  // creates an account, and an unknown address gets the same success response
  // as a known one (with no mail), so sending is not an enumeration oracle.
  const otpEmail = `phase2-otp-${randomUUID()}@example.test`;
  const otpPassword = 'phase2-otp-password-2026';
  const otpSignup = await json(origin, '/api/auth/sign-up/email', {
    email: otpEmail,
    password: otpPassword,
    name: '验证码登录用户',
    callbackURL: '/#/verify-email',
  });
  assert.equal(otpSignup.status, 200, await otpSignup.text());
  const otpSignupCookie = sessionCookie(otpSignup);

  // Verify through the existing link flow first: this gate is about signing in
  // with a code, not about how the mailbox got verified.
  const otpVerifyMail = await latestMail(otpEmail, 'verify-email');
  assert.ok(otpVerifyMail?.url, 'verification link missing');
  const otpVerifyGet = await fetch(otpVerifyMail.url, { redirect: 'manual' });
  assert.equal(otpVerifyGet.status, 302);
  await json(origin, '/api/auth/sign-out', {}, otpSignupCookie);

  // Unknown address: send succeeds but nothing is queued.
  const unknownEmail = `phase2-otp-unknown-${randomUUID()}@example.test`;
  const unknownSend = await json(origin, '/api/auth/email-otp/send-verification-otp', {
    email: unknownEmail,
    type: 'sign-in',
  });
  assert.equal(unknownSend.status, 200, await unknownSend.text());
  assert.equal(
    await latestMail(unknownEmail, 'sign-in-otp'),
    null,
    'an unregistered address must not receive a code',
  );

  // Known address: a six-digit, link-free code.
  const otpSend = await json(origin, '/api/auth/email-otp/send-verification-otp', {
    email: otpEmail,
    type: 'sign-in',
  });
  assert.equal(otpSend.status, 200, await otpSend.text());
  const codeMail = await latestMail(otpEmail, 'sign-in-otp');
  assert.ok(codeMail, 'sign-in code was not queued');
  assert.match(codeMail.code, /^\d{6}$/, 'code is six digits');
  assert.equal(codeMail.url, '', 'a login code carries no link');
  assert.equal(codeMail.token, '', 'a login code carries no token');
  assert.ok(
    !capturedLog.includes(codeMail.code),
    'the login code must never reach the server log',
  );

  // A wrong guess is refused without minting a session.
  const wrongCode = await json(origin, '/api/auth/sign-in/email-otp', {
    email: otpEmail,
    otp: codeMail.code === '000000' ? '111111' : '000000',
  });
  assert.equal(wrongCode.status, 400, await wrongCode.text());
  assert.equal(wrongCode.headers.getSetCookie().length, 0, 'a failed code must not set cookies');

  // The right code creates the same session contract as a password sign-in.
  const codeSignin = await json(origin, '/api/auth/sign-in/email-otp', {
    email: otpEmail,
    otp: codeMail.code,
  });
  assert.equal(codeSignin.status, 200, await codeSignin.text());
  const codeCookie = sessionCookie(codeSignin);
  const meByCode = await json(origin, '/api/me', undefined, codeCookie);
  assert.equal(meByCode.status, 200);
  const meByCodeBody = (await meByCode.json()) as {
    user: { email: string; emailVerified: boolean };
  };
  assert.equal(meByCodeBody.user.email, otpEmail);
  assert.equal(meByCodeBody.user.emailVerified, true);

  // Single use: replaying the same code fails.
  const replay = await json(origin, '/api/auth/sign-in/email-otp', {
    email: otpEmail,
    otp: codeMail.code,
  });
  assert.equal(replay.status, 400, 'a consumed code must not sign in again');

  // The password still works: this account verified by link before using a
  // code, so the OTP promotion path did not discard its credential.
  const passwordStill = await json(origin, '/api/auth/sign-in/email', {
    email: otpEmail,
    password: otpPassword,
  });
  assert.equal(passwordStill.status, 200, 'code login must not remove a verified account password');

  // Unknown address + any code: refused, same shape as a wrong code.
  const unknownSignin = await json(origin, '/api/auth/sign-in/email-otp', {
    email: unknownEmail,
    otp: '000000',
  });
  assert.equal(unknownSignin.status, 400, 'an unregistered address cannot sign in by code');

  results.push({
    test: 'G11 six-digit email code signs in without creating accounts',
    pass: true,
  });

  // ── G12 · Phone registration proves the number, then stores a password ──
  // Scope: a code is the ownership proof; `emailVerified` is set for a phone
  // account for the same reason it is set for a verified mailbox, and the
  // stored address is a reserved-domain placeholder that cannot receive mail
  // and cannot be claimed through the email form.
  const phoneA = randomPhone();
  const phonePassword = 'phase2-phone-password-2026';

  const sendSignupCode = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: phoneA,
    purpose: 'sign-up',
  });
  assert.equal(sendSignupCode.status, 200, await sendSignupCode.text());
  const signupSms = await latestSms(`+86${phoneA}`, 'sign-up');
  assert.ok(signupSms, 'the sign-up code was not queued');
  assert.match(signupSms.code, /^\d{6}$/u, 'the code is six digits');
  assert.equal(signupSms.to, `+86${phoneA}`);
  assert.equal(signupSms.maskedTo, `${phoneA.slice(0, 3)}****${phoneA.slice(-4)}`);
  assert.ok(
    !capturedLog.includes(signupSms.code),
    'the SMS code must never reach the server log',
  );

  // A short password is refused before the code is consumed, so the user does
  // not lose their verification code to a validation error.
  const shortPassword = await json(origin, '/api/auth/phone/sign-up', {
    phoneNumber: phoneA,
    code: signupSms.code,
    password: 'short',
  });
  assert.equal(shortPassword.status, 400, await shortPassword.text());

  const registeredPhone = await json(origin, '/api/auth/phone/sign-up', {
    phoneNumber: phoneA,
    code: signupSms.code,
    password: phonePassword,
    name: '手机注册用户',
  });
  assert.equal(registeredPhone.status, 200, await registeredPhone.text());
  const phoneCookie = sessionCookie(registeredPhone);

  const phoneMe = await json(origin, '/api/me', undefined, phoneCookie);
  assert.equal(phoneMe.status, 200);
  const phoneMeBody = (await phoneMe.json()) as {
    user: { email: string; emailVerified: boolean; name: string; phoneNumber?: string | null };
  };
  assert.equal(phoneMeBody.user.phoneNumber, `+86${phoneA}`);
  assert.equal(phoneMeBody.user.emailVerified, true);
  assert.equal(phoneMeBody.user.name, '手机注册用户');
  assert.match(
    phoneMeBody.user.email,
    /^861\d{10}@phone\.invalid$/u,
    'a phone account stores an unroutable placeholder address',
  );

  // A second registration of the same number is refused, and the refusal is
  // only reachable after a valid code (so it is not an enumeration oracle).
  const sendSignupAgain = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: phoneA,
    purpose: 'sign-up',
  });
  assert.equal(sendSignupAgain.status, 200, await sendSignupAgain.text());
  const signupSmsAgain = await latestSms(`+86${phoneA}`, 'sign-up');
  assert.ok(signupSmsAgain, 'the second sign-up code was not queued');
  const duplicate = await json(origin, '/api/auth/phone/sign-up', {
    phoneNumber: phoneA,
    code: signupSmsAgain.code,
    password: phonePassword,
  });
  assert.equal(duplicate.status, 400);
  const duplicateBody = (await duplicate.json()) as { code?: string };
  assert.equal(duplicateBody.code, 'PHONE_ALREADY_REGISTERED');
  assert.equal(duplicate.headers.getSetCookie().length, 0, 'a refused registration sets no cookie');

  results.push({
    test: 'G12 phone registration verifies the number and stores a password',
    pass: true,
  });

  // ── G13 · Phone password and code sign-in ──────────────────────────────
  await json(origin, '/api/auth/sign-out', {}, phoneCookie);

  const passwordSignin = await json(origin, '/api/auth/phone/sign-in-password', {
    phoneNumber: phoneA,
    password: phonePassword,
  });
  assert.equal(passwordSignin.status, 200, await passwordSignin.text());
  sessionCookie(passwordSignin);

  // One answer for a wrong password, an unknown number and a malformed one.
  const wrongPassword = await json(origin, '/api/auth/phone/sign-in-password', {
    phoneNumber: phoneA,
    password: 'definitely-not-the-password',
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.headers.getSetCookie().length, 0);
  assert.equal(
    ((await wrongPassword.json()) as { code?: string }).code,
    'INVALID_PHONE_OR_PASSWORD',
  );
  const unknownNumber = await json(origin, '/api/auth/phone/sign-in-password', {
    phoneNumber: randomPhone(),
    password: 'definitely-not-the-password',
  });
  assert.equal(unknownNumber.status, 401);
  assert.equal(
    ((await unknownNumber.json()) as { code?: string }).code,
    'INVALID_PHONE_OR_PASSWORD',
  );

  // An unregistered number gets the same "sent" answer and no message.
  const unknownPhone = randomPhone();
  const sendUnknown = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: unknownPhone,
    purpose: 'sign-in',
  });
  assert.equal(sendUnknown.status, 200, await sendUnknown.text());
  assert.equal(
    await latestSms(`+86${unknownPhone}`, 'sign-in'),
    null,
    'an unregistered number must not receive a sign-in code',
  );

  const sendLoginCode = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: phoneA,
    purpose: 'sign-in',
  });
  assert.equal(sendLoginCode.status, 200, await sendLoginCode.text());
  const loginSms = await latestSms(`+86${phoneA}`, 'sign-in');
  assert.ok(loginSms, 'the sign-in code was not queued');

  const wrongPhoneCode = await json(origin, '/api/auth/phone/sign-in-code', {
    phoneNumber: phoneA,
    code: loginSms.code === '000000' ? '111111' : '000000',
  });
  assert.equal(wrongPhoneCode.status, 400, await wrongPhoneCode.text());
  assert.equal(wrongPhoneCode.headers.getSetCookie().length, 0, 'a failed code must not set cookies');

  const phoneCodeSignin = await json(origin, '/api/auth/phone/sign-in-code', {
    phoneNumber: phoneA,
    code: loginSms.code,
  });
  assert.equal(phoneCodeSignin.status, 200, await phoneCodeSignin.text());
  const phoneCodeCookie = sessionCookie(phoneCodeSignin);
  const meByPhoneCode = await json(origin, '/api/me', undefined, phoneCodeCookie);
  assert.equal(meByPhoneCode.status, 200);
  assert.equal(
    ((await meByPhoneCode.json()) as { user: { phoneNumber?: string | null } }).user.phoneNumber,
    `+86${phoneA}`,
  );

  const replayCode = await json(origin, '/api/auth/phone/sign-in-code', {
    phoneNumber: phoneA,
    code: loginSms.code,
  });
  assert.equal(replayCode.status, 400, 'a consumed phone code must not sign in again');

  results.push({
    test: 'G13 phone password sign-in and single-use code sign-in',
    pass: true,
  });

  // ── G14 · Phone password reset revokes every session ───────────────────
  const sendResetCode = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: phoneA,
    purpose: 'reset-password',
  });
  assert.equal(sendResetCode.status, 200, await sendResetCode.text());
  const resetSms = await latestSms(`+86${phoneA}`, 'reset-password');
  assert.ok(resetSms, 'the reset code was not queued');

  const resetUnknown = randomPhone();
  const sendUnknownReset = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: resetUnknown,
    purpose: 'reset-password',
  });
  assert.equal(sendUnknownReset.status, 200);
  assert.equal(await latestSms(`+86${resetUnknown}`, 'reset-password'), null);

  const phoneNewPassword = 'phase2-phone-reset-2026';
  const resetPhone = await json(origin, '/api/auth/phone/reset-password', {
    phoneNumber: phoneA,
    code: resetSms.code,
    newPassword: phoneNewPassword,
  });
  assert.equal(resetPhone.status, 200, await resetPhone.text());

  const staleSession = await json(origin, '/api/me', undefined, phoneCodeCookie);
  assert.equal(staleSession.status, 401, 'a password reset must revoke existing sessions');

  const oldPassword = await json(origin, '/api/auth/phone/sign-in-password', {
    phoneNumber: phoneA,
    password: phonePassword,
  });
  assert.equal(oldPassword.status, 401, 'the old password must stop working');

  const newPasswordSignin = await json(origin, '/api/auth/phone/sign-in-password', {
    phoneNumber: phoneA,
    password: phoneNewPassword,
  });
  assert.equal(newPasswordSignin.status, 200, await newPasswordSignin.text());
  sessionCookie(newPasswordSignin);

  results.push({
    test: 'G14 phone reset needs a code, revokes sessions and replaces the password',
    pass: true,
  });

  // ── G15 · Phone boundaries: reserved address, unset fields, budgets ────
  // The placeholder address belongs to the number, not to whoever registers
  // it first through the email form.
  const squatPhoneEmail = await json(origin, '/api/auth/sign-up/email', {
    email: `86${phoneA}@phone.invalid`,
    password: 'squatter-password-2026',
    name: 'squatter',
    callbackURL: '/#/verify-email',
  });
  // Better Auth surfaces both rejections as 422. The first is the email
  // uniqueness check inside the vendor's sign-up; the second is our own
  // reserved-domain hook, which is what stops pre-claiming a number that has
  // not registered yet.
  assert.equal(squatPhoneEmail.status, 422);
  assert.equal(
    ((await squatPhoneEmail.json()) as { code?: string }).code,
    'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  );

  const unclaimedNumber = randomPhone();
  const squatUnclaimed = await json(origin, '/api/auth/sign-up/email', {
    email: `86${unclaimedNumber}@phone.invalid`,
    password: 'squatter-password-2026',
    name: 'squatter',
    callbackURL: '/#/verify-email',
  });
  assert.equal(squatUnclaimed.status, 400);
  assert.equal(
    ((await squatUnclaimed.json()) as { code?: string }).code,
    'RESERVED_EMAIL_DOMAIN',
  );

  // `phoneNumber` is `input: false`, so an email registration that sends one is
  // rejected outright (`FIELD_NOT_ALLOWED`) rather than silently ignoring it —
  // the caller learns their field was not honoured.
  const injectedEmail = `phase2-phone-inject-${randomUUID()}@example.test`;
  const injectedSignup = await json(origin, '/api/auth/sign-up/email', {
    email: injectedEmail,
    password: 'injected-password-2026',
    name: '注入用户',
    callbackURL: '/#/verify-email',
    phoneNumber: `+86${randomPhone()}`,
  });
  assert.equal(injectedSignup.status, 400);
  assert.equal(
    ((await injectedSignup.json()) as { code?: string }).code,
    'FIELD_NOT_ALLOWED',
  );
  assert.equal(injectedSignup.headers.getSetCookie().length, 0, 'a rejected sign-up sets no cookie');

  // The hourly per-number ceiling is the kit's own budget: five sends, the
  // sixth is refused with the kit's code (not a generic 429).
  const budgetPhone = randomPhone();
  for (let index = 0; index < 5; index += 1) {
    const sent = await json(origin, '/api/auth/phone/send-code', {
      phoneNumber: budgetPhone,
      purpose: 'sign-up',
    });
    assert.equal(sent.status, 200, `send ${index + 1} should be allowed: ${await sent.text()}`);
  }
  const overBudget = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: budgetPhone,
    purpose: 'sign-up',
  });
  assert.equal(overBudget.status, 429);
  assert.equal(((await overBudget.json()) as { code?: string }).code, 'SEND_LIMITED');

  // Five wrong guesses burn the challenge, and the correct code that was
  // delivered afterwards must then fail rather than open a session.
  // A fresh number keeps this gate inside the per-phone verify budget the
  // earlier gates already spent part of.
  const phoneB = randomPhone();
  const phoneBPassword = 'phase2-phone-second-2026';
  const sendB = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: phoneB,
    purpose: 'sign-up',
  });
  assert.equal(sendB.status, 200, await sendB.text());
  const smsB = await latestSms(`+86${phoneB}`, 'sign-up');
  assert.ok(smsB, 'the second account code was not queued');
  const registerB = await json(origin, '/api/auth/phone/sign-up', {
    phoneNumber: phoneB,
    code: smsB.code,
    password: phoneBPassword,
  });
  assert.equal(registerB.status, 200, await registerB.text());

  const sendBurn = await json(origin, '/api/auth/phone/send-code', {
    phoneNumber: phoneB,
    purpose: 'sign-in',
  });
  assert.equal(sendBurn.status, 200, await sendBurn.text());
  const burnSms = await latestSms(`+86${phoneB}`, 'sign-in');
  assert.ok(burnSms, 'the code under attack was not queued');
  const wrongGuess = burnSms.code === '000000' ? '111111' : '000000';
  let lastGuessStatus = 0;
  let lastGuessCode = '';
  for (let index = 0; index < 5; index += 1) {
    const guess = await json(origin, '/api/auth/phone/sign-in-code', {
      phoneNumber: phoneB,
      code: wrongGuess,
    });
    lastGuessStatus = guess.status;
    lastGuessCode = ((await guess.json()) as { code?: string }).code ?? '';
  }
  assert.equal(lastGuessStatus, 400);
  assert.equal(lastGuessCode, 'TOO_MANY_ATTEMPTS');
  const burnedCorrect = await json(origin, '/api/auth/phone/sign-in-code', {
    phoneNumber: phoneB,
    code: burnSms.code,
  });
  assert.equal(burnedCorrect.status, 400, 'a burned challenge must not accept its code');
  assert.equal(burnedCorrect.headers.getSetCookie().length, 0);

  results.push({
    test: 'G15 phone reserved address, input:false fields and OTP budgets',
    pass: true,
  });

  evidence.pass = true;
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.pass = false;
  evidence.failure = error instanceof Error ? error.message : String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/phase2.json', JSON.stringify(evidence, null, 2) + '\n');
}
