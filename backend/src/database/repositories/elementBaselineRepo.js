/**
 * @module database/repositories/elementBaselineRepo
 * @description MNT-001b — store/read per-element baseline crops for
 * vision-healing stage 7 (pixelmatch).
 *
 * Storage: BLOB column in SQLite (better-sqlite3 binds `Buffer` directly);
 * the Postgres adapter translates BLOB → BYTEA. Typical row is 2-10 KB
 * (small UI element at viewport scale); 1000 baselines per project ≈ 10 MB.
 *
 * Retention: `purgeOlderThan(days)` is called from the scheduler's daily
 * sweep (when wired in MNT-001c) so stale crops from deleted tests or
 * pre-versioned code don't accumulate forever.
 *
 * Cascade delete: `deleteByProjectId(projectId)` is invoked from the
 * `DELETE /api/v1/projects/:id` route handler so a project hard-delete
 * doesn't orphan baselines.
 */
import { getDatabase } from "../sqlite.js";

/**
 * Upsert a baseline crop. Conflict on (projectId, healingKey) replaces the
 * existing row — there's only ever one "current" baseline per element.
 *
 * @param {Object} params
 * @param {string} params.projectId
 * @param {string} params.healingKey  "<versionedTestId>::<action>::<label>"
 * @param {Buffer} params.cropPng
 * @param {number} params.cropWidth
 * @param {number} params.cropHeight
 * @param {string} params.capturedAt  ISO 8601 timestamp.
 */
export function upsert({ projectId, healingKey, cropPng, cropWidth, cropHeight, capturedAt }) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO element_baselines (projectId, healingKey, cropPng, cropWidth, cropHeight, capturedAt)
    VALUES (@projectId, @healingKey, @cropPng, @cropWidth, @cropHeight, @capturedAt)
    ON CONFLICT(projectId, healingKey) DO UPDATE SET
      cropPng = @cropPng,
      cropWidth = @cropWidth,
      cropHeight = @cropHeight,
      capturedAt = @capturedAt
  `).run({ projectId, healingKey, cropPng, cropWidth, cropHeight, capturedAt });
}

/**
 * Fetch a baseline row for `(projectId, healingKey)`, or `undefined`.
 *
 * @param {string} projectId
 * @param {string} healingKey
 * @returns {{cropPng: Buffer, cropWidth: number, cropHeight: number, capturedAt: string} | undefined}
 */
export function get(projectId, healingKey) {
  const db = getDatabase();
  return db.prepare(
    "SELECT cropPng, cropWidth, cropHeight, capturedAt FROM element_baselines WHERE projectId = ? AND healingKey = ?"
  ).get(projectId, healingKey);
}

/**
 * Delete every baseline older than `days` days. Returns the number of
 * rows removed. Returns 0 for invalid inputs (negative / non-finite days)
 * so a misconfigured retention setting can't accidentally drop everything.
 *
 * @param {number} days
 * @returns {number}
 */
export function purgeOlderThan(days) {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM element_baselines WHERE capturedAt < ?").run(cutoff).changes;
}

/**
 * Delete every baseline belonging to a project. Used by the project
 * hard-delete cascade so a tenant cleanup doesn't orphan BLOBs.
 *
 * @param {string} projectId
 * @returns {number}
 */
export function deleteByProjectId(projectId) {
  const db = getDatabase();
  return db.prepare("DELETE FROM element_baselines WHERE projectId = ?").run(projectId).changes;
}
