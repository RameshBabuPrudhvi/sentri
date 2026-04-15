-- Migration 003: schedules table (ENH-006)
--
-- ENH-006 — Test Scheduling Engine
-- Stores one schedule per project.  Each row maps a project to a cron
-- expression, a timezone, and enabled/disabled state.  The scheduler
-- process reads this table on startup and after every PATCH to hot-reload
-- without a restart.
--
-- nextRunAt is computed by the scheduler and stored so the frontend can
-- display it without calling node-cron on the client.

CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT    PRIMARY KEY,      -- e.g. "SCH-1"
  projectId   TEXT    NOT NULL UNIQUE,  -- one schedule per project
  cronExpr    TEXT    NOT NULL,         -- standard 5-field cron expression
  timezone    TEXT    NOT NULL DEFAULT 'UTC',
  enabled     INTEGER NOT NULL DEFAULT 1,  -- 1 = active, 0 = paused
  lastRunAt   TEXT,                     -- ISO 8601, NULL until first run
  nextRunAt   TEXT,                     -- ISO 8601, computed by scheduler
  createdAt   TEXT    NOT NULL,
  updatedAt   TEXT    NOT NULL,
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schedules_projectId ON schedules(projectId);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled   ON schedules(enabled);

-- Seed counter for schedule IDs (SCH-1, SCH-2, …)
INSERT OR IGNORE INTO counters(name, value) VALUES ('schedule', 0);
