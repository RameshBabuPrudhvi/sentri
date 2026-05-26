/**
 * @module database/repositories/agentConfigRepo
 * @description Data-access layer for the `agent_configs` table (AI-004 —
 *   dormant per-workspace agent-role configuration). Reads and writes are
 *   workspace-scoped; callers are responsible for resolving `req.workspaceId`
 *   before invoking these helpers.
 */

import { getDatabase } from "../sqlite.js";
import * as providerRouteRepo from "./providerRouteRepo.js";
// AUTO-023 B3.3 — single source of truth for the reviewer↔author loop's
// hard round ceiling. Imported from the leaf constants module (NOT from
// `agentLoop.js`) to avoid a circular import: the loop also imports
// `getMaxReviewRounds` from this repo, and routing the constant through
// `agentLoop.js` would close the cycle. See `agentLoopConstants.js`'s
// docblock for the full ES-modules / TDZ rationale.
import { HARD_MAX_REVIEW_ROUNDS } from "../../aiProvider/agentLoopConstants.js";

/**
 * Fetch a single role config for a workspace.
 *
 * @param {string} workspaceId
 * @param {string} role - One of the canonical AGENT_ROLES.
 * @returns {Object|undefined} The agent-config row, or undefined when missing.
 */
export function getByRole(workspaceId, role) {
  const row = getDatabase().prepare("SELECT * FROM agent_configs WHERE workspaceId = ? AND role = ?").get(workspaceId, role);
  if (!row) return row;
  return { ...row, allowedTools: row.allowedTools ? (() => { try { return JSON.parse(row.allowedTools); } catch { return null; } })() : null };
}

/**
 * List every role config in a workspace, ordered by role name.
 *
 * @param {string} workspaceId
 * @returns {Object[]} Zero or more agent-config rows.
 */
export function listByWorkspace(workspaceId) {
  return getDatabase().prepare("SELECT * FROM agent_configs WHERE workspaceId = ? ORDER BY role ASC").all(workspaceId).map((row) => ({ ...row, allowedTools: row.allowedTools ? (() => { try { return JSON.parse(row.allowedTools); } catch { return null; } })() : null }));
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
  //
  // B4.6 — `cfg.routeId` may also point at a `route_groups` row (`rg-*`
  // prefix). `resolveRoute` in `registry.js` delegates those to
  // `resolveGroup` at call time; persisting them through this upsert
  // requires a parallel existence + workspace-scope check against the
  // groups table. Without this branch, every "assign role to route
  // group" save throws `ERR_AGENT_ROUTE_NOT_FOUND` (the route-group id
  // isn't in `provider_routes`) and the B4.6 feature is unreachable.
  if (config.routeId) {
    if (typeof config.routeId === "string" && config.routeId.startsWith("rg-")) {
      const group = getDatabase().prepare(
        "SELECT id FROM route_groups WHERE id = ? AND workspaceId = ?",
      ).get(config.routeId, config.workspaceId);
      if (!group) {
        const err = new Error(`route group not found in workspace: ${config.routeId}`);
        err.code = "ERR_AGENT_ROUTE_NOT_FOUND";
        throw err;
      }
    } else {
      const route = providerRouteRepo.getById(config.workspaceId, config.routeId);
      if (!route) {
        const err = new Error(`routeId not found in workspace: ${config.routeId}`);
        err.code = "ERR_AGENT_ROUTE_NOT_FOUND";
        throw err;
      }
    }
  }
  const db = getDatabase();
  // B4.3 — `fallbackRole` column dropped by migration 053. The
  // canonical per-route fallback lives on `provider_routes.fallbackRouteId`.
  // `provider` + `model` were already dropped in migration 048.
  // Only `routeId`, `systemPromptOverride`, `temperature`, and
  // `maxTokens` remain as mutable fields on agent_configs.
  // B3.3 — clamp `maxReviewRounds` to `[1, HARD_MAX_REVIEW_ROUNDS]` at
  // the repo layer so a bad write (operator UI, JSON import, future
  // admin script) can never exceed the loop's server-side ceiling. NULL
  // is preserved as "no override" — the loop reads `DEFAULT_MAX_REVIEW_ROUNDS`
  // for those rows. Ceiling imported from `agentLoop.js` so the constant
  // is defined exactly once.
  let mrr = config.maxReviewRounds;
  if (mrr === undefined || mrr === null) {
    mrr = null;
  } else {
    const n = Number.parseInt(String(mrr), 10);
    mrr = Number.isFinite(n) ? Math.min(Math.max(n, 1), HARD_MAX_REVIEW_ROUNDS) : null;
  }
  db.prepare(`
    INSERT INTO agent_configs (id, workspaceId, role, routeId, systemPromptOverride, temperature, maxTokens, maxReviewRounds, allowedTools, createdAt, updatedAt)
    VALUES (@id, @workspaceId, @role, @routeId, @systemPromptOverride, @temperature, @maxTokens, @maxReviewRounds, @allowedTools, @createdAt, @updatedAt)
    ON CONFLICT(workspaceId, role) DO UPDATE SET
      routeId=excluded.routeId,
      systemPromptOverride=excluded.systemPromptOverride,
      temperature=excluded.temperature,
      maxTokens=excluded.maxTokens,
      maxReviewRounds=excluded.maxReviewRounds,
      allowedTools=excluded.allowedTools,
      updatedAt=excluded.updatedAt
  `).run({ ...config, routeId: config.routeId ?? null, maxReviewRounds: mrr, allowedTools: Array.isArray(config.allowedTools) ? JSON.stringify(config.allowedTools) : null });
  return getByRole(config.workspaceId, config.role);
}

/**
 * Resolve the `maxReviewRounds` override for a (workspace, role) pair.
 * Returns `null` when no row exists or the column is NULL — callers
 * should fall through to the loop's `DEFAULT_MAX_REVIEW_ROUNDS`.
 *
 * @param {string} workspaceId
 * @param {string} role
 * @returns {number|null}
 */
export function getMaxReviewRounds(workspaceId, role) {
  if (!workspaceId || !role) return null;
  try {
    const row = getDatabase().prepare(
      "SELECT maxReviewRounds FROM agent_configs WHERE workspaceId = ? AND role = ?",
    ).get(workspaceId, role);
    const v = row?.maxReviewRounds;
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
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
