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

-- SEC-007: seed the DLQ-<n> counter so auditDlqRepo.enqueue() can mint IDs.
-- `counterRepo.next()` requires the row to exist (it does UPDATE…RETURNING,
-- which is a no-op when the row is absent and throws "Unknown counter").
-- Other counters that follow the same convention (webhook, schedule, …)
-- seed via their own feature migrations — this is the audit_dlq parallel.
INSERT OR IGNORE INTO counters(name, value) VALUES ('audit_dlq', 0);
