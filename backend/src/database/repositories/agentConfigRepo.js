import { getDatabase } from "../sqlite.js";

export function getByRole(workspaceId, role) {
  return getDatabase().prepare("SELECT * FROM agent_configs WHERE workspaceId = ? AND role = ?").get(workspaceId, role);
}

export function listByWorkspace(workspaceId) {
  return getDatabase().prepare("SELECT * FROM agent_configs WHERE workspaceId = ? ORDER BY role ASC").all(workspaceId);
}

export function upsert(config) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO agent_configs (id, workspaceId, role, provider, model, systemPromptOverride, temperature, maxTokens, fallbackRole, createdAt, updatedAt)
    VALUES (@id, @workspaceId, @role, @provider, @model, @systemPromptOverride, @temperature, @maxTokens, @fallbackRole, @createdAt, @updatedAt)
    ON CONFLICT(workspaceId, role) DO UPDATE SET
      provider=excluded.provider,
      model=excluded.model,
      systemPromptOverride=excluded.systemPromptOverride,
      temperature=excluded.temperature,
      maxTokens=excluded.maxTokens,
      fallbackRole=excluded.fallbackRole,
      updatedAt=excluded.updatedAt
  `).run(config);
  return getByRole(config.workspaceId, config.role);
}

export function remove(workspaceId, role) {
  return getDatabase().prepare("DELETE FROM agent_configs WHERE workspaceId = ? AND role = ?").run(workspaceId, role);
}
