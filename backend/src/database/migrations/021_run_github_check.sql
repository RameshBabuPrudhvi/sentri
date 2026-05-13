-- INT-002: GitHub PR check-run integration.
-- Adds per-run Check Run metadata and per-project opt-in settings.
ALTER TABLE runs ADD COLUMN githubCheck TEXT;

CREATE TABLE IF NOT EXISTS github_check_settings (
  projectId TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  installationId TEXT,
  repo TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);
