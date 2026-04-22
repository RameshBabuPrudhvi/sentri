-- Migration 006: Stale test detection (AUTO-013)
--
-- Adds an `isStale` boolean column to the `tests` table.
-- Tests that haven't been run in a configurable number of days (default 90)
-- or whose sourceUrl no longer appears in the last crawl are flagged as stale.
-- A background job in scheduler.js runs weekly to detect and flag stale tests.

ALTER TABLE tests ADD COLUMN isStale INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tests_isStale ON tests(isStale);
