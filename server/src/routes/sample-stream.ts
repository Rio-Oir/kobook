// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Mock streaming sample (`/api/sample/stream`).
 *
 * Purpose: give the transport acceptance test something real to measure.
 * The endpoint emits a scripted sequence of SSE frames with a configurable
 * delay between them, over a session-protected route.
 *
 * Two properties this route is built to make observable:
 *
 *  1. Incremental delivery. Because there is a real delay between frames, a
 *     buffering intermediary (or a `flush_interval` that batches) shows up as
 *     all frames arriving in one burst at the end. The test measures arrival
 *     timestamps per frame rather than comparing the final string.
 *
 *  2. Cancellation propagation. When the client disconnects, the server must
 *     stop producing. Every job keeps a bounded record that a test can read
 *     back over HTTP: terminal status, characters emitted before the cancel,
 *     and how many deltas slipped out afterwards (which must be 0).
 *
 * No model, no network egress, no real provider: the text is generated
 * locally from the request.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { StreamEvent } from "../../../shared/contracts/index.js";
import { ROUTES, SSE_HEADERS, encodeSseFrame } from "../../../shared/contracts/index.js";
import type { Auth } from "../auth.js";
import { createRequireSession, currentSession } from "../plugins/session.js";
import { StreamRegistry, type StreamJobSnapshot } from "../lib/stream-registry.js";

export interface StreamSampleOptions {
  registry: StreamRegistry;
  /** Used for the `started` event's model field. */
  modelLabel?: string;
}

const DEFAULT_CHUNKS = [
  "阅读",
  "是一种",
  "安静的",
  "对话",
  "。",
  "The answer",
  " arrives",
  " in pieces",
  ",",
  " not",
  " all at once",
  ".",
];

const streamSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      chunks: {
        type: "array",
        maxItems: 200,
        items: { type: "string", maxLength: 2000 },
      },
      intervalMs: { type: "integer", minimum: 0, maximum: 5000 },
    },
  },
} as const;

export async function registerStreamRoutes(
  app: FastifyInstance,
  auth: Auth,
  options: StreamSampleOptions,
): Promise<void> {
  const { registry } = options;
  const modelLabel = options.modelLabel ?? "mock-stream-v1";
  const requireSession = createRequireSession(auth);
  // Keep ownership with the bounded registry rather than creating another unbounded map.

  app.post(
    ROUTES.sampleStream,
    { preHandler: requireSession, schema: streamSchema },
    async (req, reply) => {
      const body = (req.body ?? {}) as { chunks?: string[]; intervalMs?: number };
      const chunks = body.chunks && body.chunks.length > 0 ? body.chunks : DEFAULT_CHUNKS;
      const intervalMs = body.intervalMs ?? 100;

      const jobId = randomUUID();
      registry.create(jobId, currentSession(req).user.id);

      let seq = 0;
      /** Assigns the per-job envelope fields. Kept explicit so each emitted
       *  event is fully typed rather than cast into shape. */
      const stamp = (): { jobId: string; seq: number; at: number } => ({
        jobId,
        seq: (seq += 1),
        at: Date.now(),
      });

      // Take over the socket: SSE must not go through Fastify's serialiser.
      reply.hijack();
      reply.raw.writeHead(200, { ...SSE_HEADERS });

      let finishedNormally = false;
      let emitted = 0;
      let emittedChars = 0;

      const onClientGone = (): void => {
        if (finishedNormally) return;
        const cancelled = registry.cancel(jobId, "client_abort");
        if (!cancelled) return;
        registry.record(jobId, {
          ...stamp(),
          type: "cancelled",
          reason: "client_abort",
          emittedChars,
        });
      };

      req.raw.on("close", onClientGone);
      reply.raw.on("close", onClientGone);

      try {
        const started: StreamEvent = { ...stamp(), type: "started", model: modelLabel };
        registry.record(jobId, started);
        reply.raw.write(encodeSseFrame(started));

        for (const chunk of chunks) {
          if (intervalMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
          }

          // Synchronous check-then-record: no `await` between these two
          // statements, so an abort handler running on a later tick cannot
          // interleave. That is what makes `deltasAfterCancel === 0` a real
          // guarantee rather than a race the test happens to win.
          if (registry.isCancelled(jobId)) break;

          const delta: StreamEvent = { ...stamp(), type: "delta", text: chunk };
          registry.record(jobId, delta);
          emitted += 1;
          emittedChars += chunk.length;
          reply.raw.write(encodeSseFrame(delta));
        }

        // Only a run that was neither cancelled nor interrupted gets a
        // terminal "completed". A cancelled run already recorded its own
        // terminal event from the abort handler.
        if (registry.isCancelled(jobId) && registry.snapshot(jobId)?.status === "running") {
          const cancelled: StreamEvent = { ...stamp(), type: "cancelled", reason: "server_request", emittedChars };
          registry.record(jobId, cancelled);
          reply.raw.write(encodeSseFrame(cancelled));
        } else if (!registry.isCancelled(jobId)) {
          const completed: StreamEvent = {
            ...stamp(),
            type: "completed",
            text: chunks.slice(0, emitted).join(""),
            finishReason: "stop",
          };
          registry.record(jobId, completed);
          reply.raw.write(encodeSseFrame(completed));
        }
      } finally {
        finishedNormally = true;
        req.raw.off("close", onClientGone);
        reply.raw.off("close", onClientGone);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    },
  );

  /** Observable job state — this is how a test reads cancellation outcome. */
  app.get(
    `${ROUTES.sampleStream}/:jobId`,
    { preHandler: requireSession },
    async (req, reply): Promise<StreamJobSnapshot | undefined> => {
      const { jobId } = req.params as { jobId: string };
      const snapshot = registry.snapshot(jobId);
      if (!snapshot || !registry.isOwner(jobId, currentSession(req).user.id)) {
        reply.code(404);
        return undefined;
      }
      return snapshot;
    },
  );

  /** Explicit server-side cancellation (distinct from a client disconnect). */
  app.post(
    `${ROUTES.sampleStream}/:jobId/cancel`,
    { preHandler: requireSession },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      if (!registry.isOwner(jobId, currentSession(req).user.id)) return reply.code(404).send({ cancelled: false, reason: "unknown_job" });
      const requested = registry.cancel(jobId, "server_request");
      const snapshot = registry.snapshot(jobId);
      if (!snapshot) {
        reply.code(404);
        return { cancelled: false, reason: "unknown_job" };
      }
      return { cancelled: requested, status: snapshot.status };
    },
  );
}
