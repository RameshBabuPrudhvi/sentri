-- Migration 003: CI/CD webhook trigger tokens (ENH-011)
--
-- Stores per-project secret tokens that authenticate the
-- POST /api/projects/:id/trigger endpoint.
-- The token is stored as a SHA-256 hash — the plaintext is
-- shown exactly once at creation and never stored.

CREATE TABLE IF NOT EXISTS webhook_tokens (
  id          TEXT PRIMARY KEY,     -- e.g. "WH-1"
  projectId   TEXT NOT NULL,
  tokenHash   TEXT NOT NULL,        -- SHA-256(plaintext) hex string
  label       TEXT,                 -- optional human-readable label
  createdAt   TEXT NOT NULL,
  lastUsedAt  TEXT,                 -- NULL until first use
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_tokens_projectId ON webhook_tokens(projectId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_tokens_hash ON webhook_tokens(tokenHash);

-- Seed counter for webhook token IDs (WH-1, WH-2, …)
INSERT OR IGNORE INTO counters(name, value) VALUES ('webhook', 0);
