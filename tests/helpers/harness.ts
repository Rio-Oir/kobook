// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Child-process supervision and bounded cleanup for the phase acceptance runs.
 *
 * Why this file exists (2026-10-15, phase 3/4 joint closeout):
 *
 * The third serial run of the joint acceptance (`verify --all`) died in
 * `tests/phase3.ts` at its Caddy readiness probe right after it restarted the
 * app server, and then never exited — the log ended at the throw and had to be
 * interrupted by hand. The original proxy failure cannot be reconstructed
 * from that log because its output was discarded. The following lifecycle
 * defects are independently reproducible and made diagnosis/cleanup unsafe:
 *
 * 1. The readiness probe was blind. `waitReady` retried for 30 s and then threw
 *    `Not ready: <url>`, so a proxy that had *died* (or never managed to bind
 *    its port) was reported exactly like a proxy that was merely slow. The
 *    child's own explanation had already been thrown away — the Caddy spawn
 *    used `proxy.stdout.on("data", () => {})`, discarding it on purpose. There
 *    was no way to tell "no listener is bound" from "a listener exists but
 *    answers non-2xx", and the child's exit status was never consulted.
 *
 * 2. Cleanup was neither complete nor bounded. Every fake HTTP server was
 *    created inside the `try` block, so an error thrown before its `close()`
 *    left a live listener that holds the event loop open forever: the `finally`
 *    block ran to completion and the process still did not exit. (`node -e`
 *    probe: a bare `http.Server` left listening keeps Node alive indefinitely;
 *    `process.getActiveResourcesInfo()` shows `TCPServerWrap`.) The Prisma
 *    client was never `$disconnect`ed either, which pinned the process open for
 *    the pg pool's full 10 s `idleTimeoutMillis` even on the success path.
 *    And `stop()` returned early only when `exitCode !== null`, which is never
 *    true for a child killed by a signal: a second `stop()` of an
 *    already-stopped child re-armed a listener for an `exit` event that had
 *    already fired, so it could never resolve before the 5 s grace — five
 *    children paid that 5 s twice each on every run.
 *
 * So, the rules this module enforces:
 *
 * - A child's exit is recorded when it happens, once. `stop()` never waits on
 *   an event that already fired, and every wait is bounded.
 * - A readiness failure carries evidence: which supervised child died and how,
 *   the tail of that child's output, and whether the port is accepting TCP
 *   connections at all.
 * - Cleanup is a registry of closables run from `finally`, so it happens on
 *   both the success and the failure path, is idempotent, and cannot block
 *   past its budget.
 * - Whatever is still holding the event loop open after cleanup is named
 *   rather than silently allowed to hang the run.
 *
 * Nothing here weakens a check: the probes only describe, they never pass a
 * gate that a gate would otherwise fail.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** How long a child gets to exit after the polite kill before it is forced. */
export const CHILD_GRACE_MS = 5000;
/** Per-resource budget for one close() during cleanup. */
export const CLOSE_BUDGET_MS = 2500;
/** Per-attempt TCP probe budget. */
export const PORT_PROBE_TIMEOUT_MS = 1000;
/** How much of a child's output is kept for diagnostics. */
export const OUTPUT_TAIL_CHARS = 4000;

/**
 * The slice of `ChildProcess` that supervision needs. A real child satisfies
 * it structurally; the unit tests drive it with a small stub so that the
 * "child ignores the kill" path can be exercised without depending on
 * platform signal semantics (on Windows `SIGTERM` and `SIGKILL` both map to
 * `TerminateProcess`, so a real child cannot be made to resist).
 */
export interface Stoppable extends EventEmitter {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type StopOutcome =
  | "absent"
  | "already-exited"
  | "graceful"
  | "forced"
  | "unreachable"
  | "budget-exhausted";

export interface StopReport {
  label: string;
  pid: number | undefined;
  outcome: StopOutcome;
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
}

export interface PortState {
  host: string;
  port: number;
  listening: boolean;
  detail: string;
}

function describeExit(exit: ExitInfo | null): string {
  if (!exit) return "still running";
  if (exit.signal) return `killed by ${exit.signal}`;
  return `exited with code ${exit.code ?? "null"}`;
}

function tail(text: string, chars = OUTPUT_TAIL_CHARS): string {
  if (text.length <= chars) return text;
  return `…[${text.length - chars} earlier characters omitted]\n${text.slice(-chars)}`;
}

/** A supervised child: its output, and the exit it actually had. */
export interface ChildRecord {
  id: number;
  label: string;
  child: Stoppable;
  output: string;
  exit: ExitInfo | null;
  exited: Promise<ExitInfo>;
}

/**
 * Owns every child a suite starts, so that nothing has to be killed by hand
 * and every kill can be reported.
 */
export class Supervisor {
  private readonly records: ChildRecord[] = [];
  private nextId = 1;

  /** Starts `node <args>` under supervision. */
  launch(
    label: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    options: { capture?: boolean } = {},
  ): ChildProcess {
    return this.spawnTracked(label, process.execPath, args, { ...options, env });
  }

  /** Starts any binary under supervision (the acceptance runs also spawn Caddy). */
  spawnTracked(
    label: string,
    command: string,
    args: string[],
    options: {
      capture?: boolean;
      env?: NodeJS.ProcessEnv;
      /**
       * `"inherit"` lets the child write to the parent's stdio (useful for
       * short-lived migrations). Anything else is forwarded to `child_process.spawn`
       * as-is so a long-running process can keep its output for diagnostics.
       */
      stdio?: "inherit" | "pipe" | Array<"ignore" | "pipe" | "inherit">;
    } = {},
  ): ChildProcess {
    const stdio: "inherit" | Array<"ignore" | "pipe" | "inherit"> =
      options.stdio === "inherit" ? "inherit" : Array.isArray(options.stdio) ? options.stdio : ["ignore", "pipe", "pipe"];
    const child = spawn(command, args, {
      stdio,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    this.track(label, child, options.capture ?? true);
    return child;
  }

  /** Registers a child that was not started through this supervisor. */
  track(label: string, child: Stoppable, capture = true): ChildRecord {
    const record: ChildRecord = {
      id: this.nextId++,
      label,
      child,
      output: "",
      exit: null,
      exited: Promise.resolve({ code: null, signal: null }),
    };
    record.exited = new Promise<ExitInfo>((resolve) => {
      // Recorded once, at the moment it happens. `stop()` consults `exit`
      // rather than waiting for an event that may already have fired.
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        const info: ExitInfo = { code, signal };
        record.exit = info;
        resolve(info);
      });
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      // Already gone before it was registered; mirror what a listener would
      // have seen so `stop()` can still answer truthfully.
      record.exit = { code: child.exitCode, signal: child.signalCode };
    }
    if (capture && isChildProcess(child)) {
      const onData = (chunk: Buffer | string): void => {
        record.output += chunk.toString("utf8");
        if (record.output.length > OUTPUT_TAIL_CHARS * 4) {
          record.output = record.output.slice(-OUTPUT_TAIL_CHARS * 2);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
    }
    this.records.push(record);
    return record;
  }

  get size(): number {
    return this.records.length;
  }

  /** Every child still running, in launch order. */
  running(): ChildRecord[] {
    return this.records.filter((record) => record.exit === null);
  }

  /** One human-readable line about a child: who it is and how it ended. */
  describe(child: Stoppable | undefined): string {
    if (!child) return "(no child)";
    const record = this.records.find((entry) => entry.child === child);
    const name = record ? `${record.label}#${record.id}` : "(untracked child)";
    const exit = record ? record.exit : exitOf(child);
    return `${name} (pid ${child.pid ?? "?"}): ${describeExit(exit)}`;
  }

  /** The tail of everything a child wrote to stdout/stderr. */
  outputTail(child: Stoppable | undefined, chars = OUTPUT_TAIL_CHARS): string {
    const record = this.records.find((entry) => entry.child === child);
    return record ? tail(record.output, chars) : "";
  }

  /**
   * Stops one child: polite kill, bounded grace, then force. Returns as soon as
   * the child is gone — an already-exited child costs no grace at all, which is
   * the whole point of tracking the exit instead of re-waiting for it.
   */
  async stop(
    child: Stoppable | undefined,
    options: { graceMs?: number } = {},
  ): Promise<StopReport> {
    const graceMs = options.graceMs ?? CHILD_GRACE_MS;
    const started = Date.now();
    if (!child) {
      return {
        label: "(none)",
        pid: undefined,
        outcome: "absent",
        code: null,
        signal: null,
        ms: 0,
      };
    }
    const record = this.records.find((entry) => entry.child === child);
    const label = record ? `${record.label}#${record.id}` : "(untracked child)";
    const known = record ? record.exit : exitOf(child);
    const finish = (outcome: StopOutcome, exit: ExitInfo | null): StopReport => ({
      label,
      pid: child.pid,
      outcome,
      code: exit?.code ?? null,
      signal: exit?.signal ?? null,
      ms: Date.now() - started,
    });

    if (known) return finish("already-exited", known);
    if (!record) {
      // Untracked child: no exit has been observed, so the grace is real.
      const exited = once(child);
      child.kill();
      const raced = await Promise.race([
        exited.then(() => "exited" as const),
        delay(graceMs).then(() => "grace" as const),
      ]);
      if (raced === "exited") return finish("graceful", exitOf(child));
      child.kill("SIGKILL");
      return finish("forced", exitOf(child));
    }

    child.kill();
    const raced = await Promise.race([
      record.exited.then(() => "exited" as const),
      delay(graceMs).then(() => "grace" as const),
    ]);
    if (raced === "exited") return finish("graceful", record.exit);

    // The polite kill was not enough. Force it, but stay bounded: report
    // "unreachable" instead of waiting forever for a child that will not die.
    child.kill("SIGKILL");
    const forced = await Promise.race([
      record.exited.then(() => "exited" as const),
      delay(graceMs).then(() => "grace" as const),
    ]);
    return finish(forced === "exited" ? "forced" : "unreachable", record.exit);
  }

  /**
   * Stops everything, newest first (a server started later may hold the port a
   * proxy points at). Bounded in aggregate: once `budgetMs` is spent, the
   * remaining children are force-killed without waiting and reported as such.
   */
  async stopAll(
    options: { graceMs?: number; budgetMs?: number } = {},
  ): Promise<StopReport[]> {
    const graceMs = options.graceMs ?? CHILD_GRACE_MS;
    const budgetMs = options.budgetMs ?? graceMs * 2 * Math.max(1, this.records.length);
    const started = Date.now();
    const reports: StopReport[] = [];
    for (const record of [...this.records].reverse()) {
      if (record.exit) {
        reports.push(await this.stop(record.child, { graceMs }));
        continue;
      }
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 0) {
        record.child.kill("SIGKILL");
        reports.push({
          label: `${record.label}#${record.id}`,
          pid: record.child.pid,
          outcome: "budget-exhausted",
          // Unchanged: this child never produced an exit for us to report.
          code: null,
          signal: null,
          ms: 0,
        });
        continue;
      }
      reports.push(await this.stop(record.child, { graceMs: Math.min(graceMs, remaining) }));
    }
    return reports;
  }
}

function exitOf(child: Stoppable): ExitInfo | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return { code: child.exitCode, signal: child.signalCode };
}

/** True for a real child (only those carry stdout/stderr streams to capture). */
function isChildProcess(child: Stoppable): child is ChildProcess {
  return typeof (child as ChildProcess).stdout !== "undefined";
}

/** A promise for the child's exit, used only for children we never tracked. */
function once(child: Stoppable): Promise<void> {
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

// ── Readiness ────────────────────────────────────────────────────────────

/** Probes whether anything is accepting TCP connections on host:port. */
export async function probePort(
  host: string,
  port: number,
  timeoutMs = PORT_PROBE_TIMEOUT_MS,
): Promise<PortState> {
  return await new Promise<PortState>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (listening: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, port, listening, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, `a listener accepted a TCP connection`));
    socket.once("timeout", () => done(false, `no answer to a TCP connect within ${timeoutMs}ms`));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done(false, `TCP connect failed (${error.code ?? error.message})`);
    });
  });
}

export interface ReadinessOptions {
  /** Attempts before giving up. `attempts * intervalMs` bounds the wait. */
  attempts?: number;
  /** Delay between attempts. */
  intervalMs?: number;
  /** Per-attempt HTTP budget, so a stalled connection cannot hang the loop. */
  attemptTimeoutMs?: number;
  /** What this endpoint is supposed to be, for the failure message. */
  label?: string;
  /** The supervisor that owns `children`, used to report their exit. */
  supervisor?: Supervisor;
  /**
   * Processes that must be alive for this URL to be able to come up. If any of
   * them has exited, waiting cannot help, so this fails immediately with its
   * exit status and output instead of burning the whole budget.
   */
  children?: ReadonlyArray<Stoppable | undefined>;
  /** Treats a response as ready. Defaults to `response.ok`. */
  accept?: (response: Response) => boolean;
}

/** A readiness failure that says what was observed, not just that time ran out. */
export class ReadinessError extends Error {
  readonly url: string;
  readonly label: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly lastError: string;
  readonly portState: PortState;
  readonly childLines: string[];
  readonly childOutput: string[];

  constructor(fields: {
    url: string;
    label: string;
    attempts: number;
    elapsedMs: number;
    lastError: string;
    portState: PortState;
    childLines: string[];
    childOutput: string[];
  }) {
    const lines = [
      `Not ready: ${fields.url} [${fields.label}] after ${fields.attempts} attempt(s) / ${fields.elapsedMs}ms`,
      `  port ${fields.portState.host}:${fields.portState.port}: ${
        fields.portState.listening ? "listening" : "NOT listening"
      } — ${fields.portState.detail}`,
      ...fields.childLines.map((line) => `  ${line}`),
      ...fields.childOutput.flatMap((output, index) => [
        `  child output [${index}]:`,
        ...output
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => `    | ${line}`),
      ]),
      `  last probe error: ${fields.lastError}`,
    ];
    super(lines.join("\n"));
    this.name = "ReadinessError";
    this.url = fields.url;
    this.label = fields.label;
    this.attempts = fields.attempts;
    this.elapsedMs = fields.elapsedMs;
    this.lastError = fields.lastError;
    this.portState = fields.portState;
    this.childLines = fields.childLines;
    this.childOutput = fields.childOutput;
  }
}

/**
 * Waits for `url` to answer. Fails fast — with the dead child's exit status and
 * output tail, and the TCP state of the port — when the processes that are
 * supposed to serve it are gone, instead of retrying a foregone conclusion.
 */
export async function waitReady(url: string, options: ReadinessOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 300;
  const intervalMs = options.intervalMs ?? 100;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 2000;
  const accept = options.accept ?? ((response: Response) => response.ok);
  const label = options.label ?? url;
  const children = options.children ?? [];
  const started = Date.now();
  let lastError = "no attempt completed";
  let tried = 0;

  for (let n = 0; n < attempts; n++) {
    const dead = children.find((child) => child && exitOf(child) !== null);
    if (dead) {
      throw await buildReadinessError({
        url,
        label,
        attempts: tried,
        started,
        lastError,
        children,
        supervisor: options.supervisor,
        reason: "a process this endpoint depends on has already exited",
      });
    }
    tried += 1;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(attemptTimeoutMs) });
      if (accept(response)) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await delay(intervalMs);
  }

  throw await buildReadinessError({
    url,
    label,
    attempts: tried,
    started,
    lastError,
    children,
    supervisor: options.supervisor,
    reason: `${attempts} attempts exhausted`,
  });
}

async function buildReadinessError(fields: {
  url: string;
  label: string;
  attempts: number;
  started: number;
  lastError: string;
  children: ReadonlyArray<Stoppable | undefined>;
  supervisor?: Supervisor | undefined;
  reason: string;
}): Promise<ReadinessError> {
  const target = new URL(fields.url);
  const portState = await probePort(
    target.hostname,
    Number(target.port || (target.protocol === "https:" ? 443 : 80)),
  );
  const supervisor = fields.supervisor;
  const childLines: string[] = [`(${fields.reason})`];
  const childOutput: string[] = [];
  for (const child of fields.children) {
    if (!child) continue;
    const exit = exitOf(child);
    const name = supervisor
      ? supervisor.describe(child)
      : `(unmanaged child pid ${child.pid ?? "?"}): ${describeExit(exit)}`;
    childLines.push(`child ${name}`);
    if (exit) {
      const output = supervisor?.outputTail(child) ?? "";
      if (output.trim().length > 0) childOutput.push(output);
    }
  }
  return new ReadinessError({
    url: fields.url,
    label: fields.label,
    attempts: fields.attempts,
    elapsedMs: Date.now() - fields.started,
    lastError: fields.lastError,
    portState,
    childLines,
    childOutput,
  });
}

/** Raised when a port a suite is about to bind is already answering. */
export class PortBusyError extends Error {
  readonly host: string;
  readonly port: number;
  readonly elapsedMs: number;

  constructor(host: string, port: number, elapsedMs: number, label: string) {
    super(
      `Port ${host}:${port} is still accepting connections after ${elapsedMs}ms ` +
        `(${label}); something else owns it — a parallel acceptance run, a ` +
        `leftover process, or a child that did not actually die. Refusing to ` +
        `start a replacement and race for the port.`,
    );
    this.name = "PortBusyError";
    this.host = host;
    this.port = port;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Waits until nothing answers on host:port, so a restart cannot lose the race
 * for its own port. Throws `PortBusyError` (naming the port) if something else
 * is still there — which is what a parallel run on the same fixed ports looks
 * like, and is exactly the situation a blind readiness timeout hides.
 */
export async function waitForPortFree(
  host: string,
  port: number,
  options: { budgetMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? 5000;
  const intervalMs = options.intervalMs ?? 100;
  const label = options.label ?? "unnamed";
  const started = Date.now();
  for (;;) {
    const state = await probePort(host, port);
    if (!state.listening) return;
    if (Date.now() - started >= budgetMs) {
      throw new PortBusyError(host, port, Date.now() - started, label);
    }
    await delay(intervalMs);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────

export interface CloseReport {
  label: string;
  outcome: "closed" | "timeout" | "error";
  ms: number;
  error?: string;
}

export interface Closable {
  $disconnect(): Promise<void>;
}

/**
 * Close everything a suite opened, on the success path and the failure path
 * alike. Idempotent, per-resource bounded, and it never throws: a resource that
 * will not close is reported, not allowed to turn a bounded cleanup into a
 * hang, and it never masks the failure that brought us here.
 */
export class CloseRegistry {
  private items: Array<{ label: string; close: () => void | Promise<void> }> = [];

  add(label: string, close: () => void | Promise<void>): void {
    this.items.push({ label, close });
  }

  /** Registers an HTTP server, dropping keep-alive sockets so close() can finish. */
  addHttpServer(label: string, server: Server): void {
    this.add(label, () => closeHttpServer(server));
  }

  /** Registers a Prisma client, whose pool otherwise pins the process open. */
  addPrisma(label: string, prisma: Closable): void {
    this.add(label, () => prisma.$disconnect());
  }

  get size(): number {
    return this.items.length;
  }

  async closeAll(
    options: { budgetMs?: number; totalBudgetMs?: number } = {},
  ): Promise<CloseReport[]> {
    const budgetMs = options.budgetMs ?? CLOSE_BUDGET_MS;
    const items = this.items;
    this.items = []; // idempotent: a second call has nothing left to do
    const totalBudgetMs = options.totalBudgetMs ?? budgetMs * Math.max(1, items.length);
    const startedAll = Date.now();
    const reports: CloseReport[] = [];
    for (const item of items) {
      const started = Date.now();
      const remaining = Math.max(0, totalBudgetMs - (started - startedAll));
      const budget = Math.min(budgetMs, remaining);
      const raced = await Promise.race([
        Promise.resolve()
          .then(() => item.close())
          .then(() => ({ outcome: "closed" as const }))
          .catch((error: unknown) => ({
            outcome: "error" as const,
            error: error instanceof Error ? error.message : String(error),
          })),
        delay(budget).then(() => ({ outcome: "timeout" as const, error: `no completion within ${budget}ms` })),
      ]);
      reports.push({
        label: item.label,
        outcome: raced.outcome,
        ms: Date.now() - started,
        ...("error" in raced && raced.error ? { error: raced.error } : {}),
      });
    }
    return reports;
  }
}

/**
 * Closes an HTTP server and its active connections. Node 24 closes idle
 * keep-alive sockets itself; active requests still need explicit closure.
 */
export async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// ── Process exit ─────────────────────────────────────────────────────────

/** Handles that do not keep the event loop alive, so they are not a leak. */
const BENIGN_HANDLES = new Set(["Timeout", "Immediate", "TickObject", "Microtask", "TTYWrap"]);

/**
 * Names whatever is still holding the event loop open. A leaked listener or an
 * un-disconnected pool shows up here as `TCPServerWrap` / `TCPSocketWrap` —
 * which is how the phase 3 hang was identified.
 */
export function lingeringHandles(): string[] {
  const info =
    typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
  return [...new Set(info.filter((name) => !BENIGN_HANDLES.has(name)))];
}

/**
 * Polls `lingeringHandles()` until the list is empty or the budget runs out.
 * `getActiveResourcesInfo` reflects a *snapshot* of handles the runtime is
 * still tracking; on Node 24 a closed `Server` is removed from that list
 * asynchronously (after the close callback and a tick of GC), so a test that
 * asserts "no listener remains" needs a tiny grace rather than a strict
 * post-condition. A real leak is one that persists past this grace — the
 * budget is the difference between a slow runtime and a stuck one.
 */
export async function waitForCleanHandles(timeoutMs = 200, intervalMs = 10): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    if (lingeringHandles().length === 0) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await delay(intervalMs);
  }
}

/**
 * Last thing a suite does: report any handle that survived cleanup, and — only
 * if one did — leave anyway after a moment so stdout can drain, rather than
 * hanging the whole acceptance run. The report is printed and (by the caller)
 * recorded in the evidence file, so a forced exit never passes silently.
 */
export async function finalize(
  options: { exitIfLingering?: boolean; drainMs?: number } = {},
): Promise<string[]> {
  const lingering = lingeringHandles();
  if (lingering.length === 0) return lingering;
  console.error(
    `[harness] cleanup finished but ${lingering.length} handle(s) are still active: ` +
      `${lingering.join(", ")} — exiting with code ${process.exitCode ?? 0} instead of hanging.`,
  );
  if (options.exitIfLingering ?? true) {
    await delay(options.drainMs ?? 250);
    process.exit(process.exitCode ?? 0);
  }
  return lingering;
}
