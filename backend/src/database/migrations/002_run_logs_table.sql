-- Migration 002: run_logs (ENH-008) + webhook_tokens (ENH-011) + schedules (ENH-006)
--
-- ENH-008 — Dedicated run_logs table
-- Replaces the O(n²) JSON read-modify-write pattern in run.logs with a
-- normalised append-only table.  Each log line is a single INSERT row.
-- The legacy `logs` column on `runs` is kept as a nullable tombstone so
-- that the schema change is backwards compatible; all new writes go to
-- this table.
--
-- ENH-011 — CI/CD webhook trigger tokens
-- Stores per-project secret tokens that authenticate the
-- POST /api/projects/:id/trigger endpoint.
-- The token is stored as a SHA-256 hash — the plaintext is
-- shown exactly once at creation and never stored.
--
-- ENH-006 — Test Scheduling Engine
-- Stores one schedule per project.  Each row maps a project to a cron
-- expression, a timezone, and enabled/disabled state.  The scheduler
-- process reads this table on startup and after every PATCH to hot-reload
-- without a restart.
--
-- nextRunAt is computed by the scheduler and stored so the frontend can
-- display it without calling node-cron on the client.

-- ── run_logs (ENH-008) ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS run_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  runId     TEXT    NOT NULL,
  seq       INTEGER NOT NULL,           -- 1-based monotonic counter per run
  level     TEXT    NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
  message   TEXT    NOT NULL,
  createdAt TEXT    NOT NULL            -- ISO 8601 timestamp
);

CREATE INDEX IF NOT EXISTS idx_run_logs_runId     ON run_logs(runId);
CREATE INDEX IF NOT EXISTS idx_run_logs_runId_seq ON run_logs(runId, seq);

-- ── webhook_tokens (ENH-011) ───────────────────────────────────────────────

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

-- ── schedules (ENH-006) ────────────────────────────────────────────────────

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

-- ── Concurrent-run guard (FLW-04) ──────────────────────────────────────────
-- Defence-in-depth: enforce at most one "running" run per project at the DB
-- level.  The application already checks via findActiveByProjectId() before
-- creating a run, but this partial unique index prevents a second run from
-- being inserted if two requests slip through the application-level guard
-- (e.g. in a future multi-process deployment).
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active_per_project
  ON runs(projectId)
  WHERE status = 'running' AND deletedAt IS NULL;
