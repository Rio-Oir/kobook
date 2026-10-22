// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { createPrismaClient } from '../server/src/db.js';
import type { StreamEvent } from '../shared/contracts/index.js';

const dbName = `gloss_phase1_test_${Date.now()}`;
assert.match(dbName, /^gloss_phase1_test_\d+$/);
const baseDatabaseUrl = 'postgresql://gloss_test:local_test_only@127.0.0.1:55433/gloss_phase1_test';
const databaseUrl = new URL(baseDatabaseUrl);
assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.equal(databaseUrl.port, '55433');
assert.equal(databaseUrl.pathname, '/gloss_phase1_test');
databaseUrl.pathname = `/${dbName}`;
const origin = 'http://127.0.0.1:18080';
const evidence: Record<string, unknown> = { date: new Date().toISOString(), database: dbName, results: [] };
const results = evidence.results as unknown[];
let server: ChildProcess | undefined;
let proxy: ChildProcess | undefined;
const children: ChildProcess[] = [];
function launch(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(child);
  // Keep server output local without printing any possible cookie/body secrets.
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', () => {});
  return child;
}
async function command(args: string[], env: NodeJS.ProcessEnv) {
  const child = launch(args, env);
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, `Command failed: node ${args.join(' ')}`);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, delay(5000).then(() => { child.kill('SIGKILL'); })]);
}
async function waitReady(url: string) {
  for (let n = 0; n < 300; n++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Not ready: ${url}`);
}
const env = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl.href,
  SERVER_HOST: '127.0.0.1', SERVER_PORT: '18787', BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: 'phase1-test-only-secret-000000000000000000000000', SERVER_LOG_LEVEL: 'silent',
};
function startServer() { server = launch(['--import', 'tsx', 'server/src/index.ts'], env); return server; }
async function json(path: string, body?: unknown, cookie?: string) {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function sessionCookie(response: Response) {
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some(c => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)), 'HttpOnly/SameSite cookie missing');
  assert.ok(cookies.some(c => c.includes('session_token=')), 'session token missing');
  return cookies.map(c => c.split(';')[0]).join('; ');
}
async function stream(cookie: string, cancel: boolean | 'explicit' = false) {
  const controller = new AbortController();
  const start = performance.now();
  const chunks = cancel ? Array.from({ length: 20 }, (_, i) => `分片${i}`) : ['中文', '短段', '逐步', '到达'];
  const response = await fetch(`${origin}/api/sample/stream`, {
    method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ chunks, intervalMs: 160 }), signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<{ event: StreamEvent; receivedMs: number }> = [];
  let cancelRequested = false;
  reading: while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    while (buffer.includes('\n\n')) {
      const cut = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as StreamEvent;
      events.push({ event, receivedMs: Math.round(performance.now() - start) });
      if (cancel === true && event.type === 'delta') { controller.abort(); await reader.cancel().catch(() => {}); break reading; }
      if (cancel === 'explicit' && !cancelRequested && event.type === 'delta') {
        cancelRequested = true;
        assert.equal((await json(`/api/sample/stream/${event.jobId}/cancel`, {}, cookie)).status, 200);
      }
    }
  }
  assert.equal(events[0]?.event.type, 'started');
  assert.deepEqual(events.map(e => e.event.seq), events.map((_, i) => i + 1));
  const jobId = events[0]!.event.jobId;
  if (!cancel) {
    const deltas = events.filter(e => e.event.type === 'delta');
    assert.equal(deltas.length, chunks.length);
    assert.deepEqual(deltas.map(e => (e.event as { text: string }).text), chunks);
    for (let i = 1; i < deltas.length; i++) assert.ok(deltas[i]!.receivedMs - deltas[i - 1]!.receivedMs >= 75, 'Proxy buffered SSE frames');
    assert.equal(events.at(-1)?.event.type, 'completed');
    results.push({ test: 'SSE incremental proxy', pass: true, arrivals: events.map(e => ({ type: e.event.type, seq: e.event.seq, receivedMs: e.receivedMs })) });
  } else {
    let snapshot: any;
    for (let i = 0; i < 30; i++) {
      snapshot = await (await json(`/api/sample/stream/${jobId}`, undefined, cookie)).json();
      if (snapshot.status === 'cancelled') break;
      await delay(100);
    }
    assert.equal(snapshot.status, 'cancelled', 'Abort did not propagate through Caddy');
    const count = snapshot.deltaCount;
    await delay(400);
    const after = await (await json(`/api/sample/stream/${jobId}`, undefined, cookie)).json() as any;
    assert.equal(after.deltaCount, count);
    assert.equal(after.deltasAfterCancel, 0);
    assert.ok(count < chunks.length);
    if (cancel === 'explicit') {
      assert.equal(events.at(-1)?.event.type, 'cancelled');
      assert.equal((events.at(-1)!.event as { emittedChars: number }).emittedChars, chunks[0]!.length);
    }
    results.push({ test: cancel === 'explicit' ? 'SSE explicit cancellation' : 'SSE disconnect cancellation', pass: true, emittedDeltas: count, deltasAfterCancel: after.deltasAfterCancel });
  }
  return jobId;
}
try {
  await mkdir('artifacts', { recursive: true });
  const admin = new Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  const identity = await admin.query('SELECT current_database() AS db');
  assert.equal(identity.rows[0].db, 'gloss_phase1_test');
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const empty = new Client({ connectionString: databaseUrl.href });
  await empty.connect();
  const tables = await empty.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(tables.rows[0].count, 0);
  await empty.end();
  await command(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
  await command(['node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
  let prisma = createPrismaClient(databaseUrl.href);
  const version = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
  assert.match(version[0]!.version, /^PostgreSQL 17\.11/);
  const record = await prisma.sampleRecord.create({ data: { label: 'persist', value: randomUUID(), writerPid: process.pid, writerRunId: randomUUID() } });
  await prisma.$disconnect();
  startServer();
  await waitReady('http://127.0.0.1:18787/api/health/ready');
  const config = '{ admin off\n auto_https off\n persist_config off\n storage file_system {\n root .tools/caddy/storage\n }\n}\nhttp://127.0.0.1:18080 {\n bind 127.0.0.1\n reverse_proxy 127.0.0.1:18787 {\n flush_interval -1\n }\n}\n';
  await writeFile('artifacts/Caddyfile-test', config);
  proxy = spawn('.tools/caddy/caddy.exe', ['run', '--config', 'artifacts/Caddyfile-test', '--adapter', 'caddyfile'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.push(proxy);
  proxy.stdout?.on('data', () => {}); proxy.stderr?.on('data', () => {});
  await waitReady(`${origin}/api/health/ready`);
  assert.equal((await json('/api/me')).status, 401);
  assert.equal((await json('/api/sample/stream', {})).status, 401);
  const email = `phase1-${randomUUID()}@example.test`;
  const password = 'virtual-test-password-only-2026';
  const signup = await json('/api/auth/sign-up/email', { email, password, name: '本地测试用户' });
  assert.equal(signup.status, 200, await signup.clone().text());
  let cookie = sessionCookie(signup);
  const me = await (await json('/api/me', undefined, cookie)).json() as any;
  assert.equal(me.user.email, email);
  const payload = { 中文: ['标题', '短段'], nested: { retained: true } };
  const echoed = await json('/api/sample/echo', { marker: '中文HTTP桥接', payload }, cookie);
  assert.equal(echoed.status, 200);
  const echoBody = await echoed.json() as any;
  assert.deepEqual(echoBody.payload, payload);
  assert.equal(echoBody.actorUserId, me.user.id);
  assert.ok(echoBody.receivedBytes > 0);
  results.push({ test: 'HTTP signup cookie/body/session', pass: true });
  for (const [kind, file] of [['html', 'article-zh.html'], ['markdown', 'article-zh.md']] as const) {
    const content = await readFile(`tests/fixtures/${file}`, 'utf8');
    const parsedResponse = await json('/api/sample/parse', { kind, content }, cookie);
    assert.equal(parsedResponse.status, 200);
    const parsed = await parsedResponse.json() as any;
    assert.ok(parsed.document.blocks.some((b: any) => b.text === '你好。'));
    assert.ok(parsed.document.blocks.some((b: any) => b.type === 'code'));
  }
  assert.equal((await json('/api/sample/parse', { kind: 'markdown', content: '   ' }, cookie)).status, 422);
  results.push({ test: 'HTTP fixture parsing and empty rejection', pass: true });
  const firstPid = server!.pid;
  await stop(server);
  startServer();
  assert.notEqual(server!.pid, firstPid);
  await waitReady('http://127.0.0.1:18787/api/health/ready');
  prisma = createPrismaClient(databaseUrl.href);
  const read = await prisma.sampleRecord.findUniqueOrThrow({ where: { id: record.id } });
  assert.equal(read.value, record.value);
  assert.equal((await json('/api/me', undefined, cookie)).status, 200);
  await prisma.$disconnect();
  results.push({ test: 'Empty PostgreSQL migration, repeat deploy, write/restart/read', pass: true, serverPids: [firstPid, server!.pid], version: version[0]!.version });
  const completedJob = await stream(cookie);
  await stream(cookie, true);
  await stream(cookie, 'explicit');
  const secondSignup = await json('/api/auth/sign-up/email', { email: `other-${randomUUID()}@example.test`, password, name: '第二个虚拟用户' });
  assert.equal(secondSignup.status, 200);
  const otherCookie = sessionCookie(secondSignup);
  assert.equal((await json(`/api/sample/stream/${completedJob}`, undefined, otherCookie)).status, 404);
  assert.equal((await json(`/api/sample/stream/${completedJob}/cancel`, {}, otherCookie)).status, 404);
  results.push({ test: 'Sample stream owner isolation', pass: true });
  assert.equal((await json('/api/auth/sign-out', {}, cookie)).status, 200);
  assert.equal((await json('/api/me', undefined, cookie)).status, 401);
  const signin = await json('/api/auth/sign-in/email', { email, password });
  assert.equal(signin.status, 200);
  cookie = sessionCookie(signin);
  assert.equal((await json('/api/me', undefined, cookie)).status, 200);
  results.push({ test: 'HTTP signin/signout and revoked cookie', pass: true });
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
  await writeFile('artifacts/phase1.json', JSON.stringify(evidence, null, 2) + '\n');
}
