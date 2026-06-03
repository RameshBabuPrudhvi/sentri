/**
 * @module tests/shard-config
 * @description Locks down the `normalizeShardConfig` contract — specifically
 * the BUG-0001 decoupling of `shardCount` and `parallelWorkers`.
 *
 * Regression target: the previous formula `max(shardCount, dialsParallelWorkers ?? 1)`
 * re-coupled the two values that the JSDoc explicitly calls "independent
 * concepts". A caller requesting `shards: 4` with no dials override would
 * silently get `parallelWorkers = 4` *per shard*, producing up to 16
 * concurrent browser instances on one replica (4 shards × 4 internal
 * workers) instead of the operator-intuitive 4 (cross-shard parallelism
 * via BullMQ's pool, 1 browser per shard). The fix decouples so
 * `parallelWorkers` reflects only the dials input.
 */
import assert from "node:assert/strict";
import { normalizeShardConfig } from "../src/utils/shardConfig.js";
import { createTestRunner } from "./helpers/test-base.js";

// Stage 2 (test-infra cleanup) — replaced the inline `function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. See the comment in
// `secret-scanner.test.js` for the rationale + behavioural-compat notes.
const { test, summary } = createTestRunner();

console.log("\n\u2500\u2500 normalizeShardConfig \u2500\u2500");

// Ensure deterministic clamp ceiling for the suite.
const prevMaxWorkers = process.env.MAX_WORKERS;
process.env.MAX_WORKERS = "8";

try {
  // ── Decoupling regression (BUG-0001) ──────────────────────────────────
  test("shards: 4 with no dials override → parallelWorkers stays 1 (decoupled)", () => {
    const { shardCount, parallelWorkers } = normalizeShardConfig(4, undefined);
    assert.equal(shardCount, 4);
    assert.equal(parallelWorkers, 1,
      "regression: parallelWorkers must NOT be inflated to shardCount");
  });

  test("shards: 4 with dials.parallelWorkers: 2 → parallelWorkers = 2 (dials wins)", () => {
    const { shardCount, parallelWorkers } = normalizeShardConfig(4, 2);
    assert.equal(shardCount, 4);
    assert.equal(parallelWorkers, 2);
  });

  test("shards: 1 with dials.parallelWorkers: 3 → parallelWorkers = 3 (zero-regression)", () => {
    const { shardCount, parallelWorkers } = normalizeShardConfig(1, 3);
    assert.equal(shardCount, 1);
    assert.equal(parallelWorkers, 3);
  });

  test("no shards, no dials → shardCount=1, parallelWorkers=1", () => {
    const { shardCount, parallelWorkers } = normalizeShardConfig(undefined, undefined);
    assert.equal(shardCount, 1);
    assert.equal(parallelWorkers, 1);
  });

  // ── Existing clamp contract preserved ─────────────────────────────────
  test("shards clamped to [1, MAX_WORKERS]", () => {
    const { shardCount, maxWorkers } = normalizeShardConfig(100, 1);
    assert.equal(maxWorkers, 8);
    assert.equal(shardCount, 8, "100 should clamp to MAX_WORKERS=8");
  });

  test("non-numeric shards falls back to 1", () => {
    assert.equal(normalizeShardConfig("abc", 1).shardCount, 1);
    assert.equal(normalizeShardConfig(null, 1).shardCount, 1);
    assert.equal(normalizeShardConfig(NaN, 1).shardCount, 1);
  });

  test("negative / zero / fractional shards floor to 1", () => {
    assert.equal(normalizeShardConfig(-5, 1).shardCount, 1);
    assert.equal(normalizeShardConfig(0, 1).shardCount, 1);
    assert.equal(normalizeShardConfig(3.7, 1).shardCount, 3, "fractional truncates");
  });

  test("parallelWorkers floored at 1 even when dials passes 0 / negative", () => {
    assert.equal(normalizeShardConfig(1, 0).parallelWorkers, 1);
    assert.equal(normalizeShardConfig(1, -5).parallelWorkers, 1);
  });

  // ── Total-concurrency bound is now MAX_WORKERS × parallelWorkers ──────
  // (NOT shardCount × parallelWorkers). The shard count is cross-process
  // partitioning; BullMQ's pool caps how many shards run concurrently.
  test("MAX_WORKERS surfaced on the result for caller-side concurrency math", () => {
    const { maxWorkers } = normalizeShardConfig(4, 2);
    assert.equal(maxWorkers, 8);
  });
} finally {
  if (prevMaxWorkers === undefined) delete process.env.MAX_WORKERS;
  else process.env.MAX_WORKERS = prevMaxWorkers;
}

summary("shard-config");
