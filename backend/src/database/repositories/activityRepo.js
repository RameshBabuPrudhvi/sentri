/**
 * @module database/repositories/activityRepo
 * @description Activity log CRUD backed by SQLite.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Create an activity entry.
 * @param {Object} activity — { id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId?, userName?, workspaceId? }
 */
export function create(activity) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO activities (id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId, userName, workspaceId)
    VALUES (@id, @type, @projectId, @projectName, @testId, @testName, @detail, @status, @createdAt, @userId, @userName, @workspaceId)
  `).run({
    id: activity.id,
    type: activity.type,
    projectId: activity.projectId || null,
    projectName: activity.projectName || null,
    testId: activity.testId || null,
    testName: activity.testName || null,
    detail: activity.detail || null,
    status: activity.status || "completed",
    createdAt: activity.createdAt,
    userId: activity.userId || null,
    userName: activity.userName || null,
    workspaceId: activity.workspaceId || null,
  });
}

/**
 * Get all activities.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM activities ORDER BY createdAt DESC").all();
}

/**
 * Get all activities as a dictionary keyed by ID.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const all = getAll();
  const dict = {};
  for (const a of all) dict[a.id] = a;
  return dict;
}

/**
 * Get filtered activities.
 * @param {Object} [filters]
 * @param {string} [filters.type]
 * @param {string} [filters.projectId]
 * @param {string} [filters.workspaceId] — Scope to workspace (ACL-001).
 * @param {number} [filters.limit=200]
 * @returns {Object[]}
 */
export function getFiltered({ type, projectId, workspaceId, limit } = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM activities WHERE 1=1";
  const params = [];
  if (workspaceId) {
    sql += " AND workspaceId = ?";
    params.push(workspaceId);
  }
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (projectId) {
    sql += " AND projectId = ?";
    params.push(projectId);
  }
  sql += " ORDER BY createdAt DESC LIMIT ?";
  params.push(limit || 200);
  return db.prepare(sql).all(...params);
}

/**
 * Count activities with optional workspace/project scope.
 * @param {Object} [filters]
 * @param {string} [filters.workspaceId]
 * @param {string} [filters.projectId]
 * @returns {number}
 */
export function countFiltered({ workspaceId, projectId } = {}) {
  const db = getDatabase();
  let sql = "SELECT COUNT(*) as cnt FROM activities WHERE 1=1";
  const params = [];
  if (workspaceId) {
    sql += " AND workspaceId = ?";
    params.push(workspaceId);
  }
  if (projectId) {
    sql += " AND projectId = ?";
    params.push(projectId);
  }
  return db.prepare(sql).get(...params).cnt;
}

/**
 * Get activities filtered by type for dashboard analytics.
 * Only returns type, status, createdAt — skips detail, names, etc.
 * @param {string[]} types — Activity types to include.
 * @param {Object} [opts]
 * @param {string} [opts.workspaceId] — Optional workspace scope.
 * @returns {Object[]}
 */
export function getByTypes(types, opts = {}) {
  const db = getDatabase();
  const { workspaceId } = opts;
  const placeholders = types.map(() => "?").join(", ");
  const workspaceClause = workspaceId ? " AND workspaceId = ?" : "";
  const params = workspaceId ? [...types, workspaceId] : types;
  return db.prepare(
    `SELECT type, status, createdAt FROM activities WHERE type IN (${placeholders})${workspaceClause} ORDER BY createdAt DESC`
  ).all(...params);
}

/**
 * Delete all activities for a project.
 * @param {string} projectId
 * @returns {number} Number of deleted rows.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM activities WHERE projectId = ?").run(projectId);
  return info.changes;
}

/**
 * Delete all activities in a workspace.
 * @param {string} workspaceId
 * @returns {number} Number of deleted rows.
 */
export function clearByWorkspaceId(workspaceId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM activities WHERE workspaceId = ?").run(workspaceId);
  return info.changes;
}
