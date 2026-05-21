/**
 * AUTO-009f regression test — sharded runs must produce a `coverageSummary`
 * just like single-process runs.
 *
 * The bug this guards against: prior to PR #19's follow-up, only
 * `testRunner.js` invoked the aggregator. `workers/runWorker.js#finalizeShardedRun`
 * (the boundary-crossing finalizer for CAP-002 sharded runs) bypassed it,
 * so every multi-shard run with `project.coverageEnabled === true` persisted
 * `coverageSummary: null` and the Dashboard Coverage panel never rendered
 * for sharded runs. Mirrors the AUTO-010 sharded-finalizer parity bug.
 *
 * This test exercises `finalizeCoverage` against a synthetic results array
 * that carries the same shape `runs.results` would after multiple shards'
 * `appendRunResults` calls landed — a flat list with `_shardIndex` stamps
 * — and asserts the resulting summary is well-formed, non-null, and has
 * the raw `jsCoverage` payloads stripped per AUTO-009f contract.
 *
 * Following REVIEW.md house style: direct `node:assert/strict`, no
 * `node:test` framework import.
 */
import assert from "node:assert/strict";
import { finalizeCoverage } from "../src/pipeline/finalizeCoverage.js";

async function main() {
  // Build the same shape `runs.results` would carry after a 2-shard run
  // landed both shards' results via `appendRunResults`. Each result row
  // carries its `_shardIndex` stamp (CAP-002 Phase 2 — see
  // `testRunner.js#processResult`) plus the raw `jsCoverage` payload the
  // per-shard execution emitted.
  const mainJs = "const a = 1;\nconst b = 2;\nfunction render() {\n  return a + b;\n}\n";
  const helperJs = "export function helper(x) {\n  return x * 2;\n}\n";

  const shardedResults = [
    // Shard 0 — first half of the suite
    {
      testId: "T1", _shardIndex: 0, status: "passed",
      jsCoverage: [{ url: "https://app.example.com/main.js", text: mainJs, ranges: [{ start: 0, end: mainJs.length }] }],
    },
    {
      testId: "T2", _shardIndex: 0, status: "passed",
      jsCoverage: [{ url: "https://app.example.com/helper.js", text: helperJs, ranges: [{ start: 0, end: helperJs.length }] }],
    },
    // Shard 1 — second half. Same first-party origin so both shards
    // contribute to the same project-wide totals.
    {
      testId: "T3", _shardIndex: 1, status: "passed",
      jsCoverage: [{ url: "https://app.example.com/main.js", text: mainJs, ranges: [{ start: 0, end: 12 }] }],
    },
  ];

  const project = {
    id: "PRJ-1",
    url: "https://app.example.com",
    coverageEnabled: true,
    sourcemapBaseUrl: null,
  };

  const summary = await finalizeCoverage(project, shardedResults);

  // Sharded-run parity: must produce a real summary, not null. This is
  // the entire point of the test — without the `finalizeCoverage` call
  // in `finalizeShardedRun`, sharded runs persisted null here.
  assert.ok(summary && typeof summary === "object", "sharded finalizer must produce a coverageSummary, not null");
  assert.equal(typeof summary.totalLines, "number");
  assert.equal(typeof summary.coveredLines, "number");
  assert.ok(summary.coveragePct >= 0 && summary.coveragePct <= 1, "coveragePct ∈ [0,1]");
  assert.ok(Array.isArray(summary.perTest), "perTest is an array");
  assert.equal(summary.perTest.length, 3, "one perTest row per shard-flushed result");
  assert.ok(Array.isArray(summary.topUncoveredFiles));

  // AUTO-009f contract: raw `jsCoverage` payloads must be stripped from
  // `results[]` after aggregation so the persisted JSON column stays lean.
  for (const r of shardedResults) {
    assert.ok(!("jsCoverage" in r) || r.jsCoverage == null,
      `result ${r.testId} must have jsCoverage stripped after finalizeCoverage`);
  }

  // ── Disabled-coverage zero-regression ───────────────────────────────────
  // Sharded run with coverage disabled must produce null exactly like the
  // single-process path. Raw payloads still get stripped (defensive cleanup).
  const disabledProject = { ...project, coverageEnabled: false };
  const disabledResults = [
    {
      testId: "T1", _shardIndex: 0, status: "passed",
      jsCoverage: [{ url: "https://app.example.com/x.js", text: "a\n", ranges: [] }],
    },
  ];
  const disabledSummary = await finalizeCoverage(disabledProject, disabledResults);
  assert.equal(disabledSummary, null, "coverageEnabled=false → null summary");
  assert.ok(!("jsCoverage" in disabledResults[0]) || disabledResults[0].jsCoverage == null,
    "defensive jsCoverage strip happens even when coverage disabled");

  // ── Null-project zero-regression ────────────────────────────────────────
  // Worker may pass null when the project row was deleted mid-run.
  const nullSummary = await finalizeCoverage(null, [{ testId: "T1", status: "passed" }]);
  assert.equal(nullSummary, null, "null project → null summary (deleted-mid-run cleanup)");

  console.log("run-shard-coverage.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
