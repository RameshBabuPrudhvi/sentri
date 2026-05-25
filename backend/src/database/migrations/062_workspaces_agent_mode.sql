-- AUTO-023 B4.4 — per-workspace orchestrator mode selector.
ALTER TABLE workspaces ADD COLUMN agentMode TEXT NOT NULL DEFAULT 'envelope' CHECK (agentMode IN ('pipeline','envelope','autonomous'));

