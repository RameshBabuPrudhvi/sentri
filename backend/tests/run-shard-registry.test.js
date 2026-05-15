/**
 * @module tests/run-shard-registry
 * @description CAP-002 Phase 2 (Prerequisite #4) — parent-vs-shard worker
 * registry coverage.
 *
 * `workerAbortControllers` is keyed by BullMQ jobId so multiple shards of
 * the same run on the same replica don't collide on a single map slot. The
 * three helpers under test:
 *
 *   - `workerAbortKey(runId, shardIndex)` — mirrors the jobId scheme:
 *     bare `runId` for legacy single-shard runs, `${runId}:s${i}` for shards.
 *   - `forEachShardEntry(runId, fn)` — iterates every entry belonging to a
 *     parent run, regardless of shard. Used by the abort route's
 *     local-fast-path and the cross-replica pub/sub subscriber.
 *   - `abortAllShardsForRun(runId)` — cancel + delete every shard
 *     controller for a parent run.
 *
 * Assertions:
 *   1. Key derivation: null → bare runId; integer → `${runId}:s${i}`.
 *   2. Legacy single-shard runs register at the bare runId key (zero
 *      regression for pre-Phase-2 single-process paths).
 *   3. Multiple shards register at distinct keys; no collision.
 *   4. `forEachShardEntry` finds every entry for a parent run, visits each
 *      exactly once, and supports concurrent mutation (delete) during
 *      iteration.
 *   5. `abortAllShardsForRun` aborts every controller for the parent run
 *     and leaves no orphan entries in the map.
 *   6. Other runs' entries are not touched by the fan-out (no cross-run
 *      contamination).
 */

import assert from "node:assert/strict";
import {
  workerAbortControllers,
  workerAbortKey,
  forEachShardEntry,
  abortAllShardsForRun,
} from "../src/workers/runWorker.js";

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

function makeEntry(runId, shardIndex) {
  return {
    controller: new AbortController(),
    provider: "test",
    runId,
    shardIndex,
  };
}

function resetRegistry() {
  for (const key of Array.from(workerAbortControllers.keys())) {
    workerAbortControllers.delete(key);
  }
}

console.log("\n\u2500\u2500 workerAbortControllers parent/shard registry \u2500\u2500");

test("workerAbortKey: null shardIndex returns bare runId (zero regression)", () => {
  assert.equal(workerAbortKey("RUN-x", null), "RUN-x");
  assert.equal(workerAbortKey("RUN-x", undefined), "RUN-x");
});

test("workerAbortKey: integer shardIndex returns ${runId}:s${i}", () => {
  assert.equal(workerAbortKey("RUN-x", 0), "RUN-x:s0");
  assert.equal(workerAbortKey("RUN-x", 3), "RUN-x:s3");
});

test("legacy single-shard entry registers at bare runId key", () => {
  resetRegistry();
  const e = makeEntry("RUN-legacy", null);
  workerAbortControllers.set(workerAbortKey("RUN-legacy", null), e);
  assert.equal(workerAbortControllers.has("RUN-legacy"), true);
  assert.equal(workerAbortControllers.size, 1);
});

test("4 shards of the same run register at 4 distinct keys (no collision)", () => {
  resetRegistry();
  for (let i = 0; i < 4; i++) {
    workerAbortControllers.set(workerAbortKey("RUN-quad", i), makeEntry("RUN-quad", i));
  }
  assert.equal(workerAbortControllers.size, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(workerAbortControllers.has(`RUN-quad:s${i}`), true, `shard ${i} key missing`);
  }
});

test("forEachShardEntry: visits every entry for the parent run exactly once", () => {
  resetRegistry();
  for (let i = 0; i < 3; i++) {
    workerAbortControllers.set(workerAbortKey("RUN-fes", i), makeEntry("RUN-fes", i));
  }
  // Add a sibling run that must NOT be visited.
  workerAbortControllers.set(workerAbortKey("RUN-other", null), makeEntry("RUN-other", null));

  const visited = [];
  const count = forEachShardEntry("RUN-fes", (entry) => {
    visited.push(entry.shardIndex);
  });
  assert.equal(count, 3, "must visit exactly 3 entries");
  assert.deepEqual(visited.sort(), [0, 1, 2], "must visit shards 0, 1, 2 — not the sibling run");
});

test("forEachShardEntry: supports concurrent mutation (delete during iteration)", () => {
  resetRegistry();
  for (let i = 0; i < 3; i++) {
    workerAbortControllers.set(workerAbortKey("RUN-mut", i), makeEntry("RUN-mut", i));
  }
  forEachShardEntry("RUN-mut", (entry, key) => {
    workerAbortControllers.delete(key);
  });
  // Every shard entry must be gone.
  assert.equal(workerAbortControllers.size, 0, "iteration with delete must not skip entries or throw");
});

test("forEachShardEntry: returns 0 for unknown runId", () => {
  resetRegistry();
  workerAbortControllers.set(workerAbortKey("RUN-x", null), makeEntry("RUN-x", null));
  assert.equal(forEachShardEntry("RUN-does-not-exist", () => {}), 0);
});

test("abortAllShardsForRun: aborts every shard controller and clears them from the map", () => {
  resetRegistry();
  const entries = [];
  for (let i = 0; i < 4; i++) {
    const e = makeEntry("RUN-abort", i);
    entries.push(e);
    workerAbortControllers.set(workerAbortKey("RUN-abort", i), e);
  }
  // Add a sibling run that must survive.
  const siblingEntry = makeEntry("RUN-other", null);
  workerAbortControllers.set("RUN-other", siblingEntry);

  const aborted = abortAllShardsForRun("RUN-abort");
  assert.equal(aborted, 4, "must abort exactly 4 shard controllers");
  for (const e of entries) {
    assert.equal(e.controller.signal.aborted, true, `shard ${e.shardIndex} controller must be aborted`);
  }
  // Sibling run untouched.
  assert.equal(siblingEntry.controller.signal.aborted, false, "sibling run must NOT be aborted");
  assert.equal(workerAbortControllers.size, 1, "only the sibling entry must remain");
  assert.equal(workerAbortControllers.has("RUN-other"), true);
});

test("abortAllShardsForRun: legacy bare-runId entry is also fan-out-aborted", () => {
  resetRegistry();
  const e = makeEntry("RUN-legacy2", null);
  workerAbortControllers.set("RUN-legacy2", e);
  const aborted = abortAllShardsForRun("RUN-legacy2");
  assert.equal(aborted, 1);
  assert.equal(e.controller.signal.aborted, true);
  assert.equal(workerAbortControllers.size, 0);
});

test("abortAllShardsForRun: returns 0 for unknown runId without throwing", () => {
  resetRegistry();
  assert.equal(abortAllShardsForRun("RUN-nope"), 0);
});

resetRegistry();
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
