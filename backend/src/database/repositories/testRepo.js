/**
 * @module database/repositories/testRepo
 * @description Test CRUD backed by SQLite.
 *
 * JSON columns: steps, tags (arrays stored as JSON strings).
 * Boolean columns: isJourneyTest, assertionEnhanced, isApiTest (stored as 0/1).
 */

import { getDatabase } from "../sqlite.js";

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
    // If field is not in row and not filling defaults, leave it absent
  }
  for (const f of BOOL_FIELDS) {
    if (typeof row[f] === "boolean") row[f] = row[f] ? 1 : 0;
    else if (f in row && row[f] == null) row[f] = null;
    // If field is not in row, leave it absent
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

/**
 * Get all tests.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM tests").all().map(rowToTest);
}

/**
 * Get all tests as a dictionary keyed by ID.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const all = getAll();
  const dict = {};
  for (const t of all) dict[t.id] = t;
  return dict;
}

/**
 * Get tests for a specific project.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM tests WHERE projectId = ?").all(projectId).map(rowToTest);
}

/**
 * Get a test by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return rowToTest(db.prepare("SELECT * FROM tests WHERE id = ?").get(id));
}

/**
 * Create a test.
 * @param {Object} test
 */
export function create(test) {
  const db = getDatabase();
  const row = testToRow(test, { fillDefaults: true });
  // Fill in defaults for any missing columns
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

/**
 * Update specific fields on a test.
 * @param {string} id
 * @param {Object} fields — Partial test fields to update.
 */
// Set of valid column names for filtering unknown properties in update().
const VALID_COLS = new Set(INSERT_COLS);

export function update(id, fields) {
  const db = getDatabase();
  const row = testToRow(fields);
  const sets = [];
  const params = { id };
  for (const [key, val] of Object.entries(row)) {
    if (key === "id") continue;
    // Skip properties that are not actual table columns (e.g. _regenerated,
    // _quality, _generatedFrom) to prevent SQLite "no column" errors.
    if (!VALID_COLS.has(key)) continue;
    sets.push(`${key} = @${key}`);
    params[key] = val;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE tests SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Delete a test by ID.
 * @param {string} id
 */
export function deleteById(id) {
  const db = getDatabase();
  db.prepare("DELETE FROM tests WHERE id = ?").run(id);
}

/**
 * Delete all tests for a project.
 * @param {string} projectId
 * @returns {string[]} IDs of deleted tests.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare("SELECT id FROM tests WHERE projectId = ?").all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare("DELETE FROM tests WHERE projectId = ?").run(projectId);
  }
  return ids;
}

/**
 * Bulk update review status for a list of test IDs within a project.
 * @param {string[]} testIds
 * @param {string} projectId
 * @param {string} reviewStatus
 * @param {string|null} reviewedAt
 * @returns {Object[]} Updated test objects.
 */
export function bulkUpdateReviewStatus(testIds, projectId, reviewStatus, reviewedAt) {
  const db = getDatabase();
  const updated = [];
  const stmt = db.prepare(
    "UPDATE tests SET reviewStatus = ?, reviewedAt = ? WHERE id = ? AND projectId = ?"
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

/**
 * Count total tests.
 * @returns {number}
 */
export function count() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM tests").get().cnt;
}

/**
 * Count approved tests.
 * @returns {number}
 */
export function countApproved() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM tests WHERE reviewStatus = 'approved'").get().cnt;
}

/**
 * Count draft tests.
 * @returns {number}
 */
export function countDraft() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM tests WHERE reviewStatus = 'draft'").get().cnt;
}

/**
 * Count tests by review status for a project.
 * @param {string} projectId
 * @returns {{ draft: number, approved: number, rejected: number }}
 */
export function countByReviewStatus(projectId) {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT reviewStatus, COUNT(*) as cnt FROM tests WHERE projectId = ? GROUP BY reviewStatus"
  ).all(projectId);
  const counts = { draft: 0, approved: 0, rejected: 0 };
  for (const r of rows) {
    if (r.reviewStatus in counts) counts[r.reviewStatus] = r.cnt;
  }
  return counts;
}
