import { getDatabase } from "../sqlite.js";

// `credentials` is stored as a JSON string in the DB — better-sqlite3 only
// accepts primitive bound parameters, so we serialise on write and parse
// on read. Mirrors the projectRepo pattern (projectRepo.js:17-42).
function rowToEnv(row) {
  if (!row) return row;
  return {
    ...row,
    credentials: row.credentials ? JSON.parse(row.credentials) : null,
  };
}

function envToRow(env) {
  return {
    ...env,
    credentials: env.credentials ? JSON.stringify(env.credentials) : null,
  };
}

export function create(env) {
  const db = getDatabase();
  db.prepare(`INSERT INTO environments (id, projectId, name, baseUrl, credentials, createdAt, workspaceId)
    VALUES (@id, @projectId, @name, @baseUrl, @credentials, @createdAt, @workspaceId)`).run(envToRow(env));
}

export function listByProject(projectId) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM environments WHERE projectId = ? ORDER BY createdAt ASC").all(projectId).map(rowToEnv);
}

export function getById(id) {
  const db = getDatabase();
  return rowToEnv(db.prepare("SELECT * FROM environments WHERE id = ?").get(id));
}

export function update(id, fields) {
  const db = getDatabase();
  const allowed = ["name", "baseUrl", "credentials"];
  const keys = Object.keys(fields || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  const params = { id };
  for (const k of keys) {
    params[k] = k === "credentials" && fields[k] ? JSON.stringify(fields[k]) : fields[k];
  }
  const setSql = keys.map((k) => `${k}=@${k}`).join(", ");
  db.prepare(`UPDATE environments SET ${setSql} WHERE id=@id`).run(params);
}

export function remove(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM environments WHERE id = ?").run(id);
}
