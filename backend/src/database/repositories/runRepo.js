/**
 * @module database/repositories/runRepo
 * @description Run CRUD backed by SQLite.
 *
 * JSON columns: logs, tests, results, testQueue, generateInput, promptAudit,
 * pipelineStats, feedbackLoop, videoSegments.
 */

import { getDatabase } from "../sqlite.js";

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────

const JSON_FIELDS = [
  "logs", "tests", "results", "testQueue", "generateInput",
  "promptAudit", "pipelineStats", "feedbackLoop", "videoSegments",
];

function rowToRun(row) {
  if (!row) return undefined;
  const obj = { ...row };
  for (const f of JSON_FIELDS) {
    if (obj[f]) {
      try { obj[f] = JSON.parse(obj[f]); }
      catch { obj[f] = f === "logs" || f === "tests" || f === "results" || f === "videoSegments" ? [] : null; }
    } else {
      obj[f] = f === "logs" || f === "tests" || f === "results" || f === "videoSegments" ? [] : null;
    }
  }
  return obj;
}

function runToRow(r) {
  const row = { ...r };
  for (const f of JSON_FIELDS) {
    if (row[f] != null && typeof row[f] === "object") {
      row[f] = JSON.stringify(row[f]);
    }
  }
  return row;
}

const INSERT_COLS = [
  "id", "projectId", "type", "status", "startedAt", "finishedAt",
  "duration", "error", "errorCategory", "passed", "failed", "total",
  "pagesFound", "parallelWorkers", "tracePath", "videoPath", "videoSegments",
  "logs", "tests", "results", "testQueue", "generateInput", "promptAudit",
  "pipelineStats", "feedbackLoop", "currentStep",
];

const INSERT_SQL = `INSERT INTO runs (${INSERT_COLS.join(", ")})
  VALUES (${INSERT_COLS.map(c => "@" + c).join(", ")})`;

/**
 * Get all runs.
 * @returns {Object[]}
 */
export function getAll() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM runs").all().map(rowToRun);
}

/**
 * Get all runs as a dictionary keyed by ID.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const all = getAll();
  const dict = {};
  for (const r of all) dict[r.id] = r;
  return dict;
}

/**
 * Get runs for a specific project, sorted by startedAt descending.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM runs WHERE projectId = ? ORDER BY startedAt DESC"
  ).all(projectId).map(rowToRun);
}

/**
 * Get a run by ID.
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  return rowToRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(id));
}

/**
 * Create a run.
 * @param {Object} run
 */
export function create(run) {
  const db = getDatabase();
  const row = runToRow(run);
  const params = {};
  for (const col of INSERT_COLS) {
    params[col] = row[col] !== undefined ? row[col] : null;
  }
  if (params.logs == null) params.logs = "[]";
  if (params.tests == null) params.tests = "[]";
  if (params.results == null) params.results = "[]";
  db.prepare(INSERT_SQL).run(params);
}

// Set of valid column names for filtering unknown properties in update().
const VALID_COLS = new Set(INSERT_COLS);

/**
 * Update specific fields on a run (full replacement of provided fields).
 * Unknown properties (not in the runs table) are silently skipped.
 * @param {string} id
 * @param {Object} fields
 */
export function update(id, fields) {
  const db = getDatabase();
  const row = runToRow(fields);
  const sets = [];
  const params = { id };
  for (const [key, val] of Object.entries(row)) {
    if (key === "id") continue;
    if (!VALID_COLS.has(key)) continue;
    sets.push(`${key} = @${key}`);
    params[key] = val;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/**
 * Save the entire run object (upsert-style update of all known columns).
 * Used by pipeline code that mutates the run in-memory and then flushes.
 *
 * Pipeline code accumulates non-column properties on the run object
 * (e.g. currentStep, snapshots, pages, testsGenerated, rateLimitError,
 * qualityAnalytics). These are filtered out so the generated SQL only
 * references actual table columns.
 *
 * @param {Object} run — Full run object with `id`.
 */
export function save(run) {
  const fields = {};
  for (const col of INSERT_COLS) {
    if (col !== "id" && col in run) fields[col] = run[col];
  }
  if (Object.keys(fields).length === 0) return;
  update(run.id, fields);
}

/**
 * Find an active run for a project (status = "running").
 * @param {string} projectId
 * @param {string[]} [types] — Run types to check (default: crawl, test_run, generate).
 * @returns {Object|undefined}
 */
export function findActiveByProjectId(projectId, types) {
  const db = getDatabase();
  const typeList = types || ["crawl", "test_run", "generate"];
  const placeholders = typeList.map(() => "?").join(", ");
  return rowToRun(
    db.prepare(
      `SELECT * FROM runs WHERE projectId = ? AND status = 'running' AND type IN (${placeholders}) LIMIT 1`
    ).get(projectId, ...typeList)
  );
}

/**
 * Delete all runs for a project.
 * @param {string} projectId
 * @returns {string[]} IDs of deleted runs.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare("SELECT id FROM runs WHERE projectId = ?").all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare("DELETE FROM runs WHERE projectId = ?").run(projectId);
  }
  return ids;
}

/**
 * Delete all runs.
 * @returns {number} Number of deleted rows.
 */
export function clearAll() {
  const db = getDatabase();
  const count = db.prepare("SELECT COUNT(*) as cnt FROM runs").get().cnt;
  db.prepare("DELETE FROM runs").run();
  return count;
}

/**
 * Mark all "running" runs as "interrupted" (orphan recovery on startup).
 * @returns {number} Number of runs marked.
 */
export function markOrphansInterrupted() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const info = db.prepare(
    `UPDATE runs SET status = 'interrupted', finishedAt = COALESCE(finishedAt, ?),
     error = 'Server restarted while run was in progress'
     WHERE status = 'running'`
  ).run(now);
  return info.changes;
}
