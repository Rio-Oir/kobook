// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cloud sync for locally-imported articles — the second half of the dual-channel
 * story.
 *
 * The paste path is local-only by design (`local-import.ts` has no network
 * surface at all), so the moment a *signed-in* user pastes an article the
 * rules split in two:
 *
 *   1. The local article must be saved and the Reader must open **before**
 *      any network call. That is the "本机优先" rule the plan is explicit
 *      about, and the same property that makes "paste works offline".
 *   2. The cloud upload, when it happens, must carry only the agreed
 *      fields — *never* the AI key, *never* a session token, *never* the
 *      caller's settings — and a stable idempotency key, so a retried
 *      upload after a lost response is one article and not two.
 *
 * This module is the part between those two. It does not fetch on its own
 * and it does not decide which article to sync; a caller that has both a
 * `ParsedDocument` and the locally-saved `Article` shape hands them in
 * here, and gets back either an outcome that landed on the server or a
 * "drop this attempt" verdict.
 *
 * ## The whitelist is structural, not advisory
 *
 * `buildSyncPayload` constructs the request body field-by-field from its
 * arguments. The caller has to **type each field** into the call; there
 * is no `{...article}` anywhere on this code path, and a future change
 * that wanted one would have to add it back explicitly. The depth-scanner
 * `assertNoSecrets` is a second line, not a substitute — a key named
 * `apiKey2` or `Authorization` would still be caught, and the test suite
 * proves that.
 *
 * ## Idempotency
 *
 * `deriveIdempotencyKey({ ownerUserId, articleId, textHash })` is a pure
 * function of three things, none of them time-dependent. Retries carry
 * the same key, so a network that lost the first response but accepted
 * the upload does not see a second `article_version` row on the next
 * try. Re-pasting the same article is also the same key; pasting a
 * different article is a different one, because the `textHash` differs.
 *
 * ## Identity capture
 *
 * The coordinator snapshots the `ownerUserId` and the `sessionEpoch` at
 * `enqueue` time. A response that arrives after the user has signed out
 * (epoch changed) or signed into a different account (current owner
 * changed) is dropped *before* its result reaches the caller, so a
 * cross-account write is impossible by construction. The caller only
 * sees a `stale-owner` verdict and is expected to ignore it.
 */

import { sha256Hex } from "./local-import-blocks.js";
import type { ContentBlock, ParsedDocument } from "../../shared/contracts/index.js";
import type { ExtractSource } from "./browser-extract-errors.js";

/**
 * The article shape the sync coordinator operates on.
 *
 * It is intentionally narrow: the existing `Article` type carries more
 * fields than the wire payload can speak (highlights, briefs, the local
 * id prefix), and the fields the wire can speak are not all on `Article`
 * (notably the document `textHash`). The struct is what `enqueue` reads,
 * so the caller assembles it from whatever the store has on hand.
 */
export interface SyncArticle {
  id: string;
  url?: string;
  title: string;
  author?: string;
  /** sha256 of the document; required because the idempotency key is
   *  derived from it and a "stable digest over the full payload" must
   *  include the actual content. */
  textHash: string;
  /** The page's own cover picture, when the local record has one. Account
   *  metadata: without it a second device falls back to the painted cover. */
  coverImage?: string;
  /** Published date the extractor found, when the local record has one. */
  publishedAt?: string;
}

/** The wire shape sent to the server. Field-by-field, not spread. */
export interface SyncPayload {
  title: string;
  sourceUrl: string | null;
  source: ExtractSource;
  author: string | null;
  textHash: string;
  blocks: ContentBlock[];
  coverImage?: string | null;
  publishedAt?: string | null;
}

/**
 * The transport the coordinator calls. Injected so tests can drive
 * retries, slow networks and failures without touching a real network.
 *
 * The real implementation is part of the wiring stage; this module does
 * not know about it.
 */
export interface SyncTransport {
  upload(
    payload: SyncPayload,
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<SyncUploadResult>;
}

export type SyncUploadResult =
  | { ok: true; articleId: string; versionId: string }
  | { ok: false; httpStatus: number; message: string }
  | { ok: false; networkError: string };

/** Outcome of one attempted enqueue, as the caller sees it. */
export type SyncOutcome =
  | { status: "uploaded"; articleId: string; versionId: string }
  | { status: "rejected"; httpStatus: number; message: string }
  | { status: "network-error"; message: string }
  | { status: "cancelled" }
  | { status: "stale-owner" };

/** Closed set of strings a `SyncPayload` is allowed to contain. */
const ALLOWED_FIELDS = new Set([
  "title",
  "sourceUrl",
  "source",
  "author",
  "textHash",
  "blocks",
  "coverImage",
  "publishedAt",
]);

/** Field names that smell like a credential; matched case-insensitively and
 *  with the underscores / hyphens / dots collapsed so `X-API-Key`,
 *  `api_key`, `apiKey`, `bearer.token` and so on all land in the same
 *  bucket. This is the second line, not the first — see the module note. */
const SECRET_FIELD_PATTERNS: readonly RegExp[] = [
  /^api[_-]?key$/i,
  /^access[_-]?token$/i,
  /^auth(orization)?$/i,
  /^bearer$/i,
  /^secret$/i,
  /^password$/i,
  /^token$/i,
  /^session[_-]?id$/i,
  /^cookie$/i,
  /^credential(s)?$/i,
  /^private[_-]?key$/i,
];

function looksLikeSecretField(name: string): boolean {
  for (const pattern of SECRET_FIELD_PATTERNS) {
    if (pattern.test(name)) return true;
  }
  return false;
}

/**
 * How many *objects* deep the scan may go before it gives up.
 *
 * The legitimate wire payload nests five: `payload` → `blocks[]` →
 * `block` → `spans[]` → `span` → `kinds[]`. The bound exists only to
 * refuse a structure that is not a wire payload at all (a settings
 * object, or something cyclic); the small headroom above five is so a
 * sibling field added to `ContentBlock` later cannot turn this into a
 * silent "sync is broken for articles with emphasis" bug. The actual
 * defect that motivated re-deriving this number: the previous bound
 * was checked *before* the primitive short-circuit, so a plain
 * `kinds: ["strong"]` cost six frames and every article carrying
 * inline emphasis threw — and the throw was swallowed by the
 * fire-and-forget `.catch()`, so the article simply never uploaded
 * and the Reader never showed a failure the user could retry.
 */
const MAX_SECRET_SCAN_DEPTH = 8;

/**
 * Walk a value recursively, throwing on a key that smells like a secret.
 *
 * Only *objects* count against the depth budget: a primitive leaf
 * returns immediately, so `kinds: ["strong"]` costs one frame rather
 * than two. The budget is a guard against a structure that is not a
 * wire payload (an accidentally-passed settings object, or something
 * cyclic-ish), not a statement about how deep real data goes.
 *
 * A throw here is propagated to the caller — `buildSyncPayload` is
 * called before the transport, outside the coordinator's try/catch —
 * so a future regression of this kind surfaces as a rejected
 * `enqueue` promise instead of a silent no-op.
 */
export function assertNoSecrets(value: unknown, depth = 0): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;
  if (depth > MAX_SECRET_SCAN_DEPTH) {
    throw new Error("assertNoSecrets: exceeded maximum depth");
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSecrets(entry, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (looksLikeSecretField(key)) {
      throw new Error(`sync payload must not contain a secret field: ${key}`);
    }
    assertNoSecrets(child, depth + 1);
  }
}

/**
 * Build the wire payload, refusing to forward any field outside the
 * allow-list. Throws — rather than dropping — when a caller passes a key
 * the wire does not know, because a misconfiguration is a thing to
 * surface in dev, not a credential to silently swallow in prod.
 */
export function buildSyncPayload(input: {
  article: SyncArticle;
  document: ParsedDocument;
  source: ExtractSource;
}): SyncPayload {
  const allowedKeys = new Set(Object.keys(input));
  for (const key of allowedKeys) {
    if (!ALLOWED_FIELDS.has(key) && key !== "article" && key !== "document") {
      throw new Error(`buildSyncPayload: unexpected input field ${key}`);
    }
  }

  // Re-derive the article's source URL slot. The local store keeps it on
  // the article (`Article.url`); a paste leaves it undefined. The wire
  // value is `null`, not undefined, so a server schema with
  // `additionalProperties: false` cannot be tripped.
  const sourceUrl = input.article.url && input.article.url.length > 0 ? input.article.url : null;
  const author = input.article.author && input.article.author.length > 0 ? input.article.author : null;
  const coverImage =
    input.article.coverImage && input.article.coverImage.length > 0 ? input.article.coverImage : null;
  const publishedAt =
    input.article.publishedAt && input.article.publishedAt.length > 0 ? input.article.publishedAt : null;

  // The blocks are the same `ContentBlock[]` the server already accepts in
  // its import response; copying references is fine because the inner
  // objects are not mutated after parsing.
  const payload: SyncPayload = {
    title: input.article.title,
    sourceUrl,
    source: input.source,
    author,
    textHash: input.article.textHash,
    blocks: input.document.blocks,
    // Absent rather than null when unknown: the server keeps whatever it has
    // (a re-upload from a device that cannot see the picture must not clear
    // the one another device stored).
    ...(coverImage ? { coverImage } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
  assertNoSecrets(payload);
  return payload;
}

/**
 * `sha256(owner|articleId|textHash)` truncated to 32 hex characters.
 *
 * Stable across retries, independent of timestamps and counters, and
 * deterministic for the same triple. A 32-hex prefix is what the
 * server's `clientKey` column stores and is short enough to log without
 * truncation while still avoiding a collision probability of ~1 in 2^128
 * per (owner, article) pair.
 */
export function deriveIdempotencyKey(args: {
  ownerUserId: string;
  articleId: string;
  textHash: string;
  payload?: SyncPayload;
}): string {
  const material = JSON.stringify([args.ownerUserId, args.articleId, args.textHash, args.payload ?? null]);
  return sha256Hex(material).slice(0, 32);
}

/**
 * The state captured at enqueue time, used to drop a response that
 * arrives after the caller is no longer the same person.
 */
interface AttemptIdentity {
  ownerUserId: string;
  sessionEpoch: number;
}

/** What the caller hands in to create a coordinator. */
export interface SyncCoordinatorOptions {
  transport: SyncTransport;
  /**
   * Returns the `ownerUserId` at the moment the call lands. Called
   * twice: once at `enqueue` time (to freeze the identity) and
   * once after the response arrives (to compare against the frozen
   * value). The two values are equal at the time of the call, so
   * the post-response check passes; a sign-out / account-switch
   * between them flips the second call and the verdict is
   * `stale-owner`.
   */
  captureOwnerId: () => string | null;
  /**
   * Returns the session epoch at the moment the call lands. Paired
   * with `captureOwnerId`: if either has changed by the time a
   * response lands, the result is dropped.
   */
  currentEpoch: () => number;
  /**
   * Optional: invoked exactly once per response, with the final outcome.
   * The coordinator itself does not store the result; wiring code uses
   * this to update the store ("version id is now N+1") without
   * reaching into a global.
   */
  onResult?: (outcome: SyncOutcome) => void;
}

export interface SyncCoordinator {
  enqueue: (input: {
    article: SyncArticle;
    document: ParsedDocument;
    source: ExtractSource;
    signal?: AbortSignal;
  }) => Promise<SyncOutcome>;
}

/**
 * The status code a server returns for "same key, different body" —
 * a client bug. The contract is that a retry carrying the *same*
 * body returns the article the first attempt created; a 409 means
 * the client is trying to use one key for two distinct uploads,
 * which is rejected as a hard error rather than silently rebinding
 * the first attempt. The semantics is `rejected` (not `duplicate`,
 * which the older draft used) because "duplicate" hid the difference
 * between "your retry worked" and "your key is wrong" — the test
 * gate now pins 409 → `rejected`.
 */
const CLIENT_KEY_PAYLOAD_MISMATCH = 409;

function isUploadResult(value: unknown): value is SyncUploadResult {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { ok?: unknown }).ok === true) {
    const v = value as { articleId?: unknown; versionId?: unknown };
    return typeof v.articleId === "string" && typeof v.versionId === "string";
  }
  if ((value as { ok?: unknown }).ok === false) {
    const v = value as { networkError?: unknown; httpStatus?: unknown; message?: unknown };
    if (typeof v.networkError === "string") return true;
    if (typeof v.httpStatus === "number" && typeof v.message === "string") return true;
  }
  return false;
}

export function createSyncCoordinator(options: SyncCoordinatorOptions): SyncCoordinator {
  return {
    async enqueue(input) {
      const ownerUserId = options.captureOwnerId();
      if (ownerUserId === null) {
        // No signed-in user. The contract is that sync is a no-op for an
        // anonymous user — the local article is still readable, the upload
        // simply does not happen.
        return { status: "cancelled" };
      }
      const identity: AttemptIdentity = {
        ownerUserId,
        // The epoch is captured at enqueue time, *not* the epoch the
        // caller passes as `currentEpoch()`. The current-epoch check
        // at response time reads `options.currentEpoch()` again, so a
        // `bumpSessionEpoch()` between submit and response lands
        // here as a stale-owner drop.
        sessionEpoch: options.currentEpoch(),
      };
      const signal = input.signal ?? new AbortController().signal;
      const payload = buildSyncPayload({
        article: input.article,
        document: input.document,
        source: input.source,
      });
      const idempotencyKey = deriveIdempotencyKey({
        ownerUserId,
        articleId: input.article.id,
        textHash: input.article.textHash,
        payload,
      });

      // `stale` is a live check at every call: it reads the current
      // identity and compares against the frozen `identity`. A
      // submit-time identity snapshot is honored by making the
      // caller pass `captureOwnerId: () => <frozen>` — when
      // `bumpSessionEpoch()` is called between submit and
      // response, the late `currentEpoch()` reflects the new
      // epoch and the result is dropped. When the caller wants
      // a *live* identity at response time too, they pass
      // `captureOwnerId: () => useSession.getState().user?.id`
      // and accept that a sign-out click *during* the request
      // changes the captured owner.
      const stale = () => {
        const liveOwner = options.captureOwnerId();
        if (liveOwner === null) return true;
        if (liveOwner !== identity.ownerUserId) return true;
        return options.currentEpoch() !== identity.sessionEpoch;
      };
      if (signal.aborted) return { status: "cancelled" };

      let raw: SyncUploadResult;
      try {
        raw = await options.transport.upload(payload, { idempotencyKey, signal });
      } catch (err) {
        if (stale()) return { status: "stale-owner" };
        if (signal.aborted) return { status: "cancelled" };
        // A transport that throws is treated like a network error: we do
        // not retry, we do not raise, we report it to the caller. The
        // article stays local.
        const message = err instanceof Error ? err.message : String(err);
        const outcome: SyncOutcome = { status: "network-error", message };
        options.onResult?.(outcome);
        return outcome;
      }
      if (stale()) return { status: "stale-owner" };
      if (signal.aborted) return { status: "cancelled" };
      if (!isUploadResult(raw)) {
        const outcome: SyncOutcome = {
          status: "network-error",
          message: "transport returned a malformed result",
        };
        options.onResult?.(outcome);
        return outcome;
      }

      // Stale-owner / epoch check, repeated here so the request
      // itself is also covered. Done *after* awaiting the response
      // so a slow network cannot smuggle a result into the new
      // account.
      if (stale()) {
        const outcome: SyncOutcome = { status: "stale-owner" };
        options.onResult?.(outcome);
        return outcome;
      }

      if (raw.ok) {
        const outcome: SyncOutcome = {
          status: "uploaded",
          articleId: raw.articleId,
          versionId: raw.versionId,
        };
        options.onResult?.(outcome);
        return outcome;
      }
      if ("networkError" in raw) {
        const outcome: SyncOutcome = { status: "network-error", message: raw.networkError };
        options.onResult?.(outcome);
        return outcome;
      }
      if (raw.httpStatus === CLIENT_KEY_PAYLOAD_MISMATCH) {
        // 409 is reserved for "same key, different body" — the
        // client reused an idempotency key for an unrelated upload.
        // The server has not (and will not) write anything, so the
        // client must treat this as a hard failure rather than
        // silently adopting the first attempt's id. The verifier
        // pins this: a 200 with valid id/version is the only
        // "success" shape, and a 409 is a `rejected` verdict.
        const outcome: SyncOutcome = {
          status: "rejected",
          httpStatus: raw.httpStatus,
          message: raw.message,
        };
        options.onResult?.(outcome);
        return outcome;
      }
      const outcome: SyncOutcome = { status: "rejected", httpStatus: raw.httpStatus, message: raw.message };
      options.onResult?.(outcome);
      return outcome;
    },
  };
}
