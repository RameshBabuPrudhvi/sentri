-- Migration 002: Add compound index on runs(projectId, status)
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
