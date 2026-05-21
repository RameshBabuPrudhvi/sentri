CREATE TABLE IF NOT EXISTS ai_request_log (
  id TEXT PRIMARY KEY,
  -- workspaceId is nullable to mirror the routeId column below. The
  -- dispatcher's `callProvider` path can fire with no workspace context
  -- (e.g. single-tenant env-default dispatch, healthchecks) and we'd
  -- rather persist a row with NULL workspaceId than silently drop it
  -- to the catch-all in `requestLog.js#logRequest`. NULL rows are
  -- naturally excluded from per-workspace queries (spend cap, viewer)
  -- because `WHERE workspaceId = ?` never matches NULL — same tenant-
  -- isolation guarantee as if the row didn't exist for that workspace.
  -- Retention sweep still reclaims them since it doesn't filter on ws.
  workspaceId TEXT,
  routeId TEXT,
  agentRole TEXT,
  userId TEXT,
  promptHash TEXT NOT NULL,
  promptRedacted TEXT,
  responseRedacted TEXT,
  inputTokens INTEGER,
  outputTokens INTEGER,
  costUsd REAL,
  latencyMs INTEGER,
  outcome TEXT,
  errorReason TEXT,
  traceId TEXT,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (routeId) REFERENCES provider_routes(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_req_log_workspace ON ai_request_log(workspaceId, createdAt);
CREATE INDEX IF NOT EXISTS idx_req_log_trace ON ai_request_log(traceId);
