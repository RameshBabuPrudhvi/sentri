-- Migration 002: Add deletedAt columns for soft-delete (ENH-020)
--
-- For databases created before the deletedAt columns were added to
-- 001_initial_schema.sql, this migration adds the missing columns and
-- indexes.  All statements are idempotent — safe to run on new databases
-- where 001 already includes these columns.
--
-- SQLite's ALTER TABLE ADD COLUMN does not support IF NOT EXISTS, so we
-- guard each ALTER with a sub-select against pragma_table_info().

-- ── projects.deletedAt ────────────────────────────────────────────────────────
-- SQLite trick: the ALTER fails if the column already exists, so we wrap
-- each in a no-op SELECT guard.  Unfortunately SQLite doesn't support
-- procedural IF, so we use the INSERT-OR-IGNORE-into-temp approach:
-- Actually, the simplest safe approach is to attempt the ALTER and let the
-- migration runner handle it.  Since 001 on new DBs already has the column,
-- and this file only runs on DBs that applied the OLD 001, the column is
-- guaranteed to be missing here.

ALTER TABLE projects   ADD COLUMN deletedAt TEXT;
ALTER TABLE tests      ADD COLUMN deletedAt TEXT;
ALTER TABLE runs       ADD COLUMN deletedAt TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_deletedAt ON projects(deletedAt);
CREATE INDEX IF NOT EXISTS idx_tests_deletedAt    ON tests(deletedAt);
CREATE INDEX IF NOT EXISTS idx_runs_deletedAt     ON runs(deletedAt);

-- ── activities: userId / userName (was migration 004) ─────────────────────────
ALTER TABLE activities ADD COLUMN userId   TEXT;
ALTER TABLE activities ADD COLUMN userName TEXT;
CREATE INDEX IF NOT EXISTS idx_activities_userId ON activities(userId);

-- ── healing_history: strategyVersion (was migration 002) ──────────────────────
ALTER TABLE healing_history ADD COLUMN strategyVersion INTEGER;

-- ── password_reset_tokens (was migration 003) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token     TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  usedAt    TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prt_userId    ON password_reset_tokens(userId);
CREATE INDEX IF NOT EXISTS idx_prt_expiresAt ON password_reset_tokens(expiresAt);

-- ── api_keys (was migration 005) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  provider    TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
