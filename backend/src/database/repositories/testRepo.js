/**
 * @module database/repositories/testRepo
 * @description Test CRUD backed by SQLite.
 *
 * JSON columns: steps, tags (arrays stored as JSON strings).
 * Boolean columns: isJourneyTest, assertionEnhanced, isApiTest (stored as 0/1).
 *
 * All read queries filter `WHERE deletedAt IS NULL` by default.
 * Hard deletes are replaced with soft-deletes: `deletedAt = datetime('now')`.
 * Use {@link getDeletedByProjectId} / {@link restore} for recycle-bin operations.
 *
 * ### Pagination
 * {@link getByProjectIdPaged} and {@link getAllPaged} return
 * `{ data: Test[], meta: { total, page, pageSize, hasMore } }`.
 */

import { getDatabase } from "../sqlite.js";
import { parsePagination } from "../../utils/pagination.js";

export { parsePagination };

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────

const JSON_FIELDS = ["steps", "tags"];
const BOOL_FIELDS = ["isJourneyTest", "assertionEnhanced", "isApiTest"];

function rowToTest(row) {
  if (!row) return undefined;
  const obj = { ...row };
  for (const f of JSON_FIELDS) {
    obj[f] = obj[f] ? JSON.parse(obj[f]) : (f === "steps" || f === "tags" ? [] : null);
  }
  for (const f of BOOL_FIELDS) {
    obj[f] = obj[f] === 1 ? true : obj[f] === 0 ? false : obj[f];
  }
  return obj;
}

function testToRow(t, { fillDefaults = false } = {}) {
  const row = { ...t };
  for (const f of JSON_FIELDS) {
    if (Array.isArray(row[f])) row[f] = JSON.stringify(row[f]);
    else if (f in row && row[f] == null) row[f] = fillDefaults ? "[]" : row[f];
    else if (!(f in row) && fillDefaults) row[f] = "[]";
  }
  for (const f of BOOL_FIELDS) {
    if (typeof row[f] === "boolean") row[f] = row[f] ? 1 : 0;
    else if (f in row && row[f] == null) row[f] = null;
  }
  return row;
}

// All columns in insertion order for the INSERT statement
const INSERT_COLS = [
  "id", "projectId", "name", "description", "steps", "playwrightCode",
  "playwrightCodePrev", "priority", "type", "sourceUrl", "pageTitle",
  "createdAt", "updatedAt", "lastResult", "lastRunAt", "qualityScore",
  "isJourneyTest", "journeyType", "assertionEnhanced", "reviewStatus",
  "reviewedAt", "promptVersion", "modelUsed", "linkedIssueKey", "tags",
  "generatedFrom", "isApiTest", "scenario", "codeRegeneratedAt",
  "aiFixAppliedAt", "codeVersion",
];

const INSERT_SQL = `INSERT INTO tests (${INSERT_COLS.join(", ")})
  VALUES (${INSERT_COLS.map(c => "@" + c).join(", ")})`;

// ─── Read queries ─────────────────────────────────────────────────────────────

/**
 * Get all non-deleted tests.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM tests WHERE deletedAt IS NULL").all().map(rowToTest);
}

/**
 * Get all non-deleted tests with pagination.
 * @param {number|string} [page=1]
 * @param {number|string} [pageSize=DEFAULT_PAGE_SIZE]
 * @returns {PagedResult}
 */
export function getAllPaged(page, pageSize) {
  const db = getDatabase();
  const { page: p, pageSize: ps, offset } = parsePagination(page, pageSize);
  const total = db.prepare("SELECT COUNT(*) as cnt FROM tests WHERE deletedAt IS NULL").get().cnt;
  const data  = db.prepare(
    "SELECT * FROM tests WHERE deletedAt IS NULL ORDER BY createdAt DESC LIMIT ? OFFSET ?"
  ).all(ps, offset).map(rowToTest);
  return { data, meta: { total, page: p, pageSize: ps, hasMore: offset + data.length < total } };
}

/**
 * Get all non-deleted tests as a dictionary keyed by ID.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const all = getAll();
  const dict = {};
  for (const t of all) dict[t.id] = t;
  return dict;
}

/**
 * Get non-deleted tests for a specific project.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM tests WHERE projectId = ? AND deletedAt IS NULL").all(projectId).map(rowToTest);
}

/**
 * Get non-deleted tests for a project with pagination.
 * @param {string}        projectId
 * @param {number|string} [page=1]
 * @param {number|string} [pageSize=DEFAULT_PAGE_SIZE]
 * @returns {PagedResult}
 */
export function getByProjectIdPaged(projectId, page, pageSize) {
  const db = getDatabase();
  const { page: p, pageSize: ps, offset } = parsePagination(page, pageSize);
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM tests WHERE projectId = ? AND deletedAt IS NULL"
  ).get(projectId).cnt;
  const data = db.prepare(
    "SELECT * FROM tests WHERE projectId = ? AND deletedAt IS NULL ORDER BY createdAt DESC LIMIT ? OFFSET ?"
  ).all(projectId, ps, offset).map(rowToTest);
  return { data, meta: { total, page: p, pageSize: ps, hasMore: offset + data.length < total } };
}

/**
 * Get a non-deleted test by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return rowToTest(db.prepare("SELECT * FROM tests WHERE id = ? AND deletedAt IS NULL").get(id));
}

/**
 * Get a test by ID including soft-deleted (needed for restore operations).
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getByIdIncludeDeleted(id) {
  const db = getDatabase();
  return rowToTest(db.prepare("SELECT * FROM tests WHERE id = ?").get(id));
}

// ─── Write operations ─────────────────────────────────────────────────────────

/**
 * Create a test.
 * @param {Object} test
 */
export function create(test) {
  const db = getDatabase();
  const row = testToRow(test, { fillDefaults: true });
  const params = {};
  for (const col of INSERT_COLS) {
    params[col] = row[col] !== undefined ? row[col] : null;
  }
  if (params.name == null) params.name = "";
  if (params.description == null) params.description = "";
  if (params.steps == null) params.steps = "[]";
  if (params.tags == null) params.tags = "[]";
  if (params.isJourneyTest == null) params.isJourneyTest = 0;
  if (params.assertionEnhanced == null) params.assertionEnhanced = 0;
  if (params.reviewStatus == null) params.reviewStatus = "draft";
  if (params.priority == null) params.priority = "medium";
  if (params.codeVersion == null) params.codeVersion = 0;
  db.prepare(INSERT_SQL).run(params);
}

// Set of valid column names for filtering unknown properties in update().
const VALID_COLS = new Set(INSERT_COLS);

/**
 * Update specific fields on a test.
 * @param {string} id
 * @param {Object} fields — Partial test fields to update.
 */
export function update(id, fields) {
  const db = getDatabase();
  const row = testToRow(fields);
  const sets = [];
  const params = { id };
  for (const [key, val] of Object.entries(row)) {
    if (key === "id") continue;
    if (!VALID_COLS.has(key)) continue;
    sets.push(`${key} = @${key}`);
    params[key] = val;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE tests SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Soft-delete a test by ID (sets deletedAt to now).
 * @param {string} id
 */
export function deleteById(id) {
  const db = getDatabase();
  db.prepare("UPDATE tests SET deletedAt = datetime('now') WHERE id = ? AND deletedAt IS NULL").run(id);
}

/**
 * Hard-delete a test by ID (permanent — use only for purge operations).
 * @param {string} id
 */
export function hardDeleteById(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM tests WHERE id = ?").run(id);
}

/**
 * Soft-delete all tests for a project.
 * Returns IDs of the tests that were just soft-deleted (excludes already-deleted).
 * @param {string} projectId
 * @returns {string[]} IDs of newly soft-deleted tests.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare(
    "SELECT id FROM tests WHERE projectId = ? AND deletedAt IS NULL"
  ).all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare(
      "UPDATE tests SET deletedAt = datetime('now') WHERE projectId = ? AND deletedAt IS NULL"
    ).run(projectId);
  }
  return ids;
}

/**
 * Hard-delete all tests for a project (permanent — for project purge).
 * @param {string} projectId
 * @returns {string[]} IDs of all deleted tests.
 */
export function hardDeleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare("SELECT id FROM tests WHERE projectId = ?").all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare("DELETE FROM tests WHERE projectId = ?").run(projectId);
  }
  return ids;
}

/**
 * Bulk update review status for a list of test IDs within a project.
 * Only applies to non-deleted tests.
 * @param {string[]}    testIds
 * @param {string}      projectId
 * @param {string}      reviewStatus
 * @param {string|null} reviewedAt
 * @returns {Object[]} Updated test objects.
 */
export function bulkUpdateReviewStatus(testIds, projectId, reviewStatus, reviewedAt) {
  const db = getDatabase();
  const updated = [];
  const stmt = db.prepare(
    "UPDATE tests SET reviewStatus = ?, reviewedAt = ? WHERE id = ? AND projectId = ? AND deletedAt IS NULL"
  );
  const txn = db.transaction(() => {
    for (const tid of testIds) {
      const info = stmt.run(reviewStatus, reviewedAt, tid, projectId);
      if (info.changes > 0) {
        const test = getById(tid);
        if (test) updated.push(test);
      }
    }
  });
  txn();
  return updated;
}

// ─── Recycle bin ─────────────────────────────────────────────────────────────

/**
 * Get soft-deleted tests for a project (recycle bin view).
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getDeletedByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM tests WHERE projectId = ? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC"
  ).all(projectId).map(rowToTest);
}

/**
 * Get all soft-deleted tests across all projects.
 * @returns {Object[]}
 */
export function getDeletedAll() {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM tests WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC"
  ).all().map(rowToTest);
}

/**
 * Restore a soft-deleted test (clears deletedAt).
 * @param {string} id
 * @returns {boolean} Whether the test was found and restored.
 */
export function restore(id) {
  const db = getDatabase();
  const info = db.prepare("UPDATE tests SET deletedAt = NULL WHERE id = ? AND deletedAt IS NOT NULL").run(id);
  return info.changes > 0;
}

/**
 * Restore soft-deleted tests for a project that were deleted at or after a
 * given timestamp. Used by project cascade-restore to avoid restoring items
 * that were individually deleted before the project.
 * @param {string} projectId
 * @param {string} deletedAfter — ISO timestamp (inclusive lower bound).
 * @returns {number} Number of tests restored.
 */
export function restoreByProjectIdAfter(projectId, deletedAfter) {
  const db = getDatabase();
  const info = db.prepare(
    "UPDATE tests SET deletedAt = NULL WHERE projectId = ? AND deletedAt IS NOT NULL AND deletedAt >= ?"
  ).run(projectId, deletedAfter);
  return info.changes;
}

// ─── Counts ───────────────────────────────────────────────────────────────────

/**
 * Count total non-deleted tests.
 * @returns {number}
 */
export function count() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM tests WHERE deletedAt IS NULL").get().cnt;
}

/**
 * Count approved non-deleted tests.
 * @returns {number}
 */
export function countApproved() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM tests WHERE reviewStatus = 'approved' AND deletedAt IS NULL").get().cnt;
}

/**
 * Count draft non-deleted tests.
 * @returns {number}
 */
export function countDraft() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM tests WHERE reviewStatus = 'draft' AND deletedAt IS NULL").get().cnt;
}

/**
 * Count tests by review status for a project (non-deleted only).
 * Also returns last-result breakdown (passed/failed) for approved tests
 * and category breakdown (api/ui) across all statuses — so the frontend
 * can display accurate stats without fetching all rows.
 * @param {string} projectId
 * @returns {{ draft: number, approved: number, rejected: number, passed: number, failed: number, api: number, ui: number }}
 */
export function countByReviewStatus(projectId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN reviewStatus = 'draft'    THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN reviewStatus = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN reviewStatus = 'rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN reviewStatus = 'approved' AND lastResult = 'passed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN reviewStatus = 'approved' AND lastResult = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN generatedFrom IN ('api_har_capture', 'api_user_described') THEN 1 ELSE 0 END) AS api
    FROM tests
    WHERE projectId = ? AND deletedAt IS NULL
  `).get(projectId);
  return {
    draft:    row.draft    || 0,
    approved: row.approved || 0,
    rejected: row.rejected || 0,
    passed:   row.passed   || 0,
    failed:   row.failed   || 0,
    api:      row.api      || 0,
    ui:       (row.draft || 0) + (row.approved || 0) + (row.rejected || 0) - (row.api || 0),
  };
}
