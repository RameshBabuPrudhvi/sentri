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

export function purgeOlderThan(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  const result = getDatabase().prepare("DELETE FROM ai_request_log WHERE createdAt < ?").run(cutoff);
  return result.changes || 0;
}
