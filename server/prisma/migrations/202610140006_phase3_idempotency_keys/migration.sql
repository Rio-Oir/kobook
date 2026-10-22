-- Phase 3: client-supplied idempotency keys for import and note creation.
--
-- The anonymous→account migration has to be retryable: a dropped
-- connection between "the server created the row" and "the client
-- recorded the id" is the normal failure mode of a network operation, and
-- without a key the retry creates a *second* row. Tracking local ids
-- alone cannot close that window, because the id that was lost is exactly
-- the one the client needed.
--
-- So the key travels with the request and the server enforces uniqueness
-- on it:
--
--   * `article.clientKey` is unique per owner. A retried import returns
--     the article the first attempt created instead of a duplicate.
--   * `note.clientKey` is unique per article. A retried note creation
--     returns the note the first attempt created.
--
-- Both columns are nullable and both indexes are non-unique for NULL, so
-- every existing caller (which sends no key) keeps working unchanged and
-- every existing row is untouched. `clientKey` is a *correlation* value,
-- not an identifier of the caller: it is stored with the owner, and a
-- lookup always scopes by owner (or by article, which is itself
-- owner-scoped), so a guessed key cannot reach another account's row.
--
-- Purely additive; no existing column is modified and no data is
-- rewritten.

-- ── article.clientKey ──────────────────────────────────────────────────────
ALTER TABLE "article" ADD COLUMN "clientKey" TEXT;
CREATE UNIQUE INDEX "article_ownerUserId_clientKey_key"
    ON "article" ("ownerUserId", "clientKey");

-- ── note.clientKey ─────────────────────────────────────────────────────────
ALTER TABLE "note" ADD COLUMN "clientKey" TEXT;
CREATE UNIQUE INDEX "note_articleId_clientKey_key"
    ON "note" ("articleId", "clientKey");
