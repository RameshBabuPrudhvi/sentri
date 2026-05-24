/**
 * @module database/repositories/routeGroupRepo
 * @description B4.6 — Data-access layer for the `route_groups` +
 *   `route_group_members` tables (Migration 054).
 *
 * Thin SELECT-only repo: the existing surface uses route groups via
 * `agent_configs.routeId = "rg-..."` and the runtime resolver
 * (`aiProvider/routeGroupResolver.js#resolveGroup`). Mutations
 * (`POST/PATCH/DELETE`) intentionally NOT exported here — the Settings UI
 * for editing groups is a follow-up roadmap item; today the dropdown
 * surfaces existing groups read-only so operators can see which routes
 * each agent role is targeting without tab-switching.
 *
 * Workspace scoping is enforced by every SELECT's `workspaceId = ?`
 * predicate — cross-workspace reads are impossible by construction.
 */
import { getDatabase } from "../sqlite.js";

const VALID_STRATEGIES = new Set(["weighted", "latency", "cost"]);

/**
 * List every route group in a workspace, ordered by name. Each row
 * includes a `memberCount` aggregate and an `enabledMemberCount` so the
 * dropdown can render "3 routes (2 healthy)" at a glance without a second
 * query per group.
 *
 * Returned shape (one row per group):
 *   {
 *     id, workspaceId, name, strategy, createdAt, updatedAt,
 *     memberCount: number,
 *     enabledMemberCount: number,
 *   }
 *
 * @param {string} workspaceId
 * @returns {Object[]}
 */
export function list(workspaceId) {
  const db = getDatabase();
  return db.prepare(
    `SELECT
       rg.id, rg.workspaceId, rg.name, rg.strategy,
       rg.createdAt, rg.updatedAt,
       COUNT(rgm.id) AS memberCount,
       COALESCE(SUM(CASE WHEN pr.enabled = 1 THEN 1 ELSE 0 END), 0) AS enabledMemberCount
     FROM route_groups rg
     LEFT JOIN route_group_members rgm ON rgm.groupId = rg.id
     LEFT JOIN provider_routes pr ON pr.id = rgm.routeId
     WHERE rg.workspaceId = ?
     GROUP BY rg.id
     ORDER BY rg.name ASC`,
  ).all(workspaceId);
}

/**
 * Fetch one group by id, workspace-scoped. Returns `undefined` when the
 * id belongs to a different workspace — callers MUST NOT leak the
 * existence of cross-workspace groups.
 *
 * @param {string} workspaceId
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(workspaceId, id) {
  return getDatabase().prepare(
    `SELECT id, workspaceId, name, strategy, createdAt, updatedAt
     FROM route_groups WHERE id = ? AND workspaceId = ?`,
  ).get(id, workspaceId);
}

/**
 * List members of a group with the joined `provider_routes` row hydrated.
 * Workspace scoping is enforced via the parent `route_groups` JOIN — a
 * group id from another workspace returns `[]`.
 *
 * @param {string} workspaceId
 * @param {string} groupId
 * @returns {Array<{ id, groupId, routeId, weight, route: Object }>}
 */
export function listMembers(workspaceId, groupId) {
  const rows = getDatabase().prepare(
    `SELECT
       rgm.id, rgm.groupId, rgm.routeId, rgm.weight, rgm.createdAt,
       pr.id AS pr_id, pr.name AS pr_name, pr.family AS pr_family,
       pr.model AS pr_model, pr.enabled AS pr_enabled,
       pr.capabilities AS pr_capabilities
     FROM route_group_members rgm
     JOIN provider_routes pr ON pr.id = rgm.routeId
     JOIN route_groups rg ON rg.id = rgm.groupId
     WHERE rgm.groupId = ? AND rg.workspaceId = ?`,
  ).all(groupId, workspaceId);
  return rows.map((r) => ({
    id: r.id,
    groupId: r.groupId,
    routeId: r.routeId,
    weight: r.weight,
    createdAt: r.createdAt,
    route: {
      id: r.pr_id,
      name: r.pr_name,
      family: r.pr_family,
      model: r.pr_model,
      enabled: r.pr_enabled === 1,
      capabilities: r.pr_capabilities ? safeParse(r.pr_capabilities) : null,
    },
  }));
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

export { VALID_STRATEGIES };
