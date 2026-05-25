-- AUTO-023 Bundle 1 (B1.1): thread-scoped, structured agent-to-agent envelope history.
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  traceId TEXT NOT NULL,
  fromRole TEXT NOT NULL,
  toRole TEXT,
  -- ON DELETE SET NULL so the daily `purgeOlderThan` retention sweep can
  -- delete a parent envelope whose child reply lives outside the cutoff
  -- window. Without this, the self-referential FK defaults to NO ACTION
  -- and SQLite refuses the entire DELETE statement on any reply chain
  -- that spans the retention boundary — the sweep becomes a permanent
  -- no-op the moment an `accept` / `request_revision` envelope lands a
  -- day later than its `handoff` parent (lifeguard finding). Matches the
  -- `ON DELETE SET NULL` pattern used by sibling self-ref FKs elsewhere
  -- in the schema (`provider_routes.fallbackRouteId`, etc.).
  replyToId TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  intent TEXT NOT NULL,
  artifact TEXT,
  rationale TEXT,
  round INTEGER NOT NULL DEFAULT 0,
  workspaceId TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(threadId, createdAt);
CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(runId, createdAt);
CREATE INDEX IF NOT EXISTS idx_agent_messages_workspace ON agent_messages(workspaceId, threadId, createdAt);
