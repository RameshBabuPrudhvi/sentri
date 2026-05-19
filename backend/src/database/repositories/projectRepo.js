/**
 * @module database/repositories/projectRepo
 * @description Project CRUD backed by SQLite.
 *
 * All read queries filter `WHERE deletedAt IS NULL` by default.
 * Hard deletes are replaced with soft-deletes: `deletedAt = datetime('now')`.
 * Use {@link getDeletedAll} / {@link restore} for recycle-bin operations.
 * Use {@link getAllIncludeDeleted} for data-management cleanup that must
 * span both live and soft-deleted projects.
 */

import { getDatabase } from "../sqlite.js";

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────
// `credentials` is stored as a JSON string in the DB.

function rowToProject(row) {
  if (!row) return undefined;
  return {
    ...row,
    credentials: row.credentials ? JSON.parse(row.credentials) : null,
    qualityGates: row.qualityGates ? JSON.parse(row.qualityGates) : null,
    webVitalsBudgets: row.webVitalsBudgets ? JSON.parse(row.webVitalsBudgets) : null,
    autoApproveThreshold: row.autoApproveThreshold,
    iterationCap: row.iterationCap,
    strictPiiFirewall: row.strictPiiFirewall === 1,
    piiAllowlist: row.piiAllowlist ? JSON.parse(row.piiAllowlist) : [],
    visionHealing: row.visionHealing || 'off',
    visionHealMaxCallsPerDay: row.visionHealMaxCallsPerDay ?? 100,
    visionHealMaxCostUsdPerMonth: row.visionHealMaxCostUsdPerMonth ?? 50,
    coverageEnabled: row.coverageEnabled === 1,
    sourcemapBaseUrl: row.sourcemapBaseUrl || null,
  };
}

function projectToRow(p) {
  return {
    id: p.id,
    name: p.name,
    url: p.url || "",
    credentials: p.credentials ? JSON.stringify(p.credentials) : null,
    status: p.status || "idle",
    qualityGates: p.qualityGates ? JSON.stringify(p.qualityGates) : null,
    webVitalsBudgets: p.webVitalsBudgets ? JSON.stringify(p.webVitalsBudgets) : null,
    createdAt: p.createdAt,
    autoApproveThreshold: p.autoApproveThreshold ?? null,
    iterationCap: p.iterationCap ?? null,
    // Default ON when the caller omits the field — `projects.strictPiiFirewall`
    // is `INTEGER NOT NULL DEFAULT 1` (migration 030) and creating a project
    // via `POST /api/v1/projects` doesn't pass this field through. A naive
    // `p.strictPiiFirewall ? 1 : 0` would coerce `undefined` → 0 and silently
    // disable the SEC-006 PII firewall on every new project, defeating the
    // migration's intent. Only an explicit `false` opts out.
    strictPiiFirewall: p.strictPiiFirewall === false ? 0 : 1,
    piiAllowlist: p.piiAllowlist ? JSON.stringify(p.piiAllowlist) : null,
    visionHealing: p.visionHealing || 'off',
    visionHealMaxCallsPerDay: p.visionHealMaxCallsPerDay ?? 100,
    visionHealMaxCostUsdPerMonth: p.visionHealMaxCostUsdPerMonth ?? 50,
    coverageEnabled: p.coverageEnabled ? 1 : 0,
    sourcemapBaseUrl: p.sourcemapBaseUrl || null,
  };
}

/**
 * Get all non-deleted projects.
 * @param {string} [workspaceId] — If provided, scope to this workspace (ACL-001).
 * @returns {Object[]}
 */
export function getAll(workspaceId) {
  const db = getDatabase();
  if (workspaceId) {
    return db.prepare("SELECT * FROM projects WHERE deletedAt IS NULL AND workspaceId = ?").all(workspaceId).map(rowToProject);
  }
  return db.prepare("SELECT * FROM projects WHERE deletedAt IS NULL").all().map(rowToProject);
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
 * Get a non-deleted project by ID, scoped to a workspace (ACL-001).
 * Returns undefined if the project doesn't exist OR belongs to a different workspace.
 * Use this in route handlers to prevent cross-workspace IDOR.
 * @param {string} id
 * @param {string} workspaceId
 * @returns {Object|undefined}
 */
export function getByIdInWorkspace(id, workspaceId) {
  const db = getDatabase();
  return rowToProject(
    db.prepare("SELECT * FROM projects WHERE id = ? AND workspaceId = ? AND deletedAt IS NULL").get(id, workspaceId)
  );
}

/**
 * Create a project.
 * @param {Object} project — Must include `workspaceId` (ACL-001).
 */
export function create(project) {
  const db = getDatabase();
  const row = projectToRow(project);
  row.workspaceId = project.workspaceId || null;
  db.prepare(`
    INSERT INTO projects (id, name, url, credentials, status, qualityGates, webVitalsBudgets, createdAt, workspaceId, autoApproveThreshold, iterationCap, strictPiiFirewall, piiAllowlist, visionHealing, visionHealMaxCallsPerDay, visionHealMaxCostUsdPerMonth, coverageEnabled, sourcemapBaseUrl)
    VALUES (@id, @name, @url, @credentials, @status, @qualityGates, @webVitalsBudgets, @createdAt, @workspaceId, @autoApproveThreshold, @iterationCap, @strictPiiFirewall, @piiAllowlist, @visionHealing, @visionHealMaxCallsPerDay, @visionHealMaxCostUsdPerMonth, @coverageEnabled, @sourcemapBaseUrl)
  `).run(row);
}

/**
 * Update specific fields on a project.
 * @param {string} id
 * @param {Object} fields
 */
export function update(id, fields) {
  const db = getDatabase();
  const allowed = ["name", "url", "credentials", "status", "qualityGates", "webVitalsBudgets", "autoApproveThreshold", "iterationCap", "strictPiiFirewall", "piiAllowlist", "visionHealing", "visionHealMaxCallsPerDay", "visionHealMaxCostUsdPerMonth", "coverageEnabled", "sourcemapBaseUrl"];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (key in fields) {
      let val = (key === "credentials" || key === "qualityGates" || key === "webVitalsBudgets" || key === "piiAllowlist") && fields[key]
        ? JSON.stringify(fields[key])
        : fields[key];
      // `strictPiiFirewall` is a JS boolean at the route layer but the column
      // is `INTEGER NOT NULL` — better-sqlite3 refuses to bind booleans and
      // throws "SQLite3 can only bind numbers, strings, bigints, buffers,
      // and null". Coerce here so callers can pass a natural `true` / `false`.
      if (key === "strictPiiFirewall" && typeof val === "boolean") {
        val = val ? 1 : 0;
      }
      if (key === "coverageEnabled" && typeof val === "boolean") {
        val = val ? 1 : 0;
      }
      sets.push(`${key} = @${key}`);
      params[key] = val;
    }
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Count total non-deleted projects.
 * @param {string} [workspaceId] — If provided, scope to this workspace (ACL-001).
 * @returns {number}
 */
export function count(workspaceId) {
  const db = getDatabase();
  if (workspaceId) {
    return db.prepare("SELECT COUNT(*) as cnt FROM projects WHERE deletedAt IS NULL AND workspaceId = ?").get(workspaceId).cnt;
  }
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
 * Get all projects (live + soft-deleted) for a workspace.
 * Used by data-management cleanup endpoints that must clear derived data
 * across all projects regardless of soft-delete status.
 * @param {string} workspaceId
 * @returns {Object[]}
 */
export function getAllIncludeDeleted(workspaceId) {
  return [...getAll(workspaceId), ...getDeletedAll(workspaceId)];
}

/**
 * Get all soft-deleted projects (recycle bin).
 * @param {string} [workspaceId] — If provided, scope to this workspace (ACL-001).
 * @returns {Object[]}
 */
export function getDeletedAll(workspaceId) {
  const db = getDatabase();
  if (workspaceId) {
    return db.prepare("SELECT * FROM projects WHERE deletedAt IS NOT NULL AND workspaceId = ? ORDER BY deletedAt DESC").all(workspaceId).map(rowToProject);
  }
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
