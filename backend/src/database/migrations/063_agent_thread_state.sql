CREATE TABLE IF NOT EXISTS agent_thread_state (
  threadId TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_thread_state_workspace ON agent_thread_state(workspaceId, updatedAt);
