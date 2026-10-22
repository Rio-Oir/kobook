-- Phase 3 (slice 3): notes + messages.
--
-- Two new tables, both bound to the article / version that already
-- exists from slice 1. Notes are anchored on a specific parse run so
-- refresh leaves the old notes readable against the old text; messages
-- are the conversation turns.
--
-- Purely additive. Existing tables (article, article_version, paragraph)
-- are not touched, so applying this migration does not invalidate any
-- row from slice 1 / 2.

-- CreateTable
CREATE TABLE "note" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "paragraphIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "selectionText" TEXT NOT NULL,
    "selectionHash" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'mock',
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "note_ownerUserId_articleId_idx" ON "note"("ownerUserId", "articleId");

-- CreateIndex
CREATE INDEX "note_versionId_idx" ON "note"("versionId");

-- CreateIndex
CREATE INDEX "note_articleId_paragraphIndex_idx" ON "note"("articleId", "paragraphIndex");

-- CreateIndex
CREATE INDEX "message_noteId_idx" ON "message"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX "message_noteId_sequence_key" ON "message"("noteId", "sequence");

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "article_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE CASCADE;
