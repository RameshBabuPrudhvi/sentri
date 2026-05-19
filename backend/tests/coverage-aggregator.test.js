import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRunCoverage } from "../src/pipeline/coverageAggregator.js";

test("aggregateRunCoverage computes per-test deltas without double-counting", () => {
  const text = "a\nb\nc\nd\n";
  const r1 = { testId: "T1", jsCoverage: [{ url: "https://app.example.com/a.js", text, ranges: [{ start: 0, end: 3 }] }] };
  const r2 = { testId: "T2", jsCoverage: [{ url: "https://app.example.com/a.js", text, ranges: [{ start: 0, end: 3 }] }] };
  const out = aggregateRunCoverage([r1, r2], { sutOrigin: "https://app.example.com" });
  assert.equal(out.perTest[0].deltaLines > 0, true);
  assert.equal(out.perTest[1].deltaLines, 0);
  assert.equal(out.sourceMapStatus, "fallback");
});

test("aggregateRunCoverage filters third-party scripts", () => {
  const text = "a\nb\n";
  const out = aggregateRunCoverage([
    { testId: "T1", jsCoverage: [{ url: "https://cdn.third.com/lib.js", text, ranges: [{ start: 0, end: 2 }] }] },
  ], { sutOrigin: "https://app.example.com" });
  assert.equal(out.totalLines, 0);
  assert.equal(out.coveredLines, 0);
});

