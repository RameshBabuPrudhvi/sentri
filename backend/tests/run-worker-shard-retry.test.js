/**
 * @module tests/run-worker-shard-retry
 * @description CAP-002 Phase 2 — Prerequisite #3 coverage.
 *
 * Verifies that the retry-reset path in `backend/src/workers/runWorker.js`
 * is shard-scoped: when one shard of a multi-shard run hits a non-final
 * BullMQ retry, only that shard's results get wiped — sibling shards that
 * already completed must keep their persisted results so a single shard's
 * transient failure doesn't erase three other shards' worth of work.
 *
 * The retry-reset filter is a pure expression — it's the only piece of the
 * catch block that's interesting to test in isolation. The surrounding
 * machinery (BullMQ retry semantics, abort detection, attempt-counter
 * arithmetic) is already covered by `run-worker.test.js` via its
 * `simulateCatchBlock` helper. This file extends that idea with a tiny
 * `shardScopedRetryReset` fixture that mirrors the production filter at
 * `runWorker.js` precisely:
 *
 *   - `isNonExecutedSkip` rows always survive (AUTO-001 / AUTO-004 contract)
 *   - `shardIndex == null` → legacy wipe-all (every execution row dropped)
 *   - `shardIndex === N` → keep rows where `_shardIndex !== N` (sibling shards)
 *
 * Importing `isNonExecutedSkip` from the real module keeps the test
 * honest — if a future skip kind is added to `skipReasons.js` it'll
 * automatically be preserved here too, matching the production behaviour.
 */

import assert from "node:assert/strict";
import { isNonExecutedSkip } from "../src/utils/skipReasons.js";

/**
 * Mirror of the production retry-reset filter at
 * `backend/src/workers/runWorker.js` (Prerequisite #3 block). Keep this
 * in lockstep with the production code — if the filter logic changes,
 * change it here too and the assertions will catch any drift.
 */
function shardScopedRetryReset(results, shardIndex) {
  const survivors = (results || []).filter((r) => {
    if (isNonExecutedSkip(r)) return true;
    if (shardIndex == null) return false;
    return r?._shardIndex != null && r._shardIndex !== shardIndex;
  });
  return {
    results: survivors,
    passed: survivors.filter((r) => r?.status === "passed" || r?.status === "warning").length,
    failed: survivors.filter((r) => r?.status === "failed").length,
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

console.log("\n\u2500\u2500 runWorker shard-scoped retry reset \u2500\u2500");

test("shardIndex == null → legacy wipe-all (zero regression for single-shard runs)", () => {
  const results = [
    { testId: "T1", status: "passed", _shardIndex: 0 },
    { testId: "T2", status: "failed", _shardIndex: 0 },
    { testId: "T3", status: "skipped", skipReason: "over_budget" },
  ];
  const out = shardScopedRetryReset(results, null);
  // Only the non-executed skip survives — execution rows are wiped.
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].testId, "T3");
  assert.equal(out.passed, 0);
  assert.equal(out.failed, 0);
});

test("non-executed skips always survive (AUTO-001 / AUTO-004 contract)", () => {
  const results = [
    { testId: "T1", status: "skipped", skipReason: "over_budget" },
    { testId: "T2", status: "skipped", skipReason: "skipped_no_impact" },
    { testId: "T3", status: "passed", _shardIndex: 1 },
  ];
  // Retrying shard 1 — its execution row should be wiped, both skips survive.
  const out = shardScopedRetryReset(results, 1);
  assert.equal(out.results.length, 2, "both non-executed skips must survive");
  assert.ok(out.results.every((r) => r.status === "skipped"));
});

test("4 shards, shard 2 retries: shards 0 + 1 + 3 results preserved", () => {
  const results = [
    { testId: "T0a", status: "passed", _shardIndex: 0 },
    { testId: "T0b", status: "failed", _shardIndex: 0 },
    { testId: "T1a", status: "passed", _shardIndex: 1 },
    { testId: "T2a", status: "passed", _shardIndex: 2 },
    { testId: "T2b", status: "failed", _shardIndex: 2 },
    { testId: "T3a", status: "passed", _shardIndex: 3 },
  ];
  const out = shardScopedRetryReset(results, 2);
  // Shard 2's two rows wiped; the other four survive.
  assert.equal(out.results.length, 4);
  assert.deepEqual(
    out.results.map((r) => r.testId).sort(),
    ["T0a", "T0b", "T1a", "T3a"],
  );
  // passed = T0a + T1a + T3a = 3; failed = T0b = 1
  assert.equal(out.passed, 3);
  assert.equal(out.failed, 1);
});

test("re-derives passed/failed from survivors (does not reset to 0 in shard mode)", () => {
  const results = [
    { testId: "T0a", status: "passed", _shardIndex: 0 },
    { testId: "T0b", status: "warning", _shardIndex: 0 }, // counted as passed
    { testId: "T1a", status: "failed", _shardIndex: 1 },
  ];
  // Retrying shard 1 — keep all shard-0 outcomes.
  const out = shardScopedRetryReset(results, 1);
  assert.equal(out.results.length, 2);
  assert.equal(out.passed, 2, "warning counts as passed (matches processResult contract)");
  assert.equal(out.failed, 0);
});

test("results without _shardIndex are wiped when shardIndex is set (legacy result safety)", () => {
  // A run that started on a pre-Phase-2 worker (no _shardIndex stamping)
  // and is now retrying on a Phase-2 shard worker should NOT silently
  // preserve those rows — they could belong to *this* shard. Safer to
  // re-run them than to leave them in place with unknown attribution.
  const results = [
    { testId: "T_legacy", status: "passed" /* no _shardIndex */ },
    { testId: "T1a", status: "passed", _shardIndex: 1 },
  ];
  const out = shardScopedRetryReset(results, 2);
  // Legacy row gets wiped (no _shardIndex → not a sibling). Shard-1 row
  // is preserved (sibling of shard 2).
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].testId, "T1a");
});

test("empty / nullish results array is a clean no-op", () => {
  assert.deepEqual(shardScopedRetryReset([], 2).results, []);
  assert.deepEqual(shardScopedRetryReset(null, 2).results, []);
  assert.deepEqual(shardScopedRetryReset(undefined, null).results, []);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
