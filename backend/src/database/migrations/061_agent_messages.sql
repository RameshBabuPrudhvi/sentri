-- AUTO-023 Bundle 1 (B1.1): thread-scoped, structured agent-to-agent envelope history.
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  traceId TEXT NOT NULL,
  fromRole TEXT NOT NULL,
  toRole TEXT,
  replyToId TEXT REFERENCES agent_messages(id),
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
