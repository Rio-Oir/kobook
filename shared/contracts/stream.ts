// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Streaming (SSE) event contract.
 *
 * Phase 1 scope: the shape of the events and their wire encoding. The
 * generation *lifecycle* that emits these (`pending → running → succeeded /
 * failed / cancelled / interrupted`) is phase 4 work; phase 1 only proves the
 * transport (Fastify → real Caddy → client) delivers events incrementally and
 * that cancellation propagates.
 */

export type StreamEventType =
  | "started"
  | "delta"
  | "completed"
  | "failed"
  | "cancelled"
  /** Process died while the job was running; set on restart, never by a client. */
  | "interrupted";

export interface StreamEventBase {
  /** Generation job id. Every event carries it, including terminal ones. */
  jobId: string;
  /** Monotonic per-job sequence, starting at 1. Also used as the SSE `id:`. */
  seq: number;
  type: StreamEventType;
  /** Server-side epoch milliseconds. */
  at: number;
}

export interface StartedEvent extends StreamEventBase {
  type: "started";
  model: string;
}

export interface DeltaEvent extends StreamEventBase {
  type: "delta";
  text: string;
}

export interface CompletedEvent extends StreamEventBase {
  type: "completed";
  /** Full text. Business generators must persist before completion (phase 4);
   * phase 1 emits only a synthetic transport sample held in bounded memory. */
  text: string;
  finishReason: "stop" | "length" | "unknown";
}

export interface FailedEvent extends StreamEventBase {
  type: "failed";
  code: string;
  message: string;
  /** True when some text was already emitted before the failure. */
  partial: boolean;
}

export interface CancelledEvent extends StreamEventBase {
  type: "cancelled";
  reason: "client_abort" | "server_shutdown" | "superseded" | "server_request";
  /** How much text had already been emitted when cancellation happened. */
  emittedChars: number;
}

export interface InterruptedEvent extends StreamEventBase {
  type: "interrupted";
  reason: "process_restart";
  emittedChars: number;
}

export type StreamEvent =
  | StartedEvent
  | DeltaEvent
  | CompletedEvent
  | FailedEvent
  | CancelledEvent
  | InterruptedEvent;

export const TERMINAL_EVENT_TYPES: readonly StreamEventType[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export function isTerminalEvent(e: StreamEvent): boolean {
  return TERMINAL_EVENT_TYPES.includes(e.type);
}

/**
 * Encode one event as a single SSE frame.
 *
 * A frame is terminated by a blank line. `data` is always a single line
 * because we JSON-encode (JSON.stringify never emits a raw newline).
 */
export function encodeSseFrame(event: StreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export const SSE_HEARTBEAT_FRAME = ": keep-alive\n\n";

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Defensive: tells intermediaries not to buffer. Caddy needs no such hint
  // (its default flush_interval is immediate) but other proxies do.
  "x-accel-buffering": "no",
};
