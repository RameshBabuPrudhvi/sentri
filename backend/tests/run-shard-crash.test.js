/**
 * @module tests/run-shard-crash
 * @description CAP-002 Phase 2 (Prerequisite #6) — shard-crash → parent-run
 * failure propagation coverage.
 *
 * Scope: the storage-layer contract that the runWorker's final-attempt
 * failure path relies on — `markRunFailedFirstWriterWins`. The end-to-end
 * "kill a BullMQ job mid-execution and observe sibling-shard drain" check
 * needs a real Redis + BullMQ harness; that integration test lives in the
 * follow-up coordinator PR per NEXT.md acceptance criterion (c). What we
 * exercise here is the *unit* contract every shard worker depends on:
 *
 *   1. First crash wins — `markRunFailedFirstWriterWins` on a `running`
 *      row writes the failure reason and returns `true`.
 *   2. Subsequent crashes are no-ops — the second/third call on the same
 *      row returns `false` and leaves the first writer's error message
 *      intact (a later shard's classified error must NOT overwrite the
 *      first's, otherwise the audit trail loses which shard caused the
 *      cascade).
 *   3. `shardsCompleted < shardCount` is preserved after failure — the
 *      helper deliberately doesn't touch the counter, so the badge
 *      surfaces partial completion truthfully.
 *   4. Concurrent callers race cleanly — N parallel calls land exactly
 *      one writer, with the surviving error message belonging to that
 *      winner (same row-lock-per-UPDATE contract as Prerequisite #1's
 *      `appendRunResults`).
 *   5. Already-terminal rows (aborted, completed) are not flipped to
 *      `failed` by a late shard crash arriving after the user aborted.
 */

import assert from "node:assert/strict";
import { getDatabase, getDatabaseDialect } from "../src/database/sqlite.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";

let _ctr = 9500;
const uid = (prefix) => `${prefix}-RSC6-${++_ctr}`;

function makeProject() {
  const id = uid("PRJ");
  return {
    id,
    name: `RSC6 Project ${id}`,
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
    shardsCompleted: 2,
    ...overrides,
  };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM runs     WHERE id LIKE 'RUN-RSC6-%'");
  db.exec("DELETE FROM projects WHERE id LIKE 'PRJ-RSC6-%'");
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
  console.log(`\n\u2500\u2500 run-shard-crash (dialect: ${getDatabaseDialect()}) \u2500\u2500`);

  resetDb();
  const project = makeProject();
  projectRepo.create(project);

  await test("first call on a running row writes failure and returns true", () => {
    const run = makeRun(project.id, { status: "running" });
    runRepo.create(run);
    const writer = runRepo.markRunFailedFirstWriterWins(run.id, {
      error: "shard-2 crashed: ECONNRESET",
      errorCategory: "network",
    });
    assert.equal(writer, true, "first writer must return true");
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.status, "failed");
    assert.equal(fetched.error, "shard-2 crashed: ECONNRESET");
    assert.equal(fetched.errorCategory, "network");
    assert.ok(fetched.finishedAt, "finishedAt must be set");
    runRepo.hardDeleteById(run.id);
  });

  await test("second call is a no-op — first writer's error survives", () => {
    const run = makeRun(project.id, { status: "running" });
    runRepo.create(run);
    runRepo.markRunFailedFirstWriterWins(run.id, {
      error: "first: AbortError",
      errorCategory: "abort",
    });
    const secondWriter = runRepo.markRunFailedFirstWriterWins(run.id, {
      error: "second: TimeoutError (this should NOT win)",
      errorCategory: "timeout",
    });
    assert.equal(secondWriter, false, "second writer must return false");
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.error, "first: AbortError", "first writer's error must survive");
    assert.equal(fetched.errorCategory, "abort", "first writer's category must survive");
    runRepo.hardDeleteById(run.id);
  });

  await test("shardsCompleted < shardCount preserved after failure (badge surfaces truthful partial)", () => {
    const run = makeRun(project.id, {
      status: "running",
      shardCount: 4,
      shardsCompleted: 2,
    });
    runRepo.create(run);
    runRepo.markRunFailedFirstWriterWins(run.id, { error: "shard-3 crashed" });
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.status, "failed");
    assert.equal(fetched.shardCount, 4);
    assert.equal(fetched.shardsCompleted, 2, "shardsCompleted must NOT be flushed to shardCount on shard-crash failure");
    runRepo.hardDeleteById(run.id);
  });

  await test("4 concurrent crashes land exactly one writer; first wins atomically", async () => {
    const run = makeRun(project.id, { status: "running" });
    runRepo.create(run);
    const writers = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        Promise.resolve().then(() =>
          runRepo.markRunFailedFirstWriterWins(run.id, {
            error: `shard-${i} crashed`,
            errorCategory: `cat-${i}`,
          }),
        ),
      ),
    );
    const trueCount = writers.filter((w) => w === true).length;
    assert.equal(trueCount, 1, "exactly one writer must succeed under concurrency");
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.status, "failed");
    // The surviving error must be one of the shard messages — we can't
    // predict which because writer order is non-deterministic, but it
    // must not be a corrupted mash-up.
    assert.match(fetched.error, /^shard-\d crashed$/);
    runRepo.hardDeleteById(run.id);
  });

  await test("already-terminal (aborted) row is not flipped to failed by a late crash", () => {
    const run = makeRun(project.id, {
      status: "aborted",
      finishedAt: new Date().toISOString(),
      error: "Aborted by user",
    });
    runRepo.create(run);
    const writer = runRepo.markRunFailedFirstWriterWins(run.id, {
      error: "shard-1 crashed AFTER user aborted",
      errorCategory: "network",
    });
    assert.equal(writer, false, "late shard crash must NOT overwrite an aborted row");
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.status, "aborted", "status must stay aborted");
    assert.equal(fetched.error, "Aborted by user", "abort reason must survive");
    runRepo.hardDeleteById(run.id);
  });

  await test("already-terminal (completed) row is not flipped to failed by a late crash", () => {
    const run = makeRun(project.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      shardsCompleted: 4,
    });
    runRepo.create(run);
    const writer = runRepo.markRunFailedFirstWriterWins(run.id, { error: "stale shard echo" });
    assert.equal(writer, false);
    const fetched = runRepo.getById(run.id);
    assert.equal(fetched.status, "completed");
    runRepo.hardDeleteById(run.id);
  });

  await test("missing runId / unknown row returns false without throwing", () => {
    assert.equal(runRepo.markRunFailedFirstWriterWins("", { error: "x" }), false);
    assert.equal(runRepo.markRunFailedFirstWriterWins(null, { error: "x" }), false);
    assert.equal(runRepo.markRunFailedFirstWriterWins("RUN-DOES-NOT-EXIST-XYZ", { error: "x" }), false);
  });

  resetDb();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\u2717 run-shard-crash failed:", err);
  process.exit(1);
});
