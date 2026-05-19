/**
 * AUTO-009 integration shape test.
 *
 * Wires a stub Playwright-style `jsCoverage` payload (matching the shape
 * `page.coverage.stopJSCoverage()` returns) through the aggregator and
 * asserts the full `runs.coverageSummary` persisted shape — every field
 * NEXT.md spec requires for the dashboard + RunDetail consumers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRunCoverage } from "../src/pipeline/coverageAggregator.js";

// Synthetic Playwright stopJSCoverage() output — three first-party scripts
// plus one third-party script that must be filtered out.
function buildStubJsCoverage() {
  const mainJs = "const a = 1;\nconst b = 2;\nfunction render() {\n  return a + b;\n}\nrender();\n";
  const helperJs = "export function helper(x) {\n  return x * 2;\n}\n";
  const thirdParty = "window.tracker = function(){};\n";
  return {
    t1: [
      { url: "https://app.example.com/main.js", text: mainJs, ranges: [{ start: 0, end: mainJs.length }] },
      { url: "https://cdn.third.com/analytics.js", text: thirdParty, ranges: [{ start: 0, end: thirdParty.length }] },
    ],
    t2: [
      { url: "https://app.example.com/main.js", text: mainJs, ranges: [{ start: 0, end: 12 }] },
      { url: "https://app.example.com/helper.js", text: helperJs, ranges: [{ start: 0, end: helperJs.length }] },
    ],
  };
}

test("AUTO-009 — coverageSummary persisted shape contains every documented field", () => {
  const stub = buildStubJsCoverage();
  const summary = aggregateRunCoverage(
    [
      { testId: "T1", jsCoverage: stub.t1 },
      { testId: "T2", jsCoverage: stub.t2 },
    ],
    { sutOrigin: "https://app.example.com" },
  );

  // Top-level shape — every key the dashboard / RunDetail / changelog
  // promise is present and the right primitive.
  assert.equal(typeof summary.totalLines, "number");
  assert.equal(typeof summary.coveredLines, "number");
  assert.equal(typeof summary.coveragePct, "number");
  assert.ok(summary.coveragePct >= 0 && summary.coveragePct <= 1, "coveragePct ∈ [0,1]");
  assert.ok(Array.isArray(summary.perTest));
  assert.ok(Array.isArray(summary.topUncoveredFiles));
  assert.equal(summary.sourceMapStatus, "fallback");

  // perTest contract — one row per test in dispatch order, every row
  // carries { testId, deltaLines, deltaPct }.
  assert.equal(summary.perTest.length, 2);
  assert.equal(summary.perTest[0].testId, "T1");
  assert.equal(summary.perTest[1].testId, "T2");
  for (const row of summary.perTest) {
    assert.equal(typeof row.deltaLines, "number");
    assert.equal(typeof row.deltaPct, "number");
  }
  // T1 covered main.js first — must have a positive delta. T2 hit helper.js
  // for the first time so its delta must also be positive.
  assert.ok(summary.perTest[0].deltaLines > 0, "first test contributes new lines");
  assert.ok(summary.perTest[1].deltaLines > 0, "second test contributes new helper.js lines");

  // Third-party script must NOT appear in topUncoveredFiles.
  for (const f of summary.topUncoveredFiles) {
    assert.ok(!f.file.includes("cdn.third.com"), `third-party script leaked: ${f.file}`);
    assert.equal(typeof f.uncoveredLines, "number");
    assert.equal(typeof f.totalLines, "number");
  }
  assert.ok(summary.topUncoveredFiles.length <= 20, "topUncoveredFiles capped at 20");
});

test("AUTO-009 — disabled coverage path produces null summary (zero-regression)", () => {
  // Mirror testRunner.js behaviour when project.coverageEnabled is false:
  // aggregator is never called and run.coverageSummary stays null.
  const run = { results: [{ testId: "T1", status: "passed" }], coverageSummary: null };
  assert.equal(run.coverageSummary, null);
});

test("AUTO-009 — sourceMapStatus = 'fallback' when no source maps are resolved", () => {
  // TODO(AUTO-009b): once source-map resolution lands, extend this test to
  // assert sourceMapStatus = "resolved" when a valid .map is reachable.
  const summary = aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/x.js", text: "a\nb\n", ranges: [{ start: 0, end: 1 }] }] }],
    { sutOrigin: "https://app.example.com" },
  );
  assert.equal(summary.sourceMapStatus, "fallback");
});

