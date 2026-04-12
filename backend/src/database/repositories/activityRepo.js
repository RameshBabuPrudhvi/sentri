/**
 * @module database/repositories/activityRepo
 * @description Activity log CRUD backed by SQLite.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Create an activity entry.
 * @param {Object} activity — { id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId?, userName? }
 */
export function create(activity) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO activities (id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId, userName)
    VALUES (@id, @type, @projectId, @projectName, @testId, @testName, @detail, @status, @createdAt, @userId, @userName)
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
 * @param {number} [filters.limit=200]
 * @returns {Object[]}
 */
export function getFiltered({ type, projectId, limit } = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM activities WHERE 1=1";
  const params = [];
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
 * Count total activities.
 * @returns {number}
 */
export function count() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM activities").get().cnt;
}

/**
 * Get activities filtered by type for dashboard analytics.
 * Only returns type, status, createdAt — skips detail, names, etc.
 * @param {string[]} types — Activity types to include.
 * @returns {Object[]}
 */
export function getByTypes(types) {
  const db = getDatabase();
  const placeholders = types.map(() => "?").join(", ");
  return db.prepare(
    `SELECT type, status, createdAt FROM activities WHERE type IN (${placeholders}) ORDER BY createdAt DESC`
  ).all(...types);
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
 * Delete all activities.
 * @returns {number} Number of deleted rows.
 */
export function clearAll() {
  const db = getDatabase();
  const count = db.prepare("SELECT COUNT(*) as cnt FROM activities").get().cnt;
  db.prepare("DELETE FROM activities").run();
  return count;
}
