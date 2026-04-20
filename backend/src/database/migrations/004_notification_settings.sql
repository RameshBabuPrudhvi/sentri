-- Migration 004: Notification settings (FEA-001) + BullMQ queue metadata (INF-003)
--
-- NOTE: This file shares the 004_ prefix with 004_workspaces_rbac.sql.
-- Alphabetical sort ensures this runs first (notification < workspaces).
-- Both migrations are independent and idempotent — the ordering is safe
-- but the shared prefix is a documentation anomaly.  A future migration
-- renumber can resolve this for fresh installs.
--
-- FEA-001 — Per-project notification settings
-- Stores notification channel configuration per project: Microsoft Teams
-- incoming webhook URL, email recipients (comma-separated), and a generic
-- webhook URL.  On run completion with failures, all configured channels
-- are dispatched.
--
-- INF-003 — No schema changes required for BullMQ (uses Redis), but we
-- seed the notification_setting counter for NS-N IDs.

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
