/**
 * @module tests/metric-samples
 * @description Unit tests for metricSamplesRepo + recordMetric helper (MET-001).
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import { insertSample, getSeries, getSeriesByRunId } from "../src/database/repositories/metricSamplesRepo.js";
import { recordMetric } from "../src/utils/recordMetric.js";

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

function resetDb() {
  const db = getDatabase();
  db.exec("DELETE FROM metric_samples WHERE projectId LIKE 'PRJ-MET-%'");
}

console.log("\n── metricSamplesRepo + recordMetric ──");

resetDb();

test("insertSample + getSeries round-trip preserves order and tags", () => {
  insertSample({ projectId: "PRJ-MET-1", metricKey: "healing.savings", ts: 1000, value: 5 });
  insertSample({ projectId: "PRJ-MET-1", metricKey: "healing.savings", ts: 2000, value: 8, tags: { strategy: 2 } });
  insertSample({ projectId: "PRJ-MET-1", metricKey: "healing.savings", ts: 3000, value: 12 });
  const rows = getSeries("PRJ-MET-1", "healing.savings");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.value), [5, 8, 12]);
  assert.deepEqual(rows[1].tags, { strategy: 2 });
  assert.equal(rows[0].tags, null);
});

test("getSeries respects since filter and limit", () => {
  const rows = getSeries("PRJ-MET-1", "healing.savings", { since: 2000 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, 2000);
  const limited = getSeries("PRJ-MET-1", "healing.savings", { limit: 1 });
  assert.equal(limited.length, 1);
});

test("getSeries returns [] for unknown project", () => {
  assert.deepEqual(getSeries("PRJ-MET-DNE", "healing.savings"), []);
});

test("recordMetric inserts numeric value", () => {
  recordMetric("PRJ-MET-2", "webVitals.lcp", 2400, null, 5000);
  const rows = getSeries("PRJ-MET-2", "webVitals.lcp");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 2400);
});

test("recordMetric ignores invalid inputs (no row inserted)", () => {
  recordMetric(null, "x", 1);
  recordMetric("PRJ-MET-3", null, 1);
  recordMetric("PRJ-MET-3", "x", "not-a-number");
  recordMetric("PRJ-MET-3", "x", NaN);
  assert.deepEqual(getSeries("PRJ-MET-3", "x"), []);
});

test("recordMetric coerces numeric strings", () => {
  recordMetric("PRJ-MET-4", "healing.savings", "7.5", { strategy: 1 }, 9000);
  const rows = getSeries("PRJ-MET-4", "healing.savings");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 7.5);
  assert.deepEqual(rows[0].tags, { strategy: 1 });
});

test("getSeriesByRunId filters by tags.runId at the SQL layer", () => {
  // AUTO-022 regression coverage: getEvalRunCases relies on this helper so
  // recent drill-downs don't fall off the oldest-N edge of getSeries().
  // Three rows under runId 'run-A' and two under runId 'run-B'; the helper
  // must return exactly the runId-matching rows regardless of insertion
  // order or row count under the same (projectId, metricKey).
  insertSample({ projectId: "PRJ-MET-5", metricKey: "eval.aggregate", ts: 1000, value: 0.9, tags: { runId: "run-A", caseId: "c1" } });
  insertSample({ projectId: "PRJ-MET-5", metricKey: "eval.aggregate", ts: 1100, value: 0.7, tags: { runId: "run-B", caseId: "c1" } });
  insertSample({ projectId: "PRJ-MET-5", metricKey: "eval.aggregate", ts: 1200, value: 0.95, tags: { runId: "run-A", caseId: "c2" } });
  insertSample({ projectId: "PRJ-MET-5", metricKey: "eval.aggregate", ts: 1300, value: 0.8, tags: { runId: "run-B", caseId: "c2" } });
  insertSample({ projectId: "PRJ-MET-5", metricKey: "eval.aggregate", ts: 1400, value: 1.0, tags: { runId: "run-A", caseId: "c3" } });

  const runA = getSeriesByRunId("PRJ-MET-5", "eval.aggregate", "run-A");
  assert.equal(runA.length, 3);
  // ts ASC ordering — guarantees deterministic per-case reconstruction.
  assert.deepEqual(runA.map((r) => r.ts), [1000, 1200, 1400]);
  assert.deepEqual(runA.map((r) => r.tags.caseId), ["c1", "c2", "c3"]);

  const runB = getSeriesByRunId("PRJ-MET-5", "eval.aggregate", "run-B");
  assert.equal(runB.length, 2);
  assert.deepEqual(runB.map((r) => r.value), [0.7, 0.8]);

  // Unknown runId → empty array, not null.
  assert.deepEqual(getSeriesByRunId("PRJ-MET-5", "eval.aggregate", "run-DNE"), []);
});

test("getSeriesByRunId ignores rows whose tags lack a runId", () => {
  // Rows tagged without a runId (e.g. healing.savings) must not leak into
  // an eval drill-down query against the same metric_samples table.
  insertSample({ projectId: "PRJ-MET-6", metricKey: "eval.aggregate", ts: 2000, value: 0.5, tags: null });
  insertSample({ projectId: "PRJ-MET-6", metricKey: "eval.aggregate", ts: 2100, value: 0.6, tags: { strategy: 2 } });
  insertSample({ projectId: "PRJ-MET-6", metricKey: "eval.aggregate", ts: 2200, value: 0.7, tags: { runId: "run-X" } });
  const rows = getSeriesByRunId("PRJ-MET-6", "eval.aggregate", "run-X");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 0.7);
});

resetDb();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
