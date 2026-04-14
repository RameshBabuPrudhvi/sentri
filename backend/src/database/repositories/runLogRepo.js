/**
 * @module database/repositories/runLogRepo
 * @description Data-access layer for the `run_logs` table (ENH-008).
 *
 * Replaces the O(n²) JSON mutation pattern on `runs.logs`:
 *   - Every log line is stored as an independent row.
 *   - Writers call {@link appendLog} — a single `INSERT`.
 *   - Readers call {@link getByRunId} to retrieve all lines in order.
 *
 * ### Schema
 * ```
 * run_logs(id AUTOINCREMENT, runId TEXT, seq INT, level TEXT, message TEXT, createdAt TEXT)
 * ```
 *
 * ### Typical flow
 * ```js
 * // In runLogger.js (called for every log() invocation):
 * appendLog(run.id, 'info', '[12:34:56] Starting crawl…');
 *
 * // In SSE route (initial snapshot):
 * const logs = getByRunId(runId).map(r => r.message);
 * ```
 *
 * ### Exports
 * - {@link appendLog}   — insert one log row
 * - {@link getByRunId}  — fetch all rows for a run, ordered by seq
 * - {@link deleteByRunId} — hard-delete all logs for a run (purge path)
 * - {@link countByRunId}  — row count for a run (used in tests)
 */

import { getDatabase } from "../sqlite.js";

// ─── Sequence counter cache ───────────────────────────────────────────────────
// Each run has a monotonic seq counter so readers always get a stable order
// even if two writers race (unlikely — runs are single-threaded per pipeline
// but this makes the contract explicit).
//
// The cache is populated lazily from the DB on the first write for a run and
// then incremented in-process.  On server restart the DB is the source of truth.

/** @type {Map<string, number>} runId → next seq value */
const _seqCache = new Map();

/**
 * Return the next sequence number for `runId` and advance the cache.
 * Falls back to a DB MAX query on first access so restarts are safe.
 *
 * @param {Object} db    — better-sqlite3 Database instance
 * @param {string} runId
 * @returns {number}
 */
function nextSeq(db, runId) {
  if (!_seqCache.has(runId)) {
    const row = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_logs WHERE runId = ?"
    ).get(runId);
    _seqCache.set(runId, (row?.maxSeq ?? 0) + 1);
  }
  const seq = _seqCache.get(runId);
  _seqCache.set(runId, seq + 1);
  return seq;
}

/**
 * @typedef {Object} RunLogRow
 * @property {number} id        - Auto-increment primary key
 * @property {string} runId     - Foreign key → runs.id
 * @property {number} seq       - 1-based sequence number within the run
 * @property {string} level     - 'info' | 'warn' | 'error'
 * @property {string} message   - Formatted log line (e.g. "[12:34:56] msg")
 * @property {string} createdAt - ISO 8601 timestamp
 */

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Append a single log line to the `run_logs` table.
 *
 * This is the hot path — called on every `log()` invocation.  It executes
 * a single `INSERT` and returns immediately.
 *
 * @param {string} runId   - The run this log line belongs to
 * @param {string} level   - 'info' | 'warn' | 'error'
 * @param {string} message - Pre-formatted log string (includes timestamp prefix)
 * @returns {void}
 */
export function appendLog(runId, level, message) {
  const db = getDatabase();
  const seq = nextSeq(db, runId);
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO run_logs (runId, seq, level, message, createdAt) VALUES (?, ?, ?, ?, ?)"
  ).run(runId, seq, level, message, createdAt);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all log rows for a run, ordered by seq ascending.
 *
 * Returns the full row objects so callers can access `level` for filtering
 * if needed.  For plain string arrays (legacy API compat) use
 * `getByRunId(id).map(r => r.message)`.
 *
 * @param {string} runId
 * @returns {RunLogRow[]}
 */
export function getByRunId(runId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT id, runId, seq, level, message, createdAt FROM run_logs WHERE runId = ? ORDER BY seq ASC"
  ).all(runId);
}

/**
 * Fetch log messages (strings only) for a run, ordered by seq ascending.
 * Convenience wrapper over {@link getByRunId} for callers that only need
 * the message strings (e.g. the SSE snapshot and the run-detail REST endpoint).
 *
 * @param {string} runId
 * @returns {string[]}
 */
export function getMessagesByRunId(runId) {
  return getByRunId(runId).map((r) => r.message);
}

// ─── Delete / maintenance ─────────────────────────────────────────────────────

/**
 * Hard-delete all log rows for a run.
 * Called when a run is permanently purged (recycle-bin purge path).
 *
 * @param {string} runId
 * @returns {number} Number of rows deleted.
 */
export function deleteByRunId(runId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM run_logs WHERE runId = ?").run(runId);
  _seqCache.delete(runId);
  return info.changes;
}

/**
 * Hard-delete all log rows for multiple runs (batch purge).
 * Used when a project is purged and all its runs are hard-deleted.
 *
 * @param {string[]} runIds
 * @returns {number} Total rows deleted.
 */
export function deleteByRunIds(runIds) {
  if (!runIds.length) return 0;
  const db = getDatabase();
  const placeholders = runIds.map(() => "?").join(", ");
  const info = db.prepare(
    `DELETE FROM run_logs WHERE runId IN (${placeholders})`
  ).run(...runIds);
  for (const id of runIds) _seqCache.delete(id);
  return info.changes;
}

/**
 * Count log rows for a run.
 * Primarily used in tests to verify write behaviour.
 *
 * @param {string} runId
 * @returns {number}
 */
export function countByRunId(runId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT COUNT(*) AS cnt FROM run_logs WHERE runId = ?"
  ).get(runId).cnt;
}
