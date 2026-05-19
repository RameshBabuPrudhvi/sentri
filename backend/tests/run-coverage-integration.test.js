import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRunCoverage } from "../src/pipeline/coverageAggregator.js";

test("coverage summary shape contains required AUTO-009 fields", () => {
  const text = "line1\nline2\nline3\n";
  const summary = aggregateRunCoverage([
    { testId: "T1", jsCoverage: [{ url: "https://app.example.com/main.js", text, ranges: [{ start: 0, end: 8 }] }] },
  ], { sutOrigin: "https://app.example.com" });

  assert.equal(typeof summary.totalLines, "number");
  assert.equal(typeof summary.coveredLines, "number");
  assert.equal(typeof summary.coveragePct, "number");
  assert.ok(Array.isArray(summary.perTest));
  assert.ok(Array.isArray(summary.topUncoveredFiles));
  assert.equal(summary.sourceMapStatus, "fallback");
});

