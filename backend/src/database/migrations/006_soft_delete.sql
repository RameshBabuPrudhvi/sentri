-- Migration 006: Soft-delete support for tests, projects, and runs
-- Adds deletedAt column to all three entity tables.
-- All SELECT queries filter WHERE deletedAt IS NULL by default.
-- DELETE handlers set deletedAt = datetime('now') instead of removing rows.

-- SQLite ALTER TABLE ADD COLUMN is always a no-op if the column already exists
-- when tested via PRAGMA, but there is no "ADD COLUMN IF NOT EXISTS" syntax in
-- SQLite < 3.37.  We use a safe pattern: add columns unconditionally and let
-- SQLite raise a harmless "duplicate column" error only if re-run, which the
-- migration runner wraps in a transaction that is never re-applied (checksum guard).

ALTER TABLE tests    ADD COLUMN deletedAt TEXT;
ALTER TABLE projects ADD COLUMN deletedAt TEXT;
ALTER TABLE runs     ADD COLUMN deletedAt TEXT;

-- Indexes for the common soft-delete filter
CREATE INDEX IF NOT EXISTS idx_tests_deletedAt    ON tests(deletedAt);
CREATE INDEX IF NOT EXISTS idx_projects_deletedAt ON projects(deletedAt);
CREATE INDEX IF NOT EXISTS idx_runs_deletedAt     ON runs(deletedAt);

-- Counter for recycle-bin items (optional convenience, seeded to 0)
INSERT OR IGNORE INTO counters(name, value) VALUES ('deleted_test', 0);
INSERT OR IGNORE INTO counters(name, value) VALUES ('deleted_project', 0);
INSERT OR IGNORE INTO counters(name, value) VALUES ('deleted_run', 0);
