/**
 * @module utils/skipReasons
 * @description Single source of truth for the per-run "skip kinds" that
 * represent a *dispatch decision* rather than an *execution outcome*.
 *
 * A result row with `status === "skipped"` and one of these `skipReason`
 * values means the test never actually ran — so it must NOT count toward
 * the pass-rate denominator (`evaluateQualityGates` in `testRunner.js`,
 * the GH check `conclusionForRun` summary in `runResultFormatters.js`,
 * the RunDetail pass-rate badge in `frontend/src/pages/RunDetail.jsx`),
 * and must NOT count as an execution outcome in `scoreTestRisk`'s
 * history filter (`backend/src/pipeline/riskScorer.js`) — otherwise a
 * previously-skipped test gets a near-maximum risk score on the next run.
 *
 * Mirrored on the frontend at `frontend/src/utils/skipReasons.js`. When
 * adding a new non-executed skip kind, update BOTH files in the same PR;
 * if they drift the backend gate and the frontend badge will disagree.
 *
 * Current members:
 *  - `over_budget`        — AUTO-001 (runs.js + trigger.js budget truncation)
 *  - `skipped_no_impact`  — AUTO-004 (trigger.js impact-analysis filter)
 */

/** @type {Set<string>} */
export const NON_EXECUTED_SKIP_REASONS = new Set(["over_budget", "skipped_no_impact"]);

/**
 * Predicate — true when a result row represents a dispatch-time skip
 * (test never executed) rather than an execution outcome.
 *
 * @param {Object|null|undefined} result
 * @returns {boolean}
 */
export function isNonExecutedSkip(result) {
  return result?.status === "skipped" && NON_EXECUTED_SKIP_REASONS.has(result?.skipReason);
}
