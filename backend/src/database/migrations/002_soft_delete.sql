-- Migration 002: Add deletedAt columns for soft-delete (ENH-020)
--
-- For databases created before the deletedAt columns were added to
-- 001_initial_schema.sql, this migration adds the missing columns and
-- indexes.  On new databases where 001 already includes these columns,
-- the migration runner silently ignores "duplicate column name" errors
-- from ALTER TABLE ADD COLUMN (SQLite has no IF NOT EXISTS for ALTER).
-- CREATE TABLE / CREATE INDEX use IF NOT EXISTS and are always safe.

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
