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
    INSERT INTO activities (id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId, userName, workspaceId, meta, ipAddress, userAgent, prevHash)
    VALUES (@id, @type, @projectId, @projectName, @testId, @testName, @detail, @status, @createdAt, @userId, @userName, @workspaceId, @meta, @ipAddress, @userAgent, @prevHash)
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
    // `meta` is JSON-encoded TEXT (migration 018) so callers can pass a plain
    // object; readers below re-parse it. Null when absent so the column is
    // genuinely empty rather than the string "null".
    meta: activity.meta != null ? JSON.stringify(activity.meta) : null,
    ipAddress: activity.ipAddress || null,
    userAgent: activity.userAgent || null,
    prevHash: activity.prevHash || null,
  });
}

/**
 * Re-parse the JSON `meta` column into a plain object for callers. Tolerant
 * of legacy rows where the column is null/empty/non-JSON — those rows
 * predate migration 018 and surface as `meta: null`.
 * @param {Object} row
 * @returns {Object}
 */
function hydrate(row) {
  if (!row) return row;
  if (typeof row.meta === "string" && row.meta.length > 0) {
    try { row.meta = JSON.parse(row.meta); } catch { row.meta = null; }
  } else if (row.meta === undefined) {
    row.meta = null;
  }
  return row;
}

/**
 * Get all activities.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM activities ORDER BY createdAt DESC").all().map(hydrate);
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
 *
 * `after` / `before` accept ISO-8601 strings (matching the column's storage
 * format). The comparison is lexicographic on ISO strings, which is correct
 * for the YYYY-MM-DDTHH:MM:SS.sssZ shape `Date.toISOString()` produces.
 *
 * `offset` pairs with `limit` for cursor-style "Load more" — clients pass
 * the count of rows they've already rendered. Combined with the default
 * `ORDER BY createdAt DESC`, this gives a stable forward window even
 * when new rows arrive between fetches (the ordering key is the row's
 * own timestamp, so a new row only shifts the cursor on the *first*
 * page, not subsequent pages).
 *
 * @param {Object} [filters]
 * @param {string} [filters.type]
 * @param {string} [filters.projectId]
 * @param {string} [filters.workspaceId] — Scope to workspace (ACL-001).
 * @param {string} [filters.after]       — ISO timestamp; only rows with
 *   `createdAt >= after` are returned. Powers the AUTO-003b approvals
 *   timeline date-range picker (This week / Last 30 days / Custom).
 * @param {string} [filters.before]      — ISO timestamp; only rows with
 *   `createdAt < before` are returned. Pairs with `after` for bounded
 *   ranges; either bound is optional.
 * @param {number} [filters.limit=200]
 * @param {number} [filters.offset]      — Skip the first N rows of the
 *   result set; used by paginated UIs (Load more) to fetch the next page.
 * @returns {Object[]}
 */
export function getFiltered({ type, projectId, workspaceId, after, before, limit, offset } = {}) {
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
  if (after) {
    sql += " AND createdAt >= ?";
    params.push(after);
  }
  if (before) {
    sql += " AND createdAt < ?";
    params.push(before);
  }
  sql += " ORDER BY createdAt DESC LIMIT ?";
  // Honour an explicit `limit: 0` (legit "count-only / probe" value) and
  // reject non-finite inputs (NaN, Infinity) by falling back to the default
  // only for `undefined` / `null`. `limit || 200` would coerce both `0` and
  // `NaN` to 200 — the first silently returns 200 rows when the caller
  // asked for none; the second hides a bad input behind a full page.
  params.push(Number.isFinite(limit) ? limit : 200);
  if (Number.isFinite(offset) && offset > 0) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  return db.prepare(sql).all(...params).map(hydrate);
}

/**
 * Count `DISTINCT testId` across activity rows matching the filter (AUTO-003b).
 *
 * Used by the approval-stats 7-day revert-rate calculation, which asks
 * *"how many distinct tests were auto-approved in the window?"* and
 * *"how many distinct tests were revoked in the window?"* — set sizes,
 * not row counts, because a test that auto-approved twice in the window
 * should still count as one.
 *
 * Previously computed by fetching up to 10,000 rows via `getFiltered`
 * and building two `Set`s in JS; at ~1 KB per row that's ~10 MB of
 * transferred data per project per call. This query returns a single
 * integer, and the `activities(type, projectId, createdAt)` access
 * pattern is index-friendly on both adapters.
 *
 * The `metaIsAutoApproved` filter matches the JSON-encoded flag
 * `meta.wasAutoApproved = true` via a portable `LIKE` on the serialised
 * `meta` TEXT column (migration 018). LIKE is case-sensitive on SQLite
 * and case-insensitive on PostgreSQL (the adapter rewrites LIKE→ILIKE)
 * — fine here because `logActivity` always writes the lowercase
 * `"wasAutoApproved":true` shape, so case-variation isn't possible on
 * real data. Using LIKE instead of `json_extract` keeps the query
 * portable across the SQLite/PostgreSQL adapters without a dialect
 * branch (INF-001).
 *
 * @param {Object} filters
 * @param {string} filters.type                   — required, exact match on `activities.type`.
 * @param {string} [filters.projectId]            — scope to project.
 * @param {string} [filters.workspaceId]          — scope to workspace (ACL).
 * @param {string} [filters.after]                — ISO timestamp lower bound (inclusive).
 * @param {string} [filters.before]               — ISO timestamp upper bound (exclusive).
 * @param {boolean} [filters.metaIsAutoApproved]  — match rows whose `meta`
 *   column encodes `{ ..., "wasAutoApproved": true }`. Used to filter revoke
 *   rows down to "was the revoked test originally auto-approved?" without
 *   reading 10k rows into memory.
 * @returns {number} Count of distinct non-null `testId` values among matching rows.
 */
export function countDistinctTestIds({ type, projectId, workspaceId, after, before, metaIsAutoApproved } = {}) {
  const db = getDatabase();
  let sql = "SELECT COUNT(DISTINCT testId) AS cnt FROM activities WHERE testId IS NOT NULL";
  const params = [];
  if (type) {
    sql += " AND type = ?";
    params.push(type);
  }
  if (projectId) {
    sql += " AND projectId = ?";
    params.push(projectId);
  }
  if (workspaceId) {
    sql += " AND workspaceId = ?";
    params.push(workspaceId);
  }
  if (after) {
    sql += " AND createdAt >= ?";
    params.push(after);
  }
  if (before) {
    sql += " AND createdAt < ?";
    params.push(before);
  }
  if (metaIsAutoApproved) {
    // Portable JSON-in-TEXT probe. Matches the exact substring
    // `"wasAutoApproved":true` (no spaces — `JSON.stringify` omits them)
    // so the filter is stable across both adapters. A dialect-specific
    // `json_extract(meta, '$.wasAutoApproved') = 1` would be nicer on
    // SQLite but breaks on PostgreSQL (`jsonb_extract_path` / `->>`),
    // and the LIKE is already bounded by the indexed `type + projectId`
    // predicates above.
    sql += " AND meta LIKE ?";
    params.push('%"wasAutoApproved":true%');
  }
  return db.prepare(sql).get(...params)?.cnt || 0;
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


export function getWorkspaceAuditLog(workspaceId, { userId, types = [], dateFrom, dateTo, ipAddress, limit = 200, offset = 0 } = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM activities WHERE workspaceId = ?";
  const params = [workspaceId];
  if (userId) { sql += " AND userId = ?"; params.push(userId); }
  if (types?.length) { sql += ` AND type IN (${types.map(() => '?').join(',')})`; params.push(...types); }
  if (dateFrom) { sql += " AND createdAt >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND createdAt <= ?"; params.push(dateTo); }
  if (ipAddress) { sql += " AND ipAddress = ?"; params.push(ipAddress); }
  sql += " ORDER BY createdAt DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return db.prepare(sql).all(...params).map(hydrate);
}

export function verifyAuditChain(workspaceId) {
  const db = getDatabase();
  const rows = db.prepare("SELECT id, prevHash FROM activities WHERE workspaceId = ? ORDER BY createdAt ASC").all(workspaceId);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].prevHash !== rows[i - 1].prevHash) return { verified: false, firstBrokenRowId: rows[i].id, total: rows.length };
  }
  return { verified: true, total: rows.length };
}
