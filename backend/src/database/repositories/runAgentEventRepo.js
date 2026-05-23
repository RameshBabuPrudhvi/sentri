/**
 * @module database/repositories/runAgentEventRepo
 * @description Data-access layer for the `run_agent_events` table
 * (Task 2 — per-agent SSE events).
 *
 * Mirrors `runLogRepo.js` exactly: append-only writes via {@link append},
 * ordered hydration via {@link getByRunId}, hard-purge via
 * {@link deleteByRunId} / {@link deleteByRunIds}. Rows are returned in
 * insertion order via the secondary `(runId, createdAt)` index from
 * migration 057.
 *
 * ### Schema
 * ```
 * run_agent_events(
 *   id AUTOINCREMENT, runId TEXT, step INT, agent TEXT,
 *   phase TEXT CHECK (start|progress|finding|handoff|done),
 *   message TEXT, data TEXT, nextAgent TEXT, model TEXT, createdAt TEXT
 * )
 * ```
 *
 * ### Typical flow
 * ```js
 * // In agentEventEmitter.js (called per LLM call site):
 * append(run.id, { step: 4, agent: "author", phase: "start",
 *                  message: "Writing test", model: "claude-sonnet-4",
 *                  createdAt: new Date().toISOString() });
 *
 * // In SSE route (initial snapshot) + runRepo.getById hydration:
 * const events = getByRunId(runId); // ordered ASC by createdAt
 * ```
 *
 * ### Exports
 * - {@link append}          — insert one event row
 * - {@link getByRunId}      — fetch all rows for a run, ordered by createdAt
 * - {@link deleteByRunId}   — hard-delete all events for a run (purge path)
 * - {@link deleteByRunIds}  — batch hard-delete for project purge
 * - {@link countByRunId}    — row count for a run (used in tests)
 */

import { getDatabase } from "../sqlite.js";

/**
 * @typedef {Object} RunAgentEventRow
 * @property {number}      id        - Auto-increment primary key
 * @property {string}      runId     - Foreign key → runs.id
 * @property {number}      step      - Pipeline step 1–8
 * @property {string}      agent     - AGENT_ROLES value (explorer | planner | …)
 * @property {string}      phase     - start | progress | finding | handoff | done
 * @property {string|null} message   - Human-readable line (may be null)
 * @property {string|null} data      - JSON-stringified structured payload (may be null)
 * @property {string|null} nextAgent - Handoff target (set on phase='handoff')
 * @property {string|null} model     - Model identifier for attribution badges
 * @property {string}      createdAt - ISO 8601 timestamp
 */

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Append a single agent-event row.
 *
 * Hot path — called from every `emitAgentEvent`. Executes a single `INSERT`
 * and returns immediately. The caller is responsible for shaping `event`;
 * the emitter (`aiProvider/agentEventEmitter.js`) is the canonical writer
 * and serialises `data` to JSON before passing it through.
 *
 * @param {string} runId
 * @param {Object} event
 * @param {number}      event.step
 * @param {string}      event.agent
 * @param {string}      event.phase
 * @param {string|null} [event.message]
 * @param {string|null} [event.data]      - JSON-stringified by caller
 * @param {string|null} [event.nextAgent]
 * @param {string|null} [event.model]
 * @param {string}      event.createdAt   - ISO 8601 string
 * @returns {void}
 */
export function append(runId, event) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO run_agent_events
       (runId, step, agent, phase, message, data, nextAgent, model, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    event.step,
    event.agent,
    event.phase,
    event.message ?? null,
    // `data` is JSON-stringified by the emitter so the column is TEXT-only.
    // Defence-in-depth: if a future caller passes a plain object, serialise
    // here rather than letting better-sqlite3 reject the row at bind time.
    event.data == null
      ? null
      : (typeof event.data === "string" ? event.data : JSON.stringify(event.data)),
    event.nextAgent ?? null,
    event.model ?? null,
    event.createdAt,
  );
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all event rows for a run, ordered by `createdAt` ascending so a
 * replaying client receives them in the same order they were emitted.
 *
 * `data` is returned as the raw JSON string — the consumer (SSE snapshot
 * builder + `runRepo.getById` hydration) parses on demand so this repo
 * stays a thin data-access layer.
 *
 * @param {string} runId
 * @returns {RunAgentEventRow[]}
 */
export function getByRunId(runId) {
  const db = getDatabase();
  return db.prepare(
    `SELECT id, runId, step, agent, phase, message, data, nextAgent, model, createdAt
       FROM run_agent_events
      WHERE runId = ?
      ORDER BY createdAt ASC, id ASC`
  ).all(runId);
}

// ─── Delete / maintenance ─────────────────────────────────────────────────────

/**
 * Hard-delete all event rows for a run. Called when a run is permanently
 * purged (recycle-bin purge / `runRepo.hardDeleteById`).
 *
 * @param {string} runId
 * @returns {number} Number of rows deleted.
 */
export function deleteByRunId(runId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM run_agent_events WHERE runId = ?").run(runId);
  return info.changes;
}

/**
 * Hard-delete all event rows for multiple runs (batch purge — called when
 * a project is purged and all its runs are hard-deleted via
 * `runRepo.hardDeleteByProjectId`).
 *
 * @param {string[]} runIds
 * @returns {number} Total rows deleted.
 */
export function deleteByRunIds(runIds) {
  if (!runIds.length) return 0;
  const db = getDatabase();
  const placeholders = runIds.map(() => "?").join(", ");
  const info = db.prepare(
    `DELETE FROM run_agent_events WHERE runId IN (${placeholders})`
  ).run(...runIds);
  return info.changes;
}

/**
 * Count event rows for a run. Primarily used in tests to verify write
 * behaviour.
 *
 * @param {string} runId
 * @returns {number}
 */
export function countByRunId(runId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT COUNT(*) AS cnt FROM run_agent_events WHERE runId = ?"
  ).get(runId).cnt;
}
