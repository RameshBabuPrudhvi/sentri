/**
 * @module database/repositories/metricSamplesRepo
 * @description Repository for the generic time-series `metric_samples` table
 * (MET-001). Backs every "value over time per project" surface — healing
 * savings (CAP-004), Web Vitals trends (AUTO-017.3), flaky-rate (DIF-004),
 * accessibility violations (AUTO-016) — so each consumer doesn't reinvent
 * its own aggregation table.
 *
 * Schema (migration `016_metric_samples.sql`):
 *   metric_samples(id, projectId, metricKey, ts, value, tags, createdAt)
 *   indexed on (projectId, metricKey, ts)
 *
 * `tags` is JSON-serialised on write and parsed on read so callers can
 * attach structured context (e.g. `{ testId, strategy }`) without a
 * separate join table.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Insert a single time-series sample.
 *
 * @param {Object} sample
 * @param {string} sample.projectId
 * @param {string} sample.metricKey - Stable metric identifier (e.g. `"healing.savings"`, `"webVitals.lcp"`).
 * @param {number} [sample.ts=Date.now()] - Sample timestamp, epoch ms.
 * @param {number} sample.value - Numeric sample value (must be a finite number — validate at the call site or use `recordMetric`).
 * @param {Object|null} [sample.tags=null] - Optional structured context; JSON-serialised on write.
 */
export function insertSample({ projectId, metricKey, ts = Date.now(), value, tags = null }) {
  const db = getDatabase();
  db.prepare(`INSERT INTO metric_samples (projectId, metricKey, ts, value, tags) VALUES (?, ?, ?, ?, ?)`)
    .run(projectId, metricKey, ts, value, tags ? JSON.stringify(tags) : null);
}

/**
 * Insert many samples in a single transaction. Used by AUTO-022 to persist
 * 4 rows per golden case (selectors / actions / assertions / aggregate) on
 * every eval run — one round-trip is meaningfully cheaper than 200 when the
 * golden set is filled out (50 cases × 4 dims).
 *
 * @param {Array<{projectId: string, metricKey: string, ts?: number, value: number, tags?: (Object|null)}>} samples
 */
export function insertSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(`INSERT INTO metric_samples (projectId, metricKey, ts, value, tags) VALUES (?, ?, ?, ?, ?)`);
  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      stmt.run(
        r.projectId,
        r.metricKey,
        r.ts ?? Date.now(),
        r.value,
        r.tags ? JSON.stringify(r.tags) : null,
      );
    }
  });
  insertMany(samples);
}

/**
 * Read a project's samples for a metric, ordered ascending by timestamp.
 *
 * @param {string} projectId
 * @param {string} metricKey
 * @param {Object} [opts]
 * @param {number} [opts.since=0] - Lower-bound timestamp (epoch ms, inclusive). Default `0` returns all samples.
 * @param {number} [opts.limit=200] - Row cap; oldest-first within the window.
 * @returns {Array<{ts: number, value: number, tags: (Object|null)}>}
 */
export function getSeries(projectId, metricKey, { since = 0, limit = 200 } = {}) {
  const db = getDatabase();
  const rows = db.prepare(`SELECT ts, value, tags FROM metric_samples WHERE projectId = ? AND metricKey = ? AND ts >= ? ORDER BY ts ASC LIMIT ?`)
    .all(projectId, metricKey, since, limit);
  return rows.map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : null }));
}
