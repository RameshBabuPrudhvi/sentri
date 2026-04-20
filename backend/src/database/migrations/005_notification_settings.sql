-- Migration 005: Notification settings (FEA-001) + BullMQ queue metadata (INF-003)
--
-- Renamed from 004_ to 005_ to resolve the numbering collision with
-- 004_workspaces_rbac.sql.  Both migrations were independently safe but
-- sharing a prefix made execution order dependent on alphabetical sort,
-- which is fragile.
--
-- FEA-001 — Per-project notification settings
-- Stores notification channel configuration per project: Microsoft Teams
-- incoming webhook URL, email recipients (comma-separated), and a generic
-- webhook URL.  On run completion with failures, all configured channels
-- are dispatched.
--
-- INF-003 — No schema changes required for BullMQ (uses Redis), but we
-- seed the notification_setting counter for NS-N IDs.
--
-- NOTE FOR EXISTING DATABASES: If your schema_migrations table already
-- has "004_notification_settings" recorded, this file (005_) will be
-- treated as a new unapplied migration.  All statements use
-- CREATE TABLE IF NOT EXISTS and INSERT OR IGNORE, so re-running is safe.

-- ── notification_settings (FEA-001) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_settings (
  id          TEXT    PRIMARY KEY,       -- e.g. "NS-1"
  projectId   TEXT    NOT NULL UNIQUE,   -- one config per project
  teamsWebhookUrl  TEXT,                 -- Microsoft Teams incoming webhook URL
  emailRecipients  TEXT,                 -- comma-separated email addresses
  webhookUrl       TEXT,                 -- generic webhook URL (POST JSON)
  enabled     INTEGER NOT NULL DEFAULT 1,  -- 1 = active, 0 = paused
  createdAt   TEXT    NOT NULL,
  updatedAt   TEXT    NOT NULL,
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_settings_projectId ON notification_settings(projectId);

-- Seed counter for notification setting IDs (NS-1, NS-2, …)
INSERT OR IGNORE INTO counters(name, value) VALUES ('notification_setting', 0);
