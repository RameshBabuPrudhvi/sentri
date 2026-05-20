/**
 * AUTO-009k — unit tests for the two-stage per-shard coverage merge.
 *
 * The merge is what makes sharded-run coverage match the industry pattern
 * (c8 / nyc / Istanbul `libCoverage.merge()` / Codecov upload-then-merge):
 * each shard pre-aggregates its slice into a compact mergeable summary;
 * the finalizer takes id-set union across shards. Set union is associative
 * so the merged output is mathematically equivalent to single-pass
 * aggregation over the union of all shards' raw results — these tests pin
 * that equivalence.
 *
 * The single most important invariant: **naive count-summing across shards
 * is WRONG** when shards have overlapping covered lines. Proven by the
 * `overlapping_lines_union` test below: shard 0 covers [1,2,3], shard 1
 * covers [3,4,5] of the same bundle. Naive sum = 6; true union = 5. The
 * merge must always emit 5.
 *
 * Follows REVIEW.md house style — direct `node:assert/strict`, no
 * `node:test` framework import.
 */
import assert from "node:assert/strict";
import {
  aggregateShardCoverage,
  mergeShardSummaries,
} from "../src/pipeline/finalizeCoverage.js";
import { aggregateRunCoverage } from "../src/pipeline/coverageAggregator.js";

const PROJECT = {
  id: "PRJ-1",
  url: "https://app.example.com",
  coverageEnabled: true,
};

async function main() {
  await testMergeablePayloadShape();
  await testAggregateShardCoverage();
  await testCoverageDisabled();
  await testInvalidInputs();
  await testOverlappingLinesUnion();
  await testSetUnionAssociativity();
  await testSbfIdSetUnion();
  await testServerDisjointSum();
  await testEquivalenceWithSinglePass();
  console.log("coverage-shard-merge.test.js passed");
}

// ── Test 1: Mergeable payload shape exposed via outRef.mergeable ────────
async function testMergeablePayloadShape() {
  const text = "a\nb\nc\nd\n";
  const outRef = {};
  await aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/a.js", text, ranges: [{ start: 0, end: 3 }] }] }],
    { sutOrigin: "https://app.example.com", outRef },
  );
  assert.ok(outRef.mergeable, "outRef.mergeable must be populated when outRef is supplied");
  assert.ok(outRef.mergeable.perBundle, "mergeable.perBundle must exist");
  assert.ok(outRef.mergeable.perSource, "mergeable.perSource must exist");
  assert.ok(outRef.mergeable.sbfPerBundle, "mergeable.sbfPerBundle must exist");
  assert.ok(outRef.mergeable.serverFiles, "mergeable.serverFiles must exist");
  assert.equal(typeof outRef.mergeable.sbfHasData, "boolean");
  assert.equal(typeof outRef.mergeable.serverLayer, "boolean");
  const bundleKey = Object.keys(outRef.mergeable.perBundle)[0];
  assert.ok(Array.isArray(outRef.mergeable.perBundle[bundleKey].covered),
    "per-bundle covered lines must be a JSON-serializable array (not a Set)");
}

// ── Test 2: aggregateShardCoverage shape ────────────────────────────────
async function testAggregateShardCoverage() {
  const text = "a\nb\nc\n";
  const shardCov = await aggregateShardCoverage(PROJECT, [
    { testId: "T1", jsCoverage: [{ url: "https://app.example.com/a.js", text, ranges: [{ start: 0, end: 1 }] }] },
  ]);
  assert.ok(shardCov, "non-null payload");
  assert.ok(shardCov.perBundle, "carries perBundle");
  assert.ok(Array.isArray(shardCov.perTest), "carries perTest array");
  assert.equal(shardCov.perTest.length, 1);
  assert.equal(shardCov.perTest[0].testId, "T1");
}

// ── Test 3: Coverage-disabled → null ────────────────────────────────────
async function testCoverageDisabled() {
  const shardCov = await aggregateShardCoverage(
    { ...PROJECT, coverageEnabled: false },
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/a.js", text: "a\n", ranges: [{ start: 0, end: 1 }] }] }],
  );
  assert.equal(shardCov, null, "coverage disabled → null");
}

// ── Test 4: Empty/invalid input → null ──────────────────────────────────
async function testInvalidInputs() {
  assert.equal(await aggregateShardCoverage(PROJECT, []), null, "empty results → null");
  assert.equal(await aggregateShardCoverage(PROJECT, null), null, "null results → null");
  assert.equal(mergeShardSummaries(null), null, "null input → null");
  assert.equal(mergeShardSummaries([]), null, "empty input → null");
  assert.equal(mergeShardSummaries([null, undefined]), null, "all-null array → null");
}

// ── Test 5: THE CRITICAL INVARIANT — overlapping lines union, not sum ───
// Shard 0 covers lines [1,2,3] of bundleA.js.
// Shard 1 covers lines [3,4,5] of bundleA.js.
// Naive sum: coveredLines = 6 (WRONG — double-counts line 3).
// True union: coveredLines = 5 (lines 1,2,3,4,5).
async function testOverlappingLinesUnion() {
  const mkShard = (covered, deltaLines, testId) => ({
    perBundle: {
      "https://app.example.com/a.js": { covered, totalLines: 10 },
    },
    sbfPerBundle: {},
    sbfHasData: false,
    perSource: {
      "https://app.example.com/a.js": {
        coveredLines: covered,
        totalLines: 10,
        bundleUrl: "https://app.example.com/a.js",
      },
    },
    serverFiles: {},
    serverLayer: false,
    perTest: [{ testId, deltaLines, deltaPct: 0, deltaStatements: 0, deltaBranches: 0, deltaFunctions: 0 }],
  });
  const merged = mergeShardSummaries([mkShard([1, 2, 3], 3, "T1"), mkShard([3, 4, 5], 3, "T2")]);
  assert.ok(merged, "merge produces a summary");
  assert.equal(merged.totalLines, 10, "totalLines from max-per-bundle (not sum)");
  assert.equal(merged.coveredLines, 5,
    "OVERLAPPING UNION INVARIANT — covered = |{1,2,3} ∪ {3,4,5}| = 5, NOT 3+3=6");
  assert.equal(merged.coveragePct, 0.5, "5/10 = 50%");
  assert.equal(merged.perTest.length, 2, "per-test deltas concatenated losslessly");
}

// ── Test 6: Set-union associativity over 3 shards ───────────────────────
async function testSetUnionAssociativity() {
  const mk = (covered) => ({
    perBundle: { "https://app.example.com/x.js": { covered, totalLines: 20 } },
    sbfPerBundle: {},
    sbfHasData: false,
    perSource: {
      "https://app.example.com/x.js": {
        coveredLines: covered,
        totalLines: 20,
        bundleUrl: "https://app.example.com/x.js",
      },
    },
    serverFiles: {},
    serverLayer: false,
    perTest: [],
  });
  const a = mk([1, 2, 3, 4]);
  const b = mk([3, 4, 5, 6]);
  const c = mk([5, 6, 7, 8]);
  const direct = mergeShardSummaries([a, b, c]);
  assert.equal(direct.coveredLines, 8, "{1,2,3,4} ∪ {3,4,5,6} ∪ {5,6,7,8} = {1..8} = 8");
  assert.equal(direct.totalLines, 20);
  assert.equal(direct.coveragePct, 0.4);
}

// ── Test 7: S/B/F id-set union (granularity invariant) ──────────────────
// Shard 0 covered statements [0,1,2], shard 1 covered [2,3,4] of same bundle.
// Naive sum: 6. True union: |{0,1,2}∪{2,3,4}|=5.
async function testSbfIdSetUnion() {
  const mkShard = (sIds) => ({
    perBundle: {},
    sbfPerBundle: {
      "https://app.example.com/g.js": {
        coveredIds: sIds.map((i) => `s:${i}`),
        totals: { statements: 10, branches: 0, functions: 0 },
      },
    },
    sbfHasData: true,
    perSource: {},
    serverFiles: {},
    serverLayer: false,
    perTest: [],
  });
  const merged = mergeShardSummaries([mkShard([0, 1, 2]), mkShard([2, 3, 4])]);
  assert.equal(merged.totalStatements, 10);
  assert.equal(merged.coveredStatements, 5,
    "S/B/F UNION INVARIANT — covered = |{0,1,2}∪{2,3,4}| = 5, NOT 3+3=6");
  assert.equal(merged.statementPct, 0.5);
}

// ── Test 8: Server-side disjoint sum (c8 contract) ──────────────────────
async function testServerDisjointSum() {
  const mkShard = (addedS) => ({
    perBundle: {}, sbfPerBundle: {}, sbfHasData: false, perSource: {},
    serverFiles: {
      "/app/server.js": {
        addedStatements: addedS,
        addedBranches: 0,
        addedFunctions: 0,
        totalStatements: 100,
        totalBranches: 0,
        totalFunctions: 0,
      },
    },
    serverLayer: true,
    perTest: [],
  });
  const merged = mergeShardSummaries([mkShard(20), mkShard(30)]);
  assert.equal(merged.serverLayer, true);
  const serverRow = merged.topUncoveredFiles.find((f) => f.layer === "server");
  assert.ok(serverRow, "server row present in topUncoveredFiles");
  assert.equal(serverRow.totalLines, 100);
  // Per c8 contract addedX are disjoint across shards, so union = sum.
  assert.equal(serverRow.uncoveredLines, 50, "totalStatements (100) - addedStatements (20+30) = 50");
}

// ── Test 9: merge ≡ single-pass aggregation (the equivalence invariant) ──
async function testEquivalenceWithSinglePass() {
  // Build 2 shards' worth of raw V8 coverage, capture both:
  //   (a) single-pass aggregation over the union of results
  //   (b) per-shard aggregateShardCoverage + mergeShardSummaries
  // The coverage-relevant fields must match.
  const text = "a\nb\nc\nd\ne\nf\ng\nh\n";
  const shard0Results = [
    { testId: "T1", jsCoverage: [{ url: "https://app.example.com/m.js", text, ranges: [{ start: 0, end: 4 }] }] },
  ];
  const shard1Results = [
    { testId: "T2", jsCoverage: [{ url: "https://app.example.com/m.js", text, ranges: [{ start: 2, end: 7 }] }] },
  ];

  // Path A: single-pass over union
  const singlePass = await aggregateRunCoverage(
    [...shard0Results, ...shard1Results],
    { sutOrigin: "https://app.example.com" },
  );

  // Path B: per-shard aggregate + merge
  const s0 = await aggregateShardCoverage(PROJECT, shard0Results);
  const s1 = await aggregateShardCoverage(PROJECT, shard1Results);
  const merged = mergeShardSummaries([s0, s1]);

  // Core invariants — totalLines, coveredLines, coveragePct identical.
  assert.equal(merged.totalLines, singlePass.totalLines, "totalLines parity");
  assert.equal(merged.coveredLines, singlePass.coveredLines, "coveredLines parity");
  assert.equal(merged.coveragePct, singlePass.coveragePct, "coveragePct parity");
  // perTest length: every test in either shard surfaces exactly once.
  assert.equal(merged.perTest.length, singlePass.perTest.length, "perTest length parity");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
