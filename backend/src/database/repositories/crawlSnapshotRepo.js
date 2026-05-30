/**
 * @module database/repositories/crawlSnapshotRepo
 * @description Data-access layer for the `crawl_snapshots` table (B1.3).
 *
 * Replaces the in-memory `run.snapshots[]` accumulation pattern in
 * `crawlBrowser.js` / `stateExplorer.js`. Each crawled page persists
 * its snapshot JSON immediately so peak heap drops from O(N pages) to
 * O(1 page). The pipeline orchestrator can stream-generate tests per
 * page rather than waiting for the full crawl to finish.
 *
 * The `loadMs` column is consumed by Bundle 2 (adaptive timeout) to
 * compute `run.p95LoadMs` post-crawl.
 *
 * ### Exports
 * - {@link save}              — insert one snapshot row
 * - {@link getByRunId}        — fetch all rows for a run (parsed)
 * - {@link getUrlsByRunId}    — fetch just the URL list (cheap)
 * - {@link countByRunId}      — row count
 * - {@link getLoadTimesByRunId} — load-ms array for percentile math
 * - {@link deleteByRunId}     — purge path
 * - {@link deleteByRunIds}    — batch purge
 */

import { getDatabase } from "../sqlite.js";
import { generateCrawlSnapshotId } from "../../utils/idGenerator.js";

/**
 * @typedef {Object} CrawlSnapshotRow
 * @property {string}  id
 * @property {string}  runId
 * @property {string}  url
 * @property {Object}  snapshot       - JSON-parsed snapshot payload
 * @property {number|null} loadMs
 * @property {boolean} fromIframe
 * @property {string|null} iframeSrc
 * @property {string}  createdAt
 */

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Persist one snapshot for a (runId, url). Idempotent via INSERT OR IGNORE —
 * re-crawling the same URL within a run is a no-op rather than an error,
 * which keeps retry logic in the pipeline simple.
 *
 * @param {string} runId
 * @param {string} url
 * @param {Object} snapshot   - the full snapshot object (elements, text, …)
 * @param {Object} [opts]
 * @param {number} [opts.loadMs]
 * @param {boolean} [opts.fromIframe]
 * @param {string} [opts.iframeSrc]
 * @returns {void}
 */
export function save(runId, url, snapshot, opts = {}) {
  if (!runId || !url || !snapshot) return;
  const db = getDatabase();
  const id = generateCrawlSnapshotId();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO crawl_snapshots
       (id, runId, url, snapshotJson, loadMs, fromIframe, iframeSrc, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    runId,
    url,
    JSON.stringify(snapshot),
    Number.isFinite(opts.loadMs) ? Math.round(opts.loadMs) : null,
    opts.fromIframe ? 1 : 0,
    opts.iframeSrc || null,
    createdAt,
  );
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch every snapshot row for a run, parsed and ordered by createdAt.
 * Beware: this rehydrates O(N) snapshot blobs — only call when the
 * caller actually needs the payloads (e.g. legacy in-memory shadow path
 * during the B1 → B2 transition). Use {@link getUrlsByRunId} for the
 * cheap "list of crawled URLs" projection.
 *
 * @param {string} runId
 * @returns {CrawlSnapshotRow[]}
 */
export function getByRunId(runId) {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT id, runId, url, snapshotJson, loadMs, fromIframe, iframeSrc, createdAt
     FROM crawl_snapshots
     WHERE runId = ?
     ORDER BY createdAt ASC, id ASC`
  ).all(runId);
  return rows.map((r) => {
    let snapshot = null;
    try { snapshot = JSON.parse(r.snapshotJson); } catch { snapshot = null; }
    return {
      id: r.id,
      runId: r.runId,
      url: r.url,
      snapshot,
      loadMs: r.loadMs,
      fromIframe: !!r.fromIframe,
      iframeSrc: r.iframeSrc,
      createdAt: r.createdAt,
    };
  });
}

/**
 * Return just the list of URLs already crawled for this run. Cheap —
 * does not deserialise snapshot JSON. Used by the pipeline's "is this
 * page new?" check during incremental re-crawl.
 *
 * @param {string} runId
 * @returns {string[]}
 */
export function getUrlsByRunId(runId) {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT url FROM crawl_snapshots WHERE runId = ? ORDER BY createdAt ASC"
  ).all(runId);
  return rows.map((r) => r.url);
}

/**
 * Load-time array for percentile math (consumed by B2 adaptive timeout).
 * Excludes rows with NULL `loadMs` so the percentile is computed only
 * over pages that recorded a navigation duration.
 *
 * @param {string} runId
 * @returns {number[]}
 */
export function getLoadTimesByRunId(runId) {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT loadMs FROM crawl_snapshots WHERE runId = ? AND loadMs IS NOT NULL"
  ).all(runId);
  return rows.map((r) => r.loadMs);
}

/**
 * AUDIT-ROADMAP B2 — load-time array sourced from the project's most recent
 * crawl run that actually recorded `loadMs` rows. This is the path the
 * regression-run adaptive-timeout calculation uses, because a regression
 * run gets a brand-new `runId` (`routes/runs.js:225`) distinct from the
 * crawl's runId — so `getLoadTimesByRunId(testRunId)` would return `[]`
 * and the adaptive math would silently fall back to the env floor.
 *
 * Strategy:
 *   1. Find the latest `runs` row for this project that has at least one
 *      `crawl_snapshots.loadMs IS NOT NULL` row (a real crawl run, not an
 *      explorer or API-only run).
 *   2. Return that run's load times.
 *
 * Single SELECT with a correlated subquery so the database does the
 * "latest crawl with load times" lookup in one round-trip rather than
 * the route layer iterating runs. Compatible with both SQLite and
 * Postgres (`MAX(startedAt)` + grouped subquery is portable).
 *
 * Returns `[]` when no crawl run has recorded `loadMs` for this project
 * yet (first-ever run, API-only crawls, partial-failure crawls). The
 * caller (`testRunner.js#runTests`) treats `[]` as "no signal" and falls
 * back to the env floor — matches pre-B2 behaviour bit-for-bit.
 *
 * @param {string} projectId
 * @returns {number[]}
 */
export function getLoadTimesByProjectId(projectId) {
  if (!projectId) return [];
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT cs.loadMs FROM crawl_snapshots cs
       JOIN runs r ON r.id = cs.runId
      WHERE r.projectId = ?
        AND r.deletedAt IS NULL
        AND cs.loadMs IS NOT NULL
        AND cs.runId = (
          SELECT cs2.runId FROM crawl_snapshots cs2
            JOIN runs r2 ON r2.id = cs2.runId
           WHERE r2.projectId = ?
             AND r2.deletedAt IS NULL
             AND cs2.loadMs IS NOT NULL
           ORDER BY r2.startedAt DESC, cs2.createdAt DESC
           LIMIT 1
        )`
  ).all(projectId, projectId);
  return rows.map((r) => r.loadMs);
}

/**
 * Row count for a run (used by tests and the lean run response shape).
 *
 * @param {string} runId
 * @returns {number}
 */
export function countByRunId(runId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT COUNT(*) AS cnt FROM crawl_snapshots WHERE runId = ?"
  ).get(runId).cnt;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Hard-delete all snapshot rows for a run (recycle-bin purge path).
 *
 * @param {string} runId
 * @returns {number} rows deleted
 */
export function deleteByRunId(runId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM crawl_snapshots WHERE runId = ?").run(runId);
  return info.changes;
}

/**
 * Batch hard-delete (project purge).
 *
 * @param {string[]} runIds
 * @returns {number} rows deleted
 */
export function deleteByRunIds(runIds) {
  if (!runIds.length) return 0;
  const db = getDatabase();
  const placeholders = runIds.map(() => "?").join(", ");
  const info = db.prepare(
    `DELETE FROM crawl_snapshots WHERE runId IN (${placeholders})`
  ).run(...runIds);
  return info.changes;
}
