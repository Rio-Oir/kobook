-- Article metadata that belongs to the account, not to one device.
-- Until this migration each of these lived only in the local store: a second
-- device saw the painted default cover, no tags, and no generated summary
-- even though the first device had all three.
ALTER TABLE "article" ADD COLUMN "coverImage" TEXT;
ALTER TABLE "article" ADD COLUMN "publishedAt" TEXT;
ALTER TABLE "article" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "article" ADD COLUMN "tagsModel" TEXT;
ALTER TABLE "article" ADD COLUMN "tagsAt" TIMESTAMP(3);
ALTER TABLE "article" ADD COLUMN "brief" JSONB;
ALTER TABLE "article" ADD COLUMN "briefAt" TIMESTAMP(3);

-- Reader-made marks. Separate from `note` because the common mark has no
-- question and a note's range can span paragraphs; folding them together
-- would make one shape's key fields nullable for the other's sake.
CREATE TABLE "highlight" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "paragraphIndex" INTEGER NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL DEFAULT '',
    "selectionText" TEXT NOT NULL,
    "selectionHash" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'watercolor',
    "note" TEXT NOT NULL DEFAULT '',
    "detached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clientKey" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "highlight_pkey" PRIMARY KEY ("id")
);

-- Idempotent create: a retried request with the same client key returns the
-- row the first attempt wrote instead of painting a second mark.
CREATE UNIQUE INDEX "highlight_articleId_clientKey_key" ON "highlight"("articleId", "clientKey");

-- The two queries every route runs: "this owner's marks for this article"
-- and "which paragraph do these marks belong to".
CREATE INDEX "highlight_ownerUserId_articleId_idx" ON "highlight"("ownerUserId", "articleId");
CREATE INDEX "highlight_articleId_paragraphIndex_idx" ON "highlight"("articleId", "paragraphIndex");

ALTER TABLE "highlight" ADD CONSTRAINT "highlight_articleId_fkey"
    FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;
