/**
 * @module tests/run-storage-concurrency
 * @description CAP-002 Phase 2 — Prerequisite #1 coverage.
 *
 * Verifies the new atomic primitives in `runRepo.js` against the lost-write
 * scenario that motivated them:
 *
 *   - `appendRunResults(runId, newResults[])` — N concurrent callers, each
 *     appending K results, must produce a final `results` array of length
 *     N*K with **every** input preserved (no last-write-wins).
 *   - `incrementShardsCompleted(runId)` — N concurrent increments must land
 *     `shardsCompleted` at exactly N (capped at `shardCount`), with no
 *     interleaved read-modify-write loss.
 *
 * The legacy `save(run)` path is intentionally NOT used here — its semantics
 * are last-write-wins by design (full snapshot replace), which is precisely
 * why these primitives exist.
 *
 * Cross-dialect: the test runs against whatever `DATABASE_URL` selects.
 * On SQLite (default) better-sqlite3 journal-locks per UPDATE so concurrency
 * is naturally serialized; on Postgres the row-level lock during `UPDATE …
 * WHERE id = ?` provides the same guarantee. Both paths are exercised by
 * the same assertion set — there is no dialect-conditional logic to bridge.
 */

import assert from "node:assert/strict";
import { getDatabase, getDatabaseDialect } from "../src/database/sqlite.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";

let _ctr = 9000;
const uid = (prefix) => `${prefix}-RSC-${++_ctr}`;

function makeProject() {
  const id = uid("PRJ");
  return {
    id,
    name: `RSC Project ${id}`,
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
  db.exec("DELETE FROM runs     WHERE id LIKE 'RUN-RSC-%'");
  db.exec("DELETE FROM projects WHERE id LIKE 'PRJ-RSC-%'");
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log(`\n\u2500\u2500 run-storage-concurrency (dialect: ${getDatabaseDialect()}) \u2500\u2500`);

  resetDb();
  const project = makeProject();
  projectRepo.create(project);

  // ── appendRunResults — single caller, empty → populated ─────────────
  await test("appendRunResults: empty results column accepts the first chunk verbatim", () => {
    const run = makeRun(project.id, { results: [], shardCount: 1 });
    runRepo.create(run);
    runRepo.appendRunResults(run.id, [{ testId: "T1", status: "passed" }]);
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.results.length, 1);
    assert.equal(fetched.results[0].testId, "T1");
    runRepo.hardDeleteById(run.id);
  });

  // ── appendRunResults — splice path on a non-empty column ────────────
  await test("appendRunResults: appends to a non-empty array via JSON splice", () => {
    const run = makeRun(project.id, {
      results: [{ testId: "T0", status: "passed" }],
      shardCount: 1,
    });
    runRepo.create(run);
    runRepo.appendRunResults(run.id, [
      { testId: "T1", status: "passed" },
      { testId: "T2", status: "failed", error: "boom" },
    ]);
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.results.length, 3);
    assert.deepEqual(
      fetched.results.map((r) => r.testId),
      ["T0", "T1", "T2"],
    );
    // The interesting payload survives the splice unscathed (commas, quotes).
    assert.equal(fetched.results[2].error, "boom");
    runRepo.hardDeleteById(run.id);
  });

  // ── appendRunResults — empty input is a clean no-op ─────────────────
  await test("appendRunResults: empty array is a no-op (does not corrupt column)", () => {
    const run = makeRun(project.id, {
      results: [{ testId: "T0", status: "passed" }],
      shardCount: 1,
    });
    runRepo.create(run);
    const appended = runRepo.appendRunResults(run.id, []);
    assert.equal(appended, 0);
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.results.length, 1);
    runRepo.hardDeleteById(run.id);
  });

  // ── appendRunResults — concurrency: N parallel callers, no lost writes ──
  // This is the core regression test for the lost-write bug that motivated
  // the primitive. We fire 8 concurrent appends of 5 results each; the
  // final array must contain all 40 entries (no last-write-wins). Each
  // shard tags its results with a unique `shardIdx` so we can also verify
  // that every shard's full contribution survived.
  await test("appendRunResults: 8 concurrent callers × 5 results = 40 preserved (no lost writes)", async () => {
    const run = makeRun(project.id, { results: [], shardCount: 8 });
    runRepo.create(run);
    const shardCount = 8;
    const perShard = 5;
    await Promise.all(
      Array.from({ length: shardCount }, (_, shardIdx) => {
        const chunk = Array.from({ length: perShard }, (_, i) => ({
          testId: `T${shardIdx}-${i}`,
          status: "passed",
          shardIdx,
        }));
        // No artificial await — let the JS event loop interleave the
        // synchronous better-sqlite3 calls however it wants. The SQL
        // engine's write lock is the linearization point.
        return Promise.resolve().then(() => runRepo.appendRunResults(run.id, chunk));
      }),
    );
    const fetched = runRepo.getById(run.id);
    assert.equal(
      fetched.results.length,
      shardCount * perShard,
      `expected ${shardCount * perShard} results, got ${fetched.results.length} (lost-write regression)`,
    );
    // Every shard's full contribution must survive.
    const bucket = new Map();
    for (const r of fetched.results) {
      bucket.set(r.shardIdx, (bucket.get(r.shardIdx) || 0) + 1);
    }
    for (let s = 0; s < shardCount; s++) {
      assert.equal(bucket.get(s), perShard, `shard ${s} lost results: got ${bucket.get(s)}`);
    }
    runRepo.hardDeleteById(run.id);
  });

  // ── incrementShardsCompleted — single increment ─────────────────────
  await test("incrementShardsCompleted: advances 0 \u2192 1", () => {
    const run = makeRun(project.id, { shardCount: 4, shardsCompleted: 0 });
    runRepo.create(run);
    const changed = runRepo.incrementShardsCompleted(run.id);
    assert.equal(changed, 1);
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.shardsCompleted, 1);
    runRepo.hardDeleteById(run.id);
  });

  // ── incrementShardsCompleted — caps at shardCount ───────────────────
  await test("incrementShardsCompleted: caps at shardCount (no over-run)", () => {
    const run = makeRun(project.id, { shardCount: 2, shardsCompleted: 2 });
    runRepo.create(run);
    runRepo.incrementShardsCompleted(run.id);
    runRepo.incrementShardsCompleted(run.id);
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.shardsCompleted, 2, "cap violated");
    runRepo.hardDeleteById(run.id);
  });

  // ── incrementShardsCompleted — concurrent increments hit exactly N ──
  await test("incrementShardsCompleted: 4 concurrent increments land at exactly 4", async () => {
    const run = makeRun(project.id, { shardCount: 4, shardsCompleted: 0 });
    runRepo.create(run);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        Promise.resolve().then(() => runRepo.incrementShardsCompleted(run.id)),
      ),
    );
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.shardsCompleted, 4, "concurrent increments lost a write");
    runRepo.hardDeleteById(run.id);
  });

  // ── incrementShardsCompleted — over-increment beyond cap is no-op ───
  await test("incrementShardsCompleted: 8 concurrent increments on shardCount=4 land at 4 (capped)", async () => {
    const run = makeRun(project.id, { shardCount: 4, shardsCompleted: 0 });
    runRepo.create(run);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve().then(() => runRepo.incrementShardsCompleted(run.id)),
      ),
    );
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.shardsCompleted, 4, "cap violated under concurrent over-fire");
    runRepo.hardDeleteById(run.id);
  });

  resetDb();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\u2717 run-storage-concurrency failed:", err);
  process.exit(1);
});
