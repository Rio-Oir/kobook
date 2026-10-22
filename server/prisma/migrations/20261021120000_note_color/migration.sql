-- A note takes on the highlight colour the reader had armed when they asked,
-- so the passage underline, the sidebar card and the question bubbles inside it
-- all share one colour that belongs to that note alone.
--
-- Nullable, with no default: every row written before this column existed must
-- keep reading as "no colour chosen" and render with the default note blue.
-- Same treatment `paragraph.src` gets for image blocks.
ALTER TABLE "note" ADD COLUMN "color" TEXT;
