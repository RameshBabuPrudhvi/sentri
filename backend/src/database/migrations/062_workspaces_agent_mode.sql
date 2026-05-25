-- AUTO-023 B4.4 — per-workspace orchestrator mode selector.
-- Default is 'pipeline' to match the env-var default in
-- `backend/src/aiProvider/agentMode.js#getAgentMode()`. Diverging would
-- cause the Settings UI to show a different mode than what the
-- dispatcher actually runs in.
ALTER TABLE workspaces ADD COLUMN agentMode TEXT NOT NULL DEFAULT 'pipeline' CHECK (agentMode IN ('pipeline','envelope','autonomous'));

