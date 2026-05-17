/**
 * @module tests/eval-persistence
 * @description AUTO-022 — verifies persistEvalRun() writes the expected
 * `metric_samples` rows. Pinned to the EVAL_HARNESS_PROJECT_ID sentinel so
 * a parallel real-project test can never collide with this suite's rows.
 */

import assert from "node:assert/strict";
import { getDatabase } from "../src/database/sqlite.js";
import { insertSamples, getSeries } from "../src/database/repositories/metricSamplesRepo.js";
import {
  persistEvalRun,
  getEvalTrend,
  getEvalRunCases,
  EVAL_HARNESS_PROJECT_ID,
  EVAL_METRIC_KEYS,
} from "../src/eval/evalPersistence.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

function resetEvalRows() {
  const db = getDatabase();
  db.exec(`DELETE FROM metric_samples WHERE projectId = '${EVAL_HARNESS_PROJECT_ID}'`);
}

function buildCases() {
  return [
    { caseId: "case-001", category: "form-fill", actual: "await page.click('save');", score: { aggregate: 0.9, selectors: 0.95, actions: 0.85, assertions: 0.9 } },
    { caseId: "case-002", category: "modal",     actual: "await page.click('confirm');", score: { aggregate: 0.7, selectors: 0.6,  actions: 0.8,  assertions: 0.7 } },
    { caseId: "case-003", category: "list-click", actual: "await page.click('row');",    score: { aggregate: 1.0, selectors: 1.0,  actions: 1.0,  assertions: 1.0 } },
  ];
}

console.log("\n── eval persistence (AUTO-022) ──");

resetEvalRows();

test("persistEvalRun writes 4 rows per case in a single transaction", () => {
  const cases = buildCases();
  const { runId, rowsWritten } = persistEvalRun({ cases });
  assert.ok(runId, "expected a synthesised runId");
  assert.equal(rowsWritten, 12, "3 cases × 4 dimensions = 12 rows");
});

test("each dimension writes under its dedicated metricKey", () => {
  const aggregate = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.aggregate);
  const selectors = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.selectors);
  const actions = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.actions);
  const assertions = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.assertions);
  assert.equal(aggregate.length, 3);
  assert.equal(selectors.length, 3);
  assert.equal(actions.length, 3);
  assert.equal(assertions.length, 3);
  assert.deepEqual(aggregate.map((r) => r.value).sort(), [0.7, 0.9, 1.0]);
});

test("tags carry runId, caseId, category", () => {
  const rows = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.aggregate);
  for (const r of rows) {
    assert.ok(r.tags, "tags must be present");
    assert.ok(r.tags.runId, "tag runId required for Dashboard grouping");
    assert.ok(r.tags.caseId, "tag caseId required for drill-down");
    assert.ok(r.tags.category, "tag category required for category breakdown");
  }
});

test("all rows of one run share the same runId", () => {
  resetEvalRows();
  const { runId } = persistEvalRun({ cases: buildCases() });
  const allKeys = Object.values(EVAL_METRIC_KEYS);
  const allRows = allKeys.flatMap((k) => getSeries(EVAL_HARNESS_PROJECT_ID, k));
  assert.equal(allRows.length, 12);
  for (const r of allRows) {
    assert.equal(r.tags.runId, runId, "every row of one run must carry the same runId");
  }
});

test("two consecutive runs write distinct runIds", () => {
  resetEvalRows();
  const a = persistEvalRun({ cases: buildCases() });
  const b = persistEvalRun({ cases: buildCases() });
  assert.notEqual(a.runId, b.runId, "consecutive runs must mint distinct runIds");
  const aggregate = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.aggregate);
  const runIds = new Set(aggregate.map((r) => r.tags.runId));
  assert.equal(runIds.size, 2);
});

test("empty cases array writes nothing and returns rowsWritten=0", () => {
  resetEvalRows();
  const { runId, rowsWritten } = persistEvalRun({ cases: [] });
  assert.equal(rowsWritten, 0);
  assert.equal(runId, null);
  assert.equal(getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.aggregate).length, 0);
});

test("explicit runId override is honoured", () => {
  resetEvalRows();
  const { runId } = persistEvalRun({ cases: buildCases().slice(0, 1), runId: "fixed-eval-run-id" });
  assert.equal(runId, "fixed-eval-run-id");
  const [row] = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.aggregate);
  assert.equal(row.tags.runId, "fixed-eval-run-id");
});

test("explicit ts override applies to every row", () => {
  resetEvalRows();
  persistEvalRun({ cases: buildCases(), ts: 1717_000_000_000 });
  const allKeys = Object.values(EVAL_METRIC_KEYS);
  const allRows = allKeys.flatMap((k) => getSeries(EVAL_HARNESS_PROJECT_ID, k));
  for (const r of allRows) {
    assert.equal(r.ts, 1717_000_000_000, "ts override must propagate to every row");
  }
});

test("insertSamples noop on empty array", () => {
  // Repo-level guard — `persistEvalRun` already short-circuits but double-check
  // the underlying primitive so a future caller can't trip a "no rows in
  // transaction" sqlite edge case.
  insertSamples([]);
  insertSamples(null);
  insertSamples(undefined);
});

test("actual is persisted on the aggregate row only and round-trips via getEvalRunCases", () => {
  resetEvalRows();
  const { runId } = persistEvalRun({ cases: buildCases() });
  // Read back via the drill-down helper — the aggregate row tags should
  // carry `actual` while the dimension rows must not.
  const aggregateRow = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.aggregate)
    .find((r) => r.tags?.caseId === "case-001");
  const selectorRow = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.selectors)
    .find((r) => r.tags?.caseId === "case-001");
  assert.equal(aggregateRow.tags.actual, "await page.click('save');");
  assert.equal(selectorRow.tags.actual, undefined, "dimension rows must not carry actual");

  const detail = getEvalRunCases(runId);
  assert.equal(detail.runId, runId);
  assert.equal(detail.cases.length, 3);
  const c1 = detail.cases.find((c) => c.caseId === "case-001");
  assert.equal(c1.actual, "await page.click('save');");
  assert.equal(c1.score.aggregate, 0.9);
  assert.equal(c1.score.selectors, 0.95);
  assert.equal(c1.category, "form-fill");
});

test("actual is truncated above the 4 KB cap", () => {
  resetEvalRows();
  const oversize = "x".repeat(8 * 1024); // 8 KB — twice the cap
  persistEvalRun({
    cases: [
      { caseId: "case-big", category: "form-fill", actual: oversize, score: { aggregate: 0.5, selectors: 0.5, actions: 0.5, assertions: 0.5 } },
    ],
  });
  const row = getSeries(EVAL_HARNESS_PROJECT_ID, EVAL_METRIC_KEYS.aggregate)[0];
  assert.ok(row.tags.actual.length <= 4 * 1024, `expected ≤ 4096 chars, got ${row.tags.actual.length}`);
});

test("getEvalTrend buckets per-run, returns mean per dimension, sorts ascending", () => {
  resetEvalRows();
  // Two distinct runs separated by 1 second so the sort order is stable.
  persistEvalRun({ cases: buildCases(), ts: 1_700_000_000_000 });
  persistEvalRun({ cases: buildCases(), ts: 1_700_000_001_000 });
  const trend = getEvalTrend({ windowDays: 365 });
  assert.equal(trend.length, 2);
  // Sorted ascending by createdAt.
  assert.ok(new Date(trend[0].createdAt) < new Date(trend[1].createdAt));
  // Aggregate mean = (0.9 + 0.7 + 1.0) / 3 ≈ 0.8667.
  for (const run of trend) {
    assert.ok(Math.abs(run.aggregate - (0.9 + 0.7 + 1.0) / 3) < 1e-9);
    assert.equal(run.caseCount, 3);
    assert.ok(run.runId);
  }
});

test("getEvalTrend returns [] when no rows exist", () => {
  resetEvalRows();
  assert.deepEqual(getEvalTrend(), []);
});

test("getEvalRunCases returns null for unknown runId", () => {
  resetEvalRows();
  persistEvalRun({ cases: buildCases() });
  assert.equal(getEvalRunCases("nonexistent-run-id"), null);
  assert.equal(getEvalRunCases(""), null);
  assert.equal(getEvalRunCases(null), null);
});

resetEvalRows();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
