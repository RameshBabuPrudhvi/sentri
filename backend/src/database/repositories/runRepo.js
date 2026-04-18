/**
 * @module database/repositories/runRepo
 * @description Run CRUD backed by SQLite.
 *
 * JSON columns: tests, results, testQueue, generateInput, promptAudit,
 * pipelineStats, feedbackLoop, videoSegments, qualityAnalytics.
 *
 * Log lines are stored in the `run_logs` table (ENH-008) — not in a
 * `logs` JSON column.  {@link getById} hydrates `run.logs` from
 * `run_logs` automatically so callers see no API change.
 *
 * All read queries filter `WHERE deletedAt IS NULL` by default.
 * Hard deletes are replaced with soft-deletes: `deletedAt = datetime('now')`.
 * Use {@link getDeletedByProjectId} / {@link restore} for recycle-bin operations.
 *
 * ### Pagination
 * {@link getByProjectIdPaged} returns
 * `{ data: Run[], meta: { total, page, pageSize, hasMore } }`.
 */

import { getDatabase } from "../sqlite.js";
import { parsePagination } from "../../utils/pagination.js";
import * as runLogRepo from "./runLogRepo.js";

export { parsePagination };

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────

// `logs` is intentionally excluded — log lines live in the `run_logs` table
// (ENH-008).  The `runs` table still has a `logs` column for backwards
// compatibility with existing databases, but all new writes bypass it.
const JSON_FIELDS = [
  "tests", "results", "testQueue", "generateInput",
  "promptAudit", "pipelineStats", "feedbackLoop", "videoSegments",
  "qualityAnalytics",
];

function rowToRun(row) {
  if (!row) return undefined;
  const obj = { ...row };
  for (const f of JSON_FIELDS) {
    if (obj[f]) {
      try { obj[f] = JSON.parse(obj[f]); }
      catch { obj[f] = f === "tests" || f === "results" || f === "videoSegments" ? [] : null; }
    } else {
      obj[f] = f === "tests" || f === "results" || f === "videoSegments" ? [] : null;
    }
  }
  // Always initialise logs as an empty array; callers that need the full
  // log history should call getById() which hydrates from run_logs.
  if (!Array.isArray(obj.logs)) obj.logs = [];
  return obj;
}

function runToRow(r) {
  const row = { ...r };
  for (const f of JSON_FIELDS) {
    if (row[f] != null && typeof row[f] === "object") {
      row[f] = JSON.stringify(row[f]);
    }
  }
  // Never serialise the in-memory logs array back to the runs table —
  // log lines are stored in run_logs exclusively.
  delete row.logs;
  return row;
}

const INSERT_COLS = [
  "id", "projectId", "type", "status", "startedAt", "finishedAt",
  "duration", "error", "errorCategory", "passed", "failed", "total",
  "pagesFound", "parallelWorkers", "tracePath", "videoPath", "videoSegments",
  "tests", "results", "testQueue", "generateInput", "promptAudit",
  "pipelineStats", "feedbackLoop", "currentStep",
  "rateLimitError", "qualityAnalytics", "workspaceId",
];

const INSERT_SQL = `INSERT INTO runs (${INSERT_COLS.join(", ")})
  VALUES (${INSERT_COLS.map(c => "@" + c).join(", ")})`;

// ─── Lean column sets (skip heavy JSON) ───────────────────────────────────────

const LEAN_COLS = [
  "id", "projectId", "type", "status", "startedAt", "finishedAt",
  "duration", "error", "errorCategory", "passed", "failed", "total",
  "pagesFound", "parallelWorkers", "currentStep", "rateLimitError",
].join(", ");

const LEAN_WITH_FEEDBACK_COLS = `${LEAN_COLS}, feedbackLoop, pipelineStats`;

/**
 * Parse the lightweight JSON columns (feedbackLoop, pipelineStats) on a lean
 * row in-place.  Both are small objects — safe to include in listing queries.
 * @param {Object} row
 * @returns {Object} The same row with JSON columns deserialized.
 */
function parseLeanJson(row) {
  if (row.feedbackLoop) {
    try { row.feedbackLoop = JSON.parse(row.feedbackLoop); } catch { row.feedbackLoop = null; }
  } else {
    row.feedbackLoop = null;
  }
  if (row.pipelineStats) {
    try { row.pipelineStats = JSON.parse(row.pipelineStats); } catch { row.pipelineStats = null; }
  } else {
    row.pipelineStats = null;
  }
  return row;
}

// ─── Read queries (non-deleted) ───────────────────────────────────────────────

/**
 * Get all non-deleted runs with results + feedbackLoop columns (for failure/analytics).
 * Prefer {@link getWithResultsByProjectIds} for workspace-scoped queries.
 * @returns {Object[]}
 */
export function getAllWithResults() {
  const db = getDatabase();
  return db.prepare(`SELECT ${LEAN_COLS}, results, feedbackLoop FROM runs WHERE deletedAt IS NULL`).all().map(parseResultsAndLean);
}

/**
 * Get non-deleted runs with results + feedbackLoop for a set of project IDs.
 * Workspace-scoped alternative to {@link getAllWithResults} — queries only the
 * rows belonging to the given projects instead of loading the entire table.
 *
 * @param {string[]} projectIds
 * @returns {Object[]}
 */
export function getWithResultsByProjectIds(projectIds) {
  if (!projectIds || projectIds.length === 0) return [];
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT ${LEAN_COLS}, results, feedbackLoop FROM runs WHERE projectId IN (${placeholders}) AND deletedAt IS NULL`
  ).all(...projectIds).map(parseResultsAndLean);
}

/**
 * Parse results JSON + lean JSON columns on a row.
 * Shared by {@link getAllWithResults} and {@link getWithResultsByProjectIds}.
 * @param {Object} row
 * @returns {Object}
 */
function parseResultsAndLean(row) {
  if (row.results) {
    try { row.results = JSON.parse(row.results); } catch { row.results = []; }
  } else {
    row.results = [];
  }
  return parseLeanJson(row);
}

/**
 * Get non-deleted runs for a specific project, sorted by startedAt descending.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM runs WHERE projectId = ? AND deletedAt IS NULL ORDER BY startedAt DESC"
  ).all(projectId).map(rowToRun);
}

/**
 * Count non-deleted runs for a set of project IDs.
 * @param {string[]} projectIds
 * @returns {number}
 */
export function countByProjectIds(projectIds) {
  if (!projectIds || projectIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = projectIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT COUNT(*) as cnt FROM runs WHERE projectId IN (${placeholders}) AND deletedAt IS NULL`
  ).get(...projectIds).cnt;
}

/**
 * Get non-deleted runs for a project with lean columns, paginated.
 * @param {string}        projectId
 * @param {number|string} [page=1]
 * @param {number|string} [pageSize=DEFAULT_PAGE_SIZE]
 * @returns {{ data: Object[], meta: { total: number, page: number, pageSize: number, hasMore: boolean } }}
 */
export function getByProjectIdPaged(projectId, page, pageSize) {
  const db = getDatabase();
  const { page: p, pageSize: ps, offset } = parsePagination(page, pageSize);
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM runs WHERE projectId = ? AND deletedAt IS NULL"
  ).get(projectId).cnt;
  const data = db.prepare(
    `SELECT ${LEAN_WITH_FEEDBACK_COLS} FROM runs WHERE projectId = ? AND deletedAt IS NULL ORDER BY startedAt DESC LIMIT ? OFFSET ?`
  ).all(projectId, ps, offset).map(parseLeanJson);
  return { data, meta: { total, page: p, pageSize: ps, hasMore: offset + data.length < total } };
}

/**
 * Get a non-deleted run by ID.
 * Hydrates `run.logs` from the `run_logs` table (ENH-008).
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getById(id) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM runs WHERE id = ? AND deletedAt IS NULL").get(id);
  if (!row) return undefined;
  const run = rowToRun(row);
  // Hydrate logs from run_logs table (ENH-008).  Fall back to the legacy
  // runs.logs JSON column for runs created before migration 002 that still
  // have their log history stored inline.
  const newLogs = runLogRepo.getMessagesByRunId(id);
  if (newLogs.length > 0) {
    run.logs = newLogs;
  } else if (row.logs) {
    try { run.logs = JSON.parse(row.logs); } catch { /* keep [] from rowToRun */ }
  }
  return run;
}

/**
 * Get a run by ID including soft-deleted (for restore and abort operations).
 * Hydrates `run.logs` from the `run_logs` table (ENH-008).
 * @param {string} id
 * @returns {Object|undefined}
 */
export function getByIdIncludeDeleted(id) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!row) return undefined;
  const run = rowToRun(row);
  // Same legacy fallback as getById — see comment above.
  const newLogs = runLogRepo.getMessagesByRunId(id);
  if (newLogs.length > 0) {
    run.logs = newLogs;
  } else if (row.logs) {
    try { run.logs = JSON.parse(row.logs); } catch { /* keep [] from rowToRun */ }
  }
  return run;
}

// ─── Write operations ─────────────────────────────────────────────────────────

/**
 * Create a run.
 * Note: `run.logs` is intentionally not written to `runs.logs` — log lines
 * are persisted via {@link runLogRepo.appendLog} in runLogger.js (ENH-008).
 * @param {Object} run
 */
export function create(run) {
  const db = getDatabase();
  const row = runToRow(run);
  const params = {};
  for (const col of INSERT_COLS) {
    params[col] = row[col] !== undefined ? row[col] : null;
  }
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
 * (e.g. snapshots, pages, testsGenerated). These are filtered out so
 * the generated SQL only references actual table columns.
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
 * Find an active (non-deleted, non-finished) run for a project.
 * @param {string}   projectId
 * @param {string[]} [types] — Run types to check (default: crawl, test_run, generate).
 * @returns {Object|undefined}
 */
export function findActiveByProjectId(projectId, types) {
  const db = getDatabase();
  const typeList = types || ["crawl", "test_run", "generate"];
  const placeholders = typeList.map(() => "?").join(", ");
  return rowToRun(
    db.prepare(
      `SELECT * FROM runs WHERE projectId = ? AND status = 'running' AND type IN (${placeholders}) AND deletedAt IS NULL LIMIT 1`
    ).get(projectId, ...typeList)
  );
}

/**
 * Soft-delete all runs for a project.
 * @param {string} projectId
 * @returns {string[]} IDs of newly soft-deleted runs.
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare(
    "SELECT id FROM runs WHERE projectId = ? AND deletedAt IS NULL"
  ).all(projectId).map(r => r.id);
  if (ids.length > 0) {
    db.prepare(
      "UPDATE runs SET deletedAt = datetime('now') WHERE projectId = ? AND deletedAt IS NULL"
    ).run(projectId);
  }
  return ids;
}

/**
 * Hard-delete all runs for a project (permanent — for project purge).
 * Also purges all associated log rows from `run_logs`.
 * @param {string} projectId
 * @returns {string[]} IDs of all deleted runs.
 */
export function hardDeleteByProjectId(projectId) {
  const db = getDatabase();
  const ids = db.prepare("SELECT id FROM runs WHERE projectId = ?").all(projectId).map(r => r.id);
  if (ids.length > 0) {
    runLogRepo.deleteByRunIds(ids);
    db.prepare("DELETE FROM runs WHERE projectId = ?").run(projectId);
  }
  return ids;
}

/**
 * Find the most recent non-deleted run result for a specific test ID.
 *
 * Uses a LIKE pre-filter on the JSON results column to narrow down candidate
 * rows, then parses and searches in JS. Only selects id, startedAt, results
 * to avoid deserializing heavy columns.
 *
 * @param {string} testId — e.g. "TC-1"
 * @returns {Object|null} The matching result object with `runId`, or null.
 */
export function findLatestResultForTest(testId) {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, startedAt, results FROM runs
     WHERE results LIKE ? AND results != '[]' AND deletedAt IS NULL
     ORDER BY startedAt DESC LIMIT 20`
  ).all(`%${testId}%`);

  for (const row of rows) {
    try {
      const results = JSON.parse(row.results);
      const match = results.find(r => r.testId === testId);
      if (match) return { ...match, runId: row.id };
    } catch { /* skip malformed JSON */ }
  }
  return null;
}

/**
 * Mark all "running" non-deleted runs as "interrupted" (orphan recovery on startup).
 * @returns {number} Number of runs marked.
 */
export function markOrphansInterrupted() {
  const db = getDatabase();
  const now = new Date().toISOString();
  const info = db.prepare(
    `UPDATE runs SET status = 'interrupted', finishedAt = COALESCE(finishedAt, ?),
     error = 'Server restarted while run was in progress'
     WHERE status = 'running' AND deletedAt IS NULL`
  ).run(now);
  return info.changes;
}

// ─── Recycle bin ─────────────────────────────────────────────────────────────

/**
 * Get soft-deleted runs for a project.
 * @param {string} projectId
 * @returns {Object[]}
 */
export function getDeletedByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare(
    `SELECT ${LEAN_WITH_FEEDBACK_COLS}, deletedAt FROM runs WHERE projectId = ? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC`
  ).all(projectId).map(parseLeanJson);
}

/**
 * Get all soft-deleted runs.
 * @returns {Object[]}
 */
export function getDeletedAll() {
  const db = getDatabase();
  return db.prepare(
    `SELECT ${LEAN_WITH_FEEDBACK_COLS}, deletedAt FROM runs WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC`
  ).all().map(parseLeanJson);
}

/**
 * Hard-delete a run by ID (permanent — use only for purge operations).
 * Also purges all associated log rows from `run_logs`.
 * @param {string} id
 */
export function hardDeleteById(id) {
  const db = getDatabase();
  runLogRepo.deleteByRunId(id);
  db.prepare("DELETE FROM runs WHERE id = ?").run(id);
}

/**
 * Restore a soft-deleted run (clears deletedAt).
 * @param {string} id
 * @returns {boolean} Whether the run was found and restored.
 */
export function restore(id) {
  const db = getDatabase();
  const info = db.prepare("UPDATE runs SET deletedAt = NULL WHERE id = ? AND deletedAt IS NOT NULL").run(id);
  return info.changes > 0;
}

/**
 * Restore soft-deleted runs for a project that were deleted at or after a
 * given timestamp. Used by project cascade-restore to avoid restoring items
 * that were individually deleted before the project.
 * @param {string} projectId
 * @param {string} deletedAfter — ISO timestamp (inclusive lower bound).
 * @returns {number} Number of runs restored.
 */
export function restoreByProjectIdAfter(projectId, deletedAfter) {
  const db = getDatabase();
  const info = db.prepare(
    "UPDATE runs SET deletedAt = NULL WHERE projectId = ? AND deletedAt IS NOT NULL AND deletedAt >= ?"
  ).run(projectId, deletedAfter);
  return info.changes;
}
