/**
 * @module database/repositories/auditDlqRepo
 * @description SEC-007 audit-log SIEM dead-letter queue.
 *
 * When the SIEM forwarder (see `utils/notifications.js` SIEM target) fails
 * to deliver an audit event after its retry budget is exhausted, the row's
 * snapshot is dropped into the `audit_dlq` table so an operator can inspect
 * and manually replay it later. The schema is defined by migration 031.
 *
 * ### Schema (migration `031_activities_compliance.sql`)
 * | Column       | Type    | Notes                                       |
 * |--------------|---------|---------------------------------------------|
 * | id           | TEXT PK | Short opaque ID, `DLQ-<n>` (see below).     |
 * | workspaceId  | TEXT    | Owning workspace (used for the admin scope).|
 * | rowSnapshot  | TEXT    | JSON-stringified activity row.              |
 * | lastError    | TEXT    | Most recent dispatch error message.         |
 * | attempts     | INTEGER | Count of dispatch attempts (incl. retries). |
 * | createdAt    | TEXT    | ISO timestamp of the first failure.         |
 *
 * ### ID convention
 * The `audit_dlq.id` column is `TEXT PRIMARY KEY`, so any unique opaque
 * string works. We use `DLQ-<n>` (counter via `counterRepo`) to match the
 * project-wide short-ID convention (`TC-`, `RUN-`, `ACT-`, …) — readable in
 * admin UI lists without exposing internal UUIDs.
 */

import { getDatabase } from "../sqlite.js";
import * as counterRepo from "./counterRepo.js";

/**
 * Generate the next DLQ row ID. Kept local to this module — the project
 * `idGenerator.js` module groups its exports by feature area and we don't
 * yet have other DLQ counters that warrant a shared helper.
 *
 * @returns {string} e.g. `"DLQ-42"`.
 * @private
 */
function nextId() {
  return `DLQ-${counterRepo.next("audit_dlq")}`;
}

/**
 * Insert a fresh DLQ row for an activity that could not be delivered to the
 * configured SIEM target after exhausting the retry budget.
 *
 * Always starts at `attempts = 1` — the initial delivery attempt counts as
 * the first attempt. The forwarder is expected to retry in-process up to
 * its configured budget before calling this; subsequent UI-triggered
 * `/replay` invocations increment via `incrementAttempts()`.
 *
 * @param {Object} entry
 * @param {string} entry.workspaceId - Owning workspace; the admin replay
 *   route gates by this so DLQ rows from workspace A can never be replayed
 *   by an admin of workspace B.
 * @param {Object} entry.rowSnapshot - The full activity row that failed to
 *   dispatch. Stored as a JSON string; readers re-parse via `hydrate()`.
 * @param {string} entry.lastError - Most recent dispatch error message.
 * @returns {Object} The created DLQ row (hydrated — `rowSnapshot` is an
 *   object, not a JSON string).
 */
export function enqueue({ workspaceId, rowSnapshot, lastError }) {
  const db = getDatabase();
  const id = nextId();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_dlq (id, workspaceId, rowSnapshot, lastError, attempts, createdAt)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(id, workspaceId, JSON.stringify(rowSnapshot ?? null), String(lastError ?? ""), createdAt);
  return { id, workspaceId, rowSnapshot, lastError, attempts: 1, createdAt };
}

/**
 * Re-parse the JSON `rowSnapshot` column into a plain object. Tolerant of
 * malformed historical rows — those surface as `rowSnapshot: null` rather
 * than throwing into the route handler. Matches the `hydrate` pattern in
 * `activityRepo.js`.
 *
 * @param {Object} row
 * @returns {Object}
 * @private
 */
function hydrate(row) {
  if (!row) return row;
  if (typeof row.rowSnapshot === "string" && row.rowSnapshot.length > 0) {
    try { row.rowSnapshot = JSON.parse(row.rowSnapshot); } catch { row.rowSnapshot = null; }
  } else if (row.rowSnapshot === undefined) {
    row.rowSnapshot = null;
  }
  return row;
}

/**
 * List DLQ rows for a workspace, newest-first. Caller (route handler) is
 * responsible for the admin gate and workspace-scope assertion.
 *
 * @param {string} workspaceId
 * @param {Object} [opts]
 * @param {number} [opts.limit=200] - Hard-capped at 1000 defensively.
 * @returns {Object[]}
 */
export function listByWorkspace(workspaceId, { limit = 200 } = {}) {
  const db = getDatabase();
  const cap = Math.max(1, Math.min(1000, Number.isFinite(limit) ? limit : 200));
  return db.prepare(
    "SELECT * FROM audit_dlq WHERE workspaceId = ? ORDER BY createdAt DESC, id DESC LIMIT ?",
  ).all(workspaceId, cap).map(hydrate);
}

/**
 * Fetch a single DLQ row by ID. Returns null when missing. Callers must
 * still cross-check `row.workspaceId === req.workspaceId` before acting on
 * it — the route layer is the trust boundary for cross-workspace access.
 *
 * @param {string} id
 * @returns {Object|null}
 */
export function getById(id) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM audit_dlq WHERE id = ?").get(id);
  return row ? hydrate(row) : null;
}

/**
 * Increment the attempt counter and record the most recent error after a
 * failed replay. Returns the new attempts count, or 0 if the row no longer
 * exists (e.g. another admin removed it concurrently).
 *
 * @param {string} id
 * @param {string} lastError
 * @returns {number}
 */
export function incrementAttempts(id, lastError) {
  const db = getDatabase();
  const info = db.prepare(
    "UPDATE audit_dlq SET attempts = attempts + 1, lastError = ? WHERE id = ?",
  ).run(String(lastError ?? ""), id);
  if (info.changes === 0) return 0;
  const row = db.prepare("SELECT attempts FROM audit_dlq WHERE id = ?").get(id);
  return row?.attempts ?? 0;
}

/**
 * Delete a DLQ row after a successful replay. Returns true when a row was
 * removed, false when none matched (idempotent for the caller).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function remove(id) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM audit_dlq WHERE id = ?").run(id);
  return info.changes > 0;
}

/**
 * Count of DLQ rows for a workspace — used by the AuditLog UI to render the
 * "N retry-failed" badge without loading the full list.
 *
 * @param {string} workspaceId
 * @returns {number}
 */
export function countByWorkspace(workspaceId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT COUNT(*) AS cnt FROM audit_dlq WHERE workspaceId = ?",
  ).get(workspaceId)?.cnt || 0;
}
