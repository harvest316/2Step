-- Migration 001: Rename prospects table to sites
-- Preserves all 37 existing prospect rows.
--
-- SQLite does not support ALTER TABLE RENAME TO inside a transaction in older
-- versions, but better-sqlite3 (SQLite 3.45+) supports it fine.

BEGIN IMMEDIATE;

ALTER TABLE prospects RENAME TO sites;

COMMIT;
