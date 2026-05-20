/**
 * @module database/repositories/agentConfigRepo
 * @description Data-access layer for the `agent_configs` table (AI-004 —
 *   dormant per-workspace agent-role configuration). Reads and writes are
 *   workspace-scoped; callers are responsible for resolving `req.workspaceId`
 *   before invoking these helpers.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Fetch a single role config for a workspace.
 *
 * @param {string} workspaceId
 * @param {string} role - One of the canonical AGENT_ROLES.
 * @returns {Object|undefined} The agent-config row, or undefined when missing.
 */
export function getByRole(workspaceId, role) {
  return getDatabase().prepare("SELECT * FROM agent_configs WHERE workspaceId = ? AND role = ?").get(workspaceId, role);
}

/**
 * List every role config in a workspace, ordered by role name.
 *
 * @param {string} workspaceId
 * @returns {Object[]} Zero or more agent-config rows.
 */
export function listByWorkspace(workspaceId) {
  return getDatabase().prepare("SELECT * FROM agent_configs WHERE workspaceId = ? ORDER BY role ASC").all(workspaceId);
}

/**
 * Insert or update a role config (keyed on `(workspaceId, role)`). On
 * conflict every mutable field is overwritten and `updatedAt` is bumped;
 * `id` and `createdAt` are preserved.
 *
 * @param {Object} config - Must include id, workspaceId, role, createdAt, updatedAt.
 * @returns {Object} The freshly persisted row (re-read via getByRole).
 */
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

/**
 * Delete a role config. No-op when the row doesn't exist.
 *
 * @param {string} workspaceId
 * @param {string} role
 * @returns {Object} better-sqlite3 RunResult ({ changes, lastInsertRowid }).
 */
export function remove(workspaceId, role) {
  return getDatabase().prepare("DELETE FROM agent_configs WHERE workspaceId = ? AND role = ?").run(workspaceId, role);
}
