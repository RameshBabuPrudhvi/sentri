import { getDatabase } from "../sqlite.js";

export function create(env) {
  const db = getDatabase();
  db.prepare(`INSERT INTO environments (id, projectId, name, baseUrl, credentials, createdAt, workspaceId)
    VALUES (@id, @projectId, @name, @baseUrl, @credentials, @createdAt, @workspaceId)`).run(env);
}

export function listByProject(projectId) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM environments WHERE projectId = ? ORDER BY createdAt ASC").all(projectId);
}

export function getById(id) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM environments WHERE id = ?").get(id);
}

export function update(id, fields) {
  const db = getDatabase();
  const allowed = ["name", "baseUrl", "credentials"];
  const keys = Object.keys(fields || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const setSql = keys.map((k) => `${k}=@${k}`).join(", ");
  db.prepare(`UPDATE environments SET ${setSql} WHERE id=@id`).run({ id, ...fields });
}

export function remove(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM environments WHERE id = ?").run(id);
}
