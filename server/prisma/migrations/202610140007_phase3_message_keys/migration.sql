-- Phase 3: client-supplied idempotency keys for appended messages.
--
-- `202610140006` gave `article` and `note` keys so a retried create
-- converges on one row. Messages need the same, and for a sharper reason:
-- a note's answer is appended by a client that may retry after a lost
-- response, and a duplicate assistant turn is not merely untidy — it is
-- duplicated content the user cannot remove without deleting the note,
-- and it silently doubles the context sent with the next follow-up.
--
-- The key is unique per note rather than per owner, because a message is
-- already scoped by the note it belongs to, and the note is owner-scoped
-- by the route. `NULL` keys (every existing caller) do not collide.
--
-- Purely additive. `message.sequence` is untouched, so the ordering of
-- existing rows is unaffected.

ALTER TABLE "message" ADD COLUMN "clientKey" TEXT;
CREATE UNIQUE INDEX "message_noteId_clientKey_key"
    ON "message" ("noteId", "clientKey");
