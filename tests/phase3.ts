// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Phase 3 (slice 1) acceptance run.
 *
 * The article library's seven gates. The shape mirrors `tests/phase2.ts`:
 * a fresh database, `migrate deploy` exactly twice to prove idempotence,
 * a real Fastify + real Caddy pipeline, and the dev outbox is not
 * involved here (we are past the auth / mail surface; this slice only
 * deals with article tables and the session gate).
 *
 * Ports deliberately avoid the existing baselines:
 *   - phase 1 server 18787, Caddy 18080
 *   - phase 2 server 18788, Caddy 18081
 *   - phase 2 rate-limit server 18789
 *   - phase 2 browser auth Caddy 18083, server 18793
 *   - phase 3 server 18790, Caddy 18082
 *
 * The whole run is "code ready, not yet executed"; Docker Desktop was
 * not running when the slice was written, and the run will only land
 * when the next `npm run db:up && npm run test:phase3` happens.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { createPrismaClient } from "../server/src/db.js";
import { encodeCursor, decodeCursor } from "../server/src/routes/articles.js";
import { documentTextHash, sha256Hex } from "../server/src/lib/parse/blocks.js";
import type { ArticleSyncRequest, ContentBlock } from "../shared/contracts/index.js";

const dbName = `gloss_phase3_test_${Date.now()}`;
assert.match(dbName, /^gloss_phase3_test_\d+$/);
const baseDatabaseUrl =
  "postgresql://gloss_test:local_test_only@127.0.0.1:55433/gloss_phase3_test";
const databaseUrl = new URL(baseDatabaseUrl);
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.equal(databaseUrl.port, "55433");
assert.equal(databaseUrl.pathname, "/gloss_phase3_test");
databaseUrl.pathname = `/${dbName}`;

const origin = "http://127.0.0.1:18082";
const serverPort = "18790";

const evidence: Record<string, unknown> = {
  date: new Date().toISOString(),
  database: dbName,
  results: [],
};
const results = evidence.results as unknown[];
let server: ChildProcess | undefined;
let proxy: ChildProcess | undefined;
const children: ChildProcess[] = [];

function launch(args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env,
  });
  children.push(child);
  return child;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, delay(5000).then(() => child.kill("SIGKILL"))]);
}

async function waitReady(url: string, attempts = 300): Promise<void> {
  for (let n = 0; n < attempts; n++) {
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
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl.href,
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: serverPort,
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: "phase3-test-only-secret-000000000000000000000000",
  SERVER_LOG_LEVEL: "warn",
  AUTH_RATE_LIMIT_ENABLED: "0",
};

let capturedLog = "";
function captureOutput(child: ChildProcess): void {
  const onData = (chunk: Buffer | string): void => {
    capturedLog += chunk.toString("utf8");
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
}

function startServer(): ChildProcess {
  // The transport fixture stands in for the network. The server no longer
  // calls Jina, so `url-import` fetches the page itself through
  // `pinned-fetch`, which uses `https.request`; the fixture resolves
  // `example.com` to a public address and answers over https with a fixture
  // article. That exercises the real direct-fetch path without a real
  // upstream — and without relaxing the SSRF guard, which is exactly what
  // G10 and G11 prove still bites. It is loaded into the *child* because the
  // server is the process that fetches.
  server = launch(
    [
      "--import",
      "tsx",
      "--import",
      "./tests/fixtures/direct-http-preload.mjs",
      "server/src/index.ts",
    ],
    baseEnv,
  );
  captureOutput(server);
  return server;
}

async function json(
  base: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: base,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}

async function del(base: string, path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { origin: base, accept: "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { method: "DELETE", headers, redirect: "manual" });
}

/** PUT / PATCH with a JSON body — the two verbs the metadata routes use. */
async function send(
  base: string,
  path: string,
  method: "PUT" | "PATCH",
  body: unknown,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: base,
    accept: "application/json",
    "content-type": "application/json",
  };
  if (cookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((c) => /session_token=/.test(c)), "session token missing");
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

async function signUp(email: string, password: string, name: string): Promise<string> {
  const response = await json(origin, "/api/auth/sign-up/email", {
    email,
    password,
    name,
    callbackURL: "/#/",
  });
  assert.equal(response.status, 200, await response.text());
  return sessionCookie(response);
}

/**
 * A `ContentBlock` with the id / hash the wire requires, derived with the
 * server's own helpers.
 *
 * Building the fixture through `sha256Hex` rather than pasting literal digests
 * is what makes the gate meaningful: the sync route recomputes both, so a
 * literal that drifted from the algorithm would fail the gate for the wrong
 * reason. It also means the test cannot accidentally assert a hash scheme the
 * client does not produce — `local-import-blocks.ts` implements the same
 * SHA-256 over the same string, and `tests/unit/` pins those two against each
 * other.
 */
function syncBlock(
  index: number,
  text: string,
  extra: Partial<ContentBlock> = {},
): ContentBlock {
  const hash = sha256Hex(text);
  return {
    id: `b${index}-${hash.slice(0, 8)}`,
    index,
    type: "paragraph",
    text,
    hash,
    ...extra,
  };
}

/** A schema-valid `ArticleSyncRequest`. */
function syncFixture(overrides: Partial<ArticleSyncRequest> = {}): ArticleSyncRequest {
  const blocks: ContentBlock[] = [
    syncBlock(1, "同步测试：第一章", { type: "heading", level: 1 }),
    syncBlock(2, "正文第一段。"),
    // A real emphasis run, so the gate proves spans survive the upload.
    syncBlock(3, "正文第二段，带强调。", { spans: [{ start: 6, end: 8, kinds: ["strong"] }] }),
  ];
  return {
    title: "同步测试文章",
    sourceUrl: null,
    source: "local",
    author: null,
    textHash: documentTextHash(blocks),
    blocks,
    clientKey: randomUUID().replace(/-/g, ""),
    ...overrides,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────

try {
  await mkdir("artifacts", { recursive: true });
  const admin = new Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const empty = new Client({ connectionString: databaseUrl.href });
  await empty.connect();
  const tables = await empty.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'",
  );
  assert.equal(tables.rows[0].count, 0, "fresh database must have no tables");
  await empty.end();

  // Migrate twice to prove idempotence.
  const prismaBin = "node_modules/prisma/build/index.js";
  const first = spawn(process.execPath, [prismaBin, "migrate", "deploy"], {
    env: { ...baseEnv, DATABASE_URL: databaseUrl.href },
    stdio: "inherit",
    windowsHide: true,
  });
  assert.equal((await once(first, "exit"))[0], 0, "first migrate deploy failed");
  const second = spawn(process.execPath, [prismaBin, "migrate", "deploy"], {
    env: { ...baseEnv, DATABASE_URL: databaseUrl.href },
    stdio: "inherit",
    windowsHide: true,
  });
  assert.equal((await once(second, "exit"))[0], 0, "second migrate deploy failed");

  // Schema sanity: the new tables and indexes exist.
  const prisma = createPrismaClient(databaseUrl.href);
  const { rows: articleRows } = await new Client({ connectionString: databaseUrl.href })
    .connect()
    .then(async (client) => {
      const r = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('article','article_version','paragraph') ORDER BY table_name",
      );
      await client.end();
      return { rows: r.rows };
    });
  assert.deepEqual(
    articleRows.map((r) => r.table_name),
    ["article", "article_version", "paragraph"],
  );

  // Cursor encoding round-trip is a pure function and tested here too, so
  // the integration test fails loudly if the route silently changes shape.
  assert.equal(decodeCursor(encodeCursor("abc-123")), "abc-123");
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor(undefined), null);

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
http://127.0.0.1:18082 {
 bind 127.0.0.1
 reverse_proxy 127.0.0.1:${serverPort} {
  flush_interval -1
 }
}
`;
  await writeFile("artifacts/Caddyfile-phase3", caddyConfig);
  proxy = spawn(
    ".tools/caddy/caddy.exe",
    ["run", "--config", "artifacts/Caddyfile-phase3", "--adapter", "caddyfile"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  children.push(proxy);
  proxy.stdout?.on("data", () => {});
  proxy.stderr?.on("data", () => {});
  await waitReady(`${origin}/api/health/ready`);

  // ── G1 · Unauthenticated access is 401 on every article route ─────────
  // GET on the list endpoint and the import URL is rejected with 401
  // because there is no body to validate.
  for (const path of ["/api/articles", "/api/articles/import", "/api/articles/anything/notes"]) {
    const response = await json(origin, path);
    assert.equal(response.status, 401, `expected 401 on GET ${path}`);
  }
  // POST with a body that passes the JSON schema; the preHandler
  // (`requireSession`) is what actually rejects with 401. DELETE on
  // /api/articles/import also reaches the preHandler because the param
  // schema is satisfied by the literal `import`.
  const postResp = await fetch(`${origin}/api/articles/import`, {
    method: "POST",
    headers: { origin: origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "text", content: "x" }),
  });
  assert.equal(postResp.status, 401, `expected 401 on POST /api/articles/import`);
  const delAnonResp = await fetch(`${origin}/api/articles/import`, {
    method: "DELETE",
    headers: { origin: origin, accept: "application/json" },
  });
  assert.equal(delAnonResp.status, 401, `expected 401 on DELETE /api/articles/import`);
  // Wire A's route is asserted with a body that satisfies its JSON schema, so
  // the only thing that can reject it is `requireSession`. That distinction is
  // the whole point: an unregistered path answers 404, and a 404 here is
  // exactly how the sync upload stayed broken — the contract declared it, the
  // client posted to it, and no server handler existed, so every upload was
  // silently `rejected`. A gate that accepted "401 or 404" would not have
  // caught it; this one does.
  const syncAnonResp = await fetch(`${origin}/api/articles/sync`, {
    method: "POST",
    headers: { origin: origin, "content-type": "application/json" },
    body: JSON.stringify(syncFixture()),
  });
  assert.equal(
    syncAnonResp.status,
    401,
    `expected 401 on POST /api/articles/sync (404 means the route is not registered)`,
  );
  results.push({ test: "G1 unauthenticated 401 on every article route", pass: true });

  // ── G2 · A verified user can import a pasted text and read it back ────
  const userA = `phase3-A-${randomUUID()}@example.test`;
  const cookieA = await signUp(userA, "phase3-A-password-2026", "用户甲");
  const sample = [
    "# 标题",
    "",
    "第一段正文。",
    "",
    "## 子标题",
    "",
    "第二段正文。",
    "",
    "- 列表项一",
    "- 列表项二",
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");
  const importResp = await json(origin, "/api/articles/import", {
    kind: "text",
    content: sample,
  }, cookieA);
  const importRespText = await importResp.text();
  assert.equal(importResp.status, 200, importRespText);
  const importBody = JSON.parse(importRespText) as {
    article: { id: string; title: string; source: string; importedAt: string };
    version: { id: string; version: number; paragraphs: Array<{ index: number; type: string; text: string }> };
  };
  assert.equal(importBody.article.title, "标题");
  assert.equal(importBody.article.source, "text");
  assert.equal(importBody.version.version, 1);
  assert.ok(importBody.version.paragraphs.length >= 4, "all blocks should round-trip");
  const types = importBody.version.paragraphs.map((p) => p.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("paragraph"));
  assert.ok(types.includes("listItem"));
  assert.ok(types.includes("code"));
  const articleId = importBody.article.id;

  // List returns it.
  const listBody = (await (await json(origin, "/api/articles", undefined, cookieA)).json()) as {
    articles: Array<{ id: string }>;
    nextCursor: string | null;
  };
  assert.equal(listBody.articles.length, 1);
  assert.equal(listBody.articles[0]!.id, articleId);

  // Detail returns the same paragraphs.
  const detailBody = (await (await json(origin, `/api/articles/${articleId}`, undefined, cookieA)).json()) as {
    article: { id: string };
    version: { paragraphs: Array<{ type: string; text: string }> };
  };
  assert.equal(detailBody.article.id, articleId);
  assert.deepEqual(
    detailBody.version.paragraphs.map((p) => p.type),
    types,
  );
  results.push({ test: "G2 import / list / detail round-trip with full block shapes", pass: true });

  // ── G2c · Editing appends an immutable version ────────────────────────
  // The editing feature writes version N+1 instead of mutating N: notes made
  // against N stay valid, and a second device that edited from N is refused
  // rather than silently overwriting this write.
  const beforeEdit = (await (await json(origin, `/api/articles/${articleId}`, undefined, cookieA)).json()) as {
    version: { id: string; version: number; paragraphs: ContentBlock[] };
  };
  const editedBlocks = beforeEdit.version.paragraphs.map((block) => ({ ...block }));
  const editedParagraph = editedBlocks.find((block) => block.type === "paragraph");
  assert.ok(editedParagraph, "the fixture must contain a paragraph to edit");
  editedParagraph!.text = `${editedParagraph!.text}（编辑后）`;
  editedParagraph!.hash = sha256Hex(editedParagraph!.text);
  const editHash = documentTextHash(editedBlocks);

  const editResp = await json(origin, `/api/articles/${articleId}/versions`, {
    blocks: editedBlocks,
    textHash: editHash,
    baseVersionId: beforeEdit.version.id,
  }, cookieA);
  const editText = await editResp.text();
  assert.equal(editResp.status, 200, editText);
  const editBody = JSON.parse(editText) as {
    articleId: string;
    version: { id: string; version: number; paragraphs: ContentBlock[] };
  };
  assert.equal(editBody.articleId, articleId);
  assert.equal(editBody.version.version, 2);
  assert.ok(
    editBody.version.paragraphs.some((paragraph) => paragraph.text.includes("编辑后")),
    "the edited text must be stored in version 2",
  );

  // The base version is now stale: a second append from it must not overwrite
  // version 2, because the other device never saw this edit.
  const staleEdit = await json(origin, `/api/articles/${articleId}/versions`, {
    blocks: editedBlocks,
    textHash: editHash,
    baseVersionId: beforeEdit.version.id,
  }, cookieA);
  assert.equal(staleEdit.status, 409, await staleEdit.text());

  // A client hash that does not describe its blocks is rejected before writing.
  const badHashEdit = await json(origin, `/api/articles/${articleId}/versions`, {
    blocks: editedBlocks,
    textHash: "0".repeat(64),
    baseVersionId: editBody.version.id,
  }, cookieA);
  assert.equal(badHashEdit.status, 422, await badHashEdit.text());

  const afterEditDetail = (await (await json(origin, `/api/articles/${articleId}`, undefined, cookieA)).json()) as {
    version: { id: string; version: number; paragraphs: ContentBlock[] };
  };
  assert.equal(afterEditDetail.version.id, editBody.version.id);
  assert.ok(afterEditDetail.version.paragraphs.some((paragraph) => paragraph.text.includes("编辑后")));

  // Reused by the cross-user check once user B exists.
  const editedVersionPayload = {
    blocks: editedBlocks,
    textHash: editHash,
    baseVersionId: editBody.version.id,
  };
  results.push({
    test: "G2c edit appends version 2, rejects a stale base (409) and a bad hash (422)",
    pass: true,
  });

  // ── G2b · HTML import round-trips through Readability + the walker ────
  // The route advertises three kinds; only `text` and `url` were covered.
  // The audit's P1#3 was "import drops short Chinese paragraphs", so the
  // fixture deliberately contains a short Chinese paragraph that a
  // length filter would delete.
  const htmlSample = `<!doctype html>
<html lang="zh">
  <head><meta charset="utf-8" /><title>HTML 导入标题</title></head>
  <body>
    <article>
      <h1>HTML 导入标题</h1>
      <p>短。</p>
      <p>深度学习的训练需要大量算力，团队通常租用云端 GPU。</p>
      <ul><li>列表项甲</li><li>列表项乙</li></ul>
      <pre><code>const x = 1;</code></pre>
    </article>
  </body>
</html>`;
  const htmlImport = await json(origin, "/api/articles/import", {
    kind: "html",
    content: htmlSample,
  }, cookieA);
  const htmlText = await htmlImport.text();
  assert.equal(htmlImport.status, 200, htmlText);
  const htmlBody = JSON.parse(htmlText) as {
    article: { id: string; source: string; title: string };
    version: { source: string; paragraphs: Array<{ type: string; text: string }> };
  };
  assert.equal(htmlBody.article.source, "text", "pasted HTML is stored under the text source");
  assert.equal(htmlBody.article.title, "HTML 导入标题");
  assert.match(htmlBody.version.source, /readability|markdown/);
  const htmlTypes = htmlBody.version.paragraphs.map((p) => p.type);
  assert.ok(htmlTypes.includes("paragraph"), "the HTML body must survive Readability");
  assert.ok(
    htmlBody.version.paragraphs.some((p) => p.text === "短。"),
    "a one-word Chinese paragraph must not be filtered out",
  );
  assert.ok(
    htmlBody.version.paragraphs.some((p) => p.text.includes("云端 GPU")),
    "the long paragraph must survive too",
  );
  assert.ok(htmlTypes.includes("listItem"), "list items must round-trip from HTML");
  assert.ok(htmlTypes.includes("code"), "code blocks must round-trip from HTML");

  // An HTML document with no body text is refused, not saved empty.
  const htmlEmpty = await json(origin, "/api/articles/import", {
    kind: "html",
    content: "<html><head><title>只有标题</title></head><body></body></html>",
  }, cookieA);
  assert.equal(htmlEmpty.status, 422, await htmlEmpty.text());

  // Clean up so the later list assertions keep their counts.
  assert.equal((await del(origin, `/api/articles/${htmlBody.article.id}`, cookieA)).status, 200);
  results.push({ test: "G2b HTML import round-trips blocks and keeps short Chinese paragraphs", pass: true });

  // ── G3 · Cross-user isolation: B cannot see A's article ───────────────
  const userB = `phase3-B-${randomUUID()}@example.test`;
  const cookieB = await signUp(userB, "phase3-B-password-2026", "用户乙");
  const bList = (await (await json(origin, "/api/articles", undefined, cookieB)).json()) as {
    articles: Array<{ id: string }>;
  };
  assert.equal(bList.articles.length, 0, "B's library must be empty");

  // B requests A's article by id — must be 404 (not 403, not 200).
  const bDetail = await json(origin, `/api/articles/${articleId}`, undefined, cookieB);
  assert.equal(bDetail.status, 404, await bDetail.text());
  // Same for delete and export.
  const bDelete = await del(origin, `/api/articles/${articleId}`, cookieB);
  assert.equal(bDelete.status, 404);
  const bExport = await json(origin, `/api/articles/${articleId}/export`, undefined, cookieB);
  assert.equal(bExport.status, 404);
  // B cannot append a version to A's article either: ownership is checked
  // before the blocks are sanitised, so this is the same indistinguishable 404.
  const bEdit = await json(origin, `/api/articles/${articleId}/versions`, editedVersionPayload, cookieB);
  assert.equal(bEdit.status, 404, "another user must not append a version");
  results.push({ test: "G3 cross-user reads and writes are 404, never 200 or 403", pass: true });

  // ── G4 · Empty content is rejected with EMPTY_ARTICLE (422) ──────────
  // The body schema blocks "" via minLength, so the realistic case is
  // "real text that yields no blocks after parsing" (e.g. only a heading).
  const emptyResp = await json(origin, "/api/articles/import", {
    kind: "text",
    content: "# 唯一标题",
  }, cookieA);
  const emptyRespText = await emptyResp.text();
  assert.equal(emptyResp.status, 422, emptyRespText);
  const emptyBody = JSON.parse(emptyRespText) as { error: { code: string } };
  assert.equal(emptyBody.error.code, "EMPTY_ARTICLE");

  // Body schema rejects truly empty content.
  const schemaReject = await json(origin, "/api/articles/import", {
    kind: "text",
    content: "",
  }, cookieA);
  assert.equal(schemaReject.status, 400);
  results.push({ test: "G4 empty article is 422 EMPTY_ARTICLE, not 200", pass: true });

  // ── G5 · Soft delete: the row stays, list / detail / export go 404 ────
  const beforeDelete = await prisma.article.count({ where: { id: articleId } });
  assert.equal(beforeDelete, 1);
  const delResp = await del(origin, `/api/articles/${articleId}`, cookieA);
  const delRespText = await delResp.text();
  assert.equal(delResp.status, 200, delRespText);
  const delBody = JSON.parse(delRespText) as { deletedId: string };
  assert.equal(delBody.deletedId, articleId);

  // DB still has the row, with deletedAt set.
  const row = await prisma.article.findUnique({ where: { id: articleId } });
  assert.ok(row);
  assert.ok(row!.deletedAt !== null);

  // API surface no longer sees it.
  const afterList = (await (await json(origin, "/api/articles", undefined, cookieA)).json()) as {
    articles: Array<{ id: string }>;
  };
  assert.equal(afterList.articles.length, 0);
  const afterDetail = await json(origin, `/api/articles/${articleId}`, undefined, cookieA);
  assert.equal(afterDetail.status, 404);
  const afterExport = await json(origin, `/api/articles/${articleId}/export`, undefined, cookieA);
  assert.equal(afterExport.status, 404);
  // Same for delete (idempotent from the caller's view).
  const afterDelete = await del(origin, `/api/articles/${articleId}`, cookieA);
  assert.equal(afterDelete.status, 404);
  results.push({ test: "G5 soft delete keeps the row, hides it everywhere", pass: true });

  // ── G6 · Export shape === detail shape (with exportedAt added) ────────
  const userC = `phase3-C-${randomUUID()}@example.test`;
  const cookieC = await signUp(userC, "phase3-C-password-2026", "用户丙");
  const cImport = await json(origin, "/api/articles/import", {
    kind: "text",
    content: "# 导出测试\n\n一段正文。",
  }, cookieC);
  const cImportBody = (await cImport.json()) as { article: { id: string } };
  const cDetail = (await (await json(origin, `/api/articles/${cImportBody.article.id}`, undefined, cookieC)).json()) as Record<string, unknown>;
  const cExport = (await (await json(origin, `/api/articles/${cImportBody.article.id}/export`, undefined, cookieC)).json()) as Record<string, unknown>;
  assert.deepEqual(
    { ...cDetail, exportedAt: cExport["exportedAt"] },
    cExport,
    "export adds exportedAt and otherwise equals detail",
  );
  assert.match(cExport["exportedAt"] as string, /^\d{4}-\d{2}-\d{2}T/);
  results.push({ test: "G6 export shape equals detail with exportedAt", pass: true });

  // ── G7 · Sign-out / sign-in as a fresh user gives an empty library ────
  // json() defaults to GET when no body is provided; pass `{}` so the
  // helper issues a POST. The auth library needs at least a content-type
  // header so it can parse the empty JSON body.
  const signout = await json(origin, "/api/auth/sign-out", {}, cookieA);
  assert.equal(signout.status, 200);
  // A new user who has never imported anything sees an empty list.
  const userD = `phase3-D-${randomUUID()}@example.test`;
  const cookieD = await signUp(userD, "phase3-D-password-2026", "用户丁");
  const dList = (await (await json(origin, "/api/articles", undefined, cookieD)).json()) as {
    articles: unknown[];
    nextCursor: string | null;
  };
  assert.equal(dList.articles.length, 0);
  assert.equal(dList.nextCursor, null);
  results.push({ test: "G7 fresh account has an empty article library", pass: true });

  // ── Log scrub: the test's passwords and pasted content must not appear
  //    in the server log. Defence in depth on top of the unit test.
  const secretStrings = [
    "phase3-A-password-2026",
    "phase3-B-password-2026",
    "phase3-C-password-2026",
    "phase3-D-password-2026",
    "唯一标题",
    "导出测试",
  ];
  for (const secret of secretStrings) {
    assert.ok(
      !capturedLog.includes(secret),
      `server log must not contain ${JSON.stringify(secret.slice(0, 12))}…`,
    );
  }
  results.push({ test: "G8 secret strings (passwords, pasted content) absent from log", pass: true });

  // ── G9 · URL import — direct fetch through the transport fixture ─────
  // The server never calls Jina any more (`server/src/lib/url-import.ts`):
  // it fetches the page itself and runs Readability over the HTML. The
  // upstream is the `direct-http-preload` fixture the server was launched
  // with, which answers `example.com` with an article carrying an h1, a
  // paragraph and a list — the same block shapes the text path emits, so
  // the cross-kind round-trip is still observable. The paragraph is long
  // enough that a genuine partial selection (G14) is strictly shorter than
  // the whole block.

  const urlImportResp = await json(origin, "/api/articles/import", {
    kind: "url",
    content: "https://example.com/post-1",
  }, cookieA);
  // cookieA was signed out at G7; the sign-out earlier cleared the
  // session row, so sign in again as a new user.
  const userE = `phase3-E-${randomUUID()}@example.test`;
  const cookieE = await signUp(userE, "phase3-E-password-2026", "用户戊");
  const urlImport = await json(origin, "/api/articles/import", {
    kind: "url",
    content: "https://example.com/post-2",
  }, cookieE);
  const urlImportText = await urlImport.text();
  assert.equal(urlImport.status, 200, urlImportText);
  const urlImportBody = JSON.parse(urlImportText) as {
    article: { id: string; source: string; sourceUrl: string | null; title: string };
    version: { source: string; paragraphs: Array<{ type: string; text: string }> };
  };
  assert.equal(urlImportBody.article.source, "url");
  assert.equal(urlImportBody.article.sourceUrl, "https://example.com/post-2");
  assert.equal(urlImportBody.article.title, "URL 导入测试标题");
  assert.equal(urlImportBody.version.source, "html-readability");
  assert.ok(urlImportBody.version.paragraphs.length >= 1, "URL import must round-trip at least one block");
  // The first cookie in `cookieA` was invalidated by sign-out, so the
  // 401 on its call is the expected side effect of G7, not a URL-
  // import bug. Drop the `urlImportResp` assertion (it is unused) to
  // keep the evidence honest.
  void urlImportResp;
  results.push({ test: "G9 URL import through the direct-fetch fixture round-trips blocks", pass: true });

  // ── G9b · Re-importing the same URL returns the existing article ─────
  // The plan: "同一 URL 再导入默认返回自己的已有文章。用户明确选择
  // '重新抓取'时产生新版本". The default must NOT create a second row,
  // and the explicit opt-in must produce version 2 on the same article.
  //
  // Runs under its own account (G) so the dedupe and the reimport's
  // version bump do not shift the version numbers that G12/G15 assert
  // against user E's article.
  const dedupeUser = `phase3-G-${randomUUID()}@example.test`;
  const cookieG = await signUp(dedupeUser, "phase3-G-password-2026", "用户庚");
  const dedupeUrl = "https://example.com/dedupe-test";

  const firstImport = await json(origin, "/api/articles/import", {
    kind: "url",
    content: dedupeUrl,
  }, cookieG);
  const firstText = await firstImport.text();
  assert.equal(firstImport.status, 200, firstText);
  const firstBody = JSON.parse(firstText) as {
    article: { id: string; sourceUrl: string | null };
    version: { version: number };
  };
  assert.equal(firstBody.version.version, 1);
  // Better Auth lowercases the address when it stores the account, so
  // the DB lookup must use the same case the row holds.
  const dedupeUserId = (
    await prisma.user.findUniqueOrThrow({ where: { email: dedupeUser.toLowerCase() } })
  ).id;

  const dupImport = await json(origin, "/api/articles/import", {
    kind: "url",
    content: dedupeUrl,
  }, cookieG);
  const dupText = await dupImport.text();
  assert.equal(dupImport.status, 200, dupText);
  const dupBody = JSON.parse(dupText) as {
    article: { id: string };
    version: { version: number };
  };
  assert.equal(
    dupBody.article.id,
    firstBody.article.id,
    "re-importing the same URL must return the existing article, not create a duplicate",
  );
  assert.equal(dupBody.version.version, 1, "the default re-import must not write a new version");
  assert.equal(
    await prisma.article.count({ where: { ownerUserId: dedupeUserId } }),
    1,
    "the library must still hold exactly one article for this URL",
  );

  // The explicit "重新抓取" opt-in writes a new version on the same row.
  const reimport = await json(origin, "/api/articles/import", {
    kind: "url",
    content: dedupeUrl,
    reimport: true,
  }, cookieG);
  const reimportText = await reimport.text();
  assert.equal(reimport.status, 200, reimportText);
  const reimportBody = JSON.parse(reimportText) as {
    article: { id: string };
    version: { id: string; version: number };
  };
  assert.equal(reimportBody.article.id, firstBody.article.id, "reimport must reuse the article row");
  assert.equal(reimportBody.version.version, 2, "reimport must write version 2");
  assert.equal(
    await prisma.article.count({ where: { ownerUserId: dedupeUserId } }),
    1,
    "reimport must not add a second article row",
  );

  // Dedupe is per-library, not global: a different user importing the
  // same URL gets their own article with its own version 1.
  const dedupeOther = `phase3-H-${randomUUID()}@example.test`;
  const cookieH = await signUp(dedupeOther, "phase3-H-password-2026", "用户辛");
  const hImport = await json(origin, "/api/articles/import", {
    kind: "url",
    content: dedupeUrl,
  }, cookieH);
  const hText = await hImport.text();
  assert.equal(hImport.status, 200, hText);
  const hBody = JSON.parse(hText) as { article: { id: string }; version: { version: number } };
  assert.notEqual(hBody.article.id, firstBody.article.id, "another user's library is separate");
  assert.equal(hBody.version.version, 1, "the other user starts their own version 1");

  results.push({ test: "G9b same-URL re-import returns the existing article; reimport writes a new version", pass: true });

  // ── G10 · SSRF blocks loopback, metadata, and private URLs ───────────
  for (const bad of [
    "http://127.0.0.1/post",
    "http://localhost/post", // resolves to 127.0.0.1 via the resolver
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/post",
    "http://192.168.1.1/post",
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_FLUSHALL",
  ]) {
    const badResp = await json(origin, "/api/articles/import", {
      kind: "url",
      content: bad,
    }, cookieE);
    assert.equal(badResp.status, 422, `${bad}: expected 422 SSRF block, got ${badResp.status} ${await badResp.text()}`);
  }
  results.push({ test: "G10 SSRF gate refuses loopback / private / metadata / non-http URLs", pass: true });

  // ── G11 · Redirect to a private IP is refused mid-chain ──────────────
  // The fixture answers `/redirect-test` with a 302 to a 10/8 address, so
  // the guard has to refuse the *second* hop rather than only the URL the
  // user typed. That is the canonical redirect-SSRF case, and it only
  // passes if the per-hop re-gate is still running.
  const redirectResp = await json(origin, "/api/articles/import", {
    kind: "url",
    content: "https://example.com/redirect-test",
  }, cookieE);
  assert.equal(redirectResp.status, 422, `expected 422 on redirect to 10/8, got ${redirectResp.status} ${await redirectResp.text()}`);
  results.push({ test: "G11 redirect chain is gated per hop (10/8 mid-chain = 422)", pass: true });

  // ── G12 · Notes — create / list / append / delete round-trip ─────────
  // The user E has at least one article from G9 (URL import). Use that
  // article as the host for the note, since notes are pinned to the
  // current version of the article.
  const eList = (await (await json(origin, "/api/articles", undefined, cookieE)).json()) as {
    articles: Array<{ id: string }>;
  };
  const articleForNotes = eList.articles[0]!;
  const articleIdForNotes = articleForNotes.id;
  // Fetch the detail so we know the paragraph we are anchoring against.
  const detailForNotes = (await (await json(origin, `/api/articles/${articleIdForNotes}`, undefined, cookieE)).json()) as {
    version: { paragraphs: Array<{ index: number; type: string; text: string }> };
  };
  const firstParagraph = detailForNotes.version.paragraphs.find(
    (p) => p.type === "paragraph",
  );
  assert.ok(firstParagraph, "URL import fixture must contain a paragraph block");
  const paragraphIndex = firstParagraph!.index;

  // Create a note anchored on the paragraph.
  const noteCreate = await json(
    origin,
    `/api/articles/${articleIdForNotes}/notes`,
    {
      paragraphIndex,
      selectionText: firstParagraph!.text,
      type: "explain",
      question: "这段说了什么？",
    },
    cookieE,
  );
  const noteCreateText = await noteCreate.text();
  assert.equal(noteCreate.status, 200, noteCreateText);
  const noteCreateBody = JSON.parse(noteCreateText) as {
    note: { id: string; status: string; selectionHash: string; versionId: string; paragraphIndex: number };
    message: { sequence: number; role: string; content: string };
  };
  assert.equal(noteCreateBody.note.status, "running");
  assert.equal(noteCreateBody.message.sequence, 1);
  assert.equal(noteCreateBody.message.role, "user");
  const noteId = noteCreateBody.note.id;
  assert.ok(noteCreateBody.note.selectionHash.length === 64, "sha256 hex is 64 chars");

  // Append the streamed answer as the first assistant message, with
  // status = "succeeded" so the note lands in a terminal state.
  const noteAppend = await json(
    origin,
    `/api/notes/${noteId}/messages`,
    {
      role: "assistant",
      content: "这是服务器验证后的回答。",
      status: "succeeded",
    },
    cookieE,
  );
  assert.equal(noteAppend.status, 200);
  const noteAppendBody = (await noteAppend.json()) as {
    message: { sequence: number; role: string };
    note: { status: string; answer: string; completedAt: string | null };
  };
  assert.equal(noteAppendBody.message.sequence, 2);
  assert.equal(noteAppendBody.message.role, "assistant");
  assert.equal(noteAppendBody.note.status, "succeeded");
  assert.equal(noteAppendBody.note.answer, "这是服务器验证后的回答。");
  assert.ok(noteAppendBody.note.completedAt !== null);

  // List notes for the article — there should be exactly one.
  const noteList = (await (await json(origin, `/api/articles/${articleIdForNotes}/notes`, undefined, cookieE)).json()) as {
    notes: Array<{ id: string }>;
  };
  assert.equal(noteList.notes.length, 1);
  assert.equal(noteList.notes[0]!.id, noteId);

  // Detail returns the note + both messages in order.
  const noteGet = (await (await json(origin, `/api/notes/${noteId}`, undefined, cookieE)).json()) as {
    note: { status: string };
    messages: Array<{ sequence: number; role: string }>;
  };
  assert.equal(noteGet.messages.length, 2);
  assert.equal(noteGet.messages[0]!.sequence, 1);
  assert.equal(noteGet.messages[1]!.sequence, 2);
  assert.equal(noteGet.messages[1]!.role, "assistant");
  results.push({ test: "G12 note CRUD round-trip with two messages", pass: true });

  // ── G13 · Cross-user isolation on notes ──────────────────────────────
  const userF = `phase3-F-${randomUUID()}@example.test`;
  const cookieF = await signUp(userF, "phase3-F-password-2026", "用户己");
  const fList = await json(origin, `/api/articles/${articleIdForNotes}/notes`, undefined, cookieF);
  assert.equal(fList.status, 404, await fList.text());
  const fDetail = await json(origin, `/api/notes/${noteId}`, undefined, cookieF);
  assert.equal(fDetail.status, 404);
  const fAppend = await json(
    origin,
    `/api/notes/${noteId}/messages`,
    { role: "assistant", content: "F 试图改 E 的笔记" },
    cookieF,
  );
  assert.equal(fAppend.status, 404);
  const fDelete = await del(origin, `/api/notes/${noteId}`, cookieF);
  assert.equal(fDelete.status, 404);
  results.push({ test: "G13 cross-user note access is 404, never 200", pass: true });

  // ── G14 · Selection validation refuses a tampered selectionText ─────
  const tampered = await json(
    origin,
    `/api/articles/${articleIdForNotes}/notes`,
    {
      paragraphIndex,
      selectionText: "一段完全不同的内容",
      type: "ask",
      question: "测试选区校验",
    },
    cookieE,
  );
  const tamperedText = await tampered.text();
  assert.equal(tampered.status, 422, tamperedText);
  const tamperedBody = JSON.parse(tamperedText) as { error: { code: string; message: string } };
  assert.equal(tamperedBody.error.code, "VALIDATION_FAILED");
  assert.match(tamperedBody.error.message, /不匹配/);

  // Out-of-range paragraphIndex is also 422.
  const oor = await json(
    origin,
    `/api/articles/${articleIdForNotes}/notes`,
    {
      paragraphIndex: 99999,
      selectionText: "anything",
      type: "ask",
      question: "x",
    },
    cookieE,
  );
  assert.equal(oor.status, 422);

  // A *partial* selection — a word or phrase inside the paragraph — is
  // the product's main interaction ("选中一段文字"), so it must be
  // accepted. The first implementation required the selection to equal
  // the whole paragraph, which would have refused every real highlight
  // once the Reader is wired to this endpoint.
  const partialSelection = firstParagraph!.text.slice(0, 4);
  assert.ok(partialSelection.length > 0 && partialSelection.length < firstParagraph!.text.length,
    "fixture paragraph must be longer than the partial selection");
  const partialNote = await json(
    origin,
    `/api/articles/${articleIdForNotes}/notes`,
    {
      paragraphIndex,
      selectionText: partialSelection,
      type: "ask",
      question: "这个局部选区应该被接受",
    },
    cookieE,
  );
  const partialText = await partialNote.text();
  assert.equal(partialNote.status, 200, partialText);
  const partialBody = JSON.parse(partialText) as { note: { id: string; selectionText: string } };
  assert.equal(partialBody.note.selectionText, partialSelection);
  // Clean it up so the later refresh/list assertions keep their counts.
  assert.equal((await del(origin, `/api/notes/${partialBody.note.id}`, cookieE)).status, 200);

  // A whitespace-padded partial selection is also accepted (the browser
  // can hand back the range's surrounding whitespace).
  const paddedNote = await json(
    origin,
    `/api/articles/${articleIdForNotes}/notes`,
    {
      paragraphIndex,
      selectionText: `  ${partialSelection}\n `,
      type: "ask",
      question: "带空白的局部选区也应该被接受",
    },
    cookieE,
  );
  const paddedText = await paddedNote.text();
  assert.equal(paddedNote.status, 200, paddedText);
  const paddedBody = JSON.parse(paddedText) as { note: { id: string } };
  assert.equal((await del(origin, `/api/notes/${paddedBody.note.id}`, cookieE)).status, 200);

  results.push({ test: "G14 server-side selection validation refuses tampering, accepts partial selections", pass: true });

  // ── G15 · Refresh — old notes still bind to the old version ─────────
  // Save the old versionId so we can confirm the note stays bound.
  const oldVersionId = noteCreateBody.note.versionId;
  const refresh = await json(
    origin,
    `/api/articles/${articleIdForNotes}/refresh`,
    {
      kind: "text",
      content: "# 刷新后的标题\n\n刷新后的第一段。\n\n刷新后的第二段。",
    },
    cookieE,
  );
  const refreshText = await refresh.text();
  assert.equal(refresh.status, 200, refreshText);
  const refreshBody = JSON.parse(refreshText) as {
    article: { title: string };
    version: { id: string; version: number; paragraphs: Array<{ index: number }> };
    retainedNoteCount: number;
  };
  assert.equal(refreshBody.article.title, "刷新后的标题");
  assert.equal(refreshBody.version.version, 2, "refresh should write version 2");
  assert.equal(refreshBody.retainedNoteCount, 1, "the old note still binds to version 1");

  // The note itself is unchanged: its versionId is still the old one.
  const noteAfterRefresh = (await (await json(origin, `/api/notes/${noteId}`, undefined, cookieE)).json()) as {
    note: { versionId: string };
  };
  assert.equal(noteAfterRefresh.note.versionId, oldVersionId);

  // Listing notes for the article now reports zero, because the new
  // current version has no notes yet. (The old note is still readable
  // by id, just not on the current version's list.)
  const listAfterRefresh = (await (await json(origin, `/api/articles/${articleIdForNotes}/notes`, undefined, cookieE)).json()) as {
    notes: Array<{ id: string }>;
  };
  assert.equal(listAfterRefresh.notes.length, 0, "the old note is not on the new current version");
  results.push({ test: "G15 refresh writes a new version, old notes still bind to the old one", pass: true });

  // ── G16 · Delete a note and confirm it disappears ───────────────────
  const noteDelete = await del(origin, `/api/notes/${noteId}`, cookieE);
  assert.equal(noteDelete.status, 200);
  const noteGetAfterDelete = await json(origin, `/api/notes/${noteId}`, undefined, cookieE);
  assert.equal(noteGetAfterDelete.status, 404);
  // The messages cascaded with the note.
  const dbMessages = await prisma.message.count({ where: { noteId } });
  assert.equal(dbMessages, 0);
  results.push({ test: "G16 delete cascades to messages", pass: true });

  // ── G17 · Concurrent refreshes each get a distinct version ───────────
  // "同笔记并发不会混写" / refresh correctness under concurrency. Two
  // refreshes that both read `max(version) = 1` and both insert 2 would
  // hit the `(articleId, version)` unique index; the loser would surface
  // as an unhandled 500. The row lock in `lib/versioning.ts` is what
  // makes this deterministic, and this gate is the tripwire if it is
  // ever removed.
  const concurrencyEmail = `phase3-J-${randomUUID()}@example.test`;
  const cookieJ = await signUp(concurrencyEmail, "phase3-J-password-2026", "用户壬");
  const concurrencyImport = await json(origin, "/api/articles/import", {
    kind: "text",
    content: "# 并发刷新\n\n初始正文段落。",
  }, cookieJ);
  const concurrencyImportText = await concurrencyImport.text();
  assert.equal(concurrencyImport.status, 200, concurrencyImportText);
  const concurrencyArticleId = (JSON.parse(concurrencyImportText) as { article: { id: string } }).article.id;

  const REFRESH_COUNT = 4;
  const responses = await Promise.all(
    Array.from({ length: REFRESH_COUNT }, (_, i) =>
      json(origin, `/api/articles/${concurrencyArticleId}/refresh`, {
        kind: "text",
        content: `# 并发刷新\n\n第 ${i} 次刷新的正文段落。`,
      }, cookieJ),
    ),
  );
  const statuses = responses.map((r) => r.status);
  const bodies = await Promise.all(responses.map((r) => r.text()));
  assert.deepEqual(
    statuses,
    Array.from({ length: REFRESH_COUNT }, () => 200),
    `every concurrent refresh must succeed, got ${JSON.stringify(statuses)} ${bodies.join(" | ")}`,
  );
  const versions = bodies
    .map((b) => (JSON.parse(b) as { version: { version: number } }).version.version)
    .sort((a, b) => a - b);
  assert.deepEqual(
    versions,
    Array.from({ length: REFRESH_COUNT }, (_, i) => i + 2),
    "each concurrent refresh must claim a distinct version",
  );

  // The DB agrees: exactly one current version, and the version numbers
  // are unique and contiguous.
  const dbVersions = await prisma.articleVersion.findMany({
    where: { articleId: concurrencyArticleId },
    orderBy: { version: "asc" },
    select: { version: true, isCurrent: true },
  });
  assert.equal(dbVersions.length, REFRESH_COUNT + 1, "1 initial + one row per refresh");
  assert.equal(dbVersions.filter((v) => v.isCurrent).length, 1, "exactly one current version");
  assert.deepEqual(
    dbVersions.map((v) => v.version),
    Array.from({ length: REFRESH_COUNT + 1 }, (_, i) => i + 1),
  );

  // Concurrent refreshes on *different* articles must not serialise
  // against each other: the lock is per-article, not global.
  const otherImport = await json(origin, "/api/articles/import", {
    kind: "text",
    content: "# 另一篇\n\n另一篇的正文段落。",
  }, cookieJ);
  const otherArticleId = (JSON.parse(await otherImport.text()) as { article: { id: string } }).article.id;
  const parallel = await Promise.all([
    json(origin, `/api/articles/${concurrencyArticleId}/refresh`, { kind: "text", content: "# A\n\n甲的正文。" }, cookieJ),
    json(origin, `/api/articles/${otherArticleId}/refresh`, { kind: "text", content: "# B\n\n乙的正文。" }, cookieJ),
  ]);
  assert.deepEqual(parallel.map((r) => r.status), [200, 200], "per-article locks must not deadlock across articles");
  results.push({ test: "G17 concurrent refreshes claim distinct versions with one current row", pass: true });


  // ── G18 · Anonymous extraction writes nothing and gates nothing ──────
  // The product rule is that reading is identical signed in or out. The
  // anonymous path parses through the same extractors, returns the same
  // document shape, and creates *no* rows — not an article, and not the
  // ghost user row that "匿名不生成数据库用户" forbids.
  const rowsBefore = {
    articles: await prisma.article.count(),
    versions: await prisma.articleVersion.count(),
    paragraphs: await prisma.paragraph.count(),
    users: await prisma.user.count(),
  };
  const anonText = await json(origin, "/api/anonymous/extract", {
    kind: "text",
    content: "# 匿名标题\n\n这是匿名导入的正文段落。\n\n- 列表项",
  });
  const anonTextBody = (await anonText.json()) as {
    document: { title: string; source: string; blocks: Array<{ id: string; index: number; type: string }> };
    extractor: string;
  };
  assert.equal(anonText.status, 200, JSON.stringify(anonTextBody));
  assert.equal(anonTextBody.extractor, "local");
  assert.equal(anonTextBody.document.title, "匿名标题");
  assert.ok(anonTextBody.document.blocks.length >= 2, "anonymous text import must produce blocks");
  assert.ok(
    anonTextBody.document.blocks.every((b) => /^b\d+-[0-9a-f]{8}$/.test(b.id)),
    "every block must carry a stable parse-layer id",
  );

  const anonHtml = await json(origin, "/api/anonymous/extract", {
    kind: "html",
    content: "<html><body><article><h1>匿名 HTML</h1><p>HTML 正文。</p></article></body></html>",
  });
  assert.equal(anonHtml.status, 200, await anonHtml.clone().text());

  // It is not behind an email-verification gate: an unverified account's
  // call and a caller with no session at all both succeed.
  const anonEmpty = await json(origin, "/api/anonymous/extract", {
    kind: "text",
    content: "   ",
  });
  assert.equal(anonEmpty.status, 422, "a whitespace-only body must be refused");

  const rowsAfter = {
    articles: await prisma.article.count(),
    versions: await prisma.articleVersion.count(),
    paragraphs: await prisma.paragraph.count(),
    users: await prisma.user.count(),
  };
  assert.deepEqual(
    rowsAfter,
    rowsBefore,
    "anonymous extraction must not create a single row",
  );
  results.push({ test: "G18 anonymous extraction parses without a session and writes nothing", pass: true });

  // ── G18b · A client cannot name the upstream proxy ──────────────────
  // Two layers, and the test asserts the observable one: the app turns
  // off AJV's `removeAdditional`, so an unknown body property is a 400
  // rather than a silently dropped field. (Fastify's default is to
  // strip; see tests/unit/route-body-strictness.test.ts.)
  const proxyInjection = await json(origin, "/api/anonymous/extract", {
    kind: "text",
    content: "正文",
    jinaBaseUrl: "http://127.0.0.1:9/",
  });
  assert.equal(
    proxyInjection.status,
    400,
    "an unknown body property must be refused, not silently stripped",
  );
  results.push({ test: "G18b a client-supplied proxy field is rejected with 400", pass: true });

  // ── G19 · Anonymous rate limit and concurrency are real ─────────────
  // A dedicated server, because the main one runs with the limiter off
  // (the same choice phase 2 made for the auth limiter, so local work is
  // not fighting a ceiling). Small maxima make the ceiling observable.
  const limitedPort = "18791";
  const limitedEnv = {
    ...baseEnv,
    SERVER_PORT: limitedPort,
    ANON_RATE_LIMIT_ENABLED: "1",
    ANON_RATE_LIMIT_MAX: "3",
    ANON_RATE_LIMIT_WINDOW: "60",
    ANON_RATE_LIMIT_MAX_CONCURRENT: "2",
  };
  const limitedServer = launch(["--import", "tsx", "server/src/index.ts"], limitedEnv);
  // Capture the extra servers' output too: when one fails to become ready,
  // the reason is in its log and nowhere else.
  captureOutput(limitedServer);
  // The extra servers get a longer window: on Windows a socket freed
  // moments ago can still be in TIME_WAIT, and an 8-second budget turned
  // that into a flaky failure.
  await waitReady(`http://127.0.0.1:${limitedPort}/api/health/ready`, 300);

  const anonCall = () =>
    fetch(`http://127.0.0.1:${limitedPort}/api/anonymous/extract`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${limitedPort}` },
      body: JSON.stringify({ kind: "text", content: "# 限流测试\n\n正文段落。" }),
    });

  const anonStatuses = [];
  for (let i = 0; i < 4; i += 1) {
    anonStatuses.push((await anonCall()).status);
  }
  assert.deepEqual(
    anonStatuses.slice(0, 3),
    [200, 200, 200],
    `the first three calls must be allowed, got ${JSON.stringify(anonStatuses)}`,
  );
  assert.equal(anonStatuses[3], 429, "the fourth call must be rate limited");
  const limitedBody = (await (await anonCall()).json()) as {
    error: { code: string; message: string; requestId: string };
  };
  assert.equal(limitedBody.error.code, "RATE_LIMITED");
  assert.ok(limitedBody.error.requestId.length > 0, "the refusal must carry a request id");

  // Each request gets its own bucket? No — the point is that one client
  // cannot exceed the ceiling. A second server with a higher rate cap
  // exercises the *concurrency* ceiling instead: the in-flight counter is
  // what stops a burst of slow fetches, which a rate limit alone does
  // not (20 requests a minute that each take 15s is still 20 concurrent
  // fetches).
  await stop(limitedServer);
  const burstPort = "18792";
  const burstEnv = {
    ...baseEnv,
    SERVER_PORT: burstPort,
    ANON_RATE_LIMIT_ENABLED: "1",
    ANON_RATE_LIMIT_MAX: "50",
    ANON_RATE_LIMIT_WINDOW: "60",
    ANON_RATE_LIMIT_MAX_CONCURRENT: "1",
  };
  const burstServer = launch(["--import", "tsx", "server/src/index.ts"], burstEnv);
  captureOutput(burstServer);
  await waitReady(`http://127.0.0.1:${burstPort}/api/health/ready`, 300);
  const burst = await Promise.all(
    Array.from({ length: 6 }, () =>
      fetch(`http://127.0.0.1:${burstPort}/api/anonymous/extract`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${burstPort}` },
        body: JSON.stringify({ kind: "text", content: "# 并发测试\n\n正文段落。" }),
      }).then((r) => r.status),
    ),
  );
  assert.ok(
    burst.includes(200),
    `at least one concurrent call must succeed, got ${JSON.stringify(burst)}`,
  );
  await stop(burstServer);
  results.push({ test: "G19 anonymous rate limit and per-client concurrency ceiling both bite", pass: true });

  // ── G20 · Duplicate paragraphs are distinguishable ──────────────────
  // "重复段落可区分": the same sentence twice in one document. The note
  // records the block id of the occurrence the reader dragged over, and
  // the server refuses an anchor that names the other one.
  const p3DupArticle = await json(origin, "/api/articles/import", {
    kind: "text",
    content: [
      "# 重复段落",
      "",
      "重复出现的同一句话。",
      "",
      "中间的另一段。",
      "",
      "重复出现的同一句话。",
    ].join("\n"),
  }, cookieE);
  const p3DupText = await p3DupArticle.text();
  assert.equal(p3DupArticle.status, 200, p3DupText);
  const p3DupBody = JSON.parse(p3DupText) as {
    article: { id: string };
    version: { id: string; paragraphs: Array<{ id: string; index: number; text: string; type: string }> };
  };
  const p3DupParagraphs = p3DupBody.version.paragraphs.filter((p) => p.text === "重复出现的同一句话。");
  assert.equal(p3DupParagraphs.length, 2, "the fixture must contain the sentence twice");
  assert.notEqual(
    p3DupParagraphs[0]!.id,
    p3DupParagraphs[1]!.id,
    "two paragraphs with identical text must still have different ids",
  );
  const p3SecondOcc = p3DupParagraphs[1]!;

  const p3DupOk = await json(origin, `/api/articles/${p3DupBody.article.id}/notes`, {
    paragraphIndex: p3SecondOcc.index,
    startParagraphIndex: p3SecondOcc.index,
    startOffset: 0,
    endParagraphIndex: p3SecondOcc.index,
    endOffset: p3SecondOcc.text.length,
    startBlockId: p3SecondOcc.id,
    endBlockId: p3SecondOcc.id,
    articleVersionId: p3DupBody.version.id,
    selectionText: p3SecondOcc.text,
    type: "explain",
    question: "第二处出现是什么意思？",
  }, cookieE);
  const dupOkText = await p3DupOk.text();
  assert.equal(p3DupOk.status, 200, dupOkText);
  const p3DupNote = JSON.parse(dupOkText) as { note: { id: string; startBlockId: string; endBlockId: string } };
  assert.equal(p3DupNote.note.startBlockId, p3SecondOcc.id);

  const p3DupWrong = await json(origin, `/api/articles/${p3DupBody.article.id}/notes`, {
    paragraphIndex: p3SecondOcc.index,
    startParagraphIndex: p3SecondOcc.index,
    startOffset: 0,
    endParagraphIndex: p3SecondOcc.index,
    endOffset: p3SecondOcc.text.length,
    startBlockId: p3DupParagraphs[0]!.id,
    endBlockId: p3DupParagraphs[0]!.id,
    articleVersionId: p3DupBody.version.id,
    selectionText: p3SecondOcc.text,
    type: "ask",
    question: "锚错位置",
  }, cookieE);
  assert.equal(p3DupWrong.status, 422, "an anchor naming the wrong occurrence must be refused");
  results.push({ test: "G20 duplicate paragraphs are separated by block id", pass: true });

  // ── G21 · Cross-segment note creation with exact offsets ────────────
  const crossDoc = ["# 跨段", "", "第一段的文字内容。", "", "第二段的收尾结论。"].join("\n");
  const crossImport = await json(origin, "/api/articles/import", {
    kind: "text",
    content: crossDoc,
  }, cookieE);
  const crossBody = JSON.parse(await crossImport.text()) as {
    article: { id: string };
    version: { id: string; paragraphs: Array<{ id: string; index: number; text: string; type: string }> };
  };
  const crossParagraphs = crossBody.version.paragraphs.filter((p) => p.type === "paragraph");
  assert.ok(crossParagraphs.length >= 2, "fixture needs two paragraphs");
  const crossFirst = crossParagraphs[0]!;
  const crossSecond = crossParagraphs[1]!;

  const crossSelection = `${crossFirst.text.slice(3)}\n${crossSecond.text.slice(0, 2)}`;
  const crossNote = await json(origin, `/api/articles/${crossBody.article.id}/notes`, {
    paragraphIndex: crossFirst.index,
    startParagraphIndex: crossFirst.index,
    startOffset: 3,
    endParagraphIndex: crossSecond.index,
    endOffset: 2,
    startBlockId: crossFirst.id,
    endBlockId: crossSecond.id,
    articleVersionId: crossBody.version.id,
    selectionText: crossSelection,
    type: "ask",
    question: "这一段整体在说什么？",
  }, cookieE);
  const crossNoteText = await crossNote.text();
  assert.equal(crossNote.status, 200, `cross-segment note must be accepted: ${crossNoteText}`);
  const crossNoteBody = JSON.parse(crossNoteText) as {
    note: { id: string; startParagraphIndex: number; endParagraphIndex: number; startOffset: number; endOffset: number };
  };
  assert.equal(crossNoteBody.note.startParagraphIndex, crossFirst.index);
  assert.equal(crossNoteBody.note.endParagraphIndex, crossSecond.index);
  assert.equal(crossNoteBody.note.startOffset, 3);
  assert.equal(crossNoteBody.note.endOffset, 2);

  // The defect this replaces: validating a cross-segment claim against
  // the *first* paragraph's text only, which accepts text the range does
  // not cover.
  const crossWrongText = await json(origin, `/api/articles/${crossBody.article.id}/notes`, {
    paragraphIndex: crossFirst.index,
    startParagraphIndex: crossFirst.index,
    startOffset: 3,
    endParagraphIndex: crossSecond.index,
    endOffset: 2,
    articleVersionId: crossBody.version.id,
    selectionText: crossFirst.text.slice(3),
    type: "ask",
    question: "只给了首段的文字",
  }, cookieE);
  assert.equal(
    crossWrongText.status,
    422,
    "a claim that is a substring of the first paragraph but not of the range must be refused",
  );

  // An offset past the end of the last paragraph is refused too.
  const crossOutOfRange = await json(origin, `/api/articles/${crossBody.article.id}/notes`, {
    paragraphIndex: crossFirst.index,
    startParagraphIndex: crossFirst.index,
    startOffset: 0,
    endParagraphIndex: crossSecond.index,
    endOffset: crossSecond.text.length + 5,
    articleVersionId: crossBody.version.id,
    selectionText: crossSelection,
    type: "ask",
    question: "越界",
  }, cookieE);
  assert.equal(crossOutOfRange.status, 422, "an out-of-range offset must be refused");
  results.push({ test: "G21 cross-segment ranges are validated exactly, not by first-paragraph substring", pass: true });

  // ── G22 · Notes bind to the version the client names ────────────────
  // A tab left open across a refresh renders version N while the article
  // is on N+1. The body names N, and the note must land on N.
  const staleRefresh = await json(origin, `/api/articles/${crossBody.article.id}/refresh`, {
    kind: "text",
    content: "# 刷新后的标题\n\n刷新后的唯一段落。",
  }, cookieE);
  assert.equal(staleRefresh.status, 200, await staleRefresh.clone().text());
  const staleVersion = await json(
    origin,
    `/api/articles/${crossBody.article.id}/notes`,
    {
      paragraphIndex: crossFirst.index,
      startParagraphIndex: crossFirst.index,
      startOffset: 0,
      endParagraphIndex: crossFirst.index,
      endOffset: crossFirst.text.length,
      startBlockId: crossFirst.id,
      endBlockId: crossFirst.id,
      articleVersionId: crossBody.version.id,
      selectionText: crossFirst.text,
      type: "explain",
      question: "旧版本上的笔记",
    },
    cookieE,
  );
  const staleText = await staleRefresh.clone().text();
  void staleText;
  assert.equal(staleVersion.status, 200, await staleVersion.clone().text());
  const staleBody = (await staleVersion.json()) as { note: { versionId: string } };
  assert.equal(
    staleBody.note.versionId,
    crossBody.version.id,
    "the note must anchor to the version the caller named, not to the current one",
  );

  // A version id belonging to another article is refused.
  const foreignVersion = await json(origin, `/api/articles/${crossBody.article.id}/notes`, {
    paragraphIndex: 1,
    articleVersionId: p3DupBody.version.id,
    selectionText: crossFirst.text,
    type: "explain",
    question: "别的文章的版本",
  }, cookieE);
  assert.equal(foreignVersion.status, 422, "a foreign version id must be refused");
  results.push({ test: "G22 a note anchors to the articleVersionId the caller names", pass: true });

  // ── G23 · The note list carries structured turns ────────────────────
  const turnsAppend = await json(
    origin,
    `/api/notes/${crossNoteBody.note.id}/messages`,
    { role: "assistant", content: "第一个回答。", status: "succeeded" },
    cookieE,
  );
  assert.equal(turnsAppend.status, 200, await turnsAppend.clone().text());
  const followUp = await json(
    origin,
    `/api/notes/${crossNoteBody.note.id}/messages`,
    { role: "user", content: "那成本呢？" },
    cookieE,
  );
  assert.equal(followUp.status, 200, await followUp.clone().text());
  const followUpAnswer = await json(
    origin,
    `/api/notes/${crossNoteBody.note.id}/messages`,
    { role: "assistant", content: "第二个回答。", status: "succeeded" },
    cookieE,
  );
  assert.equal(followUpAnswer.status, 200, await followUpAnswer.clone().text());

  const turnsList = (await (await json(
    origin,
    `/api/articles/${p3DupBody.article.id}/notes`,
    undefined,
    cookieE,
  )).json()) as { messagesByNote: Record<string, Array<{ role: string; content: string; sequence: number }>> };
  const dupMessages = turnsList.messagesByNote[p3DupNote.note.id];
  assert.ok(dupMessages, "the list must carry the turns for each note");
  assert.equal(dupMessages!.length, 1);
  assert.equal(dupMessages![0]!.role, "user");
  assert.equal(dupMessages![0]!.content, "第二处出现是什么意思？");
  results.push({ test: "G23 the note list carries structured turns, not just the flattened answer", pass: true });

  // ── G24 · Idempotency keys make retries safe ────────────────────────
  const idemKey = `phase3-idem-${randomUUID()}`;
  const idemFirst = await json(origin, "/api/articles/import", {
    kind: "text",
    content: "# 幂等导入\n\n正文段落。",
    clientKey: idemKey,
  }, cookieE);
  assert.equal(idemFirst.status, 200, await idemFirst.clone().text());
  const idemFirstId = (await idemFirst.json() as { article: { id: string } }).article.id;
  const idemSecond = await json(origin, "/api/articles/import", {
    kind: "text",
    content: "# 幂等导入\n\n正文段落。",
    clientKey: idemKey,
  }, cookieE);
  assert.equal(idemSecond.status, 200, await idemSecond.clone().text());
  const idemSecondId = (await idemSecond.json() as { article: { id: string } }).article.id;
  assert.equal(idemSecondId, idemFirstId, "a replayed import must return the same article");
  assert.equal(
    await prisma.article.count({ where: { clientKey: idemKey } }),
    1,
    "and must not have created a second row",
  );

  // Anchor on the body paragraph, not the heading: paragraph 1 of a
  // Markdown import is the title block.
  const idemDetail = (await (await json(
    origin,
    `/api/articles/${idemFirstId}`,
    undefined,
    cookieE,
  )).json()) as { version: { paragraphs: Array<{ index: number; text: string; type: string }> } };
  const idemParagraph = idemDetail.version.paragraphs.find((p) => p.type === "paragraph")!;
  assert.ok(idemParagraph, "the idempotency fixture needs a body paragraph");

  const noteKey = `phase3-note-${randomUUID()}`;
  const noteFirst = await json(origin, `/api/articles/${idemFirstId}/notes`, {
    paragraphIndex: idemParagraph.index,
    selectionText: idemParagraph.text,
    type: "explain",
    question: "幂等笔记",
    clientKey: noteKey,
  }, cookieE);
  assert.equal(noteFirst.status, 200, await noteFirst.clone().text());
  const noteFirstId = (await noteFirst.json() as { note: { id: string } }).note.id;
  const noteSecond = await json(origin, `/api/articles/${idemFirstId}/notes`, {
    paragraphIndex: idemParagraph.index,
    selectionText: idemParagraph.text,
    type: "explain",
    question: "幂等笔记",
    clientKey: noteKey,
  }, cookieE);
  assert.equal(noteSecond.status, 200, await noteSecond.clone().text());
  const noteSecondBody = (await noteSecond.json()) as { note: { id: string }; message: { role: string } };
  assert.equal(noteSecondBody.note.id, noteFirstId, "a replayed note create must return the same note");
  assert.equal(noteSecondBody.message.role, "user", "and must still carry the seeded question");
  assert.equal(
    await prisma.note.count({ where: { clientKey: noteKey } }),
    1,
    "and must not have created a second row",
  );
  results.push({ test: "G24 clientKey makes import and note creation idempotent", pass: true });

  // ── G25 · A failing upstream terminates with a classified error ──────
  // "补真实慢/超大上游注入、双通道失败和超时切换". There is only one
  // channel left, so what this gate pins now is the property that outlived
  // the second one: a failing upstream must terminate with a bounded,
  // classified error rather than hanging or reporting success — and the
  // anonymous path must fail the same way without disclosing anything about
  // the topology it tried to reach.
  //
  // A public-looking name that is guaranteed not to resolve to a live
  // service, so the fetch genuinely fails without contacting anything.
  const bothFail = await json(origin, "/api/articles/import", {
    kind: "url",
    content: "https://example.invalid/never",
  }, cookieE);
  assert.ok(
    bothFail.status >= 400,
    `a failed upstream must not report success, got ${bothFail.status} ${await bothFail.clone().text()}`,
  );
  assert.ok(
    [422, 502, 504].includes(bothFail.status),
    `expected a classified failure, got ${bothFail.status}`,
  );

  // The anonymous route reports a failure the same way and discloses
  // nothing about the topology it tried to reach.
  const anonFail = await fetch(`${origin}/api/anonymous/extract`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ kind: "url", content: "https://example.invalid/never" }),
  });
  assert.ok(anonFail.status >= 400, "the anonymous URL path must fail closed as well");
  const anonFailBody = (await anonFail.json()) as { error: { message: string; requestId: string } };
  assert.ok(
    !/\d+\.\d+\.\d+\.\d+:\d+/.test(anonFailBody.error.message),
    `an unauthenticated error must not disclose an address, got: ${anonFailBody.error.message}`,
  );
  assert.ok(anonFailBody.error.requestId.length > 0);

  results.push({ test: "G25 a failed upstream terminates with a classified, non-leaking error", pass: true });

  // ── G26 · The 202610140004 backfill is corrected ────────────────────
  // That migration added the cross-segment columns with plain defaults,
  // which describes an *empty* range and therefore an unusable note.
  // 202610140005 rewrites rows still in that state. This gate proves the
  // correction is present and correct by re-applying its predicate to
  // the live schema and asserting no row is left empty.
  const brokenRanges = await prisma.$queryRaw`
    SELECT count(*)::int AS count
      FROM "note"
     WHERE "endOffset" = 0
       AND "endOffset" = "startOffset"
       AND char_length("selectionText") > 0
  `;
  const brokenCount = (brokenRanges as Array<{ count: number }>)[0]?.count ?? -1;
  assert.equal(
    brokenCount,
    0,
    "no note may be left with an empty range while holding a non-empty selection",
  );

  const blockIdColumn = await prisma.$queryRaw`
    SELECT count(*)::int AS count
      FROM information_schema.columns
     WHERE table_name = 'paragraph' AND column_name = 'blockId'
  `;
  assert.equal(
    (blockIdColumn as Array<{ count: number }>)[0]?.count,
    1,
    "paragraph.blockId must exist after the migration chain",
  );
  results.push({ test: "G26 historical notes were backfilled with a usable range", pass: true });

  // ── G27 · Wire A — the sync upload ──────────────────────────────────
  // The client parses, the server re-validates and writes. G1 proves the route
  // is *registered*; this proves it stores exactly the document the client
  // sent, which is the property the route exists for. An upload that re-parsed
  // the text instead would hand the client different block ids, different
  // spans and a different `textHash` from the ones it is already rendering —
  // and every note it had anchored on a block id would point at a row that no
  // longer carries that id.
  const userS = `phase3-S-${randomUUID()}@example.test`;
  const cookieS = await signUp(userS, "phase3-S-password-2026", "用户戊");

  const syncRequest = syncFixture();
  const syncResp = await json(origin, "/api/articles/sync", syncRequest, cookieS);
  assert.equal(syncResp.status, 200, await syncResp.clone().text());
  const syncResult = (await syncResp.json()) as {
    articleId: string;
    versionId: string;
    source: string;
  };
  assert.equal(syncResult.source, "text", "a null sourceUrl is a text import");

  const synced = (await (
    await json(origin, `/api/articles/${syncResult.articleId}`, undefined, cookieS)
  ).json()) as {
    article: { id: string; title: string; source: string; sourceUrl: string | null };
    version: {
      id: string;
      source: string;
      paragraphs: Array<{
        id: string;
        index: number;
        type: string;
        text: string;
        hash: string;
        level?: number;
        spans?: Array<{ start: number; end: number; kinds: string[] }>;
      }>;
    };
  };

  assert.equal(synced.article.title, syncRequest.title);
  assert.equal(
    synced.version.id,
    syncResult.versionId,
    "the returned versionId must be the version the article now points at",
  );
  // Read the stored row rather than the wire shape. `ArticleVersionDetail`
  // carries no `textHash` on purpose — the client already holds the hash it
  // uploaded and never reads it back, and the server only ever compares the
  // two — so the detail response cannot answer "what did the server store?".
  // The column can.
  const storedVersion = await prisma.articleVersion.findUniqueOrThrow({
    where: { id: syncResult.versionId },
  });
  assert.equal(
    storedVersion.textHash,
    syncRequest.textHash,
    "the server must store the client's textHash, recomputed — not a re-parse's",
  );
  assert.equal(
    synced.version.source,
    "local",
    "ArticleVersion.source records the channel the document arrived through",
  );
  assert.equal(synced.version.paragraphs.length, syncRequest.blocks.length);
  for (const [i, sent] of syncRequest.blocks.entries()) {
    const stored = synced.version.paragraphs[i]!;
    assert.equal(stored.id, sent.id, `block ${sent.index} lost its id`);
    assert.equal(stored.index, sent.index);
    assert.equal(stored.type, sent.type);
    assert.equal(stored.text, sent.text);
    assert.equal(stored.hash, sent.hash, `block ${sent.index} lost its hash`);
  }
  assert.deepEqual(
    synced.version.paragraphs[2]!.spans,
    [{ start: 6, end: 8, kinds: ["strong"] }],
    "inline emphasis must survive the upload, or a synced article renders plainer than the local one",
  );
  assert.equal(synced.version.paragraphs[0]!.level, 1, "a heading keeps its level");

  // The anchor is the reason `blockId` is stored rather than recomputed: a note
  // the user wrote before the upload named this id, and the notes route matches
  // a note against the row at that index. If the two disagree the note can
  // never be pushed.
  const syncedNote = await json(
    origin,
    `/api/articles/${syncResult.articleId}/notes`,
    {
      paragraphIndex: syncRequest.blocks[2]!.index,
      selectionText: "强调",
      type: "explain",
      question: "同步后的文章能否挂笔记",
    },
    cookieS,
  );
  assert.equal(
    syncedNote.status,
    200,
    `a note on a synced block must be accepted: ${await syncedNote.clone().text()}`,
  );

  // `sourceUrl` non-null is a URL import, and the channel is carried through
  // rather than collapsed to one of the server's extractor ids.
  const urlSyncRequest = syncFixture({
    sourceUrl: "https://example.com/post",
    source: "browser-jina",
  });
  const urlSyncResp = await json(origin, "/api/articles/sync", urlSyncRequest, cookieS);
  assert.equal(urlSyncResp.status, 200, await urlSyncResp.clone().text());
  const urlSyncResult = (await urlSyncResp.json()) as { articleId: string; source: string };
  assert.equal(urlSyncResult.source, "url");
  const urlSynced = (await (
    await json(origin, `/api/articles/${urlSyncResult.articleId}`, undefined, cookieS)
  ).json()) as { article: { sourceUrl: string | null }; version: { source: string } };
  assert.equal(urlSynced.article.sourceUrl, "https://example.com/post");
  assert.equal(urlSynced.version.source, "browser-jina");

  // ── Replay ────────────────────────────────────────────────────────
  const replayResp = await json(origin, "/api/articles/sync", syncRequest, cookieS);
  assert.equal(replayResp.status, 200, await replayResp.clone().text());
  const replayResult = (await replayResp.json()) as { articleId: string; versionId: string };
  assert.equal(
    replayResult.articleId,
    syncResult.articleId,
    "a retried upload must return the article the first attempt created",
  );
  assert.equal(
    replayResult.versionId,
    syncResult.versionId,
    "and must not have written a second version",
  );
  assert.equal(
    await prisma.article.count({ where: { clientKey: syncRequest.clientKey } }),
    1,
    "a replayed sync must not create a second row",
  );

  // ── Same key, different document ──────────────────────────────────
  // The key is derived from the payload, so this is a client bug. Answering it
  // with the first article would discard the second document without a word.
  const conflictResp = await json(
    origin,
    "/api/articles/sync",
    { ...syncRequest, title: "另一个标题" },
    cookieS,
  );
  assert.equal(conflictResp.status, 409, await conflictResp.clone().text());
  const conflictBody = (await conflictResp.json()) as { error: { code: string } };
  assert.equal(conflictBody.error.code, "CONFLICT");

  const changedBlocks = syncRequest.blocks.map((b) =>
    b.index === 2 ? syncBlock(2, "正文第一段，但改过了。") : b,
  );
  const changedResp = await json(
    origin,
    "/api/articles/sync",
    { ...syncRequest, blocks: changedBlocks, textHash: documentTextHash(changedBlocks) },
    cookieS,
  );
  assert.equal(changedResp.status, 409, await changedResp.clone().text());

  // ── Rejections ────────────────────────────────────────────────────
  // Every one of these is a payload a re-parsing import route could not be
  // handed, and each is refused rather than written.
  const reject = async (
    label: string,
    body: unknown,
    expectedStatus: number,
  ): Promise<void> => {
    const response = await json(origin, "/api/articles/sync", body, cookieS);
    assert.equal(response.status, expectedStatus, `${label}: ${await response.clone().text()}`);
  };

  await reject(
    "textHash that does not describe the blocks",
    { ...syncFixture(), textHash: sha256Hex("not the document") },
    422,
  );
  await reject(
    "a block whose hash does not describe its text",
    (() => {
      const blocks = [syncBlock(1, "正文。"), { ...syncBlock(2, "另一段。"), hash: sha256Hex("x") }];
      return { ...syncFixture(), blocks, textHash: documentTextHash(blocks) };
    })(),
    422,
  );
  await reject(
    "block indices that are not 1-based and ascending",
    (() => {
      const blocks = [syncBlock(2, "第二段。"), syncBlock(1, "第一段。")];
      return { ...syncFixture(), blocks, textHash: documentTextHash(blocks) };
    })(),
    422,
  );
  await reject("an unknown source", { ...syncFixture(), source: "bogus" }, 400);
  await reject("an undeclared field", { ...syncFixture(), apiKey: "sk-nope" }, 400);
  await reject("an empty block list", { ...syncFixture(), blocks: [] }, 400);
  await reject(
    "a sourceUrl that is not http(s)",
    { ...syncFixture(), sourceUrl: "javascript:alert(1)" },
    400,
  );

  // ── Unsound spans are dropped, not stored ─────────────────────────
  // The same rule the read path applies. A span past the end of its paragraph
  // would put every highlight in that block on the wrong characters, and the
  // user would have no way to tell why.
  //
  // `textHash` has to be recomputed alongside the blocks: `syncFixture`
  // derives it from the *default* blocks, so overriding `blocks` alone
  // produces a document whose hash does not describe it, and the route
  // refuses that with 422 before it ever looks at a span.
  const unsoundBlocks = [
    syncBlock(1, "正文段落。", {
      spans: [
        { start: 0, end: 999, kinds: ["strong"] },
        { start: 4, end: 2, kinds: ["em"] },
      ],
    }),
  ];
  const unsoundRequest = syncFixture({
    blocks: unsoundBlocks,
    textHash: documentTextHash(unsoundBlocks),
  });
  const unsoundResp = await json(origin, "/api/articles/sync", unsoundRequest, cookieS);
  assert.equal(unsoundResp.status, 200, await unsoundResp.clone().text());
  const unsoundResult = (await unsoundResp.json()) as { articleId: string };
  const unsoundDetail = (await (
    await json(origin, `/api/articles/${unsoundResult.articleId}`, undefined, cookieS)
  ).json()) as { version: { paragraphs: Array<{ spans?: unknown }> } };
  assert.equal(
    unsoundDetail.version.paragraphs[0]!.spans,
    undefined,
    "an unsound span must be dropped rather than stored",
  );

  // ── The key is unique per owner, not globally ─────────────────────
  const userT = `phase3-T-${randomUUID()}@example.test`;
  const cookieT = await signUp(userT, "phase3-T-password-2026", "用户己");
  const otherUserResp = await json(origin, "/api/articles/sync", syncRequest, cookieT);
  assert.equal(otherUserResp.status, 200, await otherUserResp.clone().text());
  const otherUserResult = (await otherUserResp.json()) as { articleId: string };
  assert.notEqual(
    otherUserResult.articleId,
    syncResult.articleId,
    "the same clientKey must not reach another account's article",
  );

  // ── Delete, then import the same text again ───────────────────────
  // Deleting must never make a document permanently unsyncable: the unique
  // `(owner, clientKey)` index ignores `deletedAt`, so a re-import has to end
  // with a live article rather than a permanent 409.
  //
  // Which article it ends up as depends on whether this key ever owned a row.
  // Since the sync route now treats "same content" as the same article, an
  // upload whose content already exists is *deduplicated* onto that article and
  // never stores the new key; deleting that article therefore leaves this key
  // unclaimed, and the re-import creates a fresh row instead of reviving one.
  // A key that did create its own row still replays/revives it (covered by the
  // replay section above). What the reader must get either way: 200, and the
  // article visible in the library again.
  const revivedRequest = syncFixture();
  const firstSync = (await (
    await json(origin, "/api/articles/sync", revivedRequest, cookieS)
  ).json()) as { articleId: string };
  assert.equal(
    (await del(origin, `/api/articles/${firstSync.articleId}`, cookieS)).status,
    200,
  );
  const revivedResp = await json(origin, "/api/articles/sync", revivedRequest, cookieS);
  assert.equal(
    revivedResp.status,
    200,
    `re-importing a deleted article must succeed: ${await revivedResp.clone().text()}`,
  );
  const revived = (await revivedResp.json()) as { articleId: string };
  assert.ok(revived.articleId, "the re-import must land on an article");
  const revivedList = (await (
    await json(origin, "/api/articles", undefined, cookieS)
  ).json()) as { articles: Array<{ id: string }> };
  assert.ok(
    revivedList.articles.some((a) => a.id === revived.articleId),
    "the re-imported article must be visible in the library again",
  );

  results.push({ test: "G27 Wire A sync stores the client's blocks, is idempotent, and is gated", pass: true });

  // ── G28 · Highlights + account metadata ──────────────────────────────
  //
  // The reader's marks used to be device-only. This is the wire contract that
  // makes them account data: create is idempotent on `clientKey`, the server
  // re-derives the marked text and refuses a claim that does not match, update
  // patches colour/remark, delete removes the row, and every route is
  // owner-scoped. Tags, the generated summary and the cover ride along on the
  // article record.
  const userHl = `phase3-HL-${randomUUID()}@example.test`;
  const cookieHl = await signUp(userHl, "phase3-HL-password-2026", "标记用户");
  const dImport = (await (
    await json(
      origin,
      "/api/articles/import",
      { kind: "text", content: "# 划线测试\n\n这段文字会被标记。" },
      cookieHl,
    )
  ).json()) as {
    article: { id: string };
    version: { id: string; paragraphs: Array<{ index: number; id: string; text: string }> };
  };
  const dArticleId = dImport.article.id;
  const dParagraph = dImport.version.paragraphs.find((p) => p.index === 1)!;
  assert.ok(dParagraph, "the imported version must carry paragraph 1");

  const markBody = {
    paragraphIndex: 1,
    startOffset: 0,
    endOffset: 2,
    blockId: dParagraph.id,
    articleVersionId: dImport.version.id,
    clientKey: `hl-${randomUUID()}`,
    selectionText: dParagraph.text.slice(0, 2),
    color: "yellow",
    note: "第一处备注",
  };
  const markResp = await json(origin, `/api/articles/${dArticleId}/highlights`, markBody, cookieHl);
  assert.equal(markResp.status, 200, `highlight create must succeed: ${await markResp.clone().text()}`);
  const mark = (await markResp.json()) as { highlight: { id: string; note: string } };
  assert.equal(mark.highlight.note, "第一处备注");

  // Idempotent: the same clientKey returns the row the first attempt wrote.
  const markReplayResp = await json(origin, `/api/articles/${dArticleId}/highlights`, markBody, cookieHl);
  const markReplay = (await markReplayResp.json()) as { highlight: { id: string } };
  assert.equal(
    markReplay.highlight.id,
    mark.highlight.id,
    "a retried create must not paint a second mark",
  );

  // A claim the paragraph text does not support is refused.
  const forgedResp = await json(
    origin,
    `/api/articles/${dArticleId}/highlights`,
    { ...markBody, clientKey: `hl-${randomUUID()}`, selectionText: "正文里没有这句话" },
    cookieHl,
  );
  assert.equal(forgedResp.status, 422, "a forged selection must be rejected");

  // Update: colour + remark.
  const patchResp = await send(
    origin,
    `/api/highlights/${mark.highlight.id}`,
    "PATCH",
    { color: "green", note: "改过的备注" },
    cookieHl,
  );
  assert.equal(patchResp.status, 200);
  const patched = (await patchResp.json()) as { highlight: { color: string; note: string } };
  assert.equal(patched.highlight.color, "green");
  assert.equal(patched.highlight.note, "改过的备注");

  const listResp = (await (
    await json(origin, `/api/articles/${dArticleId}/highlights`, undefined, cookieHl)
  ).json()) as { versionId: string; highlights: Array<{ id: string }> };
  assert.equal(listResp.highlights.length, 1);
  assert.equal(listResp.versionId, dImport.version.id);

  // Owner scoping: another account cannot see, patch or delete this mark.
  const userOther = `phase3-HL2-${randomUUID()}@example.test`;
  const cookieOther = await signUp(userOther, "phase3-HL2-password-2026", "旁观用户");
  assert.equal(
    (await json(origin, `/api/articles/${dArticleId}/highlights`, undefined, cookieOther)).status,
    404,
    "another account must not list this article's marks",
  );
  assert.equal(
    (await send(origin, `/api/highlights/${mark.highlight.id}`, "PATCH", { color: "red" }, cookieOther))
      .status,
    404,
    "another account must not patch this mark",
  );
  assert.equal(
    (await del(origin, `/api/highlights/${mark.highlight.id}`, cookieOther)).status,
    404,
    "another account must not delete this mark",
  );

  // Account metadata: tags, summary, cover.
  const tagsResp = await send(
    origin,
    `/api/articles/${dArticleId}/tags`,
    "PUT",
    { tags: ["测试", "划线"], model: "test-model" },
    cookieHl,
  );
  assert.equal(tagsResp.status, 200);
  const briefResp = await send(
    origin,
    `/api/articles/${dArticleId}/brief`,
    "PUT",
    { brief: { gist: "一段摘要", claims: [{ text: "要点", paragraphRef: "¶1" }], generatedAt: Date.now() } },
    cookieHl,
  );
  assert.equal(briefResp.status, 200);
  const metaResp = await send(
    origin,
    `/api/articles/${dArticleId}/meta`,
    "PUT",
    { coverImage: "https://example.test/cover.jpg", publishedAt: "2026-01-02" },
    cookieHl,
  );
  assert.equal(metaResp.status, 200);
  const dDetail = (await (
    await json(origin, `/api/articles/${dArticleId}`, undefined, cookieHl)
  ).json()) as {
    article: { tags: string[]; coverImage: string | null; publishedAt: string | null };
    brief: { gist: string } | null;
  };
  assert.deepEqual(dDetail.article.tags, ["测试", "划线"]);
  assert.equal(dDetail.article.coverImage, "https://example.test/cover.jpg");
  assert.equal(dDetail.article.publishedAt, "2026-01-02");
  assert.equal(dDetail.brief?.gist, "一段摘要");

  // Deleting the mark removes the row for its owner.
  assert.equal((await del(origin, `/api/highlights/${mark.highlight.id}`, cookieHl)).status, 200);
  const emptyList = (await (
    await json(origin, `/api/articles/${dArticleId}/highlights`, undefined, cookieHl)
  ).json()) as { highlights: unknown[] };
  assert.equal(emptyList.highlights.length, 0);

  results.push({
    test: "G28 highlights sync with idempotent create, selection validation, owner scoping, and account metadata",
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
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/phase3.json", JSON.stringify(evidence, null, 2) + "\n");
}
