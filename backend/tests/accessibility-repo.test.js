/**
 * @module tests/accessibility-repo
 * @description Unit tests for accessibilityViolationRepo (AUTO-016).
 *
 * Covers:
 *   - bulkCreate() inserts rows and returns count
 *   - bulkCreate([]) returns 0 and inserts nothing
 *   - getByRunId() returns rows ordered by pageUrl ASC, ruleId ASC
 *   - getByRunAndPage() filters by (runId, pageUrl)
 *   - cascade delete: removing the parent run deletes its violations
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import * as accessibilityViolationRepo from "../src/database/repositories/accessibilityViolationRepo.js";
import * as runRepo from "../src/database/repositories/runRepo.js";
import * as projectRepo from "../src/database/repositories/projectRepo.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _ctr = 9000;
const uid = (prefix) => `${prefix}-A11Y-${++_ctr}`;

function makeProject(overrides = {}) {
  const id = uid("PRJ");
  return { id, name: `A11y Project ${id}`, url: "https://example.com",
    createdAt: new Date().toISOString(), status: "idle", ...overrides };
}

function makeRun(projectId, overrides = {}) {
  const id = uid("RUN");
  return { id, projectId, type: "test_run", status: "completed",
    startedAt: new Date().toISOString(), logs: [], tests: [], results: [],
    passed: 0, failed: 0, total: 0, ...overrides };
}

function makeViolation(runId, pageUrl, ruleId, overrides = {}) {
  return {
    runId,
    pageUrl,
    ruleId,
    impact: "serious",
    wcagCriterion: "wcag2aa",
    help: `Help for ${ruleId}`,
    description: `Description for ${ruleId}`,
    nodesJson: JSON.stringify([{ html: "<div/>" }]),
    ...overrides,
  };
}

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM accessibility_violations WHERE runId LIKE 'RUN-A11Y-%'");
  db.exec("DELETE FROM runs                     WHERE id    LIKE 'RUN-A11Y-%'");
  db.exec("DELETE FROM projects                 WHERE id    LIKE 'PRJ-A11Y-%'");
}

function countViolations(runId) {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) AS n FROM accessibility_violations WHERE runId = ?").get(runId).n;
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
const proj = makeProject();
projectRepo.create(proj);

console.log("\n── accessibilityViolationRepo ──");

// ─── Tests ────────────────────────────────────────────────────────────────────

test("bulkCreate returns 0 for empty array and inserts nothing", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  const inserted = accessibilityViolationRepo.bulkCreate([]);
  assert.equal(inserted, 0);
  assert.equal(countViolations(run.id), 0);
  runRepo.hardDeleteById(run.id);
});

test("bulkCreate returns 0 for non-array input", () => {
  assert.equal(accessibilityViolationRepo.bulkCreate(null), 0);
  assert.equal(accessibilityViolationRepo.bulkCreate(undefined), 0);
});

test("bulkCreate inserts rows and returns count", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  const rows = [
    makeViolation(run.id, "https://example.com/a", "color-contrast"),
    makeViolation(run.id, "https://example.com/a", "label"),
    makeViolation(run.id, "https://example.com/b", "image-alt"),
  ];
  const n = accessibilityViolationRepo.bulkCreate(rows);
  assert.equal(n, 3);
  assert.equal(countViolations(run.id), 3);
  runRepo.hardDeleteById(run.id);
});

test("bulkCreate applies safe defaults for missing fields", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  accessibilityViolationRepo.bulkCreate([
    { runId: run.id, pageUrl: "https://example.com/", ruleId: "rule-x" },
  ]);
  const [row] = accessibilityViolationRepo.getByRunId(run.id);
  assert.equal(row.impact, null);
  assert.equal(row.wcagCriterion, null);
  assert.equal(row.help, "");
  assert.equal(row.description, "");
  assert.equal(row.nodesJson, "[]");
  assert.ok(row.createdAt);
  runRepo.hardDeleteById(run.id);
});

test("getByRunId returns rows ordered by pageUrl ASC, ruleId ASC", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  accessibilityViolationRepo.bulkCreate([
    makeViolation(run.id, "https://example.com/b", "label"),
    makeViolation(run.id, "https://example.com/a", "label"),
    makeViolation(run.id, "https://example.com/a", "color-contrast"),
  ]);
  const rows = accessibilityViolationRepo.getByRunId(run.id);
  assert.deepEqual(
    rows.map(r => [r.pageUrl, r.ruleId]),
    [
      ["https://example.com/a", "color-contrast"],
      ["https://example.com/a", "label"],
      ["https://example.com/b", "label"],
    ]
  );
  runRepo.hardDeleteById(run.id);
});

test("getByRunId returns empty array for unknown runId", () => {
  assert.deepEqual(accessibilityViolationRepo.getByRunId("RUN-DOES-NOT-EXIST"), []);
});

test("getByRunAndPage filters by (runId, pageUrl) and orders by ruleId", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  accessibilityViolationRepo.bulkCreate([
    makeViolation(run.id, "https://example.com/a", "label"),
    makeViolation(run.id, "https://example.com/a", "color-contrast"),
    makeViolation(run.id, "https://example.com/b", "image-alt"),
  ]);
  const rows = accessibilityViolationRepo.getByRunAndPage(run.id, "https://example.com/a");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.ruleId), ["color-contrast", "label"]);
  // Different page returns only its violations
  const rowsB = accessibilityViolationRepo.getByRunAndPage(run.id, "https://example.com/b");
  assert.equal(rowsB.length, 1);
  assert.equal(rowsB[0].ruleId, "image-alt");
  runRepo.hardDeleteById(run.id);
});

test("violations cascade-delete when parent run is removed", () => {
  const run = makeRun(proj.id);
  runRepo.create(run);
  accessibilityViolationRepo.bulkCreate([
    makeViolation(run.id, "https://example.com/", "label"),
    makeViolation(run.id, "https://example.com/", "color-contrast"),
  ]);
  assert.equal(countViolations(run.id), 2);
  runRepo.hardDeleteById(run.id);
  assert.equal(countViolations(run.id), 0);
});

// ─── Teardown ─────────────────────────────────────────────────────────────────

resetDb();

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
