/**
 * @module tests/soft-delete
 * @description Unit tests for ENH-020 soft-delete on testRepo, runRepo, and projectRepo,
 * and for ENH-010 pagination helpers (parsePagination) in testRepo and runRepo.
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";
import * as testRepo from "../src/database/repositories/testRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import { parsePagination } from "../src/database/repositories/testRepo.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let projectCounter = 9000;
let testCounter    = 9000;
let runCounter     = 9000;

function makeProject(overrides = {}) {
  const id = `PRJ-SD-${++projectCounter}`;
  return { id, name: `SD Project ${id}`, url: "https://example.com", createdAt: new Date().toISOString(), status: "idle", ...overrides };
}

function makeTest(projectId, overrides = {}) {
  const id = `TC-SD-${++testCounter}`;
  return {
    id, projectId, name: `SD Test ${id}`,
    description: "soft-delete test", steps: [], tags: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    reviewStatus: "draft", priority: "medium", codeVersion: 0,
    isJourneyTest: false, assertionEnhanced: false,
    ...overrides,
  };
}

function makeRun(projectId, overrides = {}) {
  const id = `RUN-SD-${++runCounter}`;
  return {
    id, projectId, type: "test_run", status: "completed",
    startedAt: new Date().toISOString(), logs: [], tests: [], results: [],
    passed: 1, failed: 0, total: 1,
    ...overrides,
  };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM healing_history");
  db.exec("DELETE FROM activities");
  // Delete rows matching our test-specific prefixes only to avoid interfering
  // with other test runs that share the same in-memory DB.
  db.exec("DELETE FROM runs     WHERE id LIKE 'RUN-SD-%'");
  db.exec("DELETE FROM tests    WHERE id LIKE 'TC-SD-%'");
  db.exec("DELETE FROM projects WHERE id LIKE 'PRJ-SD-%'");
}

// ─── Test runner ──────────────────────────────────────────────────────────────

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

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
  }
}

resetDb();

// ─── parsePagination ──────────────────────────────────────────────────────────

console.log("\n🧪 parsePagination");

test("defaults to page=1, pageSize=50", () => {
  const r = parsePagination(undefined, undefined);
  assert.equal(r.page, 1);
  assert.equal(r.pageSize, 50);
  assert.equal(r.offset, 0);
});

test("parses valid numbers", () => {
  const r = parsePagination("3", "10");
  assert.equal(r.page, 3);
  assert.equal(r.pageSize, 10);
  assert.equal(r.offset, 20);
});

test("clamps page to minimum 1", () => {
  const r = parsePagination("-5", "10");
  assert.equal(r.page, 1);
});

test("clamps pageSize to maximum 200", () => {
  const r = parsePagination("1", "999");
  assert.equal(r.pageSize, 200);
});

test("clamps pageSize to minimum 1", () => {
  const r = parsePagination("1", "0");
  assert.equal(r.pageSize, 1);
});

test("non-numeric strings fall back to defaults", () => {
  const r = parsePagination("abc", "xyz");
  assert.equal(r.page, 1);
  assert.equal(r.pageSize, 50);
});

// ─── projectRepo soft-delete ──────────────────────────────────────────────────

console.log("\n🧪 projectRepo — soft-delete");

test("create then getById returns project", () => {
  const p = makeProject();
  projectRepo.create(p);
  const found = projectRepo.getById(p.id);
  assert.ok(found, "should find project");
  assert.equal(found.id, p.id);
  assert.equal(found.deletedAt, null);
});

test("deleteById soft-deletes: getById returns undefined", () => {
  const p = makeProject();
  projectRepo.create(p);
  projectRepo.deleteById(p.id);
  const found = projectRepo.getById(p.id);
  assert.equal(found, undefined, "getById should not return soft-deleted project");
});

test("deleteById soft-deletes: getByIdIncludeDeleted returns the row with deletedAt set", () => {
  const p = makeProject();
  projectRepo.create(p);
  projectRepo.deleteById(p.id);
  const found = projectRepo.getByIdIncludeDeleted(p.id);
  assert.ok(found, "getByIdIncludeDeleted should return the row");
  assert.ok(found.deletedAt, "deletedAt should be set");
});

test("getAll excludes soft-deleted projects", () => {
  const p = makeProject();
  projectRepo.create(p);
  projectRepo.deleteById(p.id);
  const all = projectRepo.getAll();
  assert.ok(!all.find(x => x.id === p.id), "getAll should not include deleted project");
});

test("getDeletedAll includes soft-deleted projects", () => {
  const p = makeProject();
  projectRepo.create(p);
  projectRepo.deleteById(p.id);
  const deleted = projectRepo.getDeletedAll();
  assert.ok(deleted.find(x => x.id === p.id), "getDeletedAll should include the deleted project");
});

test("restore clears deletedAt and project reappears in getAll", () => {
  const p = makeProject();
  projectRepo.create(p);
  projectRepo.deleteById(p.id);
  const ok = projectRepo.restore(p.id);
  assert.ok(ok, "restore should return true");
  const found = projectRepo.getById(p.id);
  assert.ok(found, "should find restored project via getById");
  assert.equal(found.deletedAt, null);
});

test("restore returns false for non-existent id", () => {
  const ok = projectRepo.restore("PRJ-SD-NONEXISTENT");
  assert.equal(ok, false);
});

test("hardDeleteById permanently removes the row", () => {
  const p = makeProject();
  projectRepo.create(p);
  projectRepo.deleteById(p.id);
  projectRepo.hardDeleteById(p.id);
  const found = projectRepo.getByIdIncludeDeleted(p.id);
  assert.equal(found, undefined, "row should be gone after hard delete");
});

// ─── testRepo soft-delete ─────────────────────────────────────────────────────

console.log("\n🧪 testRepo — soft-delete");

const sharedProject = makeProject();
projectRepo.create(sharedProject);

test("deleteById soft-deletes a test", () => {
  const t = makeTest(sharedProject.id);
  testRepo.create(t);
  testRepo.deleteById(t.id);
  assert.equal(testRepo.getById(t.id), undefined, "getById should not return soft-deleted test");
});

test("getByIdIncludeDeleted returns soft-deleted test with deletedAt set", () => {
  const t = makeTest(sharedProject.id);
  testRepo.create(t);
  testRepo.deleteById(t.id);
  const found = testRepo.getByIdIncludeDeleted(t.id);
  assert.ok(found, "should find via getByIdIncludeDeleted");
  assert.ok(found.deletedAt, "deletedAt should be set");
});

test("getByProjectId excludes soft-deleted tests", () => {
  const t = makeTest(sharedProject.id);
  testRepo.create(t);
  testRepo.deleteById(t.id);
  const all = testRepo.getByProjectId(sharedProject.id);
  assert.ok(!all.find(x => x.id === t.id), "deleted test should not appear in getByProjectId");
});

test("getDeletedByProjectId lists soft-deleted tests for a project", () => {
  const t = makeTest(sharedProject.id);
  testRepo.create(t);
  testRepo.deleteById(t.id);
  const deleted = testRepo.getDeletedByProjectId(sharedProject.id);
  assert.ok(deleted.find(x => x.id === t.id), "deleted test should appear in getDeletedByProjectId");
});

test("restore brings test back to getByProjectId", () => {
  const t = makeTest(sharedProject.id);
  testRepo.create(t);
  testRepo.deleteById(t.id);
  testRepo.restore(t.id);
  const found = testRepo.getById(t.id);
  assert.ok(found, "restored test should be found by getById");
  assert.equal(found.deletedAt, null);
});

test("deleteByProjectId soft-deletes all tests for a project", () => {
  const p2 = makeProject();
  projectRepo.create(p2);
  const t1 = makeTest(p2.id);
  const t2 = makeTest(p2.id);
  testRepo.create(t1);
  testRepo.create(t2);
  const ids = testRepo.deleteByProjectId(p2.id);
  assert.equal(ids.length, 2, "should return 2 soft-deleted IDs");
  assert.equal(testRepo.getByProjectId(p2.id).length, 0, "getByProjectId should return empty");
});

test("hardDeleteByProjectId permanently removes tests", () => {
  const p3 = makeProject();
  projectRepo.create(p3);
  const t = makeTest(p3.id);
  testRepo.create(t);
  testRepo.hardDeleteByProjectId(p3.id);
  assert.equal(testRepo.getByIdIncludeDeleted(t.id), undefined, "row should be gone");
});

test("countApproved excludes soft-deleted tests", () => {
  const p4 = makeProject();
  projectRepo.create(p4);
  const t = makeTest(p4.id, { reviewStatus: "approved" });
  testRepo.create(t);
  const before = testRepo.countApproved();
  testRepo.deleteById(t.id);
  const after = testRepo.countApproved();
  assert.equal(after, before - 1, "countApproved should decrease after soft-delete");
});

// ─── testRepo pagination ──────────────────────────────────────────────────────

console.log("\n🧪 testRepo — pagination");

test("getByProjectIdPaged returns correct meta for single page", () => {
  const p = makeProject();
  projectRepo.create(p);
  // Create exactly 3 tests
  for (let i = 0; i < 3; i++) testRepo.create(makeTest(p.id));
  const result = testRepo.getByProjectIdPaged(p.id, 1, 10);
  assert.equal(result.data.length, 3);
  assert.equal(result.meta.total, 3);
  assert.equal(result.meta.hasMore, false);
  assert.equal(result.meta.page, 1);
});

test("getByProjectIdPaged paginates correctly", () => {
  const p = makeProject();
  projectRepo.create(p);
  for (let i = 0; i < 5; i++) testRepo.create(makeTest(p.id));
  const page1 = testRepo.getByProjectIdPaged(p.id, 1, 2);
  assert.equal(page1.data.length, 2);
  assert.equal(page1.meta.hasMore, true);
  const page3 = testRepo.getByProjectIdPaged(p.id, 3, 2);
  assert.equal(page3.data.length, 1, "last page has 1 remaining item");
  assert.equal(page3.meta.hasMore, false);
});

test("getByProjectIdPaged excludes soft-deleted tests", () => {
  const p = makeProject();
  projectRepo.create(p);
  const t1 = makeTest(p.id);
  const t2 = makeTest(p.id);
  testRepo.create(t1);
  testRepo.create(t2);
  testRepo.deleteById(t1.id);
  const result = testRepo.getByProjectIdPaged(p.id, 1, 50);
  assert.equal(result.meta.total, 1, "total should exclude soft-deleted test");
  assert.equal(result.data.length, 1);
});

// ─── runRepo soft-delete ──────────────────────────────────────────────────────

console.log("\n🧪 runRepo — soft-delete");

const runProject = makeProject();
projectRepo.create(runProject);

test("run deleteByProjectId soft-deletes runs", () => {
  const r1 = makeRun(runProject.id);
  const r2 = makeRun(runProject.id);
  runRepo.create(r1);
  runRepo.create(r2);
  const ids = runRepo.deleteByProjectId(runProject.id);
  assert.ok(ids.length >= 2, "should return at least 2 IDs");
  const liveRuns = runRepo.getByProjectId(runProject.id);
  assert.ok(!liveRuns.find(x => x.id === r1.id), "r1 should not appear in getByProjectId");
});

test("run getByIdIncludeDeleted returns soft-deleted run", () => {
  const r = makeRun(runProject.id);
  runRepo.create(r);
  runRepo.deleteByProjectId(runProject.id);
  const found = runRepo.getByIdIncludeDeleted(r.id);
  assert.ok(found, "should find soft-deleted run via getByIdIncludeDeleted");
  assert.ok(found.deletedAt, "deletedAt should be set");
});

test("run restore re-exposes the run", () => {
  const r = makeRun(runProject.id);
  runRepo.create(r);
  runRepo.deleteByProjectId(runProject.id);
  runRepo.restore(r.id);
  const found = runRepo.getById(r.id);
  assert.ok(found, "restored run should be visible via getById");
});

test("getByProjectIdPaged respects soft-delete", () => {
  const p = makeProject();
  projectRepo.create(p);
  const r1 = makeRun(p.id);
  const r2 = makeRun(p.id);
  runRepo.create(r1);
  runRepo.create(r2);
  runRepo.deleteByProjectId(p.id);
  const result = runRepo.getByProjectIdPaged(p.id, 1, 50);
  assert.equal(result.meta.total, 0, "paged total should be 0 after soft-delete");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
