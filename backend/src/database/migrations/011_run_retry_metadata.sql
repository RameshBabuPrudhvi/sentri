-- Migration 011: Run retry metadata (AUTO-005)
-- Tracks aggregated retry telemetry for run-level analytics.

ALTER TABLE runs ADD COLUMN retryCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN failedAfterRetry INTEGER NOT NULL DEFAULT 0;
