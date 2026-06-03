/**
 * @module tests/run-shard-finalizer
 * @description CAP-002 Phase 2 — coordinator/worker finalization race coverage.
 *
 * The whole sharded-run architecture rests on one race-safety property:
 *
 *   Across N concurrent shard workers — each of which calls
 *   `incrementRunStats(...)` then `incrementShardsCompleted(runId)` —
 *   *exactly one* shard's `incrementShardsCompleted` UPDATE both
 *   (a) returns `info.changes === 1` AND
 *   (b) observes `shardsCompleted === shardCount` afterwards.
 *
 * That single shard is the finalizer (runs the feedback loop + emits
 * `done`); every other shard returns without firing finalization. The
 * "exactly once" guarantee is delegated to the SQL row-lock plus the
 * predicate `AND COALESCE(shardsCompleted, 0) < COALESCE(shardCount, 1)`
 * on `incrementShardsCompleted` (Prerequisite #1). Without that, a
 * sharded run could either:
 *   - Fire finalization N times → duplicate `done` events, N feedback-
 *     loop AI passes, N `test_run.complete` activity rows.
 *   - Fire finalization zero times → run stuck in `running` forever; CI
 *     pipelines polling `/trigger/runs/:id` time out.
 *
 * Asserts:
 *   1. Stats compose without lost writes (passed/failed/total deltas
 *      sum correctly across N concurrent UPDATEs — sibling test to
 *      `run-storage-concurrency.test.js` for the `appendRunResults`
 *      primitive).
 *   2. Exactly one shard observes the boundary crossing.
 *   3. `shardsCompleted` lands at exactly `shardCount` (no over-increment).
 *   4. Over-firing shards (more workers than the cap) are silent no-ops.
 *
 * Pure repo-layer coverage — no BullMQ, no Redis, no Playwright.
 * Cross-process integration is gated on a real Redis + BullMQ harness
 * which lives outside this PR (same scoping precedent as
 * `run-shard-crash.test.js`).
 */
import assert from "node:assert/strict";
import { getDatabase, getDatabaseDialect } from "../src/database/sqlite.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
let _ctr = 9700;
const uid = (prefix) => `${prefix}-RSF-${++_ctr}`;
function makeProject() {
  const id = uid("PRJ");
  return {
    id,
    name: `RSF Project ${id}`,
    url: "https://example.com",
    createdAt: new Date().toISOString(),
    status: "idle",
  };
}
function makeRun(projectId, overrides = {}) {
  const id = uid("RUN");
  return {
    id,
    projectId,
    type: "test_run",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    tests: [],
    results: [],
    passed: 0,
    failed: 0,
    total: 0,
    shardCount: 4,
    shardsCompleted: 0,
    ...overrides,
  };
}
function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM runs     WHERE id LIKE 'RUN-RSF-%'");
  db.exec("DELETE FROM projects WHERE id LIKE 'PRJ-RSF-%'");
}
// Stage 2 (test-infra cleanup) — replaced the inline `async function test(name, fn)`
// with the shared runner from `helpers/test-base.js`. See the comment in
// `secret-scanner.test.js` for the rationale + behavioural-compat notes.
import { createTestRunner } from "./helpers/test-base.js";
const { test, summary } = createTestRunner();
async function main() {
  console.log(`\n\u2500\u2500 run-shard-finalizer (dialect: ${getDatabaseDialect()}) \u2500\u2500`);
  resetDb();
  const project = makeProject();
  projectRepo.create(project);
  // ── incrementRunStats: single-shard delta lands cleanly ──────────────
  await test("incrementRunStats: single shard's delta lands on the parent row", () => {
    const run = makeRun(project.id, { shardCount: 1, total: 10 });
    runRepo.create(run);
    const changed = runRepo.incrementRunStats(run.id, {
      passedDelta: 7, failedDelta: 3, totalDelta: 0,
    });
    assert.equal(changed, 1);
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.passed, 7);
    assert.equal(fetched.failed, 3);
    assert.equal(fetched.total, 10, "total preserved when totalDelta=0");
    runRepo.hardDeleteById(run.id);
  });
  // ── incrementRunStats: zero deltas is a clean no-op ─────────────────
  await test("incrementRunStats: zero deltas is a no-op (avoids spurious UPDATE)", () => {
    const run = makeRun(project.id, { shardCount: 1, total: 5 });
    runRepo.create(run);
    const changed = runRepo.incrementRunStats(run.id, {});
    assert.equal(changed, 0, "no-op must not touch the row");
    runRepo.hardDeleteById(run.id);
  });
  // ── incrementRunStats: totalDelta composes for data-driven tests ────
  await test("incrementRunStats: totalDelta composes (data-driven iteration overflow)", () => {
    // Simulate 4 shards each with 10 base tests; shard-2 has a data-driven
    // test that fans out from 1 → 5 iterations (totalDelta = 4).
    const run = makeRun(project.id, { shardCount: 4, total: 40 });
    runRepo.create(run);
    runRepo.incrementRunStats(run.id, { passedDelta: 10, totalDelta: 0 });
    runRepo.incrementRunStats(run.id, { passedDelta: 9, failedDelta: 1, totalDelta: 0 });
    runRepo.incrementRunStats(run.id, { passedDelta: 13, failedDelta: 1, totalDelta: 4 });
    runRepo.incrementRunStats(run.id, { passedDelta: 10, totalDelta: 0 });
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.passed, 42, "passes compose: 10+9+13+10");
    assert.equal(fetched.failed, 2, "failures compose: 0+1+1+0");
    assert.equal(fetched.total, 44, "total: 40 base + 4 iteration overflow");
    runRepo.hardDeleteById(run.id);
  });
  // ── incrementRunStats: concurrent shard composition, no lost writes ──
  await test("incrementRunStats: 8 concurrent shards compose without lost writes", async () => {
    const run = makeRun(project.id, { shardCount: 8, total: 0, passed: 0, failed: 0 });
    runRepo.create(run);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() =>
          runRepo.incrementRunStats(run.id, { passedDelta: 5, failedDelta: 2, totalDelta: 7 }),
        ),
      ),
    );
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.passed, 40, "8 × 5 = 40 passes preserved");
    assert.equal(fetched.failed, 16, "8 × 2 = 16 failures preserved");
    assert.equal(fetched.total, 56, "8 × 7 = 56 total preserved");
    runRepo.hardDeleteById(run.id);
  });
  // ── Finalization handoff: exactly one shard observes the boundary ───
  // The headline race. Simulate N parallel worker increments and assert
  // exactly one "finalizer" sees both (a) advanced === 1 AND
  // (b) post-increment shardsCompleted === shardCount.
  await test("finalization handoff: exactly one of 4 concurrent shards is the finalizer", async () => {
    const run = makeRun(project.id, { shardCount: 4, shardsCompleted: 0 });
    runRepo.create(run);
    let finalizerCount = 0;
    let finalizerShardIndex = null;
    const observations = await Promise.all(
      Array.from({ length: 4 }, (_, shardIndex) =>
        Promise.resolve().then(() => {
          // Simulate the worker's exact sequence: stats first, then increment.
          runRepo.incrementRunStats(run.id, { passedDelta: 10, failedDelta: 0 });
          const { advanced, newValue } = runRepo.incrementShardsCompleted(run.id);
          if (advanced === 1 && newValue >= run.shardCount) {
            finalizerCount++;
            finalizerShardIndex = shardIndex;
          }
          return { shardIndex, advanced };
        }),
      ),
    );
    assert.equal(finalizerCount, 1,
      `exactly one shard must be the finalizer (got ${finalizerCount}; shard=${finalizerShardIndex})`);
    const advancedCount = observations.filter((o) => o.advanced === 1).length;
    assert.equal(advancedCount, 4, "all 4 shards must advance the counter under the cap");
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.shardsCompleted, 4);
    assert.equal(fetched.passed, 40, "stats from all 4 shards composed correctly");
    runRepo.hardDeleteById(run.id);
  });
  // ── Over-firing shards (>shardCount) become no-ops at the predicate ─
  await test("over-firing: 6 concurrent shards on shardCount=4 land exactly one finalizer", async () => {
    const run = makeRun(project.id, { shardCount: 4, shardsCompleted: 0 });
    runRepo.create(run);
    let finalizerCount = 0;
    const observations = await Promise.all(
      Array.from({ length: 6 }, () =>
        Promise.resolve().then(() => {
          const { advanced, newValue } = runRepo.incrementShardsCompleted(run.id);
          if (advanced === 1 && newValue >= run.shardCount) finalizerCount++;
          return { advanced };
        }),
      ),
    );
    assert.equal(finalizerCount, 1,
      "exactly one finalizer even when more workers than shardCount call increment");
    // Exactly shardCount of the 6 calls should advance; the other 2 are no-ops.
    const advancedCount = observations.filter((o) => o.advanced === 1).length;
    assert.equal(advancedCount, 4, "only shardCount=4 increments should advance; 2 must be no-ops");
    runRepo.hardDeleteById(run.id);
  });
  // ── Atomicity under stats + increment interleaving ──────────────────
  // The worker calls incrementRunStats THEN incrementShardsCompleted as
  // two separate UPDATEs. Between them, a sibling shard could land its
  // own pair of UPDATEs. Assert the final composed state is correct
  // regardless of interleave order.
  await test("interleaving: stats and counter stay consistent under heavy interleave", async () => {
    const run = makeRun(project.id, { shardCount: 10, shardsCompleted: 0 });
    runRepo.create(run);
    await Promise.all(
      Array.from({ length: 10 }, (_, shardIndex) =>
        Promise.resolve().then(() => {
          runRepo.incrementRunStats(run.id, { passedDelta: 3, failedDelta: 1, totalDelta: 0 });
          const { advanced } = runRepo.incrementShardsCompleted(run.id);
          void advanced; // consume to avoid lint warning
        }),
      ),
    );
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.shardsCompleted, 10, "all 10 shards must increment");
    assert.equal(fetched.passed, 30, "10 × 3 passes");
    assert.equal(fetched.failed, 10, "10 × 1 failures");
    runRepo.hardDeleteById(run.id);
  });
  resetDb();
}
// Run main() then summary() — main() registers all `await test(...)` calls
// in sequence, summary() drains the pending promises and exits.
main()
  .then(() => summary("run-shard-finalizer"))
  .catch((err) => {
    console.error("\u2717 run-shard-finalizer failed:", err);
    process.exit(1);
  });
