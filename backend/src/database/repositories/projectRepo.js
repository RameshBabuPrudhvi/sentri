/**
 * @module database/repositories/projectRepo
 * @description Project CRUD backed by SQLite.
 */

import { getDatabase } from "../sqlite.js";

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────
// `credentials` is stored as a JSON string in the DB.

function rowToProject(row) {
  if (!row) return undefined;
  return {
    ...row,
    credentials: row.credentials ? JSON.parse(row.credentials) : null,
  };
}

function projectToRow(p) {
  return {
    id: p.id,
    name: p.name,
    url: p.url || "",
    credentials: p.credentials ? JSON.stringify(p.credentials) : null,
    status: p.status || "idle",
    createdAt: p.createdAt,
  };
}

/**
 * Get all projects.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM projects").all().map(rowToProject);
}

/**
 * Get all projects as a dictionary keyed by ID.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const all = getAll();
  const dict = {};
  for (const p of all) dict[p.id] = p;
  return dict;
}

/**
 * Get a project by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
}

/**
 * Create a project.
 * @param {Object} project
 */
export function create(project) {
  const db = getDatabase();
  const row = projectToRow(project);
  db.prepare(`
    INSERT INTO projects (id, name, url, credentials, status, createdAt)
    VALUES (@id, @name, @url, @credentials, @status, @createdAt)
  `).run(row);
}

/**
 * Update specific fields on a project.
 * @param {string} id
 * @param {Object} fields
 */
export function update(id, fields) {
  const db = getDatabase();
  const allowed = ["name", "url", "credentials", "status"];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (key in fields) {
      const val = key === "credentials" && fields[key]
        ? JSON.stringify(fields[key])
        : fields[key];
      sets.push(`${key} = @${key}`);
      params[key] = val;
    }
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Count total projects.
 * @returns {number}
 */
export function count() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM projects").get().cnt;
}

/**
 * Delete a project by ID.
 * Cascade deletes (tests, runs, activities, healing) are handled by the caller
 * or by ON DELETE CASCADE foreign keys.
 * @param {string} id
 */
export function deleteById(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}
