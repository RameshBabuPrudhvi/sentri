/**
 * @module database/repositories/projectRepo
 * @description Project CRUD backed by SQLite.
 *
 * All read queries filter `WHERE deletedAt IS NULL` by default.
 * Hard deletes are replaced with soft-deletes: `deletedAt = datetime('now')`.
 * Use {@link getDeletedAll} / {@link restore} for recycle-bin operations.
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
 * Get all non-deleted projects.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM projects WHERE deletedAt IS NULL").all().map(rowToProject);
}

/**
 * Get all non-deleted projects as a dictionary keyed by ID.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const all = getAll();
  const dict = {};
  for (const p of all) dict[p.id] = p;
  return dict;
}

/**
 * Get a project by ID (including soft-deleted — needed for restore and audit).
 * Most callers should use {@link getById} which excludes deleted items.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getByIdIncludeDeleted(id) {
  const db = getDatabase();
  return rowToProject(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
}

/**
 * Get a non-deleted project by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return rowToProject(db.prepare("SELECT * FROM projects WHERE id = ? AND deletedAt IS NULL").get(id));
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
 * Count total non-deleted projects.
 * @returns {number}
 */
export function count() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE deletedAt IS NULL").get().cnt;
}

/**
 * Soft-delete a project by ID.
 * The row is retained in the database and visible via {@link getDeletedAll}.
 * Cascade soft-deletes for tests and runs are handled by the caller.
 * @param {string} id
 */
export function deleteById(id) {
  const db = getDatabase();
  db.prepare("UPDATE projects SET deletedAt = datetime('now') WHERE id = ?").run(id);
}

/**
 * Hard-delete a project by ID (permanent — use only for purge operations).
 * @param {string} id
 */
export function hardDeleteById(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

/**
 * Get all soft-deleted projects (recycle bin).
 * @returns {Object[]}
 */
export function getDeletedAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM projects WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC").all().map(rowToProject);
}

/**
 * Restore a soft-deleted project (clear deletedAt).
 * @param {string} id
 * @returns {boolean} Whether the project was found and restored.
 */
export function restore(id) {
  const db = getDatabase();
  const info = db.prepare("UPDATE projects SET deletedAt = NULL WHERE id = ? AND deletedAt IS NOT NULL").run(id);
  return info.changes > 0;
}
