-- Phase 3 (slice 1): article library
--
-- Three tables back the user-owned article library:
--   * `article`         — owner, source, title, soft-delete marker
--   * `article_version` — one parse run; refresh in slice 2 will add v2/v3
--   * `paragraph`       — verbatim copy of the ContentBlock array
--
-- Slice 1 ships only the text-import + CRUD path. Notes / messages /
-- generation jobs are slice 2 / 4 work and are not represented here yet;
-- the type names live in `shared/contracts` so frontend callers do not
-- break when those tables arrive.
--
-- Soft delete (`deletedAt`) is the only delete the slice exposes. Account
-- deletion is the only thing that will physically remove these rows
-- (phase 6); a hard delete here would be inconsistent with the "no
-- leaked entry points" gate, because foreign keys (notes, generation
-- jobs) would still reference the row until they too are deleted.

-- CreateTable
CREATE TABLE "article" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "article_version" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "textHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "article_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paragraph" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "blockIndex" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "level" INTEGER,
    "lang" TEXT,
    "ordered" BOOLEAN,

    CONSTRAINT "paragraph_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "article_ownerUserId_id_idx" ON "article"("ownerUserId", "id");

-- CreateIndex
CREATE INDEX "article_ownerUserId_deletedAt_id_idx" ON "article"("ownerUserId", "deletedAt", "id");

-- CreateIndex
CREATE INDEX "article_version_articleId_isCurrent_idx" ON "article_version"("articleId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "article_version_articleId_version_key" ON "article_version"("articleId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "paragraph_versionId_blockIndex_key" ON "paragraph"("versionId", "blockIndex");

-- AddForeignKey
ALTER TABLE "article_version" ADD CONSTRAINT "article_version_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paragraph" ADD CONSTRAINT "paragraph_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "article_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
