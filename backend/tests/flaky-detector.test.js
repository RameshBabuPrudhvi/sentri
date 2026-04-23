/**
 * @module tests/flaky-detector
 * @description Unit tests for the flaky test detection utility (DIF-004).
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import { computeAndPersistFlakyScores, getTopFlakyTests } from "../src/utils/flakyDetector.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const db = getDatabase();

function resetDb() {
  db.exec("DELETE FROM tests");
  db.exec("DELETE FROM runs");
  db.exec("DELETE FROM run_logs");
  db.exec("DELETE FROM projects");
  db.exec("UPDATE counters SET value = 0 WHERE name IN ('test', 'project', 'run')");
}

const now = new Date().toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\n🧪 flaky-detector: computeAndPersistFlakyScores");

resetDb();

projectRepo.create({ id: "PRJ-1", name: "Flaky Project", url: "https://example.com", createdAt: now, workspaceId: "WS-1" });
testRepo.create({ id: "TC-1", projectId: "PRJ-1", name: "Stable test", createdAt: now, reviewStatus: "approved", workspaceId: "WS-1" });
testRepo.create({ id: "TC-2", projectId: "PRJ-1", name: "Flaky test", createdAt: now, reviewStatus: "approved", workspaceId: "WS-1" });
testRepo.create({ id: "TC-3", projectId: "PRJ-1", name: "Always fails", createdAt: now, reviewStatus: "approved", workspaceId: "WS-1" });

// Create two completed runs with results
runRepo.create({
  id: "RUN-1", projectId: "PRJ-1", type: "test_run", status: "completed",
  startedAt: twoHoursAgo, total: 3, passed: 2, failed: 1,
  results: [
    { testId: "TC-1", status: "passed" },
    { testId: "TC-2", status: "passed" },
    { testId: "TC-3", status: "failed", error: "timeout" },
  ],
  workspaceId: "WS-1",
});
runRepo.create({
  id: "RUN-2", projectId: "PRJ-1", type: "test_run", status: "completed",
  startedAt: oneHourAgo, total: 3, passed: 1, failed: 2,
  results: [
    { testId: "TC-1", status: "passed" },
    { testId: "TC-2", status: "failed", error: "assertion" },
    { testId: "TC-3", status: "failed", error: "timeout" },
  ],
  workspaceId: "WS-1",
});

test("computes flaky scores from run history", () => {
  const result = computeAndPersistFlakyScores("PRJ-1");
  assert.ok(result.updated >= 3, "Should update at least 3 tests");
  assert.ok(result.flaky >= 1, "Should detect at least 1 flaky test");

  const tc1 = testRepo.getById("TC-1");
  assert.equal(tc1.flakyScore, 0, "TC-1 always passes — score should be 0");

  const tc2 = testRepo.getById("TC-2");
  assert.equal(tc2.flakyScore, 50, "TC-2 passes once, fails once — score should be 50");

  const tc3 = testRepo.getById("TC-3");
  assert.equal(tc3.flakyScore, 0, "TC-3 always fails — score should be 0");
});

test("returns empty when fewer than 2 runs exist", () => {
  const result = computeAndPersistFlakyScores("PRJ-NONEXISTENT");
  assert.deepEqual(result, { updated: 0, flaky: 0 });
});

test("getTopFlakyTests returns ranked flaky tests", () => {
  const top = getTopFlakyTests(["PRJ-1"], 10);
  assert.ok(top.length >= 1, "Should return at least 1 flaky test");
  assert.equal(top[0].testId, "TC-2", "TC-2 should be the flakiest");
  assert.equal(top[0].flakyScore, 50);
});

test("getTopFlakyTests returns empty for no projects", () => {
  const top = getTopFlakyTests([], 10);
  assert.deepEqual(top, []);
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────
db.exec("DELETE FROM tests");
db.exec("DELETE FROM runs");
db.exec("DELETE FROM run_logs");
db.exec("DELETE FROM projects");

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  flaky-detector tests failed");
  process.exit(1);
}

console.log("\n🎉 flaky-detector tests passed");
