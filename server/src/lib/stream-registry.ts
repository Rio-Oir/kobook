// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bounded in-memory registry of mock streaming jobs.
 *
 * Phase 1 purpose: make cancellation *observable*. A sample that only proved
 * "the client stopped reading" would not show whether the server noticed, so
 * every job keeps a small, bounded record that a test can read back over
 * HTTP:
 *
 *   - terminal status (completed / failed / cancelled / interrupted)
 *   - how many characters had been emitted when cancellation happened
 *   - how many *additional* deltas were emitted after cancellation, which
 *     must stay 0 — that is the actual propagation guarantee
 *
 * Memory is bounded on two axes: a per-job ring buffer of the most recent
 * events, and a cap on the number of retained jobs (oldest evicted first).
 * This is a development sample, not the phase 4 job ledger, which will live
 * in PostgreSQL.
 */

import type { StreamEvent, StreamEventType } from "../../../shared/contracts/index.js";

export type JobStatus = "running" | StreamEventType;

export interface StreamJobSnapshot {
  jobId: string;
  status: JobStatus;
  /** Deltas emitted in total. */
  deltaCount: number;
  /** Characters emitted in total. */
  emittedChars: number;
  /** Deltas emitted *after* a cancellation was recorded. Must always be 0. */
  deltasAfterCancel: number;
  cancelledReason: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** Most recent events, oldest first. Bounded by maxEventsPerJob. */
  recentEvents: StreamEvent[];
  /** Number of events dropped from the ring buffer. */
  droppedEvents: number;
}

interface JobState extends Omit<StreamJobSnapshot, "recentEvents" | "droppedEvents"> {
  ownerUserId: string;
  events: StreamEvent[];
  dropped: number;
}

export interface StreamRegistryOptions {
  /** Ring-buffer size per job. */
  maxEventsPerJob?: number;
  /** How many jobs are retained at all. */
  maxJobs?: number;
}

const DEFAULT_MAX_EVENTS_PER_JOB = 64;
const DEFAULT_MAX_JOBS = 32;

export class StreamRegistry {
  private readonly jobs = new Map<string, JobState>();
  private readonly maxEventsPerJob: number;
  private readonly maxJobs: number;

  constructor(options: StreamRegistryOptions = {}) {
    this.maxEventsPerJob = options.maxEventsPerJob ?? DEFAULT_MAX_EVENTS_PER_JOB;
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  }

  create(jobId: string, ownerUserId: string): void {
    this.evictIfNeeded();
    this.jobs.set(jobId, {
      ownerUserId,
      jobId,
      status: "running",
      deltaCount: 0,
      emittedChars: 0,
      deltasAfterCancel: 0,
      cancelledReason: null,
      createdAt: Date.now(),
      finishedAt: null,
      events: [],
      dropped: 0,
    });
  }

  record(jobId: string, event: StreamEvent): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    if (event.type === "delta") {
      job.deltaCount += 1;
      job.emittedChars += event.text.length;
      // A delta arriving after cancellation means propagation failed.
      if (job.cancelledReason !== null) job.deltasAfterCancel += 1;
    }

    job.events.push(event);
    if (job.events.length > this.maxEventsPerJob) {
      job.events.shift();
      job.dropped += 1;
    }

    if (event.type !== "delta" && event.type !== "started") {
      job.status = event.type;
      job.finishedAt = event.at;
    }
  }

  /** Records a cancellation. Idempotent: the first reason wins. */
  cancel(jobId: string, reason: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running" || job.cancelledReason !== null) return false;
    job.cancelledReason = reason;
    return true;
  }

  isCancelled(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    return job ? job.cancelledReason !== null : false;
  }

  /** Marks every still-running job as interrupted (used on server shutdown). */
  markAllRunningInterrupted(reason: string): string[] {
    const affected: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.cancelledReason = reason;
      job.status = "interrupted";
      job.finishedAt = Date.now();
      affected.push(job.jobId);
    }
    return affected;
  }

  snapshot(jobId: string): StreamJobSnapshot | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      jobId: job.jobId,
      status: job.status,
      deltaCount: job.deltaCount,
      emittedChars: job.emittedChars,
      deltasAfterCancel: job.deltasAfterCancel,
      cancelledReason: job.cancelledReason,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      recentEvents: [...job.events],
      droppedEvents: job.dropped,
    };
  }

  get size(): number {
    return this.jobs.size;
  }

  isOwner(jobId: string, userId: string): boolean {
    return this.jobs.get(jobId)?.ownerUserId === userId;
  }

  private evictIfNeeded(): void {
    while (this.jobs.size >= this.maxJobs) {
      const oldestTerminal = [...this.jobs].find(([, job]) => job.status !== "running");
      if (!oldestTerminal) throw Object.assign(new Error("Mock stream capacity reached."), { statusCode: 429 });
      this.jobs.delete(oldestTerminal[0]);
    }
  }
}
