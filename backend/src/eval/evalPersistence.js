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
 *   tags       = { runId, caseId, category }
 *
 * `runId` is a uuid minted per harness invocation so the Dashboard can group
 * "all rows from one run" without depending on `ts` equality (clock-resolution
 * collisions are rare but possible across the 200-row insert below).
 *
 * The harness writes scoring data only — `expected` / `actual` Playwright
 * code is intentionally NOT persisted here. The drill-down route reads those
 * directly from the golden JSON files at request time so this table stays
 * lean and the row-count cardinality is bounded at 200/run.
 */

import crypto from "node:crypto";
import { insertSamples } from "../database/repositories/metricSamplesRepo.js";

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
    const tags = { runId: evalRunId, caseId: c.caseId, category: c.category || "uncategorised" };
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.aggregate, ts: evalTs, value: c.score.aggregate, tags });
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.selectors, ts: evalTs, value: c.score.selectors, tags });
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.actions,    ts: evalTs, value: c.score.actions,    tags });
    rows.push({ projectId: EVAL_HARNESS_PROJECT_ID, metricKey: METRIC_KEYS.assertions, ts: evalTs, value: c.score.assertions, tags });
  }
  insertSamples(rows);
  return { runId: evalRunId, rowsWritten: rows.length };
}

export const EVAL_METRIC_KEYS = METRIC_KEYS;
