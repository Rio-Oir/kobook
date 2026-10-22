-- Image blocks: a `paragraph` row may now be an image, so the three fields
-- the renderer needs live next to the text columns instead of in a JSON blob.
-- Existing rows are unaffected (`NULL` means "not an image").
ALTER TABLE "paragraph" ADD COLUMN "src" TEXT;
ALTER TABLE "paragraph" ADD COLUMN "alt" TEXT;
ALTER TABLE "paragraph" ADD COLUMN "title" TEXT;
