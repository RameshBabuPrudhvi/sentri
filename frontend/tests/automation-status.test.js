/**
 * @module tests/automation-status
 * @description Unit tests for the Automation status-chip parsers.
 *
 * These tests pin down the exact backend response shapes consumed by
 * useProjectStatus / useQualityStatus on the Automation page. Three real
 * bugs caught in PR #6 review would have been blocked at this layer:
 *
 *   - schedule.enabled is nested under `data.schedule`, not `data.enabled`
 *   - quality gates live under `data.qualityGates`, not `data.gates`
 *   - web-vitals budgets live under `data.webVitalsBudgets`, not `data.budgets`
 *
 * Plain Node assertions (no framework), matches project test convention.
 *
 * Usage: node frontend/tests/automation-status.test.js
 */

import assert from "node:assert/strict";
import {
  parseTokenCount,
  parseHasSchedule,
  parseHasGates,
  parseHasBudgets,
  isValidPageTab,
  PAGE_TAB_IDS,
} from "../src/utils/automationStatus.js";

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705  ${name}`);
  } catch (err) {
    console.log(`  \u274C  ${name}`);
    console.log(`      ${err.message}`);
    process.exitCode = 1;
  }
}

// ── parseTokenCount ──────────────────────────────────────────────────────────
console.log("\n\uD83E\uDDEA parseTokenCount");

test("returns count from { tokens: [...] }", () => {
  assert.equal(parseTokenCount({ tokens: [{ id: "t1" }, { id: "t2" }] }), 2);
});
test("returns 0 for empty token list", () => {
  assert.equal(parseTokenCount({ tokens: [] }), 0);
});
test("returns 0 for null/undefined response", () => {
  assert.equal(parseTokenCount(null), 0);
  assert.equal(parseTokenCount(undefined), 0);
});
test("returns 0 for malformed (non-array) response", () => {
  assert.equal(parseTokenCount({ tokens: "oops" }), 0);
});

// ── parseHasSchedule ─────────────────────────────────────────────────────────
console.log("\n\uD83E\uDDEA parseHasSchedule");

test("true when data.schedule.enabled is true (real backend shape)", () => {
  assert.equal(parseHasSchedule({ schedule: { enabled: true, cronExpr: "0 * * * *" } }), true);
});
test("false when data.schedule is null (no schedule configured)", () => {
  assert.equal(parseHasSchedule({ schedule: null }), false);
});
test("false when schedule exists but is disabled", () => {
  assert.equal(parseHasSchedule({ schedule: { enabled: false } }), false);
});
test("regression: top-level data.enabled must NOT count as configured", () => {
  // The original bug: code read data?.enabled instead of data?.schedule?.enabled.
  assert.equal(parseHasSchedule({ enabled: true }), false);
});

// ── parseHasGates ────────────────────────────────────────────────────────────
console.log("\n\uD83E\uDDEA parseHasGates");

test("true when data.qualityGates has any non-empty value", () => {
  assert.equal(parseHasGates({ qualityGates: { minPassRate: 90 } }), true);
});
test("false when data.qualityGates is null", () => {
  assert.equal(parseHasGates({ qualityGates: null }), false);
});
test("false when all gate values are empty strings or null", () => {
  assert.equal(parseHasGates({ qualityGates: { minPassRate: "", maxFailures: null } }), false);
});
test("regression: data.gates wrapper must be ignored (key is qualityGates)", () => {
  // Original bug: code read data?.gates which always returned undefined,
  // then fell back to the entire response wrapper.
  assert.equal(parseHasGates({ gates: { minPassRate: 90 } }), false);
});

// ── parseHasBudgets ──────────────────────────────────────────────────────────
console.log("\n\uD83E\uDDEA parseHasBudgets");

test("true when data.webVitalsBudgets has any non-empty value", () => {
  assert.equal(parseHasBudgets({ webVitalsBudgets: { lcp: 2500 } }), true);
});
test("false when data.webVitalsBudgets is null", () => {
  assert.equal(parseHasBudgets({ webVitalsBudgets: null }), false);
});
test("false when all budget values are empty", () => {
  assert.equal(parseHasBudgets({ webVitalsBudgets: { lcp: "", cls: null, inp: undefined } }), false);
});
test("regression: data.budgets wrapper must be ignored (key is webVitalsBudgets)", () => {
  assert.equal(parseHasBudgets({ budgets: { lcp: 2500 } }), false);
});

// ── isValidPageTab / tab-switching contract ──────────────────────────────────
console.log("\n\uD83E\uDDEA isValidPageTab");

test("accepts all four documented tab ids", () => {
  for (const id of ["triggers", "quality", "integrations", "snippets"]) {
    assert.equal(isValidPageTab(id), true, `expected '${id}' to be valid`);
  }
});
test("rejects unknown ids (would-be deep-link injection)", () => {
  assert.equal(isValidPageTab("admin"), false);
  assert.equal(isValidPageTab(""), false);
  assert.equal(isValidPageTab(null), false);
});
test("PAGE_TAB_IDS preserves the documented order", () => {
  assert.deepEqual(PAGE_TAB_IDS, ["triggers", "quality", "integrations", "snippets"]);
});

// ── Summary ──────────────────────────────────────────────────────────────────
if (process.exitCode) {
  console.log("\n\u26A0\uFE0F  Some automation-status tests failed");
  process.exit(1);
}
console.log("\n\uD83C\uDF89 All automation-status tests passed");
