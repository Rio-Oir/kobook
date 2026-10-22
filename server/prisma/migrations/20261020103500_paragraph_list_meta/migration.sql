-- Nested and task lists: a `paragraph` row that is a list item now records
-- its 0-based nesting depth and, for a task item, whether its box is ticked.
-- Existing rows are unaffected (`NULL` depth means depth 0, `NULL` task means
-- an ordinary list item).
ALTER TABLE "paragraph" ADD COLUMN "depth" INTEGER;
ALTER TABLE "paragraph" ADD COLUMN "task" BOOLEAN;
ALTER TABLE "paragraph" ADD COLUMN "checked" BOOLEAN;
