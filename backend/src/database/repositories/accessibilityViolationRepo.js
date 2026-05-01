/**
 * @module database/repositories/accessibilityViolationRepo
 * @description Persistence for axe-core accessibility violations (AUTO-016).
 *
 * One row per (run, page, ruleId, node-set) — the axe-core node array is
 * stored as a JSON blob in `nodesJson` rather than a separate table to keep
 * crawl-time inserts cheap. Rows cascade-delete with their parent run.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Insert a batch of normalised violation records for a single page.
 *
 * Records are produced by `mapA11yViolations()` in
 * `backend/src/pipeline/crawlBrowser.js`. The insert is wrapped in a single
 * prepared statement and a transaction so a 50-violation page is one
 * round-trip rather than 50.
 *
 * @param {Array<Object>} violations
 * @returns {number} rows inserted
 */
export function bulkCreate(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return 0;
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO accessibility_violations
      (runId, pageUrl, ruleId, impact, wcagCriterion, help, description, nodesJson, createdAt)
    VALUES (@runId, @pageUrl, @ruleId, @impact, @wcagCriterion, @help, @description, @nodesJson, @createdAt)
  `);
  const createdAt = new Date().toISOString();
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run({
        runId: row.runId,
        pageUrl: row.pageUrl,
        ruleId: row.ruleId,
        impact: row.impact ?? null,
        wcagCriterion: row.wcagCriterion ?? null,
        help: row.help ?? "",
        description: row.description ?? "",
        nodesJson: row.nodesJson ?? "[]",
        createdAt,
      });
    }
  });
  insertMany(violations);
  return violations.length;
}

/**
 * List all violations for a run, ordered by page then rule.
 *
 * @param {string} runId
 * @returns {Array<Object>}
 */
export function getByRunId(runId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM accessibility_violations WHERE runId = ? ORDER BY pageUrl ASC, ruleId ASC"
  ).all(runId);
}

/**
 * List violations for a single page within a run.
 *
 * @param {string} runId
 * @param {string} pageUrl
 * @returns {Array<Object>}
 */
export function getByRunAndPage(runId, pageUrl) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM accessibility_violations WHERE runId = ? AND pageUrl = ? ORDER BY ruleId ASC"
  ).all(runId, pageUrl);
}

/**
 * Count violations grouped by runId for a set of run IDs.
 *
 * Used by the dashboard "top accessibility offenders" rollup so we can
 * aggregate counts in a single query instead of N `SELECT *` calls.
 *
 * @param {Array<string>} runIds
 * @returns {Record<string, number>} runId → violation count (only runs with > 0 are present)
 */
export function countByRunIds(runIds) {
  if (!Array.isArray(runIds) || runIds.length === 0) return {};
  const db = getDatabase();
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT runId, COUNT(*) AS count FROM accessibility_violations WHERE runId IN (${placeholders}) GROUP BY runId`
  ).all(...runIds);
  const out = {};
  for (const row of rows) out[row.runId] = row.count;
  return out;
}
