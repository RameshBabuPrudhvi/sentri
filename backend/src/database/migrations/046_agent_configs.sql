CREATE TABLE IF NOT EXISTS agent_configs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  systemPromptOverride TEXT,
  temperature REAL DEFAULT 0.2,
  maxTokens INTEGER,
  fallbackRole TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, role),
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_configs_workspace_role ON agent_configs(workspaceId, role);
