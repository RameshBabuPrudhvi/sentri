-- 005: Stale test detection (AUTO-013) + Flaky score (DIF-004)
--
-- isStale: boolean flag for tests not run in STALE_TEST_DAYS (default 90).
--   A weekly cron job in scheduler.js detects and flags stale tests.
--
-- flakyScore: 0–100 alternation rate between pass/fail across recent runs.
--   Computed after each test run by the flaky detector utility.

ALTER TABLE tests ADD COLUMN isStale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tests ADD COLUMN flakyScore REAL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tests_isStale ON tests(isStale);
CREATE INDEX IF NOT EXISTS idx_tests_flakyScore ON tests(flakyScore);
