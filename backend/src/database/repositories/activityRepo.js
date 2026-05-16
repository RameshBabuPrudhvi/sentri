/**
 * @module database/repositories/activityRepo
 * @description Activity log CRUD backed by SQLite.
 */

import crypto from "node:crypto";
import { getDatabase } from "../sqlite.js";

/**
 * SEC-007: Canonical hash-input shape for an activity row — everything that
 * is persisted EXCEPT `prevHash` itself. Both the INSERT path and the
 * verification path must use this identical helper so the computed hash
 * round-trips deterministically. Key order is stable because object
 * literal property order is preserved in V8.
 *
 * `meta` is normalised to its JSON-string form (or null) so the hash input
 * matches the exact byte sequence stored in the TEXT column — the
 * verification path reads the column back as TEXT and must hash it without
 * re-parsing.
 *
 * @param {Object} row
 * @returns {Object}
 * @private
 */
function rowMinusHash(row) {
  return {
    id: row.id,
    type: row.type,
    projectId: row.projectId || null,
    projectName: row.projectName || null,
    testId: row.testId || null,
    testName: row.testName || null,
    detail: row.detail || null,
    status: row.status || "completed",
    createdAt: row.createdAt,
    userId: row.userId || null,
    userName: row.userName || null,
    workspaceId: row.workspaceId || null,
    meta: row.meta == null
      ? null
      : (typeof row.meta === "string" ? row.meta : JSON.stringify(row.meta)),
    ipAddress: row.ipAddress || null,
    userAgent: row.userAgent || null,
  };
}

/**
 * SEC-007: Compute the next `prevHash` from the previous row's hash and the
 * current row's content. Exported for tests and re-used by `verifyAuditChain`
 * so a single implementation is the source of truth (any drift between
 * INSERT and verify breaks the chain immediately rather than silently).
 *
 *   prevHash_i = sha256(prevHash_{i-1} ++ JSON.stringify(rowMinusHash_i))
 *
 * The leading hash for the very first row is the empty string.
 *
 * @param {string|null} previousHash
 * @param {Object}      row
 * @returns {string} 64-char lowercase hex digest.
 */
export function computePrevHash(previousHash, row) {
  const input = (previousHash || "") + JSON.stringify(rowMinusHash(row));
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Create an activity entry.
 *
 * When `AUDIT_HASH_CHAIN=true`, computes `prevHash` from the last row in
 * the same workspace and stores it in the same transaction as the INSERT.
 * Otherwise `prevHash` is persisted as null (chain disabled — default).
 *
 * @param {Object} activity — { id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId?, userName?, workspaceId?, meta?, ipAddress?, userAgent?, prevHash? }
 */
export function create(activity) {
  const db = getDatabase();
  // `meta` is JSON-encoded TEXT (migration 018) so callers can pass a plain
  // object; readers below re-parse it. Null when absent so the column is
  // genuinely empty rather than the string "null".
  const metaStr = activity.meta != null ? JSON.stringify(activity.meta) : null;

  const insert = db.prepare(`
    INSERT INTO activities (id, type, projectId, projectName, testId, testName, detail, status, createdAt, userId, userName, workspaceId, meta, ipAddress, userAgent, prevHash)
    VALUES (@id, @type, @projectId, @projectName, @testId, @testName, @detail, @status, @createdAt, @userId, @userName, @workspaceId, @meta, @ipAddress, @userAgent, @prevHash)
  `);

  // SEC-007: hash-chain compute. Wrapped in a transaction so the lookup of
  // the previous row and the INSERT are atomic — without this, two parallel
  // logActivity() calls could both read the same "previous" row and chain
  // off it, producing two siblings with identical prevHash that break the
  // verification walk. The feature is opt-in (chained writes serialise
  // INSERTs under contention) and gated by AUDIT_HASH_CHAIN=true.
  const chainEnabled = process.env.AUDIT_HASH_CHAIN === "true";

  const params = {
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
    meta: metaStr,
    ipAddress: activity.ipAddress || null,
    userAgent: activity.userAgent || null,
    prevHash: activity.prevHash || null,
  };

  if (chainEnabled) {
    const tx = db.transaction((row) => {
      // Order by createdAt DESC, id DESC as a tiebreaker for sub-millisecond
      // bursts where two rows can share the same ISO timestamp.
      const prev = db.prepare(
        "SELECT prevHash FROM activities WHERE workspaceId = ? ORDER BY createdAt DESC, id DESC LIMIT 1"
      ).get(row.workspaceId);
      // Pass the stringified meta (matching what's about to be persisted) so
      // computePrevHash's normaliser sees the same bytes the verifier will.
      row.prevHash = computePrevHash(prev?.prevHash || null, { ...row, meta: metaStr });
      insert.run(row);
    });
    tx(params);
  } else {
    insert.run(params);
  }
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

/**
 * SEC-007: Walk the audit-log chain for a workspace in chronological order
 * and verify each row's `prevHash` matches the recomputed
 * `sha256(prev.prevHash + JSON.stringify(rowMinusHash(row)))`.
 *
 * Uses the shared `computePrevHash` helper so any drift between the INSERT
 * path and the verification path is impossible — both call the same function.
 *
 * Returns `{ verified: true, total }` on a clean walk, or
 * `{ verified: false, firstBrokenRowId, total }` at the first mismatch.
 * An empty workspace is trivially verified.
 *
 * Caller is expected to gate this behind `AUDIT_HASH_CHAIN=true` — when
 * the chain is disabled, every row has `prevHash = null` and this walk
 * would falsely report the second row as broken. The route handler in
 * `backend/src/routes/system.js` short-circuits to `{ chainDisabled: true }`
 * in that case.
 *
 * @param {string} workspaceId
 * @returns {{ verified: boolean, firstBrokenRowId?: string, total: number }}
 */
export function verifyAuditChain(workspaceId) {
  const db = getDatabase();
  // SELECT * so we have every column needed to reproduce `rowMinusHash`.
  // Tiebreaker `id ASC` matches the INSERT-side `id DESC` ordering for
  // sub-millisecond bursts where two rows share the same createdAt.
  const rows = db.prepare(
    "SELECT * FROM activities WHERE workspaceId = ? ORDER BY createdAt ASC, id ASC"
  ).all(workspaceId);
  let previousHash = null;
  for (let i = 0; i < rows.length; i++) {
    const expected = computePrevHash(previousHash, rows[i]);
    if (rows[i].prevHash !== expected) {
      return { verified: false, firstBrokenRowId: rows[i].id, total: rows.length };
    }
    previousHash = rows[i].prevHash;
  }
  return { verified: true, total: rows.length };
}
