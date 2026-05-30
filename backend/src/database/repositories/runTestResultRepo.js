/**
 * @module database/repositories/runTestResultRepo
 * @description Data-access layer for the `run_test_results` table (B1.1).
 *
 * Replaces the in-memory `run.results[]` accumulation pattern in
 * `testRunner.js`. Each completed test writes one row immediately so a
 * SIGKILL / OOM / container kill mid-run preserves every result
 * collected up to that point.
 *
 * Mirrors {@link module:database/repositories/runLogRepo} in shape and
 * conventions — append-only, single-INSERT hot path, batch delete on
 * purge, reconstruct full array via {@link getByRunId} on read.
 *
 * ### Typical flow
 * ```js
 * // In testRunner.js processResult, called per test `finally`:
 * append(run.id, result);
 *
 * // In runRepo.getById to reconstruct run.results[]:
 * const results = getByRunId(runId);
 *
 * // In POST /runs/:id/resume:
 * const done = new Set(getCompletedTestIds(runId));
 * const todo = run.tests.filter(t => !done.has(t.id));
 * ```
 *
 * ### Exports
 * - {@link append}                — insert one test-result row
 * - {@link getByRunId}            — fetch all rows for a run
 * - {@link getCompletedTestIds}   — return Set of testIds with any row
 * - {@link deleteByRunId}         — hard-delete on purge
 * - {@link deleteByRunIds}        — batch hard-delete
 * - {@link countByRunId}          — used in tests
 */

import { getDatabase } from "../sqlite.js";
import { generateRunTestResultId } from "../../utils/idGenerator.js";
import { runTestResultDuplicatesTotal } from "../../utils/metrics.js";
import { formatLogLine } from "../../utils/logFormatter.js";

/**
 * @typedef {Object} RunTestResultRow
 * @property {string}  id              - Primary key (generated)
 * @property {string}  runId           - Foreign key → runs.id
 * @property {string}  testId          - Foreign key → tests.id
 * @property {string}  status          - 'passed' | 'failed' | 'skipped' | 'warning'
 * @property {string|null} error
 * @property {string|null} errorCategory
 * @property {number|null} duration
 * @property {number}  retryCount
 * @property {Object|null}  artifacts     - JSON-parsed
 * @property {Array|null}   healingEvents - JSON-parsed
 * @property {number|null}  iterationIndex - null for non-data-driven tests
 * @property {string}  createdAt
 */

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Append a single test-result row to `run_test_results`.
 *
 * Called from `testRunner.js#processResult` in the per-test `finally` so
 * the result is durable before the next test starts. Safe to call
 * concurrently from parallel workers — SQLite serialises via WAL and the
 * UNIQUE(runId, testId, iterationIndex) constraint prevents duplicate
 * writes when a worker is restarted mid-flight.
 *
 * ### Conflict handling
 *
 * Uses `INSERT OR IGNORE` for idempotency, but bumps the
 * `app_run_test_result_duplicates_total{reason}` counter on every
 * conflict so silent drops are observable. Industry-standard
 * (Splunk / Datadog / Auth0) convention is to log every dedup decision,
 * never swallow it — operators must be able to distinguish "the resume
 * path correctly replayed" from "we have a write-amplification bug".
 *
 * The caller passes `opts.reason` so the counter label is honest:
 *   • `"resume_replay"`     — `POST /runs/:id/resume` is re-enqueuing.
 *   • `"runner"` (default)  — normal per-test flush from `testRunner.js`.
 *
 * A conflict with `reason='runner'` records `duplicate_dispatch` on the
 * counter (unexpected). A conflict with `reason='resume_replay'`
 * records `resume_replay` (expected).
 *
 * @param {string} runId
 * @param {Object} result  — shape produced by `executeTest.js`
 * @param {Object} [opts]
 * @param {"runner"|"resume_replay"} [opts.reason="runner"]
 * @returns {{ inserted: boolean, reason: string }} `inserted: false` when the
 *   UNIQUE constraint kicked in; counter is bumped before returning.
 */
export function append(runId, result, opts = {}) {
  if (!runId || !result || !result.testId) return { inserted: false, reason: "invalid_input" };
  const callerReason = opts.reason === "resume_replay" ? "resume_replay" : "runner";
  const db = getDatabase();
  const id = generateRunTestResultId();
  const createdAt = new Date().toISOString();
  // iterationIndex is part of the UNIQUE key; SQLite treats NULL as
  // distinct in unique constraints, so coerce non-data-driven tests
  // (iterationIndex undefined) to 0 to keep "one row per testId" honest.
  const iterationIndex = Number.isInteger(result.iterationIndex)
    ? result.iterationIndex
    : 0;
  // INSERT OR IGNORE keeps the write idempotent, but `info.changes === 0`
  // tells us the UNIQUE constraint kicked in so we can attribute the
  // duplicate to its source via the counter.
  const info = db.prepare(
    `INSERT OR IGNORE INTO run_test_results
       (id, runId, testId, status, error, errorCategory, duration,
        retryCount, artifacts, healingEvents, iterationIndex, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    runId,
    result.testId,
    result.status || "failed",
    result.error || null,
    result.errorCategory || null,
    Number.isFinite(result.duration) ? result.duration : null,
    Number.isInteger(result.retryCount) ? result.retryCount : 0,
    result.artifacts ? JSON.stringify(result.artifacts) : null,
    result.healingEvents ? JSON.stringify(result.healingEvents) : null,
    iterationIndex,
    createdAt,
  );
  if (info.changes === 0) {
    // The label distinguishes "expected (resume)" from "unexpected
    // (double-dispatch bug)". Best-effort metric increment — a metric
    // hiccup must never fail an audit-row write.
    const metricLabel = callerReason === "resume_replay" ? "resume_replay" : "duplicate_dispatch";
    try { runTestResultDuplicatesTotal.inc({ reason: metricLabel }); } catch { /* best-effort */ }
    if (metricLabel === "duplicate_dispatch") {
      // Loud warn so the structured log surfaces what the counter
      // alert points to. `runId` + `testId` + `iterationIndex` is the
      // exact tuple the dispatcher must investigate.
      console.warn(formatLogLine(
        "warn",
        runId,
        `[run_test_results] duplicate write rejected (runId=${runId} testId=${result.testId} iter=${iterationIndex}) — investigate runner dispatch`,
      ));
    }
    return { inserted: false, reason: metricLabel };
  }
  return { inserted: true, reason: callerReason };
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all test-result rows for a run, ordered by createdAt ascending.
 * JSON columns (`artifacts`, `healingEvents`) are parsed.
 *
 * Used by `runRepo.getById` to rehydrate `run.results[]`.
 *
 * @param {string} runId
 * @returns {RunTestResultRow[]}
 */
export function getByRunId(runId) {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, runId, testId, status, error, errorCategory, duration,
            retryCount, artifacts, healingEvents, iterationIndex, createdAt
     FROM run_test_results
     WHERE runId = ?
     ORDER BY createdAt ASC, id ASC`
  ).all(runId);
  for (const r of rows) {
    if (r.artifacts) {
      try { r.artifacts = JSON.parse(r.artifacts); } catch { r.artifacts = null; }
    }
    if (r.healingEvents) {
      try { r.healingEvents = JSON.parse(r.healingEvents); } catch { r.healingEvents = null; }
    }
  }
  return rows;
}

/**
 * Return the set of testIds that already have at least one result row
 * for this run. Used by `POST /runs/:id/resume` to skip already-executed
 * tests when re-enqueuing the dispatch queue after a crash.
 *
 * @param {string} runId
 * @returns {Set<string>}
 */
export function getCompletedTestIds(runId) {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT DISTINCT testId FROM run_test_results WHERE runId = ?"
  ).all(runId);
  return new Set(rows.map((r) => r.testId));
}

/**
 * Timestamp of the most recent result write for a run, or null if none.
 * Used by the stale-run cleanup on server startup to decide whether a
 * `status = 'running'` row should be transitioned to
 * `status = 'failed', failureReason = 'process_crash'`.
 *
 * @param {string} runId
 * @returns {string|null} ISO 8601 timestamp
 */
export function getLastResultAt(runId) {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT MAX(createdAt) AS lastAt FROM run_test_results WHERE runId = ?"
  ).get(runId);
  return row?.lastAt || null;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Hard-delete all rows for a run (recycle-bin purge path).
 *
 * @param {string} runId
 * @returns {number} rows deleted
 */
export function deleteByRunId(runId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM run_test_results WHERE runId = ?").run(runId);
  return info.changes;
}

/**
 * Batch hard-delete (used when a project is purged).
 *
 * @param {string[]} runIds
 * @returns {number} rows deleted
 */
export function deleteByRunIds(runIds) {
  if (!runIds.length) return 0;
  const db = getDatabase();
  const placeholders = runIds.map(() => "?").join(", ");
  const info = db.prepare(
    `DELETE FROM run_test_results WHERE runId IN (${placeholders})`
  ).run(...runIds);
  return info.changes;
}

/**
 * Count rows for a run. Test-only helper.
 *
 * @param {string} runId
 * @returns {number}
 */
export function countByRunId(runId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT COUNT(*) AS cnt FROM run_test_results WHERE runId = ?"
  ).get(runId).cnt;
}
