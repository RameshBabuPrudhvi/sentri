/**
 * @module tests/run-logs
 * @description Unit tests for ENH-008 — dedicated run_logs table.
 *
 * Verifies:
 *   - appendLog() inserts rows with correct seq, level, message
 *   - getByRunId() returns rows ordered by seq ASC
 *   - getMessagesByRunId() returns plain string array
 *   - countByRunId() returns accurate row counts
 *   - deleteByRunId() removes all rows for a run
 *   - deleteByRunIds() batch-removes rows for multiple runs
 *   - seq counter is monotonic within a run and independent between runs
 *   - seq cache survives cross-run independence (no bleed between runs)
 *   - runRepo.getById() hydrates logs from run_logs (integration)
 *   - runRepo.hardDeleteById() cascades into run_logs (integration)
 *   - runRepo.hardDeleteByProjectId() cascades into run_logs (integration)
 *   - runLogger.log() persists to run_logs (integration)
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as runLogRepo from "../src/database/repositories/runLogRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import { log, logWarn, logError, logSuccess } from "../src/utils/runLogger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _ctr = 8000;
const uid = (prefix) => `${prefix}-RL-${++_ctr}`;

function makeProject(overrides = {}) {
  const id = uid("PRJ");
  return { id, name: `RL Project ${id}`, url: "https://example.com",
    createdAt: new Date().toISOString(), status: "idle", ...overrides };
}

function makeRun(projectId, overrides = {}) {
  const id = uid("RUN");
  return { id, projectId, type: "test_run", status: "completed",
    startedAt: new Date().toISOString(), logs: [], tests: [], results: [],
    passed: 0, failed: 0, total: 0, ...overrides };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM run_logs  WHERE runId  LIKE 'RUN-RL-%'");
  db.exec("DELETE FROM runs      WHERE id     LIKE 'RUN-RL-%'");
  db.exec("DELETE FROM projects  WHERE id     LIKE 'PRJ-RL-%'");
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

resetDb();

// ─── runLogRepo unit tests ────────────────────────────────────────────────────

console.log("\n── runLogRepo ──");

test("appendLog inserts a row with correct fields", () => {
  const runId = uid("RUN");
  runLogRepo.appendLog(runId, "info", "[12:00:00] hello");
  const rows = runLogRepo.getByRunId(runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, runId);
  assert.equal(rows[0].level, "info");
  assert.equal(rows[0].message, "[12:00:00] hello");
  assert.equal(rows[0].seq, 1);
  assert.ok(rows[0].createdAt);
  // cleanup
  runLogRepo.deleteByRunId(runId);
});

test("seq is monotonically increasing within a run", () => {
  const runId = uid("RUN");
  runLogRepo.appendLog(runId, "info",  "msg 1");
  runLogRepo.appendLog(runId, "warn",  "msg 2");
  runLogRepo.appendLog(runId, "error", "msg 3");
  const rows = runLogRepo.getByRunId(runId);
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3]);
  runLogRepo.deleteByRunId(runId);
});

test("seq counters are independent between runs", () => {
  const runA = uid("RUN");
  const runB = uid("RUN");
  runLogRepo.appendLog(runA, "info", "A-1");
  runLogRepo.appendLog(runA, "info", "A-2");
  runLogRepo.appendLog(runB, "info", "B-1");
  const rowsA = runLogRepo.getByRunId(runA);
  const rowsB = runLogRepo.getByRunId(runB);
  assert.deepEqual(rowsA.map(r => r.seq), [1, 2]);
  assert.deepEqual(rowsB.map(r => r.seq), [1]);
  runLogRepo.deleteByRunId(runA);
  runLogRepo.deleteByRunId(runB);
});

test("getByRunId returns rows ordered by seq ASC", () => {
  const runId = uid("RUN");
  runLogRepo.appendLog(runId, "info", "first");
  runLogRepo.appendLog(runId, "warn", "second");
  runLogRepo.appendLog(runId, "info", "third");
  const rows = runLogRepo.getByRunId(runId);
  assert.deepEqual(rows.map(r => r.message), ["first", "second", "third"]);
  runLogRepo.deleteByRunId(runId);
});

test("getByRunId returns empty array for unknown runId", () => {
  const rows = runLogRepo.getByRunId("RUN-DOES-NOT-EXIST");
  assert.deepEqual(rows, []);
});

test("getMessagesByRunId returns plain string array", () => {
  const runId = uid("RUN");
  runLogRepo.appendLog(runId, "info", "line one");
  runLogRepo.appendLog(runId, "info", "line two");
  const msgs = runLogRepo.getMessagesByRunId(runId);
  assert.deepEqual(msgs, ["line one", "line two"]);
  runLogRepo.deleteByRunId(runId);
});

test("countByRunId returns accurate row count", () => {
  const runId = uid("RUN");
  assert.equal(runLogRepo.countByRunId(runId), 0);
  runLogRepo.appendLog(runId, "info", "a");
  runLogRepo.appendLog(runId, "info", "b");
  assert.equal(runLogRepo.countByRunId(runId), 2);
  runLogRepo.deleteByRunId(runId);
  assert.equal(runLogRepo.countByRunId(runId), 0);
});

test("deleteByRunId removes only rows for the target run", () => {
  const runA = uid("RUN");
  const runB = uid("RUN");
  runLogRepo.appendLog(runA, "info", "keep");
  runLogRepo.appendLog(runB, "info", "delete me");
  runLogRepo.deleteByRunId(runB);
  assert.equal(runLogRepo.countByRunId(runA), 1);
  assert.equal(runLogRepo.countByRunId(runB), 0);
  runLogRepo.deleteByRunId(runA);
});

test("deleteByRunIds batch-removes rows for multiple runs", () => {
  const ids = [uid("RUN"), uid("RUN"), uid("RUN")];
  for (const id of ids) runLogRepo.appendLog(id, "info", "msg");
  runLogRepo.deleteByRunIds(ids);
  for (const id of ids) assert.equal(runLogRepo.countByRunId(id), 0);
});

test("deleteByRunIds is a no-op for empty array", () => {
  // Should not throw
  const deleted = runLogRepo.deleteByRunIds([]);
  assert.equal(deleted, 0);
});

test("level values are preserved correctly", () => {
  const runId = uid("RUN");
  runLogRepo.appendLog(runId, "info",  "info msg");
  runLogRepo.appendLog(runId, "warn",  "warn msg");
  runLogRepo.appendLog(runId, "error", "error msg");
  const rows = runLogRepo.getByRunId(runId);
  assert.deepEqual(rows.map(r => r.level), ["info", "warn", "error"]);
  runLogRepo.deleteByRunId(runId);
});

// ─── Integration: runRepo ─────────────────────────────────────────────────────

console.log("\n── runRepo integration ──");

const proj = makeProject();
projectRepo.create(proj);

test("runRepo.create() + getById() hydrates logs from run_logs", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  // Manually insert some log rows (simulates runLogger.log())
  runLogRepo.appendLog(run.id, "info", "[ts] step one");
  runLogRepo.appendLog(run.id, "warn", "[ts] step two");
  const fetched = runRepo.getById(run.id);
  assert.deepEqual(fetched.logs, ["[ts] step one", "[ts] step two"]);
  runRepo.hardDeleteById(run.id);
});

test("runRepo.getById() returns logs:[] when run has no log rows", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  const fetched = runRepo.getById(run.id);
  assert.deepEqual(fetched.logs, []);
  runRepo.hardDeleteById(run.id);
});

test("runRepo.hardDeleteById() cascades into run_logs", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  runLogRepo.appendLog(run.id, "info", "will be purged");
  assert.equal(runLogRepo.countByRunId(run.id), 1);
  runRepo.hardDeleteById(run.id);
  assert.equal(runLogRepo.countByRunId(run.id), 0);
});

test("runRepo.hardDeleteByProjectId() cascades into run_logs", () => {
  const localProj = makeProject();
  projectRepo.create(localProj);
  const run1 = makeRun(localProj.id);
  const run2 = makeRun(localProj.id);
  runRepo.create(run1);
  runRepo.create(run2);
  runLogRepo.appendLog(run1.id, "info", "log A");
  runLogRepo.appendLog(run2.id, "info", "log B");
  runRepo.hardDeleteByProjectId(localProj.id);
  assert.equal(runLogRepo.countByRunId(run1.id), 0);
  assert.equal(runLogRepo.countByRunId(run2.id), 0);
});

// ─── Integration: runLogger ───────────────────────────────────────────────────

console.log("\n── runLogger integration ──");

test("log() persists entry to run_logs AND appends to run.logs array", () => {
  const run = makeRun(proj.id);
  run.logs = [];
  runRepo.create(run);
  log(run, "test message");
  // In-memory array updated
  assert.equal(run.logs.length, 1);
  assert.ok(run.logs[0].includes("test message"));
  // Persisted to run_logs
  assert.equal(runLogRepo.countByRunId(run.id), 1);
  const rows = runLogRepo.getByRunId(run.id);
  assert.ok(rows[0].message.includes("test message"));
  assert.equal(rows[0].level, "info");
  runRepo.hardDeleteById(run.id);
});

test("logWarn() stores level=warn in run_logs", () => {
  const run = makeRun(proj.id);
  run.logs = [];
  runRepo.create(run);
  logWarn(run, "something suspicious");
  const rows = runLogRepo.getByRunId(run.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "warn");
  assert.ok(rows[0].message.includes("something suspicious"));
  runRepo.hardDeleteById(run.id);
});

test("logError() stores level=error in run_logs", () => {
  const run = makeRun(proj.id);
  run.logs = [];
  runRepo.create(run);
  logError(run, "something broke");
  const rows = runLogRepo.getByRunId(run.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "error");
  runRepo.hardDeleteById(run.id);
});

test("logSuccess() stores level=info in run_logs", () => {
  const run = makeRun(proj.id);
  run.logs = [];
  runRepo.create(run);
  logSuccess(run, "all done");
  const rows = runLogRepo.getByRunId(run.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "info");
  assert.ok(rows[0].message.includes("all done"));
  runRepo.hardDeleteById(run.id);
});

test("multiple log() calls produce monotonically increasing seq", () => {
  const run = makeRun(proj.id);
  run.logs = [];
  runRepo.create(run);
  log(run, "alpha");
  logWarn(run, "beta");
  logError(run, "gamma");
  const rows = runLogRepo.getByRunId(run.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3]);
  // In-memory array and DB are in sync
  assert.equal(run.logs.length, 3);
  runRepo.hardDeleteById(run.id);
});

test("runRepo.save() does not write logs column back to runs table", () => {
  const run = makeRun(proj.id);
  run.logs = [];
  runRepo.create(run);
  log(run, "a log entry");
  // Save the run (as pipeline code does after every step)
  runRepo.save(run);
  // The logs must come from run_logs, not the runs.logs column
  const fetched = runRepo.getById(run.id);
  assert.deepEqual(fetched.logs, runLogRepo.getMessagesByRunId(run.id));
  // Verify the runs.logs column is not being written (still NULL or '[]')
  const db = getDatabase();
  const raw = db.prepare("SELECT logs FROM runs WHERE id = ?").get(run.id);
  // logs column should be NULL or empty '[]' — never the in-memory array JSON
  assert.ok(raw.logs == null || raw.logs === "[]" || raw.logs === "",
    `runs.logs should be empty but got: ${raw.logs}`);
  runRepo.hardDeleteById(run.id);
});

// ─── Teardown ─────────────────────────────────────────────────────────────────

resetDb();

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
