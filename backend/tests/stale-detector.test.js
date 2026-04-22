/**
 * @module tests/stale-detector
 * @description Unit tests for the stale test detection utility (AUTO-013).
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";

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
  db.exec("DELETE FROM projects");
  db.exec("DELETE FROM counters");
  db.exec("INSERT OR REPLACE INTO counters(name, value) VALUES ('test', 0)");
  db.exec("INSERT OR REPLACE INTO counters(name, value) VALUES ('project', 0)");
}

const now = new Date().toISOString();
const longAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(); // 120 days ago
const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();   // 10 days ago

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\n🧪 stale-detector: testRepo stale helpers");

resetDb();

// Create a project
projectRepo.create({ id: "PRJ-1", name: "Test Project", url: "https://example.com", createdAt: now, workspaceId: "WS-1" });

test("findStaleByAge returns tests not run in N days", () => {
  testRepo.create({ id: "TC-1", projectId: "PRJ-1", name: "Old test", createdAt: now, reviewStatus: "approved", lastRunAt: longAgo, workspaceId: "WS-1" });
  testRepo.create({ id: "TC-2", projectId: "PRJ-1", name: "Recent test", createdAt: now, reviewStatus: "approved", lastRunAt: recent, workspaceId: "WS-1" });
  testRepo.create({ id: "TC-3", projectId: "PRJ-1", name: "Never run", createdAt: now, reviewStatus: "approved", lastRunAt: null, workspaceId: "WS-1" });
  testRepo.create({ id: "TC-4", projectId: "PRJ-1", name: "Draft test", createdAt: now, reviewStatus: "draft", lastRunAt: longAgo, workspaceId: "WS-1" });

  const staleIds = testRepo.findStaleByAge(["PRJ-1"], 90);
  assert.ok(staleIds.includes("TC-1"), "TC-1 should be stale (120 days ago)");
  assert.ok(!staleIds.includes("TC-2"), "TC-2 should NOT be stale (10 days ago)");
  assert.ok(staleIds.includes("TC-3"), "TC-3 should be stale (never run)");
  assert.ok(!staleIds.includes("TC-4"), "TC-4 should NOT be stale (draft, not approved)");
});

test("bulkSetStale flags tests correctly", () => {
  testRepo.bulkSetStale(["TC-1", "TC-3"], true);
  const t1 = testRepo.getById("TC-1");
  const t3 = testRepo.getById("TC-3");
  const t2 = testRepo.getById("TC-2");
  assert.equal(t1.isStale, true, "TC-1 should be flagged stale");
  assert.equal(t3.isStale, true, "TC-3 should be flagged stale");
  assert.equal(t2.isStale, false, "TC-2 should NOT be flagged stale");
});

test("clearStaleByProjectIds clears stale flags", () => {
  testRepo.clearStaleByProjectIds(["PRJ-1"]);
  const t1 = testRepo.getById("TC-1");
  const t3 = testRepo.getById("TC-3");
  assert.equal(t1.isStale, false, "TC-1 stale flag should be cleared");
  assert.equal(t3.isStale, false, "TC-3 stale flag should be cleared");
});

test("findStaleByAge returns empty for empty project list", () => {
  const result = testRepo.findStaleByAge([], 90);
  assert.deepEqual(result, []);
});

test("countByReviewStatus includes stale count", () => {
  testRepo.bulkSetStale(["TC-1"], true);
  const counts = testRepo.countByReviewStatus("PRJ-1");
  assert.equal(counts.stale, 1, "Should count 1 stale test");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log("\n⚠️  stale-detector tests failed");
  process.exit(1);
}

console.log("\n🎉 stale-detector tests passed");
