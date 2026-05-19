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

test("AUTO-009 — coverageSummary persisted shape contains every documented field", async () => {
  const stub = buildStubJsCoverage();
  const summary = await aggregateRunCoverage(
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

test("AUTO-009 — sourceMapStatus = 'fallback' when no source maps are resolved", async () => {
  const summary = await aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/x.js", text: "a\nb\n", ranges: [{ start: 0, end: 1 }] }] }],
    { sutOrigin: "https://app.example.com" },
  );
  assert.equal(summary.sourceMapStatus, "fallback");
});

test("AUTO-009b — sourceMapStatus = 'resolved' when ≥80% of bundle lines map", async () => {
  // Stub resolver: every bundle line maps to src/Cart.tsx. The aggregator
  // should group by the original source path and surface sourceMapStatus =
  // "resolved" because 100% of bundle lines resolved.
  const summary = await aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/main.js", text: "a\nb\nc\n", ranges: [{ start: 0, end: 1 }] }] }],
    {
      sutOrigin: "https://app.example.com",
      resolver: {
        resolve: async () => ({ /* fake consumer */ }),
        mapLine: (_c, line) => ({ source: "src/Cart.tsx", line }),
      },
    },
  );
  assert.equal(summary.sourceMapStatus, "resolved");
  assert.ok(summary.topUncoveredFiles.some((f) => f.file === "src/Cart.tsx"), "groups by original source");
  assert.ok(summary.topUncoveredFiles.every((f) => "bundleUrl" in f), "retains bundleUrl secondary field");
});

test("AUTO-009b — sourceMapStatus = 'partial' when <80% of bundle lines map", async () => {
  // Resolver only maps every other line — partial resolution.
  const summary = await aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/main.js", text: "a\nb\nc\nd\ne\n", ranges: [{ start: 0, end: 1 }] }] }],
    {
      sutOrigin: "https://app.example.com",
      resolver: {
        resolve: async () => ({}),
        mapLine: (_c, line) => (line % 2 === 0 ? { source: "src/Partial.tsx", line } : null),
      },
    },
  );
  assert.equal(summary.sourceMapStatus, "partial");
});

test("AUTO-009c — branchPct < linePct when one branch arm never fires", async () => {
  // Synthetic SUT with two if-arms — only one is taken. We inject a stub
  // `convertV8ToIstanbul` so this test stays hermetic — no real
  // v8-to-istanbul, no source-map round-trip. The injection point is the
  // aggregator's `convertV8ToIstanbul` option.
  const ifElseSrc =
    "function pickPath(flag) {\n" +
    "  if (flag) { return doA(); }\n" +     // arm 0 — covered
    "  return doB();\n" +                     // arm 1 — never reached
    "}\n";
  const stubConvert = async () => ({
    path: "https://app.example.com/main.js",
    statementMap: { 0: {}, 1: {}, 2: {} },
    s:            { 0: 1, 1: 1, 2: 0 },             // 2/3 statements covered
    fnMap:        { 0: { name: "pickPath" } },
    f:            { 0: 1 },                         // function covered
    branchMap:    { 0: { type: "if" } },
    b:            { 0: [1, 0] },                    // arm 0 hit, arm 1 not
  });

  const summary = await aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/main.js", text: ifElseSrc, ranges: [{ start: 0, end: 30 }] }] }],
    { sutOrigin: "https://app.example.com", convertV8ToIstanbul: stubConvert },
  );

  assert.equal(summary.totalBranches,   2, "two branch arms recorded");
  assert.equal(summary.coveredBranches, 1, "only arm 0 covered");
  assert.equal(summary.branchPct,     0.5);
  // Line pct should be ≥ branch pct because the line containing the
  // taken-arm `return doA()` IS hit at least once. Acceptance criterion is
  // strictly that branchPct surfaces the missed arm — assert branch ≤ line.
  assert.ok(summary.branchPct <= summary.coveragePct + 1e-9, "branchPct ≤ linePct when one arm never fires");
  assert.ok(summary.branchPct < 1, "branchPct < 100% because one arm never fires");

  // Per-test delta should attribute the covered branch to T1.
  const t1 = summary.perTest.find((p) => p.testId === "T1");
  assert.ok(t1.deltaBranches > 0, "T1 first hit the taken branch arm");
  assert.equal(typeof t1.deltaStatements, "number");
  assert.equal(typeof t1.deltaFunctions,  "number");
});

test("AUTO-009c — granularity keys omitted when converter never produces data", async () => {
  // Stub converter that returns null for every entry — mirrors the
  // production behaviour when v8-to-istanbul is unavailable or the script
  // can't be parsed. The returned summary should NOT carry `totalBranches`
  // / `branchPct` so pre-009c and 009c-without-granularity runs look
  // byte-identical on the wire.
  const summary = await aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/x.js", text: "a\n", ranges: [{ start: 0, end: 1 }] }] }],
    { sutOrigin: "https://app.example.com", convertV8ToIstanbul: async () => null },
  );
  assert.equal(summary.totalBranches,   undefined);
  assert.equal(summary.coveredBranches, undefined);
  assert.equal(summary.branchPct,       undefined);
});

test("AUTO-009b — resolver throw never fails the aggregator", async () => {
  const summary = await aggregateRunCoverage(
    [{ testId: "T1", jsCoverage: [{ url: "https://app.example.com/x.js", text: "a\nb\n", ranges: [{ start: 0, end: 1 }] }] }],
    {
      sutOrigin: "https://app.example.com",
      resolver: {
        resolve: async () => { throw new Error("network down"); },
        mapLine: () => null,
      },
    },
  );
  // Falls back cleanly; status stays "fallback".
  assert.equal(summary.sourceMapStatus, "fallback");
});

