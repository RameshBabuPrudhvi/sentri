-- B1.1 — Per-test result flush + crash recovery (AUDIT-ROADMAP Bundle 1).
--
-- Replaces the in-memory `run.results[]` accumulation pattern in
-- `testRunner.js` with an append-only table. Each completed test writes
-- one row immediately on its execution `finally` so a SIGKILL / OOM /
-- container kill mid-run preserves every result collected up to that
-- point. `runRepo.getById()` reconstructs `run.results[]` from this
-- table on read (mirrors the `run_logs` pattern from ENH-008).
--
-- The UNIQUE(runId, testId, iterationIndex) constraint guarantees the
-- resume endpoint (`POST /api/v1/runs/:id/resume`) can use a single
-- SELECT to discover which tests have already completed and re-enqueue
-- only the missing ones. Data-driven tests (CAP-001 iterations) store
-- one row per iteration via the iterationIndex column (default 0 for
-- non-data-driven tests so SQLite's NULL-distinct UNIQUE semantics
-- don't permit accidental duplicates).
--
-- Referential integrity: `ON DELETE CASCADE` mirrors `run_logs`
-- (migration 002), `accessibility_violations` (migration 013), and
-- every other child table of `runs`. Industry-standard ACID FK
-- enforcement (SOC 2 CC8.1) requires child rows to be removed when the
-- parent run is hard-deleted — leaving orphans would corrupt the
-- audit trail.
--
-- Rollback: DROP TABLE run_test_results; — callers fall back to the
-- legacy in-memory `run.results[]` path that `testRunner.js` still
-- populates (B1 keeps both paths until B1.4 follow-up removes the
-- in-memory shadow).

CREATE TABLE IF NOT EXISTS run_test_results (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  testId TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  errorCategory TEXT,
  duration INTEGER,
  retryCount INTEGER DEFAULT 0,
  artifacts TEXT,
  healingEvents TEXT,
  iterationIndex INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  UNIQUE(runId, testId, iterationIndex)
);

CREATE INDEX IF NOT EXISTS idx_rtr_runId ON run_test_results(runId);
CREATE INDEX IF NOT EXISTS idx_rtr_runId_status ON run_test_results(runId, status);

INSERT OR IGNORE INTO counters(name, value) VALUES ('run_test_result', 0);
