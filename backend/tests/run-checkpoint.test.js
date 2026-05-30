/**
 * @module tests/run-checkpoint
 * @description B1.1 (AUDIT-ROADMAP Bundle 1) — per-test result flush + crash recovery.
 *
 * Locks in three contracts that together survive the SIGKILL scenario:
 *   1. `runTestResultRepo.append()` is idempotent and bumps the duplicates
 *      counter under `resume_replay` vs `duplicate_dispatch`.
 *   2. `getCompletedTestIds(runId)` returns the resume endpoint's checkpoint.
 *   3. `markOrphansInterrupted()` returns `{ count, ids }` and stamps
 *      `failureReason='process_crash'`.
 */

import assert from "node:assert/strict";
import { getDatabase, getDatabaseDialect } from "../src/database/sqlite.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as runTestResultRepo from "../src/database/repositories/runTestResultRepo.js";
import { runTestResultDuplicatesTotal } from "../src/utils/metrics.js";

let _ctr = 9000;
const uid = (prefix) => `${prefix}-CHK-${++_ctr}`;

function makeProject() {
  return {
    id: uid("PRJ"),
    name: "Checkpoint Project",
    url: "https://example.com",
    createdAt: new Date().toISOString(),
    status: "idle",
  };
}

function makeRun(projectId, overrides = {}) {
  return {
    id: uid("RUN"),
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
    shardCount: 1,
    shardsCompleted: 0,
    ...overrides,
  };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM run_test_results WHERE runId LIKE 'RUN-CHK-%'");
  db.exec("DELETE FROM runs            WHERE id LIKE 'RUN-CHK-%'");
  db.exec("DELETE FROM projects        WHERE id LIKE 'PRJ-CHK-%'");
}

async function getDuplicateCount(reason) {
  const snapshot = await runTestResultDuplicatesTotal.get();
  const row = snapshot.values.find((v) => v.labels?.reason === reason);
  return row?.value || 0;
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
    console.error(`     ${err?.stack || err?.message || err}`);
    failed++;
  }
}

async function main() {
  console.log(`\n\u2500\u2500 run-checkpoint (dialect: ${getDatabaseDialect()}) \u2500\u2500`);
  resetDb();
  const project = makeProject();
  projectRepo.create(project);

  // ── append + getByRunId round-trip ─────────────────────────────────────
  await test("append + getByRunId: result round-trips with parsed artifacts", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    const out = runTestResultRepo.append(run.id, {
      testId: "TC-1",
      status: "passed",
      duration: 1234,
      retryCount: 0,
      artifacts: { screenshotPath: "/foo.png", videoPath: null, tracePath: null },
      healingEvents: [{ key: "click::Submit", strategyIndex: 0 }],
    });
    assert.equal(out.inserted, true);
    assert.equal(out.reason, "runner");
    const rows = runTestResultRepo.getByRunId(run.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].testId, "TC-1");
    assert.equal(rows[0].status, "passed");
    assert.deepEqual(rows[0].artifacts, {
      screenshotPath: "/foo.png", videoPath: null, tracePath: null,
    });
    assert.equal(rows[0].healingEvents.length, 1);
    runRepo.hardDeleteById(run.id);
  });

  // ── INSERT OR IGNORE: runner duplicate bumps duplicate_dispatch ─────────
  await test("append: runner duplicate increments duplicates counter under 'duplicate_dispatch'", async () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    const before = await getDuplicateCount("duplicate_dispatch");
    runTestResultRepo.append(run.id, { testId: "TC-2", status: "passed" });
    // Second append of the same (runId, testId, iterationIndex=0) — the
    // `INSERT OR IGNORE` rejects and the counter bumps under the
    // `duplicate_dispatch` label (default `reason: "runner"`).
    const out = runTestResultRepo.append(run.id, { testId: "TC-2", status: "passed" });
    assert.equal(out.inserted, false);
    assert.equal(out.reason, "duplicate_dispatch");
    const after = await getDuplicateCount("duplicate_dispatch");
    assert.equal(after - before, 1,
      `duplicate_dispatch counter should advance by 1, got ${after - before}`);
    assert.equal(runTestResultRepo.countByRunId(run.id), 1);
    runRepo.hardDeleteById(run.id);
  });

  // ── INSERT OR IGNORE: resume duplicate bumps resume_replay ──────────────
  await test("append: opts.reason='resume_replay' uses the expected counter label", async () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    runTestResultRepo.append(run.id, { testId: "TC-3", status: "passed" });
    const before = await getDuplicateCount("resume_replay");
    const out = runTestResultRepo.append(
      run.id,
      { testId: "TC-3", status: "passed" },
      { reason: "resume_replay" },
    );
    assert.equal(out.inserted, false);
    assert.equal(out.reason, "resume_replay");
    const after = await getDuplicateCount("resume_replay");
    assert.equal(after - before, 1);
    runRepo.hardDeleteById(run.id);
  });

  // ── getCompletedTestIds is the resume checkpoint source ────────────────
  await test("getCompletedTestIds: returns the exact set of testIds with any row", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    runTestResultRepo.append(run.id, { testId: "TC-A", status: "passed" });
    runTestResultRepo.append(run.id, { testId: "TC-B", status: "failed", error: "boom" });
    runTestResultRepo.append(run.id, { testId: "TC-C", status: "warning" });
    const ids = runTestResultRepo.getCompletedTestIds(run.id);
    assert.equal(ids.size, 3);
    assert.ok(ids.has("TC-A"));
    assert.ok(ids.has("TC-B"));
    assert.ok(ids.has("TC-C"));
    assert.ok(!ids.has("TC-MISSING"));
    runRepo.hardDeleteById(run.id);
  });

  // ── data-driven iterations are distinct rows ────────────────────────────
  await test("append: iterationIndex makes data-driven iterations distinct rows", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    runTestResultRepo.append(run.id, { testId: "TC-FX", status: "passed", iterationIndex: 0 });
    runTestResultRepo.append(run.id, { testId: "TC-FX", status: "passed", iterationIndex: 1 });
    runTestResultRepo.append(run.id, { testId: "TC-FX", status: "failed", iterationIndex: 2, error: "row 3" });
    assert.equal(runTestResultRepo.countByRunId(run.id), 3,
      "three iteration rows should coexist under the same testId");
    runRepo.hardDeleteById(run.id);
  });

  // ── deleteByRunId on the purge path ─────────────────────────────────────
  await test("deleteByRunId: removes every row for a run", () => {
    const run = makeRun(project.id);
    runRepo.create(run);
    for (let i = 0; i < 5; i++) {
      runTestResultRepo.append(run.id, { testId: `TC-DEL-${i}`, status: "passed" });
    }
    assert.equal(runTestResultRepo.countByRunId(run.id), 5);
    const deleted = runTestResultRepo.deleteByRunId(run.id);
    assert.equal(deleted, 5);
    assert.equal(runTestResultRepo.countByRunId(run.id), 0);
    runRepo.hardDeleteById(run.id);
  });

  // ── markOrphansInterrupted: returns {count, ids} + stamps failureReason ─
  // The B1 change preserves the existing `status='interrupted'` transition
  // byte-for-byte AND stamps the new `failureReason='process_crash'` column.
  // Return shape changed from `number` → `{ count, ids }` so the boot-time
  // hook can correlate recovered runs with subsequent resume requests.
  await test("markOrphansInterrupted: stamps failureReason and returns recovered IDs", () => {
    // Each orphan needs its own project because the partial unique index
    // `idx_runs_one_active_per_project` (migration 002) enforces at most one
    // status='running' run per projectId.
    const p1 = makeProject();
    const p2 = makeProject();
    const p3 = makeProject();
    const p4 = makeProject();
    projectRepo.create(p1);
    projectRepo.create(p2);
    projectRepo.create(p3);
    projectRepo.create(p4);
    const orphan1 = makeRun(p1.id, { status: "running" });
    const orphan2 = makeRun(p2.id, { status: "running" });
    const orphan3 = makeRun(p3.id, { status: "running" });
    const control = makeRun(p4.id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
    });
    runRepo.create(orphan1);
    runRepo.create(orphan2);
    runRepo.create(orphan3);
    runRepo.create(control);

    const result = runRepo.markOrphansInterrupted();
    assert.ok(result && typeof result === "object",
      `markOrphansInterrupted must return an object, got ${typeof result}`);
    assert.equal(typeof result.count, "number");
    assert.ok(Array.isArray(result.ids));
    assert.ok(result.count >= 3,
      `expected at least 3 orphans recovered, got ${result.count}`);
    assert.ok(result.ids.includes(orphan1.id));
    assert.ok(result.ids.includes(orphan2.id));
    assert.ok(result.ids.includes(orphan3.id));
    assert.ok(!result.ids.includes(control.id),
      "completed control run must not be in the recovered set");

    // Each orphan is now `interrupted` with `failureReason='process_crash'`.
    const o1 = runRepo.getById(orphan1.id);
    assert.equal(o1.status, "interrupted");
    assert.equal(o1.failureReason, "process_crash",
      "failureReason must be stamped for crash-recovery distinction");

    // The control run is untouched.
    const c = runRepo.getById(control.id);
    assert.equal(c.status, "completed");
    assert.equal(c.failureReason, null,
      "completed control must not have failureReason stamped");

    // Idempotent: second call finds no orphans.
    const second = runRepo.markOrphansInterrupted();
    assert.equal(second.count, 0);
    assert.equal(second.ids.length, 0);

    runRepo.hardDeleteById(orphan1.id);
    runRepo.hardDeleteById(orphan2.id);
    runRepo.hardDeleteById(orphan3.id);
    runRepo.hardDeleteById(control.id);
  });

  resetDb();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\u2717 run-checkpoint failed:", err);
  process.exit(1);
});
