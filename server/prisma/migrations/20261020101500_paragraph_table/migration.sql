-- Table blocks: a `paragraph` row may now be a table, so its cells live in a
-- JSONB column next to the text columns. Cell text stays plain strings; the
-- first row is the header. Existing rows are unaffected (`NULL` means "not a
-- table").
ALTER TABLE "paragraph" ADD COLUMN "rows" JSONB;
