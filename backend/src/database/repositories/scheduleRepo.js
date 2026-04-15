/**
 * @module database/repositories/scheduleRepo
 * @description Data access layer for project test schedules (ENH-006).
 *
 * One schedule row per project (enforced by UNIQUE constraint on projectId).
 * The scheduler process reads this table on startup and after every mutation
 * to hot-reload cron jobs without a process restart.
 *
 * ### Exports
 * - {@link getByProjectId} — Get schedule for a project (or undefined).
 * - {@link getAllEnabled}  — Get all enabled schedules (used at startup).
 * - {@link upsert}        — Create or fully replace a project's schedule.
 * - {@link setEnabled}    — Toggle enabled/disabled without clearing config.
 * - {@link updateRunTimes} — Record lastRunAt and nextRunAt after a fire.
 * - {@link deleteByProjectId} — Hard-delete (called on project delete/purge).
 */

import { getDatabase } from "../sqlite.js";

// ─── Row ↔ Object helpers ─────────────────────────────────────────────────────

/**
 * @typedef {Object} Schedule
 * @property {string}       id          - e.g. "SCH-1"
 * @property {string}       projectId
 * @property {string}       cronExpr    - 5-field cron expression
 * @property {string}       timezone    - IANA timezone name
 * @property {boolean}      enabled
 * @property {string|null}  lastRunAt   - ISO 8601 or null
 * @property {string|null}  nextRunAt   - ISO 8601 or null
 * @property {string}       createdAt   - ISO 8601
 * @property {string}       updatedAt   - ISO 8601
 */

/**
 * Convert a SQLite row to a Schedule object.
 * @param {Object|undefined} row
 * @returns {Schedule|undefined}
 */
function rowToSchedule(row) {
  if (!row) return undefined;
  return {
    ...row,
    enabled: row.enabled === 1 || row.enabled === true,
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get the schedule for a project.
 *
 * @param {string} projectId
 * @returns {Schedule|undefined}
 */
export function getByProjectId(projectId) {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM schedules WHERE projectId = ?")
    .get(projectId);
  return rowToSchedule(row);
}

/**
 * Get all enabled schedules.  Called by the scheduler on startup to
 * restore all active cron jobs.
 *
 * @returns {Schedule[]}
 */
export function getAllEnabled() {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM schedules WHERE enabled = 1")
    .all()
    .map(rowToSchedule);
}

/**
 * Get all schedules (enabled and disabled).  Used by admin views.
 *
 * @returns {Schedule[]}
 */
export function getAll() {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM schedules ORDER BY createdAt DESC")
    .all()
    .map(rowToSchedule);
}

/**
 * Create or fully replace a project's schedule.
 * Uses INSERT OR REPLACE so the caller does not need to know whether a
 * schedule already exists — the projectId UNIQUE constraint handles dedup.
 *
 * @param {Schedule} schedule
 * @returns {Schedule}
 */
export function upsert(schedule) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO schedules (id, projectId, cronExpr, timezone, enabled, lastRunAt, nextRunAt, createdAt, updatedAt)
    VALUES (@id, @projectId, @cronExpr, @timezone, @enabled, @lastRunAt, @nextRunAt, @createdAt, @updatedAt)
    ON CONFLICT(projectId) DO UPDATE SET
      cronExpr  = excluded.cronExpr,
      timezone  = excluded.timezone,
      enabled   = excluded.enabled,
      nextRunAt = excluded.nextRunAt,
      updatedAt = excluded.updatedAt
  `).run({
    ...schedule,
    enabled: schedule.enabled ? 1 : 0,
  });
  return getByProjectId(schedule.projectId);
}

/**
 * Toggle a schedule's enabled state without changing its cron expression.
 *
 * @param {string}  projectId
 * @param {boolean} enabled
 * @returns {Schedule|undefined} Updated schedule, or undefined if not found.
 */
export function setEnabled(projectId, enabled) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const changes = db
    .prepare("UPDATE schedules SET enabled = ?, updatedAt = ? WHERE projectId = ?")
    .run(enabled ? 1 : 0, now, projectId)
    .changes;
  if (changes === 0) return undefined;
  return getByProjectId(projectId);
}

/**
 * Record lastRunAt and nextRunAt after a scheduled run fires.
 *
 * @param {string}      projectId
 * @param {string}      lastRunAt  - ISO 8601
 * @param {string|null} nextRunAt  - ISO 8601 or null
 */
export function updateRunTimes(projectId, lastRunAt, nextRunAt) {
  const db = getDatabase();
  db.prepare(`
    UPDATE schedules
    SET lastRunAt = ?, nextRunAt = ?, updatedAt = ?
    WHERE projectId = ?
  `).run(lastRunAt, nextRunAt, new Date().toISOString(), projectId);
}

/**
 * Hard-delete a schedule for a project.
 * Called when a project is permanently purged from the recycle bin.
 *
 * @param {string} projectId
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  db.prepare("DELETE FROM schedules WHERE projectId = ?").run(projectId);
}
