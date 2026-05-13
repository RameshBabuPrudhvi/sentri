-- CAP-001: per-test data-driven fixtures. Keyed on (testId, version) so a
-- new code version (e.g. after an AI fix bumps `codeVersion`) starts with a
-- fresh fixture slot and old fixtures stay around for run-history replay.
-- `format` is constrained to keep the upload validator's allowlist in lock
-- step with the persisted shape — single-quoted literals so the migration
-- parses on both SQLite and the Postgres adapter (INF-008).
CREATE TABLE IF NOT EXISTS test_fixtures (
  testId TEXT NOT NULL,
  version INTEGER NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv', 'json')),
  rows TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (testId, version)
);

CREATE INDEX IF NOT EXISTS idx_test_fixtures_testId ON test_fixtures(testId);

-- CAP-001: per-project cap on fixture iterations dispatched per test (default
-- 10, hard ceiling 100). Server-side `clampIterationCap` enforces the
-- 1..100 range regardless of the persisted value so a malformed write can't
-- exhaust the worker pool. NULL → falls through to the default 10.
ALTER TABLE projects ADD COLUMN iterationCap INTEGER;
