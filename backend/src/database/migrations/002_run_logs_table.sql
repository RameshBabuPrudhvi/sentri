-- Migration 002: Dedicated run_logs table (ENH-008)
--
-- Replaces the O(n²) JSON read-modify-write pattern in run.logs with a
-- normalised append-only table.  Each log line is a single INSERT row.
-- The legacy `logs` column on `runs` is kept as a nullable tombstone so
-- that the schema change is backwards compatible; all new writes go to
-- this table.

CREATE TABLE IF NOT EXISTS run_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  runId     TEXT    NOT NULL,
  seq       INTEGER NOT NULL,           -- 1-based monotonic counter per run
  level     TEXT    NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
  message   TEXT    NOT NULL,
  createdAt TEXT    NOT NULL            -- ISO 8601 timestamp
);

CREATE INDEX IF NOT EXISTS idx_run_logs_runId     ON run_logs(runId);
CREATE INDEX IF NOT EXISTS idx_run_logs_runId_seq ON run_logs(runId, seq);
