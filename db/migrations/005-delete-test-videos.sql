-- Migration 005: Delete 44 test videos (one-time cleanup)
-- All videos created before 2026-01-01 are prototype/test data and can be discarded.
-- The 37 existing site rows are preserved.

BEGIN IMMEDIATE;

DELETE FROM videos WHERE created_at < '2026-01-01';

COMMIT;
