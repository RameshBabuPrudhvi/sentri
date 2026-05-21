CREATE TABLE IF NOT EXISTS ai_request_log (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
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
