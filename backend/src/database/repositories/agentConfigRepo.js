/**
 * @module database/repositories/agentConfigRepo
 * @description Data-access layer for the `agent_configs` table (AI-004 —
 *   dormant per-workspace agent-role configuration). Reads and writes are
 *   workspace-scoped; callers are responsible for resolving `req.workspaceId`
 *   before invoking these helpers.
 */

import { getDatabase } from "../sqlite.js";
import * as providerRouteRepo from "./providerRouteRepo.js";

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

// B4.3 — `wouldCreateCycle` removed. Migration 053 dropped the
// `agent_configs.fallbackRole` column; the canonical per-route fallback
// now lives on `provider_routes.fallbackRouteId` and is cycle-checked
// by `providerRouteRepo.upsert` (ERR_ROUTE_FALLBACK_CYCLE). The
// role-level cycle detector is dead code post-053.

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
  // B2.1 — validate routeId belongs to the same workspace before any write.
  // Runs first so a bad routeId fails fast without spending a fallback-cycle
  // walk on the same call. `providerRouteRepo.getById` is workspace-scoped,
  // so a route in another workspace returns undefined here and fails the
  // check — preventing cross-workspace route assignment.
  if (config.routeId) {
    const route = providerRouteRepo.getById(config.workspaceId, config.routeId);
    if (!route) {
      const err = new Error(`routeId not found in workspace: ${config.routeId}`);
      err.code = "ERR_AGENT_ROUTE_NOT_FOUND";
      throw err;
    }
  }
  const db = getDatabase();
  // B4.3 — `fallbackRole` column dropped by migration 053. The
  // canonical per-route fallback lives on `provider_routes.fallbackRouteId`.
  // `provider` + `model` were already dropped in migration 048.
  // Only `routeId`, `systemPromptOverride`, `temperature`, and
  // `maxTokens` remain as mutable fields on agent_configs.
  db.prepare(`
    INSERT INTO agent_configs (id, workspaceId, role, routeId, systemPromptOverride, temperature, maxTokens, createdAt, updatedAt)
    VALUES (@id, @workspaceId, @role, @routeId, @systemPromptOverride, @temperature, @maxTokens, @createdAt, @updatedAt)
    ON CONFLICT(workspaceId, role) DO UPDATE SET
      routeId=excluded.routeId,
      systemPromptOverride=excluded.systemPromptOverride,
      temperature=excluded.temperature,
      maxTokens=excluded.maxTokens,
      updatedAt=excluded.updatedAt
  `).run({ ...config, routeId: config.routeId ?? null });
  return getByRole(config.workspaceId, config.role);
}

/**
 * Delete a role config.
 *
 * B4.3 — the `fallbackRole` cascade-null is gone because migration 053
 * dropped the column. The canonical fallback chain lives on
 * `provider_routes.fallbackRouteId` now; `providerRouteRepo.remove`
 * handles its own cascade-null in the same transaction pattern.
 *
 * @param {string} workspaceId
 * @param {string} role
 * @returns {Object} { deleted } — better-sqlite3 changes count.
 */
export function remove(workspaceId, role) {
  const db = getDatabase();
  const deleted = db.prepare(
    "DELETE FROM agent_configs WHERE workspaceId = ? AND role = ?"
  ).run(workspaceId, role);
  return { deleted: deleted.changes };
}
