import { getDatabase } from "../sqlite.js";

export function list(workspaceId, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  const where = ["workspaceId = ?"];
  const params = [workspaceId];
  if (opts.routeId) { where.push("routeId = ?"); params.push(String(opts.routeId)); }
  if (opts.agentRole) { where.push("agentRole = ?"); params.push(String(opts.agentRole)); }
  if (opts.traceId) { where.push("traceId = ?"); params.push(String(opts.traceId)); }
  if (opts.outcome) { where.push("outcome = ?"); params.push(String(opts.outcome)); }
  if (opts.before) { where.push("createdAt < ?"); params.push(String(opts.before)); }
  return getDatabase().prepare(`SELECT * FROM ai_request_log WHERE ${where.join(" AND ")} ORDER BY createdAt DESC LIMIT ?`).all(...params, limit);
}

export function getById(workspaceId, id) {
  return getDatabase().prepare("SELECT * FROM ai_request_log WHERE id = ? AND workspaceId = ?").get(id, workspaceId);
}

/**
 * GAP-005 (migration 056) — fetch all AI request log rows for a given run,
 * ordered chronologically (oldest first so the timeline reads top-to-bottom).
 * Workspace ACL is enforced by the leading `workspaceId = ?` predicate —
 * the `runId` narrow is purely a render-time concern.
 *
 * Returns the full row shape including `promptRedacted` / `responseRedacted`
 * (which may be null depending on the workspace's `aiRequestLogMode`). The
 * route layer that calls this is admin-gated, so non-admin users never see
 * the prompt/response columns.
 *
 * @param {string} workspaceId
 * @param {string} runId
 * @param {Object} [opts]
 * @param {number} [opts.limit=200] - Safety cap. A single run typically
 *   produces 5-30 AI calls; the cap is a defence against pathological runs.
 * @returns {Object[]}
 */
export function listByRun(workspaceId, runId, opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
  return getDatabase().prepare(
    "SELECT * FROM ai_request_log WHERE workspaceId = ? AND runId = ? ORDER BY createdAt ASC LIMIT ?",
  ).all(workspaceId, runId, limit);
}

export function purgeOlderThan(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  const result = getDatabase().prepare("DELETE FROM ai_request_log WHERE createdAt < ?").run(cutoff);
  return result.changes || 0;
}
