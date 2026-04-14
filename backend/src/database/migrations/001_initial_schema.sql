-- Migration 001: Initial schema
-- Applied on first startup for new databases.
-- Existing databases that already have these tables are unaffected
-- (all statements use IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  passwordHash TEXT,
  role        TEXT NOT NULL DEFAULT 'user',
  avatar      TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS oauth_ids (
  key    TEXT PRIMARY KEY,   -- "github:12345"
  userId TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,  -- "PRJ-1"
  name        TEXT NOT NULL,
  url         TEXT NOT NULL DEFAULT '',
  credentials TEXT,              -- JSON blob (encrypted)
  status      TEXT NOT NULL DEFAULT 'idle',
  createdAt   TEXT NOT NULL,
  deletedAt   TEXT                          -- soft-delete timestamp (NULL = live)
);
CREATE INDEX IF NOT EXISTS idx_projects_deletedAt ON projects(deletedAt);

CREATE TABLE IF NOT EXISTS tests (
  id                  TEXT PRIMARY KEY,  -- "TC-1"
  projectId           TEXT NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  steps               TEXT NOT NULL DEFAULT '[]',   -- JSON array
  playwrightCode      TEXT,
  playwrightCodePrev  TEXT,
  priority            TEXT NOT NULL DEFAULT 'medium',
  type                TEXT DEFAULT 'manual',
  sourceUrl           TEXT DEFAULT '',
  pageTitle           TEXT DEFAULT '',
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT,
  lastResult          TEXT,
  lastRunAt           TEXT,
  qualityScore        REAL,
  isJourneyTest       INTEGER NOT NULL DEFAULT 0,
  journeyType         TEXT,
  assertionEnhanced   INTEGER NOT NULL DEFAULT 0,
  reviewStatus        TEXT NOT NULL DEFAULT 'draft',
  reviewedAt          TEXT,
  promptVersion       TEXT,
  modelUsed           TEXT,
  linkedIssueKey      TEXT,
  tags                TEXT NOT NULL DEFAULT '[]',    -- JSON array
  generatedFrom       TEXT,
  isApiTest           INTEGER,
  scenario            TEXT,
  codeRegeneratedAt   TEXT,
  aiFixAppliedAt      TEXT,
  codeVersion         INTEGER DEFAULT 0,
  deletedAt           TEXT,                           -- soft-delete timestamp (NULL = live)
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tests_projectId ON tests(projectId);
CREATE INDEX IF NOT EXISTS idx_tests_reviewStatus ON tests(reviewStatus);
CREATE INDEX IF NOT EXISTS idx_tests_deletedAt ON tests(deletedAt);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,  -- "RUN-1"
  projectId       TEXT NOT NULL,
  type            TEXT NOT NULL,     -- "crawl", "test_run", "generate"
  status          TEXT NOT NULL DEFAULT 'running',
  startedAt       TEXT NOT NULL,
  finishedAt      TEXT,
  duration        INTEGER,
  error           TEXT,
  errorCategory   TEXT,
  passed          INTEGER,
  failed          INTEGER,
  total           INTEGER,
  pagesFound      INTEGER,
  parallelWorkers INTEGER,
  tracePath       TEXT,
  videoPath       TEXT,
  videoSegments   TEXT,              -- JSON array
  logs            TEXT NOT NULL DEFAULT '[]',       -- JSON array
  tests           TEXT NOT NULL DEFAULT '[]',       -- JSON array of test IDs
  results         TEXT NOT NULL DEFAULT '[]',       -- JSON array of result objects
  testQueue       TEXT,                              -- JSON array
  generateInput   TEXT,                              -- JSON object
  promptAudit     TEXT,                              -- JSON object
  pipelineStats   TEXT,                              -- JSON object
  feedbackLoop    TEXT,                              -- JSON object
  currentStep     INTEGER DEFAULT 0,                 -- pipeline progress (1-8)
  rateLimitError  TEXT,                              -- rate limit error message (if any)
  qualityAnalytics TEXT,                             -- JSON object (feedback loop analytics)
  deletedAt       TEXT,                              -- soft-delete timestamp (NULL = live)
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_projectId ON runs(projectId);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_deletedAt ON runs(deletedAt);
-- Compound index for the common findActiveByProjectId query:
-- SELECT * FROM runs WHERE projectId = ? AND status = 'running'
-- Without this, SQLite does an index intersection of the two single-column
-- indexes above. The compound index resolves both predicates in one scan.
CREATE INDEX IF NOT EXISTS idx_runs_project_status ON runs(projectId, status);

CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,  -- "ACT-1"
  type        TEXT NOT NULL,
  projectId   TEXT,
  projectName TEXT,
  testId      TEXT,
  testName    TEXT,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'completed',
  createdAt   TEXT NOT NULL,
  userId      TEXT,                                   -- user who performed the action (NULL for system)
  userName    TEXT                                     -- display name snapshot
);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_projectId ON activities(projectId);
CREATE INDEX IF NOT EXISTS idx_activities_createdAt ON activities(createdAt);
CREATE INDEX IF NOT EXISTS idx_activities_userId ON activities(userId);

CREATE TABLE IF NOT EXISTS healing_history (
  key              TEXT PRIMARY KEY,  -- "<testId>::<action>::<label>"
  strategyIndex    INTEGER NOT NULL DEFAULT -1,
  succeededAt      TEXT,
  failCount        INTEGER NOT NULL DEFAULT 0,
  strategyVersion  INTEGER                            -- versioned healing scope
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token     TEXT PRIMARY KEY,          -- 32-byte cryptographically random base64url string
  userId    TEXT NOT NULL,             -- references users(id)
  expiresAt TEXT NOT NULL,             -- ISO 8601; checked on every verification
  usedAt    TEXT,                      -- NULL = unused; set on successful password reset
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prt_userId    ON password_reset_tokens(userId);
CREATE INDEX IF NOT EXISTS idx_prt_expiresAt ON password_reset_tokens(expiresAt);

CREATE TABLE IF NOT EXISTS api_keys (
  provider    TEXT PRIMARY KEY,   -- 'anthropic' | 'openai' | 'google' | 'local'
  value       TEXT NOT NULL,      -- AES-256-GCM encrypted key (cloud) or JSON config (local)
  updatedAt   TEXT NOT NULL       -- ISO 8601 timestamp of last write
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Seed counters
INSERT OR IGNORE INTO counters(name, value) VALUES ('test', 0);
INSERT OR IGNORE INTO counters(name, value) VALUES ('run', 0);
INSERT OR IGNORE INTO counters(name, value) VALUES ('project', 0);
INSERT OR IGNORE INTO counters(name, value) VALUES ('activity', 0);
