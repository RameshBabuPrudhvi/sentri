-- Migration 004: Workspaces + RBAC (ACL-001, ACL-002)
--
-- ACL-001 — Multi-tenancy: workspace ownership on all entities
-- Adds a `workspaces` table and a `workspaceId` foreign key to projects,
-- tests, runs, and activities.  All queries are scoped to the authenticated
-- user's workspace so tenants cannot see each other's data.
--
-- ACL-002 — Role-based access control (Admin / QA Lead / Viewer)
-- Adds a `workspace_members` join table with a `role` column.
-- Roles: 'admin', 'qa_lead', 'viewer'.
-- The first user in a workspace is automatically assigned 'admin'.
--
-- Existing data is assigned to a default workspace so the migration is
-- non-breaking for current single-user deployments.

-- ── workspaces table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
  id        TEXT PRIMARY KEY,           -- e.g. "WS-1"
  name      TEXT NOT NULL,
  slug      TEXT NOT NULL,              -- URL-friendly unique identifier
  ownerId   TEXT NOT NULL,              -- references users(id) — workspace creator
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);

-- ── workspace_members table (ACL-002) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspace_members (
  id          TEXT PRIMARY KEY,         -- e.g. "WM-1"
  workspaceId TEXT NOT NULL,
  userId      TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer',  -- 'admin' | 'qa_lead' | 'viewer'
  joinedAt    TEXT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_workspace_user ON workspace_members(workspaceId, userId);
CREATE INDEX IF NOT EXISTS idx_wm_userId ON workspace_members(userId);

-- Seed counters for workspace and member IDs
INSERT OR IGNORE INTO counters(name, value) VALUES ('workspace', 0);
INSERT OR IGNORE INTO counters(name, value) VALUES ('workspace_member', 0);

-- ── Add workspaceId to existing entity tables ──────────────────────────────
-- The column is nullable initially so existing rows are valid.  The
-- application-level data backfill (in workspaceRepo.js ensureDefaultWorkspace)
-- assigns all orphaned rows to the default workspace on first startup after
-- this migration.

ALTER TABLE projects ADD COLUMN workspaceId TEXT REFERENCES workspaces(id);
ALTER TABLE tests ADD COLUMN workspaceId TEXT REFERENCES workspaces(id);
ALTER TABLE runs ADD COLUMN workspaceId TEXT REFERENCES workspaces(id);
ALTER TABLE activities ADD COLUMN workspaceId TEXT REFERENCES workspaces(id);

CREATE INDEX IF NOT EXISTS idx_projects_workspaceId ON projects(workspaceId);
CREATE INDEX IF NOT EXISTS idx_tests_workspaceId ON tests(workspaceId);
CREATE INDEX IF NOT EXISTS idx_runs_workspaceId ON runs(workspaceId);
CREATE INDEX IF NOT EXISTS idx_activities_workspaceId ON activities(workspaceId);
