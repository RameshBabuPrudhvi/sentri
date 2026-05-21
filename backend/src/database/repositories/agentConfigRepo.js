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
 * Walk the `fallbackRole` chain starting from `startRole` (with `startRole`'s
 * fallback set hypothetically to `proposedFallback`) and return `true` if the
 * walk revisits `startRole` before terminating. Used by `upsert()` to reject
 * cycles at config-save time (AI-005 acceptance criterion).
 *
 * @param {string} workspaceId
 * @param {string} startRole
 * @param {string|null} proposedFallback
 * @returns {boolean}
 */
function wouldCreateCycle(workspaceId, startRole, proposedFallback) {
  if (!proposedFallback) return false;
  if (proposedFallback === startRole) return true;
  const db = getDatabase();
  const seen = new Set([startRole]);
  let next = proposedFallback;
  // Bounded walk — agent_configs has at most ~8 canonical roles per workspace,
  // so a 16-hop guard is well beyond any legitimate chain length.
  for (let i = 0; i < 16 && next; i += 1) {
    if (seen.has(next)) return true;
    seen.add(next);
    const row = db.prepare("SELECT fallbackRole FROM agent_configs WHERE workspaceId = ? AND role = ?").get(workspaceId, next);
    next = row?.fallbackRole || null;
  }
  return false;
}

/**
 * Insert or update a role config (keyed on `(workspaceId, role)`). On
 * conflict every mutable field is overwritten and `updatedAt` is bumped;
 * `id` and `createdAt` are preserved.
 *
 * AI-005 acceptance criterion: a `fallbackRole` cycle (planner → critic →
 * planner) is rejected at save time so dispatch never enters an infinite
 * resolution loop. The cycle detector walks the existing chain assuming the
 * proposed change is already applied.
 *
 * @param {Object} config - Must include id, workspaceId, role, createdAt, updatedAt.
 * @returns {Object} The freshly persisted row (re-read via getByRole).
 * @throws {Error} An Error with `code === "ERR_AGENT_FALLBACK_CYCLE"` if `fallbackRole` would create a cycle.
 */
export function upsert(config) {
  if (wouldCreateCycle(config.workspaceId, config.role, config.fallbackRole)) {
    const err = new Error(`fallbackRole cycle detected: ${config.role} → ${config.fallbackRole}`);
    err.code = "ERR_AGENT_FALLBACK_CYCLE";
    throw err;
  }
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
 * Delete a role config and null out any sibling `fallbackRole` references
 * to the deleted role in the same workspace. The two writes run in a single
 * transaction so dispatch (AI-005) can rely on the invariant that every
 * non-null `fallbackRole` points at an existing config.
 *
 * @param {string} workspaceId
 * @param {string} role
 * @returns {Object} { deleted, fallbacksCleared } — better-sqlite3 changes counts.
 */
export function remove(workspaceId, role) {
  const db = getDatabase();
  const tx = db.transaction(() => {
    const cleared = db.prepare(
      "UPDATE agent_configs SET fallbackRole = NULL, updatedAt = ? WHERE workspaceId = ? AND fallbackRole = ?"
    ).run(new Date().toISOString(), workspaceId, role);
    const deleted = db.prepare(
      "DELETE FROM agent_configs WHERE workspaceId = ? AND role = ?"
    ).run(workspaceId, role);
    return { deleted: deleted.changes, fallbacksCleared: cleared.changes };
  });
  return tx();
}
