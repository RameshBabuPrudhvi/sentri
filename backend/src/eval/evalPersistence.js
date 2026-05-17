/**
 * @module eval/evalPersistence
 * @description AUTO-022 — persist per-case eval scores into `metric_samples`
 * so the Dashboard `EvalPanel` can render trend charts without re-running the
 * harness on every page load.
 *
 * Storage shape (one row per dimension × case):
 *   projectId  = EVAL_HARNESS_PROJECT_ID sentinel (the eval harness has no
 *                real workspace — it runs from CI against a frozen golden
 *                set, not against any tenant's project)
 *   metricKey  = "eval.aggregate" | "eval.selectors" | "eval.actions" | "eval.assertions"
 *                (mirrors AUTO-017.3's `webVitals.lcp` / `cls` / `inp` / `ttfb`
 *                pattern — one key per dimension keeps `getSeries` callable
 *                without post-filtering)
 *   ts         = harness invocation timestamp (epoch ms) — same value across
 *                every row of one run so the Dashboard can group by ts
 *   value      = score in [0, 1]
 *   tags       = { runId, caseId, category, actual? }
 *
 * `runId` is a uuid minted per harness invocation so the Dashboard can group
 * "all rows from one run" without depending on `ts` equality (clock-resolution
 * collisions are rare but possible across the 200-row insert below).
 *
 * `actual` Playwright code is persisted on the `eval.aggregate` row ONLY
 * (skipped on the three dimension rows to keep storage ~4× smaller — the
 * per-dimension breakdown doesn't need the raw code, only the score). It's
 * truncated to MAX_ACTUAL_BYTES so a runaway generation can't blow up the
 * tags column. `expected` is NOT persisted — the drill-down route reads it
 * directly from the golden JSON files at request time so it stays a single
 * source of truth (the file on disk).
 */

import crypto from "node:crypto";
import { insertSamples, getSeries } from "../database/repositories/metricSamplesRepo.js";

// Per-row `actual` cap. 4 KB keeps the tags blob bounded — a 50-case run
// thus contributes at most 200 KB of `actual` payload across its aggregate
// rows. Truncation is silent (we'd rather under-report than crash the DB
// write); the report.json artifact already carries the full strings for
// reviewers who need them.
const MAX_ACTUAL_BYTES = 4 * 1024;

// Sentinel project ID — the eval harness is workspace-agnostic and isn't
// scoped to any tenant. The Dashboard query reads under this id explicitly
// (no risk of leaking eval rows into a real project's `getSeries`).
export const EVAL_HARNESS_PROJECT_ID = "__eval_harness__";

const METRIC_KEYS = Object.freeze({
  aggregate: "eval.aggregate",
  selectors: "eval.selectors",
  actions: "eval.actions",
  assertions: "eval.assertions",
});

/**
 * Persist a runEval() result as `metric_samples` rows.
 *
 * Writes 4 rows per case (one per dimension) in a single transaction. Returns
 * the synthesised `runId` so the caller can echo it on the CLI / store it for
 * the Dashboard drill-down link.
 *
 * @param {Object} params
 * @param {Array}  params.cases       - `runEval()` `results.cases` array.
 * @param {string} [params.runId]     - Optional pre-minted run id; default uuid.
 * @param {number} [params.ts]        - Optional override timestamp (epoch ms).
 * @returns {{ runId: string, rowsWritten: number }}
 */
export function persistEvalRun({ cases, runId, ts } = {}) {
  if (!Array.isArray(cases) || cases.length === 0) {
    return { runId: runId || null, rowsWritten: 0 };
  }
  const evalRunId = runId || crypto.randomUUID();
  const evalTs = typeof ts === "number" ? ts : Date.now();
  const rows = [];
  for (const c of cases) {
    const baseTags = { runId: evalRunId, caseId: c.caseId, category: c.category || "uncategorised" };
    // Embed `actual` on the aggregate row only — that's the single row the
    // drill-down route reads when reconstructing the per-case detail view.
    const actualStr = String(c.actual ?? "").slice(0, MAX_ACTUAL_BYTES);
    const aggregateTags = actualStr ? { ...baseTags, actual: actualStr } : baseTags;
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.aggregate, ts: evalTs, value: c.score.aggregate, tags: aggregateTags });
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.selectors, ts: evalTs, value: c.score.selectors, tags: baseTags });
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.actions,    ts: evalTs, value: c.score.actions,    tags: baseTags });
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.assertions, ts: evalTs, value: c.score.assertions, tags: baseTags });
  }
  insertSamples(rows);
  return { runId: evalRunId, rowsWritten: rows.length };
}

/**
 * Read the per-run trend for the Dashboard `EvalPanel`. Returns one entry
 * per `runId` ordered by `ts` ascending, each carrying every dimension's
 * score so the panel can render four overlaid sparklines without a
 * second round trip.
 *
 * @param {Object} [opts]
 * @param {number} [opts.windowDays=30]  Trailing window. 30 days matches the
 *                                        NEXT.md AC #2 spec.
 * @param {number} [opts.limit=500]      Per-dimension row cap (200 cases × 30
 *                                        days at 1 run/day ≈ 6k rows worst
 *                                        case; 500 is the per-dimension cap
 *                                        which assumes ≤1 run/day for 50
 *                                        cases — adjust if cadence grows).
 * @returns {Array<{runId: string, createdAt: string, aggregate: number,
 *                  selectors: number, actions: number, assertions: number,
 *                  caseCount: number}>}
 */
export function getEvalTrend({ windowDays = 30, limit = 500 } = {}) {
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const aggregateRows = getSeries(EVAL_HARNESS_PROJECT_ID, METRIC_KEYS.aggregate, { since, limit });
  if (aggregateRows.length === 0) return [];

  // Group by runId. Same uuid → same run; aggregate the per-case scores
  // into a run-level mean (every row of one run shares ts so we don't have
  // to track per-row timestamps).
  const byRun = new Map();
  for (const row of aggregateRows) {
    const runId = row.tags?.runId;
    if (!runId) continue;
    if (!byRun.has(runId)) {
      byRun.set(runId, { runId, ts: row.ts, scores: [] });
    }
    byRun.get(runId).scores.push(row.value);
  }

  // Layer in per-dimension means by walking the other three metricKeys
  // exactly once each. Skipping dimensions when zero rows exist for that
  // runId keeps the response stable across mid-migration data (a partial
  // run that crashed after writing only the aggregate row still surfaces).
  const dimensions = { selectors: METRIC_KEYS.selectors, actions: METRIC_KEYS.actions, assertions: METRIC_KEYS.assertions };
  const dimByRun = {};
  for (const [name, key] of Object.entries(dimensions)) {
    dimByRun[name] = new Map();
    for (const row of getSeries(EVAL_HARNESS_PROJECT_ID, key, { since, limit })) {
      const runId = row.tags?.runId;
      if (!runId) continue;
      if (!dimByRun[name].has(runId)) dimByRun[name].set(runId, []);
      dimByRun[name].get(runId).push(row.value);
    }
  }

  const mean = (arr) => arr.length === 0 ? null : arr.reduce((s, v) => s + v, 0) / arr.length;

  return Array.from(byRun.values())
    .map((r) => ({
      runId: r.runId,
      createdAt: new Date(r.ts).toISOString(),
      aggregate: mean(r.scores),
      selectors: mean(dimByRun.selectors.get(r.runId) || []),
      actions: mean(dimByRun.actions.get(r.runId) || []),
      assertions: mean(dimByRun.assertions.get(r.runId) || []),
      caseCount: r.scores.length,
    }))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/**
 * Read per-case detail for one eval run. Returns the four scores plus the
 * persisted `actual` for each case. `expected` is NOT included — callers
 * (the dashboard drill-down route) layer it in from the on-disk golden
 * JSON so the file stays single-source-of-truth.
 *
 * @param {string} runId
 * @returns {{ runId: string, createdAt: string|null, cases: Array<{
 *   caseId: string, category: string, score: { aggregate, selectors, actions, assertions },
 *   actual: string|null
 * }> } | null}
 */
export function getEvalRunCases(runId) {
  if (!runId) return null;
  // No `since` filter — drill-down on older runs is valid. limit=2000 caps
  // the result at 500 cases (4 rows each) which is well above the 50-case
  // golden-set target.
  const allRows = [];
  for (const key of Object.values(METRIC_KEYS)) {
    for (const row of getSeries(EVAL_HARNESS_PROJECT_ID, key, { limit: 2000 })) {
      if (row.tags?.runId === runId) allRows.push({ ...row, metricKey: key });
    }
  }
  if (allRows.length === 0) return null;

  const caseMap = new Map();
  let firstTs = null;
  for (const row of allRows) {
    const caseId = row.tags?.caseId;
    if (!caseId) continue;
    if (!caseMap.has(caseId)) {
      caseMap.set(caseId, {
        caseId,
        category: row.tags?.category || "uncategorised",
        score: { aggregate: null, selectors: null, actions: null, assertions: null },
        actual: null,
      });
    }
    const entry = caseMap.get(caseId);
    if (row.metricKey === METRIC_KEYS.aggregate)  entry.score.aggregate = row.value;
    if (row.metricKey === METRIC_KEYS.selectors)  entry.score.selectors = row.value;
    if (row.metricKey === METRIC_KEYS.actions)    entry.score.actions = row.value;
    if (row.metricKey === METRIC_KEYS.assertions) entry.score.assertions = row.value;
    if (row.metricKey === METRIC_KEYS.aggregate && row.tags?.actual) entry.actual = row.tags.actual;
    if (firstTs == null || row.ts < firstTs) firstTs = row.ts;
  }

  return {
    runId,
    createdAt: firstTs != null ? new Date(firstTs).toISOString() : null,
    cases: Array.from(caseMap.values()).sort((a, b) => a.caseId.localeCompare(b.caseId)),
  };
}

export const EVAL_METRIC_KEYS = METRIC_KEYS;
