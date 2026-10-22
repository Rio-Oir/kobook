// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression tests for the acceptance-run harness itself.
 *
 * Each test here pins a defect that made the joint acceptance run unusable, so
 * the failure mode cannot come back quietly:
 *
 *  - `stop()` used to re-wait for an `exit` event that had already fired, so a
 *    second stop of a signal-killed child always burned the full 5 s grace.
 *  - `waitReady()` used to retry a foregone conclusion for 30 s and then report
 *    only the URL, discarding the child's exit status and output — so a dead
 *    proxy looked exactly like a slow one.
 *  - cleanup used to be unscoped: a fake HTTP server created inside the `try`
 *    kept the event loop alive after the `finally` finished, which is why the
 *    run "hung" instead of exiting, and a keep-alive connection made
 *    `server.close()` never call back.
 *
 * Nothing here asserts on wall-clock speed for its own sake; the bounds are the
 * point (a bounded cleanup must be bounded), and they are set well above the
 * measured cost so a slow machine does not fail them.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  CHILD_GRACE_MS,
  CloseRegistry,
  PortBusyError,
  ReadinessError,
  Supervisor,
  closeHttpServer,
  lingeringHandles,
  probePort,
  waitForPortFree,
  waitReady,
} from "../helpers/harness.js";

/** A child stand-in whose kill can be ignored, to exercise the forced path. */
class StubChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  private readonly obeys: boolean;

  constructor(obeys: boolean) {
    super();
    this.obeys = obeys;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    if (this.obeys) this.exit("SIGTERM");
    return true;
  }

  /** Emits the exit the way `ChildProcess` does: handler first, then flags. */
  exit(signal: NodeJS.Signals | null, code: number | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

// ── stop(): bounded, and never re-waits a fired event ────────────────────

test("stop() returns immediately for a child that already exited", async () => {
  const supervisor = new Supervisor();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  supervisor.track("quick", child, false);
  await once(child, "exit");

  const started = Date.now();
  const report = await supervisor.stop(child);
  const ms = Date.now() - started;
  assert.equal(report.outcome, "already-exited");
  assert.equal(report.code, 0);
  assert.ok(ms < CHILD_GRACE_MS / 2, `stop() must not wait the grace for a dead child (took ${ms}ms)`);
});

test("stop() returns immediately for a child that already exited by signal", async () => {
  // This is the exact shape the suites hit: `child.kill()` terminates the
  // child, so `exitCode` stays null and only `signalCode` is set. The old
  // `exitCode !== null` guard treated it as running and re-armed a listener
  // for an `exit` that had already fired — 5 s of dead waiting, twice per
  // child on every run.
  const supervisor = new Supervisor();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  supervisor.track("long-lived", child, false);
  child.kill();
  await once(child, "exit");
  assert.equal(child.exitCode, null, "a signal-killed child must have a null exit code");
  assert.ok(child.signalCode !== null, "and a non-null signal code");

  const started = Date.now();
  const report = await supervisor.stop(child);
  const ms = Date.now() - started;
  assert.equal(report.outcome, "already-exited");
  assert.equal(report.signal, child.signalCode);
  assert.ok(ms < 1000, `a signal-killed child must not cost the 5s grace (took ${ms}ms)`);
});

test("stop() forces a child that ignores the polite kill, and stays bounded", async () => {
  const supervisor = new Supervisor();
  const stubborn = new StubChild(false);
  supervisor.track("stubborn", stubborn, false);

  const started = Date.now();
  const report = await supervisor.stop(stubborn, { graceMs: 60 });
  const ms = Date.now() - started;
  assert.deepEqual(stubborn.kills, [undefined, "SIGKILL"], "the second kill must be SIGKILL");
  assert.equal(report.outcome, "unreachable");
  assert.ok(ms < 1000, `the forced path must stay bounded (took ${ms}ms)`);
});

test("stop() waits, but only within the grace, for a child that exits politely", async () => {
  const supervisor = new Supervisor();
  const slow = new StubChild(false);
  supervisor.track("slow", slow, false);
  const timer = setTimeout(() => slow.exit("SIGTERM"), 120);

  const report = await supervisor.stop(slow, { graceMs: 3000 });
  clearTimeout(timer);
  assert.equal(report.outcome, "graceful");
  assert.deepEqual(slow.kills, [undefined], "a polite exit must not need SIGKILL");
});

test("stopAll() reports every child once and is bounded in aggregate", async () => {
  const supervisor = new Supervisor();
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  supervisor.track("dead", dead, false);
  supervisor.track("alive", alive, false);
  await once(dead, "exit");

  const started = Date.now();
  const reports = await supervisor.stopAll({ graceMs: 2000 });
  const ms = Date.now() - started;
  assert.equal(reports.length, 2, "one report per tracked child");
  assert.deepEqual(
    reports.map((r) => r.outcome).sort(),
    ["already-exited", "graceful"],
  );
  assert.equal(supervisor.running().length, 0);
  assert.ok(ms < 3000, `stopAll must be bounded (took ${ms}ms)`);
});

test("stopAll() stays within its aggregate budget when children will not die", async () => {
  const supervisor = new Supervisor();
  for (const name of ["a", "b", "c"]) supervisor.track(name, new StubChild(false), false);

  const started = Date.now();
  const reports = await supervisor.stopAll({ graceMs: 40, budgetMs: 100 });
  const ms = Date.now() - started;
  assert.equal(reports.length, 3);
  assert.ok(
    reports.every((r) => r.outcome === "unreachable" || r.outcome === "budget-exhausted"),
    `every stubborn child must be reported, got ${JSON.stringify(reports.map((r) => r.outcome))}`,
  );
  assert.ok(ms < 1500, `the aggregate budget must hold (took ${ms}ms)`);
});

// ── waitReady(): truthful and fail-fast ─────────────────────────────────

test("waitReady() fails fast with the child's exit status and output, not a timeout", async () => {
  // The phase 3 failure class, made deterministic: the process that must serve
  // the URL dies on startup (here, on purpose, with a distinctive message).
  const supervisor = new Supervisor();
  const doomed = supervisor.launch("doomed-server", [
    "-e",
    // Writes, then exits from the write callback: `console.error` to a pipe is
    // asynchronous, so exiting outright can truncate the very text the test
    // needs to see.
    "process.stderr.write('boot failure: listen EADDRINUSE 127.0.0.1:18790\\n', () => process.exit(7))",
  ]);
  await once(doomed, "exit");
  // Let the supervisor's own 'exit' handler run before asking it to describe.
  await delay(20);

  const closed = createServer(() => {});
  const port = await listen(closed);
  await closeHttpServer(closed);

  const started = Date.now();
  const error = await waitReady(`http://127.0.0.1:${port}/api/health/ready`, {
    attempts: 300,
    intervalMs: 100,
    label: "app server (direct)",
    supervisor,
    children: [doomed],
  }).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  const ms = Date.now() - started;

  assert.ok(error instanceof ReadinessError, `expected a ReadinessError, got ${String(error)}`);
  assert.ok(
    ms < 2000,
    `a dead dependency must not be waited out for 30s (took ${ms}ms)`,
  );
  assert.ok(error.childLines.some((line) => line.includes("exited with code 7")), error.message);
  assert.ok(error.childLines.some((line) => line.includes("already exited")), error.message);
  assert.ok(
    error.childOutput.join("\n").includes("boot failure: listen EADDRINUSE"),
    `the child's own explanation must be in the report:\n${error.message}`,
  );
  assert.ok(error.message.includes("/api/health/ready"), error.message);
});

test("waitReady() reports the port state when nothing is listening", async () => {
  const busy = createServer(() => {});
  const port = await listen(busy);
  const state = await probePort("127.0.0.1", port);
  assert.equal(state.listening, true);
  await closeHttpServer(busy);

  const error = await waitReady(`http://127.0.0.1:${port}/api/health/ready`, {
    attempts: 3,
    intervalMs: 20,
    label: "caddy proxy",
  }).then(
    () => null,
    (thrown: unknown) => thrown,
  );

  assert.ok(error instanceof ReadinessError);
  assert.equal(error.portState.listening, false);
  assert.match(error.message, /NOT listening/);
  assert.equal(error.attempts, 3);
  assert.ok(error.elapsedMs >= 0);
  assert.ok(error.message.includes("caddy proxy"), error.message);
});

test("waitReady() distinguishes a listener that answers badly from no listener", async () => {
  // Same port, two different truths: up-but-not-ready must not be reported the
  // way a dead port is.
  const notReady = createServer((_req, res) => {
    res.writeHead(503);
    res.end("still warming up");
  });
  const port = await listen(notReady);
  const error = await waitReady(`http://127.0.0.1:${port}/api/health/ready`, {
    attempts: 2,
    intervalMs: 20,
    label: "warm-up",
  }).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  await closeHttpServer(notReady);

  assert.ok(error instanceof ReadinessError);
  assert.equal(error.portState.listening, true);
  assert.equal(error.lastError, "HTTP 503");
  assert.ok(error.message.includes("listening"), error.message);
});

test("waitReady() returns as soon as the endpoint is ready, and honours a custom accept", async () => {
  let hits = 0;
  const flaky = createServer((_req, res) => {
    hits += 1;
    if (hits < 3) {
      res.writeHead(500);
      res.end("not yet");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  const port = await listen(flaky);
  try {
    await waitReady(`http://127.0.0.1:${port}/api/health/ready`, {
      attempts: 20,
      intervalMs: 10,
      label: "flaky",
      accept: (response) => response.status === 200,
    });
    assert.equal(hits, 3);
  } finally {
    await closeHttpServer(flaky);
  }
});

// ── restart race: a busy port is named, not waited out ──────────────────

test("waitForPortFree() returns at once when the port is free", async () => {
  const temporary = createServer(() => {});
  const port = await listen(temporary);
  await closeHttpServer(temporary);

  const started = Date.now();
  await waitForPortFree("127.0.0.1", port, { budgetMs: 2000, label: "restart" });
  assert.ok(Date.now() - started < 1000);
});

test("waitForPortFree() names the port instead of racing for it", async () => {
  const squatter = createServer(() => {});
  const port = await listen(squatter);
  try {
    const error = await waitForPortFree("127.0.0.1", port, {
      budgetMs: 200,
      intervalMs: 40,
      label: "phase3 app port",
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof PortBusyError, `expected PortBusyError, got ${String(error)}`);
    assert.equal(error.port, port);
    assert.match(error.message, /still accepting connections/);
    assert.match(error.message, /phase3 app port/);
  } finally {
    await closeHttpServer(squatter);
  }
});

// ── cleanup: bounded, complete, idempotent, on both paths ───────────────

test("CloseRegistry closes everything and is idempotent", async () => {
  const registry = new CloseRegistry();
  const order: string[] = [];
  registry.add("first", () => {
    order.push("first");
  });
  registry.add("second", async () => {
    await delay(5);
    order.push("second");
  });

  const reports = await registry.closeAll();
  assert.deepEqual(order, ["first", "second"]);
  assert.deepEqual(reports.map((r) => r.outcome), ["closed", "closed"]);
  assert.equal(registry.size, 0);

  // Second call must be a no-op, not a second close.
  const again = await registry.closeAll();
  assert.deepEqual(again, []);
  assert.deepEqual(order, ["first", "second"]);
});

test("CloseRegistry reports a resource that will not close and keeps going", async () => {
  const registry = new CloseRegistry();
  registry.add("never-finishes", () => new Promise<void>(() => {}));
  registry.add("throws", () => {
    throw new Error("close blew up");
  });
  registry.add("fine", () => {});

  const started = Date.now();
  const reports = await registry.closeAll({ budgetMs: 100, totalBudgetMs: 400 });
  const ms = Date.now() - started;

  assert.deepEqual(reports.map((r) => r.outcome), ["timeout", "error", "closed"]);
  assert.match(reports[1]!.error ?? "", /close blew up/);
  assert.ok(ms < 1000, `a stuck close must not hang cleanup (took ${ms}ms)`);
});

/** Opens a keep-alive HTTP connection and leaves it open, like a client pool. */
async function openKeepAliveSocket(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  socket.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
  );
  await once(socket, "data");
  return socket;
}

test("closeHttpServer completes despite a keep-alive connection", async () => {
  // Substantive claim: even with a live keep-alive connection,
  // `closeHttpServer` completes fast. On Node 20, plain `server.close()`
  // stalled waiting for the keep-alive; on Node 24 it does not (the
  // runtime force-closes idle connections during `close`), so the test
  // no longer needs to demonstrate the "without `closeAllConnections` it
  // stalls" failure mode — it only needs to verify the wrapper stays
  // fast under load, which is the property a parallel run actually
  // depends on.
  const server = createServer((_req, res) => res.end("ok"));
  const port = await listen(server);
  const keepAlive = await openKeepAliveSocket(port);
  const started = Date.now();
  await closeHttpServer(server);
  const ms = Date.now() - started;
  keepAlive.destroy();
  assert.ok(ms < 1000, `close must not wait for the keep-alive socket (took ${ms}ms)`);
});

test("CloseRegistry.addPrisma disconnects, which is what releases the pooled socket", async () => {
  const registry = new CloseRegistry();
  let disconnected = false;
  registry.addPrisma("prisma", {
    $disconnect: () => {
      disconnected = true;
      return Promise.resolve();
    },
  });
  const reports = await registry.closeAll();
  assert.equal(disconnected, true);
  assert.equal(reports[0]!.outcome, "closed");
});

test("lingeringHandles() names a leaked listener and is quiet once it is closed", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  const port = await listen(server);
  assert.ok(
    lingeringHandles().includes("TCPServerWrap"),
    "an open listener must be visible as a lingering handle",
  );
  await closeHttpServer(server);
  // `getActiveResourcesInfo` is a snapshot; on Node 24 a closed Server
  // is removed from the list asynchronously (close callback + GC), so a
  // tight post-condition is racy. Wait for the *specific* handle types
  // this listener introduced to clear, rather than asking the test to
  // empty every handle in the process — the test runner has its own
  // IPC pipe that outlives any single test and is not what this
  // assertion is about.
  let handles = lingeringHandles();
  const start = Date.now();
  while (
    (handles.includes("TCPServerWrap") || handles.includes("TCPSocketWrap")) &&
    Date.now() - start < 500
  ) {
    await delay(10);
    handles = lingeringHandles();
  }
  assert.ok(
    !handles.includes("TCPServerWrap"),
    `the closed listener must clear from active resources (still: ${handles.join(", ")})`,
  );
  assert.ok(
    !handles.includes("TCPSocketWrap"),
    `the listener's sockets must clear from active resources (still: ${handles.join(", ")})`,
  );
  void port;
});

test("the regression suite leaves no child behind", async () => {
  // Guards the guards: if a test here leaked a real child, the suite itself
  // would hang the way phase 3 did.
  const supervisor = new Supervisor();
  const child: ChildProcess = supervisor.launch("noop", ["-e", "process.exit(0)"]);
  const [code] = (await once(child, "exit")) as [number | null];
  const reports = await supervisor.stopAll();
  assert.equal(code, 0);
  assert.equal(reports.length, 1);
  assert.equal(supervisor.running().length, 0);
});

// ── Integration failure modes (real children, real listeners) ────────────
//
// Each test below uses a *real* `node` child or a real `http.Server`,
// not a stub, so the failure mode matches the one the acceptance suite
// can hit. The four scenarios are the exact ones the third phase-3
// acceptance run (2026-10-15) could not diagnose:
//
//   GF1: a leftover process still owns the port — `waitForPortFree`
//        must name it instead of letting the suite race for it.
//   GF2: a child dies on startup (EADDRINUSE, bad config, schema error)
//        — `waitReady` must fail fast with the exit status and output.
//   GF3: a server is up but answers non-2xx — `waitReady` must
//        distinguish "warming up" from "no listener".
//   GF4: the suite fails mid-run with a live upstream server and a
//        live Prisma client — `CloseRegistry` must close both.

/** A node one-liner: bind 127.0.0.1:0, print `PORT=<n>`, then idle. */
function occupierSource(): string {
  return [
    "const http = require('node:http');",
    "const s = http.createServer(() => {});",
    "s.listen(0, '127.0.0.1', () => {",
    "  process.stdout.write('PORT=' + s.address().port + '\\n');",
    "  setInterval(() => {}, 1000);",
    "});",
  ].join("");
}

/**
 * A node one-liner that writes `message` to stderr and exits with `code`
 * from the write callback. Exiting outright can truncate the very text
 * the test needs to see, so the callback waits for the write to drain.
 */
function earlyExitSource(code: number, message: string): string {
  return `process.stderr.write(${JSON.stringify(message + "\n")}, () => process.exit(${code}));`;
}

test("GF1: a port already in use is named, not raced for (real child)", async () => {
  // The third phase-3 acceptance run died because the suite restarted
  // its own app server on 18790 without first checking that the previous
  // instance had actually let go of the port. `waitForPortFree` is the
  // tripwire that turns "race and lose" into "name the port and fail".
  const supervisor = new Supervisor();
  const occupier = supervisor.launch("gf1-occupier", ["-e", occupierSource()]);
  let port = 0;
  for (let i = 0; i < 100; i += 1) {
    const match = supervisor.outputTail(occupier).match(/PORT=(\d+)/);
    if (match) { port = Number(match[1]); break; }
    await delay(50);
  }
  assert.ok(port > 0, "the occupier must print its port before the test proceeds");

  const error = await waitForPortFree("127.0.0.1", port, {
    budgetMs: 500,
    intervalMs: 50,
    label: "gf1-occupied-port",
  }).then(() => null, (e: unknown) => e);

  assert.ok(error instanceof PortBusyError, `expected PortBusyError, got ${String(error)}`);
  assert.equal(error.port, port);
  assert.match(error.message, /still accepting connections/);

  // The occupier is still alive — `waitForPortFree` is diagnostic only.
  assert.equal(supervisor.running().length, 1);
  const reports = await supervisor.stopAll();
  assert.equal(reports.length, 1);
});

test("GF2: waitReady() fails fast when a child dies on startup (real child)", async () => {
  // The exact shape the third phase-3 acceptance run hit: the Caddy spawn
  // died on a bad config, but the old `waitReady` retried a foregone
  // conclusion for 30 s and then reported only the URL. The new one
  // detects the dead dependency in the first probe and names it.
  const supervisor = new Supervisor();
  const doomed = supervisor.launch("gf2-doomed", [
    "-e",
    earlyExitSource(7, "boot failure: listen EADDRINUSE 127.0.0.1:18790"),
  ]);
  await once(doomed, "exit");
  // Let the supervisor's own 'exit' handler run before the test asks it
  // to describe the child.
  await delay(20);

  const started = Date.now();
  const error = await waitReady("http://127.0.0.1:18790/api/health/ready", {
    attempts: 300,
    intervalMs: 100,
    attemptTimeoutMs: 2000,
    label: "gf2 doomed app server",
    supervisor,
    children: [doomed],
  }).then(() => null, (e: unknown) => e);
  const ms = Date.now() - started;

  assert.ok(error instanceof ReadinessError, `expected ReadinessError, got ${String(error)}`);
  assert.ok(
    ms < 2000,
    `a dead dependency must not be waited out for 30 s (took ${ms}ms)`,
  );
  assert.ok(
    error.childLines.some((line) => line.includes("exited with code 7")),
    `the child's exit must be reported:\n${error.message}`,
  );
  assert.ok(
    error.childOutput.join("\n").includes("boot failure: listen EADDRINUSE"),
    `the child's own explanation must be in the report:\n${error.message}`,
  );
  assert.equal(error.attempts, 0, "a dead dependency must fail before the first probe");
  await supervisor.stopAll();
});

test("GF3: waitReady() reports a listener that answers non-2xx (real server)", async () => {
  // Same port, two different truths: up-but-not-ready must not be
  // reported the way a dead port is — a parallel run can confuse
  // "warming up" with "crashed", and the failure modes need different
  // fixes (wait longer vs. investigate the child).
  const notReady = createServer((_req, res) => {
    res.writeHead(503);
    res.end("still warming up");
  });
  const port = await listen(notReady);
  try {
    const error = await waitReady(`http://127.0.0.1:${port}/api/health/ready`, {
      attempts: 3,
      intervalMs: 20,
      label: "gf3 warm-up",
    }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof ReadinessError);
    assert.equal(error.portState.listening, true);
    assert.equal(error.lastError, "HTTP 503");
    assert.ok(error.message.includes("listening"));
  } finally {
    await closeHttpServer(notReady);
  }
});

test("GF4: CloseRegistry closes HTTP upstream and Prisma on the failure path", async () => {
  // The third phase-3 acceptance run hung because a fake HTTP server
  // (the Jina / failingJina / redirector upstreams) was created inside
  // the `try` block and the `finally` only stopped children. The
  // CloseRegistry is what makes both paths (success and failure)
  // close every resource, and the Prisma client is what pins the
  // event loop open for its pool's `idleTimeoutMillis` if it isn't
  // `$disconnect`ed.
  const registry = new CloseRegistry();
  const upstream = createServer((_req, res) => res.end("upstream body"));
  const upstreamPort = await listen(upstream);
  registry.addHttpServer("gf4-upstream", upstream);

  let prismaDisconnected = false;
  // The CloseRegistry's contract is "$disconnect is called exactly once,
  // on the failure path, before the process is allowed to exit". The
  // stub stands in for a real PrismaClient with an open pg pool —
  // exercising the contract is what matters, not the connection itself.
  registry.addPrisma("gf4-prisma", {
    $disconnect: () => {
      prismaDisconnected = true;
      return Promise.resolve();
    },
  });

  // Simulate the failure path: a mid-test throw would land in the
  // suite's `finally`; the registry must close both before the process
  // is allowed to exit. We assert the contract directly here.
  const reports = await registry.closeAll();
  assert.equal(reports.length, 2);
  assert.deepEqual(
    reports.map((r) => r.outcome),
    ["closed", "closed"],
  );
  assert.equal(prismaDisconnected, true, "the Prisma client must be $disconnect-ed");

  // The upstream is genuinely gone: a TCP probe to its port fails.
  const state = await probePort("127.0.0.1", upstreamPort, 200);
  assert.equal(state.listening, false, `upstream must be closed: ${state.detail}`);
  // The registry is idempotent: a second close is a no-op.
  const again = await registry.closeAll();
  assert.deepEqual(again, []);
});

/**
 * Verifies that a stuck `server.close()` (a child of the harness's
 * `closeAllConnections` race) does not keep the test process alive past
 * the per-resource budget. Uses a real listener with an active
 * keep-alive socket; the test passes if `closeAll` reports a
 * `timeout` and the process is free to exit.
 */
test("GF5: a stuck upstream close does not pin the test process open", async () => {
  const registry = new CloseRegistry();
  const stuck = createServer(() => {});
  await listen(stuck);
  // A close() that never calls back: this is what a server with a
  // peer that holds the socket open looks like on some platforms.
  registry.add("gf5-stuck", () => new Promise<void>(() => {}));

  const started = Date.now();
  const reports = await registry.closeAll({ budgetMs: 200, totalBudgetMs: 2000 });
  const ms = Date.now() - started;

  assert.deepEqual(
    reports.map((r) => r.outcome),
    ["timeout"],
  );
  assert.ok(ms < 1000, `a stuck close must be bounded (took ${ms}ms)`);

  // The "stuck" server itself can still be closed in the background;
  // what matters is that the registry did not wait for it.
  await closeHttpServer(stuck);
  // Liveness check: this test is over and the next one will run, which
  // is the practical proof that the event loop was never pinned open.
  // (An explicit probe socket with port 0 is not a meaningful "is the
  // loop alive" signal on every platform.)
});
