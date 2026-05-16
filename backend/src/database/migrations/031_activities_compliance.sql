-- SEC-007 (Phase A/B/C bootstrap): extend activities for compliance context
ALTER TABLE activities ADD COLUMN ipAddress TEXT NULL;
ALTER TABLE activities ADD COLUMN userAgent TEXT NULL;
ALTER TABLE activities ADD COLUMN prevHash TEXT NULL;

CREATE TABLE IF NOT EXISTS audit_dlq (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  rowSnapshot TEXT NOT NULL,
  lastError TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
