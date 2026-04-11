-- Migration 002: Add compound index on runs(projectId, status)
--
-- NOTE: This index is also defined in 001_initial_schema.sql for new databases.
-- This migration exists solely to add the index to databases created before
-- the 001 schema was updated. Both use IF NOT EXISTS so the duplicate is safe.
--
-- findActiveByProjectId() runs:
--   SELECT * FROM runs WHERE projectId = ? AND status = 'running'
--
-- The separate single-column indexes (idx_runs_projectId, idx_runs_status)
-- force SQLite to perform an index intersection on every call. This compound
-- index resolves both predicates in a single B-tree scan.
--
-- Called before every crawl and test-run start, so this is a hot path.

CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs(projectId, status);
