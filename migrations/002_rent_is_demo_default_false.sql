-- 002: new rent rows are real unless they say otherwise.
-- 001 left rent_records.is_demo defaulting to true (from the column's backfill). Every insert
-- in the app sets it explicitly today, but a future one that forgot would create "demo" rent
-- that Reset demo data then deletes. Existing rows keep their values; only the default changes.
ALTER TABLE rent_records ALTER COLUMN is_demo SET DEFAULT false;
