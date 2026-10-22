-- Phase 3 (cross-segment follow-up): stable block ids + note range backfill.
--
-- Purely additive and data-preserving. Three things happen, in this order:
--
--   1. `paragraph.blockId` is added and populated from the same rule the
--      parse layer uses for `ContentBlock.id` (`b<index>-<hash8>`), so an
--      existing row's id matches what the parser would produce for the
--      same document. The column is then made NOT NULL. Two paragraphs
--      with identical text get different ids because the 1-based index
--      prefixes them — that is what makes duplicate paragraphs
--      distinguishable during note creation.
--
--   2. `note.startBlockId` / `note.endBlockId` are added and populated
--      from the note's own version, so a note written before this
--      migration ends up with the same anchor a new note would get. The
--      driver for a multi-paragraph range was left NULL by 202610140003
--      and is inferred here as "single paragraph at `paragraphIndex`",
--      which is the only shape the pre-migration API could express.
--
--   3. The cross-segment columns 202610140004 added are given a *correct*
--      backfill. That migration used column defaults (start/end offset 0),
--      which describes an empty range and therefore an invalid note. The
--      only range a pre-existing note can honestly mean is "the whole
--      stored selection inside the paragraph it is already anchored to",
--      which is exactly what is written here. The UPDATE is guarded so it
--      only touches rows still carrying the migration's own default
--      shape, and never rewrites a range a later write produced.

-- ── 1. paragraph.blockId ───────────────────────────────────────────────────
ALTER TABLE "paragraph" ADD COLUMN "blockId" TEXT NOT NULL DEFAULT '';
UPDATE "paragraph"
   SET "blockId" = 'b' || "blockIndex"::text || '-' || substr("hash", 1, 8)
 WHERE "blockId" = '';
ALTER TABLE "paragraph" ALTER COLUMN "blockId" DROP DEFAULT;

-- ── 2. note.startBlockId / note.endBlockId ─────────────────────────────────
ALTER TABLE "note" ADD COLUMN "startBlockId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "note" ADD COLUMN "endBlockId" TEXT NOT NULL DEFAULT '';

UPDATE "note" n
   SET "startBlockId" = p."blockId",
       "endBlockId"   = COALESCE(
         (SELECT p2."blockId" FROM "paragraph" p2
           WHERE p2."versionId" = n."versionId"
             AND p2."blockIndex" = n."endParagraphIndex"),
         p."blockId"
       )
  FROM "paragraph" p
 WHERE p."versionId" = n."versionId"
   AND p."blockIndex" = n."startParagraphIndex";

-- ── 3. correct the 202610140004 cross-segment backfill ─────────────────────
-- Only rows still in the state 202610140004 left them in: both offsets at
-- the column default and a non-empty stored selection.
UPDATE "note"
   SET "startParagraphIndex" = "paragraphIndex",
       "endParagraphIndex"   = "paragraphIndex",
       "startOffset"         = 0,
       "endOffset"           = char_length("selectionText")
 WHERE "startOffset" = 0
   AND "endOffset" = 0
   AND "startParagraphIndex" = 1
   AND "endParagraphIndex" = 1
   AND char_length("selectionText") > 0
   AND "paragraphIndex" <> 1;

-- Rows whose paragraphIndex really was 1 still need the end offset set,
-- otherwise the range stays empty and every such note is un-rereadable.
UPDATE "note"
   SET "startParagraphIndex" = "paragraphIndex",
       "endParagraphIndex"   = "paragraphIndex",
       "startOffset"         = 0,
       "endOffset"           = char_length("selectionText")
 WHERE "startOffset" = 0
   AND "endOffset" = 0
   AND char_length("selectionText") > 0;
