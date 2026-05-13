import test from "node:test";
import assert from "node:assert/strict";
import { computeImpactedTests, routePrefixesForChangedFiles } from "../src/pipeline/impactAnalysis.js";
import { scoreTestRisk } from "../src/pipeline/riskScorer.js";
import { __evaluateQualityGatesForTest } from "../src/testRunner.js";
import { renderGithubCheckSummary } from "../src/utils/runResultFormatters.js";
import { isNonExecutedSkip } from "../src/utils/skipReasons.js";

const tests = [
  { id: "checkout", name: "Checkout", sourceUrl: "https://app.example.com/checkout/cart" },
  { id: "account", name: "Account", sourceUrl: "https://app.example.com/account" },
  { id: "search", name: "Search", sourceUrl: "https://app.example.com/search" },
];

test("file paths route to matching sourceUrl tests", () => {
  const impact = computeImpactedTests({
    tests,
    changedFiles: ["src/checkout/CartPage.tsx"],
    changedPages: [],
  });
  assert.deepEqual(impact.impactedTestIds, ["checkout"]);
  assert.equal(impact.fallbackReason, null);
  assert.ok(impact.routePrefixes.includes("/checkout"));
});

test("empty changedFiles falls back to current full-suite behaviour", () => {
  const impact = computeImpactedTests({ tests, changedFiles: [], changedPages: [] });
  assert.deepEqual(impact.impactedTestIds, ["checkout", "account", "search"]);
  assert.equal(impact.fallbackReason, "no_changed_files");
});

test("unknown file paths produce an empty no-impact subset", () => {
  const impact = computeImpactedTests({ tests, changedFiles: ["docs/README.md", "backend/src/database/migrations/022.sql"] });
  assert.deepEqual(impact.impactedTestIds, []);
  assert.equal(impact.fallbackReason, "no_impact");
});

test("changedPages merges with file-derived routes", () => {
  const impact = computeImpactedTests({
    tests,
    changedFiles: ["src/checkout/CartPage.tsx"],
    changedPages: ["https://app.example.com/account"],
  });
  assert.deepEqual(impact.impactedTestIds, ["checkout", "account"]);
});

test("route-map override can map component files to custom routes", () => {
  const impact = computeImpactedTests({
    tests,
    changedFiles: ["frontend/src/components/SearchBox.jsx"],
    routeMap: { "frontend/src/components/SearchBox.jsx": ["/search"] },
  });
  assert.deepEqual(impact.impactedTestIds, ["search"]);
  assert.deepEqual(routePrefixesForChangedFiles(["frontend/src/components/SearchBox.jsx"], {
    "frontend/src/components/SearchBox.jsx": "/search",
  }), ["/search"]);
});

test("GitHub PR-files fetch failure is represented as full-suite fallback", () => {
  const impact = computeImpactedTests({ tests, changedFiles: null, changedPages: [] });
  assert.deepEqual(impact.impactedTestIds, ["checkout", "account", "search"]);
  assert.equal(impact.fallbackReason, "no_changed_files");
});

test("routeMap entries match on path boundary, not substring", () => {
  // Regression: an earlier `file.includes(pattern)` branch made a routeMap
  // key like `"app"` match every path containing the substring `app` (e.g.
  // `backend/src/middleware/appSetup.js`). With path-boundary matching, the
  // key only matches a file at-or-under that path.
  const impact = computeImpactedTests({
    tests,
    changedFiles: ["backend/src/middleware/appSetup.js"],
    routeMap: { app: ["/account"] },
  });
  assert.deepEqual(impact.impactedTestIds, []);
  assert.equal(impact.fallbackReason, "no_impact");
});

test("backend route files do not produce frontend route prefixes", () => {
  // Regression: the route-prefix heuristic anchors on `src|app|pages|routes`,
  // which previously matched backend Express routers (e.g.
  // `backend/src/routes/trigger.js` → bogus `/trigger` prefix). The
  // NON_ROUTE_FILE_RE now excludes `backend|server|api` folders so
  // server-side files don't pollute the impacted set.
  const impact = computeImpactedTests({
    tests: [...tests, { id: "trigger", name: "Trigger", sourceUrl: "https://app.example.com/trigger" }],
    changedFiles: ["backend/src/routes/trigger.js"],
  });
  assert.ok(!impact.impactedTestIds.includes("trigger"));
  assert.deepEqual(routePrefixesForChangedFiles(["backend/src/routes/trigger.js"]), []);
});

test("changedFiles add a file-affinity risk boost that composes with changedPages", () => {
  const subject = { id: "checkout", sourceUrl: "https://app.example.com/checkout/cart" };
  const base = scoreTestRisk(subject, []);
  const fileBoost = scoreTestRisk(subject, [], { changedFiles: ["src/checkout/CartPage.tsx"] });
  const combined = scoreTestRisk(subject, [], {
    changedFiles: ["src/checkout/CartPage.tsx"],
    changedPages: ["https://app.example.com/checkout"],
  });
  assert.ok(fileBoost > base);
  assert.ok(combined > fileBoost);
});

// ─── Skip-reason denominator contract (PR #18 regression guards) ─────────────
// These tests lock the invariant that `over_budget` and `skipped_no_impact`
// result rows MUST NOT count toward the executed-test denominator in any
// surface that reports run progress. If a future skip reason lands and the
// three surfaces (gate eval, GH check summary, frontend pass-rate badge)
// drift, the same run will show different verdicts depending on where the
// reviewer is looking. Anchored by `backend/src/utils/skipReasons.js`.

test("isNonExecutedSkip matches both over_budget and skipped_no_impact", () => {
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "over_budget" }), true);
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "skipped_no_impact" }), true);
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "other" }), false);
  assert.equal(isNonExecutedSkip({ status: "failed" }), false);
  assert.equal(isNonExecutedSkip(null), false);
});

test("quality gate excludes skipped_no_impact rows from pass-rate denominator", () => {
  // 10 approved tests, 5 impact-skipped, 4 passed, 1 failed.
  // Naïve denominator (10) → 4/10 = 40% → fails minPassRate: 80.
  // Correct denominator (5 executed) → 4/5 = 80% → passes.
  const run = {
    total: 10,
    passed: 4,
    failed: 1,
    results: [
      { status: "passed" }, { status: "passed" }, { status: "passed" }, { status: "passed" },
      { status: "failed" },
      { status: "skipped", skipReason: "skipped_no_impact" },
      { status: "skipped", skipReason: "skipped_no_impact" },
      { status: "skipped", skipReason: "skipped_no_impact" },
      { status: "skipped", skipReason: "skipped_no_impact" },
      { status: "skipped", skipReason: "skipped_no_impact" },
    ],
  };
  const result = __evaluateQualityGatesForTest({ minPassRate: 80 }, run);
  assert.equal(result.passed, true, `expected gate to pass; got violations: ${JSON.stringify(result.violations)}`);
});

test("quality gate excludes mixed over_budget + skipped_no_impact rows", () => {
  // Confirms the broadened filter from AUTO-001's `over_budget`-only set to
  // include `skipped_no_impact` — the bug this PR's first fix addressed.
  const run = {
    total: 6,
    passed: 2,
    failed: 0,
    results: [
      { status: "passed" }, { status: "passed" },
      { status: "skipped", skipReason: "over_budget" },
      { status: "skipped", skipReason: "over_budget" },
      { status: "skipped", skipReason: "skipped_no_impact" },
      { status: "skipped", skipReason: "skipped_no_impact" },
    ],
  };
  const result = __evaluateQualityGatesForTest({ minPassRate: 100 }, run);
  assert.equal(result.passed, true, "2/2 executed = 100% should pass minPassRate:100");
});

test("GitHub check summary reports executed total, not approved total", () => {
  // Mirror of the gate scenario: the PR check header must show "5 total" with
  // a "5 skipped (of 10 approved)" suffix, not "10 total" — otherwise half
  // the tests look like they vanished from the PR check.
  const run = {
    total: 10,
    passed: 5,
    failed: 0,
    results: [
      ...Array.from({ length: 5 }, () => ({ status: "passed" })),
      ...Array.from({ length: 5 }, () => ({ status: "skipped", skipReason: "skipped_no_impact" })),
    ],
  };
  const md = renderGithubCheckSummary(run);
  assert.match(md, /5 passed.*0 failed.*5 total/, "executed total must be 5, not 10");
  assert.match(md, /5 skipped.*of 10 approved/, "approved-test count must be auditable in suffix");
});

test("GitHub check summary omits skipped suffix when no non-executed skips", () => {
  const run = {
    total: 3, passed: 3, failed: 0,
    results: [{ status: "passed" }, { status: "passed" }, { status: "passed" }],
  };
  const md = renderGithubCheckSummary(run);
  assert.match(md, /3 passed.*0 failed.*3 total/);
  assert.doesNotMatch(md, /skipped/);
});
