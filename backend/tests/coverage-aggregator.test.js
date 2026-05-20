/**
 * AUTO-009 — pure-function unit tests for the browser coverage aggregator.
 *
 * Follows REVIEW.md § Backend Test Conventions: direct `node:assert/strict`
 * calls, no `node:test` framework import (matches `failure-clusterer.test.js`
 * + `risk-scorer.test.js` etc.). The runner in `run-tests.js` requires each
 * test file to print "<file> passed" on success and exit non-zero on any
 * assertion failure.
 */
import assert from "node:assert/strict";
import { aggregateRunCoverage } from "../src/pipeline/coverageAggregator.js";

async function main() {
  // ── deltaLines dedup ────────────────────────────────────────────────────
  // Two tests exercising identical lines: the first contributes a positive
  // delta, the second sees zero (catches duplicate-coverage AI tests per
  // NEXT.md acceptance criterion).
  {
    const text = "a\nb\nc\nd\n";
    const r1 = { testId: "T1", jsCoverage: [{ url: "https://app.example.com/a.js", text, ranges: [{ start: 0, end: 3 }] }] };
    const r2 = { testId: "T2", jsCoverage: [{ url: "https://app.example.com/a.js", text, ranges: [{ start: 0, end: 3 }] }] };
    const out = await aggregateRunCoverage([r1, r2], { sutOrigin: "https://app.example.com" });
    assert.ok(out.perTest[0].deltaLines > 0, "first test must contribute new lines");
    assert.equal(out.perTest[1].deltaLines, 0, "second test on identical ranges sees zero delta");
    assert.equal(out.sourceMapStatus, "fallback", "no resolver supplied → sourceMapStatus stays fallback");
  }

  // ── Third-party origin filter ───────────────────────────────────────────
  // CDN scripts loaded from a different origin must NOT pollute SUT totals.
  {
    const out = await aggregateRunCoverage(
      [{ testId: "T1", jsCoverage: [{ url: "https://cdn.third.com/lib.js", text: "a\nb\n", ranges: [{ start: 0, end: 2 }] }] }],
      { sutOrigin: "https://app.example.com" },
    );
    assert.equal(out.totalLines, 0, "third-party script excluded from totalLines");
    assert.equal(out.coveredLines, 0, "third-party script excluded from coveredLines");
    assert.equal(out.topUncoveredFiles.length, 0, "third-party script must not appear in topUncoveredFiles");
  }

  // ── Empty input ─────────────────────────────────────────────────────────
  // Zero-test runs must not crash and must return a well-formed empty
  // summary (testRunner.js best-effort try/catch relies on this).
  {
    const out = await aggregateRunCoverage([], { sutOrigin: "https://app.example.com" });
    assert.equal(out.totalLines, 0);
    assert.equal(out.coveredLines, 0);
    assert.equal(out.coveragePct, 0);
    assert.deepEqual(out.perTest, []);
    assert.deepEqual(out.topUncoveredFiles, []);
  }

  // ── topUncoveredFiles cap + sort order ──────────────────────────────────
  // The aggregator caps the list at 20 sorted by descending uncoveredLines
  // so the dashboard payload stays bounded on SUTs with hundreds of chunks.
  {
    const jsCoverage = [];
    for (let i = 0; i < 30; i++) {
      jsCoverage.push({
        url: `https://app.example.com/chunk-${i}.js`,
        text: "1\n2\n3\n4\n5\n",
        ranges: [{ start: 0, end: 1 }],
      });
    }
    const out = await aggregateRunCoverage(
      [{ testId: "T1", jsCoverage }],
      { sutOrigin: "https://app.example.com" },
    );
    assert.ok(out.topUncoveredFiles.length <= 20, `topUncoveredFiles capped at 20; got ${out.topUncoveredFiles.length}`);
    for (let i = 1; i < out.topUncoveredFiles.length; i++) {
      assert.ok(
        out.topUncoveredFiles[i - 1].uncoveredLines >= out.topUncoveredFiles[i].uncoveredLines,
        "topUncoveredFiles must be sorted by uncoveredLines descending",
      );
    }
  }

  console.log("coverage-aggregator.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
