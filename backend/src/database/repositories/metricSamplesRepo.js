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
 * @typedef {Object} MetricSampleInput
 * @property {string} projectId
 * @property {string} metricKey
 * @property {number} [ts] - Optional epoch ms; defaults to `Date.now()` at insert time.
 * @property {number} value
 * @property {(Object|null)} [tags] - Optional structured context; JSON-serialised on write.
 */

/**
 * Insert many samples in a single transaction. Used by AUTO-022 to persist
 * 4 rows per golden case (selectors / actions / assertions / aggregate) on
 * every eval run — one round-trip is meaningfully cheaper than 200 when the
 * golden set is filled out (50 cases × 4 dims).
 *
 * @param {Array<MetricSampleInput>} samples
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
 * Read a project's samples for a metric, ordered by timestamp.
 *
 * Default order is ascending (oldest-first), preserving the original
 * contract for chart-rendering callers that walk the series left-to-right.
 * When the row cap is hit on a long-running series, the OLDEST `limit`
 * rows survive in ASC mode — so trend-style consumers (which care about
 * the most-recent N runs) should pass `order: "desc"` to fetch newest-
 * first inside SQL, then reverse on the JS side if they still want
 * oldest-first delivery. AUTO-022's `getEvalTrend` is the canonical
 * example of this pattern: without `desc`, runs after the first ~10
 * fell off the window once the harness accumulated history.
 *
 * @param {string} projectId
 * @param {string} metricKey
 * @param {Object} [opts]
 * @param {number} [opts.since=0] - Lower-bound timestamp (epoch ms, inclusive). Default `0` returns all samples.
 * @param {number} [opts.limit=200] - Row cap; oldest-first by default within the window.
 * @param {"asc"|"desc"} [opts.order="asc"] - Sort order. `"desc"` keeps the most recent
 *   `limit` rows when a series exceeds the cap.
 * @returns {Array<{ts: number, value: number, tags: (Object|null)}>}
 */
export function getSeries(projectId, metricKey, { since = 0, limit = 200, order = "asc" } = {}) {
  const db = getDatabase();
  const direction = order === "desc" ? "DESC" : "ASC";
  const rows = db.prepare(`SELECT ts, value, tags FROM metric_samples WHERE projectId = ? AND metricKey = ? AND ts >= ? ORDER BY ts ${direction} LIMIT ?`)
    .all(projectId, metricKey, since, limit);
  return rows.map(r => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : null }));
}

/**
 * Read all rows for a single (projectId, metricKey) whose `tags.runId`
 * matches the given runId. Used by the AUTO-022 drill-down route so it
 * stays correct regardless of how many historical runs the harness has
 * accumulated (the previous `getSeries({ limit: 2000 })` approach loaded
 * the OLDEST rows and recent runs fell off the window).
 *
 * Cross-dialect strategy — `LIKE` pre-filter + JS verification:
 * The natural query is `WHERE json_extract(tags, '$.runId') = ?`, but
 * `json_extract()` is SQLite-specific and the Postgres adapter
 * (`backend/src/database/adapters/postgres-adapter.js`) has no translation
 * rule for it — so the query would crash on every drill-down request on
 * Postgres deployments. We instead use a `LIKE` pre-filter against the
 * serialized JSON column (matching the established pattern in
 * `backend/src/database/repositories/runRepo.js:264` `findByGithubDeliveryId`
 * and `activityRepo.js:206`) and verify the parsed `runId` field in JS.
 * The pre-filter narrows the candidate set; the JS-side check is the
 * source of truth and rejects accidental substring matches that LIKE
 * would otherwise let through (e.g. a runId appearing as part of a
 * different field's value).
 *
 * Returns rows in `ts ASC` order so per-case detail reconstruction is
 * deterministic across calls.
 *
 * @param {string} projectId
 * @param {string} metricKey
 * @param {string} runId - The tag value to match against `tags.runId`.
 * @returns {Array<{ts: number, value: number, tags: (Object|null)}>}
 */
export function getSeriesByRunId(projectId, metricKey, runId) {
  if (!runId) return [];
  const db = getDatabase();
  // Escape SQL LIKE wildcards (`\`, `%`, `_`) in the runId before
  // interpolating into the pattern so a malicious / malformed runId can't
  // broaden the match. The JS-side equality check below is the actual
  // source of truth — LIKE only narrows the candidate set.
  const safeRunId = String(runId).replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%"runId":"${safeRunId}"%`;
  const rows = db.prepare(
    `SELECT ts, value, tags FROM metric_samples
     WHERE projectId = ? AND metricKey = ?
       AND tags IS NOT NULL
       AND tags LIKE ? ESCAPE '\\'
     ORDER BY ts ASC`
  ).all(projectId, metricKey, pattern);
  // Parse and verify in JS — guards against substring collisions where
  // the runId appears inside a different field's value.
  return rows
    .map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : null }))
    .filter((r) => r.tags?.runId === runId);
}
