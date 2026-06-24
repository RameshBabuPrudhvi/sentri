/**
 * @module utils/skipReasons
 * @description Frontend mirror of `backend/src/utils/skipReasons.js`.
 *
 * Defines which `skipReason` values on a result row represent a *dispatch
 * decision* (test never ran) versus an *execution outcome*. Non-executed
 * skips are excluded from the pass-rate denominator on Run Detail so the
 * UI agrees with `evaluateQualityGates()` on the backend — if these two
 * lists ever drift, the gate badge and the rendered pass rate will
 * disagree on identical runs.
 *
 * Keep this set byte-aligned with the backend `NON_EXECUTED_SKIP_REASONS`
 * export. The individual per-reason badges on Run Detail (`over budget`
 * amber chip, `no impact` gray chip) still count their own reason
 * directly — only the denominator math goes through this helper.
 */

/** @type {Set<string>} */
export const NON_EXECUTED_SKIP_REASONS = new Set(["over_budget", "skipped_no_impact", "upstream_failed", "missing_upstream", "auth_expired"]);

/**
 * Count result rows that represent a dispatch-time skip (never executed).
 *
 * @param {Array} results
 * @returns {number}
 */
export function countNonExecutedSkips(results) {
  if (!Array.isArray(results)) return 0;
  return results.filter(
    (r) => r?.status === "skipped" && NON_EXECUTED_SKIP_REASONS.has(r?.skipReason),
  ).length;
}
