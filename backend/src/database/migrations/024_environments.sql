CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  name TEXT NOT NULL,
  baseUrl TEXT NOT NULL,
  credentials TEXT,
  createdAt TEXT NOT NULL,
  workspaceId TEXT,
  FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(projectId, name)
);

CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(projectId);
CREATE INDEX IF NOT EXISTS idx_environments_workspace ON environments(workspaceId);

ALTER TABLE runs ADD COLUMN environmentId TEXT;
