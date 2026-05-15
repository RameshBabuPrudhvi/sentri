/**
 * @module utils/shardRetryFilter
 * @description CAP-002 Phase 2 (Prerequisite #3) — pure survivor filter for
 * the shard-scoped BullMQ retry path.
 *
 * Single source of truth for the "which results survive a shard retry?"
 * contract. Used by:
 *
 *   - `database/repositories/runRepo.js` `purgeShardResults` — the atomic
 *     transactional read-modify-write on the live `results` column.
 *   - `workers/runWorker.js` legacy single-shard catch block — preserves the
 *     pre-CAP-002 wipe-all behaviour (every execution row dropped, only
 *     non-executed skips kept) when `shardIndex == null`.
 *   - `backend/tests/run-worker-shard-retry.test.js` — verifies the contract
 *     directly without mirroring the logic.
 *
 * Survivors are kept when ANY of:
 *   - `isNonExecutedSkip(r)` returns true (over_budget / skipped_no_impact
 *     — AUTO-001 / AUTO-004 contract: a final dispatch decision, not a
 *     transient execution state).
 *   - `shardIndex != null && r._shardIndex != null && r._shardIndex !== shardIndex`
 *     (sibling shard's already-completed row that must not be erased).
 *
 * Legacy single-shard path (`shardIndex == null`) keeps only the non-executed
 * skips — bit-for-bit identical to the pre-CAP-002 wipe-all behaviour.
 *
 * @param {Object[]}    results            - The current results array (may be empty/null).
 * @param {number|null} shardIndex         - 0-based shard index, or `null` for legacy.
 * @param {Function}    isNonExecutedSkip  - Predicate from `utils/skipReasons.js`.
 *   Passed in (rather than imported) to avoid a runtime cycle when this
 *   helper is consumed from `runRepo.js`, which loads very early.
 * @returns {Object[]} Filtered survivors. Never returns the input array
 *   reference — callers can mutate the result without affecting the input.
 */
export function filterShardRetrySurvivors(results, shardIndex, isNonExecutedSkip) {
  if (!Array.isArray(results) || results.length === 0) return [];
  if (typeof isNonExecutedSkip !== "function") return [];
  return results.filter((r) => {
    if (isNonExecutedSkip(r)) return true;
    if (shardIndex == null) return false;
    return r?._shardIndex != null && r._shardIndex !== shardIndex;
  });
}

/**
 * CAP-002 Phase 2 — Re-derive `{ passed, failed }` from a survivor array.
 * Matches the `processResult` contract: `warning` counts as passed.
 *
 * @param {Object[]} survivors
 * @returns {{ passed: number, failed: number }}
 */
export function countShardRetrySurvivors(survivors) {
  if (!Array.isArray(survivors)) return { passed: 0, failed: 0 };
  return {
    passed: survivors.filter((r) => r?.status === "passed" || r?.status === "warning").length,
    failed: survivors.filter((r) => r?.status === "failed").length,
  };
}
