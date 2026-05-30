/**
 * @file AUTO-014 acceptance-criteria regression guards.
 *
 * Pins the three NEXT.md AC items that aren't covered by the pure-function
 * unit tests in `dependency-order.test.js` or the HTTP-level tests in
 * `test-routes-depends-on.test.js`:
 *
 *   - NEXT.md:60 — `evaluateQualityGates` excludes `upstream_failed` +
 *     `missing_upstream` skips from the pass-rate denominator (5-test run
 *     where 1 login fails + 4 dependents skip → `passRate: 0/1`).
 *   - NEXT.md:61 — Smoke-pin invariant preserved: smoke tests dispatch
 *     first; `dependsOn` only constrains ordering within the non-smoke tail.
 *   - NEXT.md:58 — Failed upstream test pre-seeds every transitive
 *     dependent as `skipped` so the dispatch loop's `resolvedTestIds`
 *     guard short-circuits before `executeTest` runs. Asserted at the
 *     pure-function layer via `computeUpstreamSkips` + the guard contract.
 */
import assert from "node:assert/strict";
import { __evaluateQualityGatesForTest } from "../src/testRunner.js";
import { computeUpstreamSkips, topologicalSortTests } from "../src/runner/dependencyOrder.js";
import { isSmokeTest } from "../src/pipeline/riskScorer.js";
import { isNonExecutedSkip, NON_EXECUTED_SKIP_REASONS } from "../src/utils/skipReasons.js";

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ── NEXT.md:60 — pass-rate denominator excludes new skip reasons ─────────────

test("isNonExecutedSkip matches upstream_failed and missing_upstream", () => {
  assert.equal(NON_EXECUTED_SKIP_REASONS.has("upstream_failed"), true);
  assert.equal(NON_EXECUTED_SKIP_REASONS.has("missing_upstream"), true);
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "upstream_failed" }), true);
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "missing_upstream" }), true);
});

test("quality gate reports passRate 0/1 when 1 fail + 4 upstream-skip on a 5-test run", () => {
  // Verbatim from NEXT.md:60 — "5-test run where 1 login fails + 4
  // dependents skip reports passRate: 0/1, not 0/5".
  const run = {
    total: 5,
    passed: 0,
    failed: 1,
    results: [
      { status: "failed", testId: "login" },
      { status: "skipped", skipReason: "upstream_failed", testId: "checkout" },
      { status: "skipped", skipReason: "upstream_failed", testId: "receipt" },
      { status: "skipped", skipReason: "upstream_failed", testId: "history" },
      { status: "skipped", skipReason: "upstream_failed", testId: "logout" },
    ],
  };
  const result = __evaluateQualityGatesForTest({ minPassRate: 1 }, run);
  assert.equal(result.passed, false, "1 failed of 1 executed must fail minPassRate:1");
  const v = result.violations.find((x) => x.rule === "minPassRate");
  assert.ok(v, "expected a minPassRate violation");
  assert.equal(v.actual, 0, "actual pass rate must be 0% (0 passed / 1 executed)");
});

test("quality gate excludes missing_upstream skips from the denominator", () => {
  // Mirror of the upstream_failed case for the second new skip reason —
  // ensures both NON_EXECUTED_SKIP_REASONS additions are honoured.
  const run = {
    total: 4,
    passed: 1,
    failed: 0,
    results: [
      { status: "passed", testId: "smoke" },
      { status: "skipped", skipReason: "missing_upstream", testId: "a" },
      { status: "skipped", skipReason: "missing_upstream", testId: "b" },
      { status: "skipped", skipReason: "missing_upstream", testId: "c" },
    ],
  };
  const result = __evaluateQualityGatesForTest({ minPassRate: 100 }, run);
  assert.equal(result.passed, true, "1/1 executed = 100% must pass minPassRate:100");
});

// ── NEXT.md:61 — smoke-pin invariant preserved alongside dependsOn ───────────

test("smoke tests dispatch first; topological sort only reorders the non-smoke tail", () => {
  // Mirrors the composition in `backend/src/testRunner.js:428-435`:
  //   smokeTests + topologicalSortTests(nonSmokeTests, { satisfiedTestIds: smokeIds })
  // Even when a non-smoke test declares `dependsOn: [<smokeId>]`, the smoke
  // test must still appear FIRST in the dispatched order — the smoke pin
  // wins over any non-smoke ordering preference.
  const tests = [
    { id: "checkout", name: "Checkout", dependsOn: ["login-smoke"] },
    { id: "receipt", name: "Receipt", dependsOn: ["checkout"] },
    { id: "login-smoke", name: "Login smoke", tags: ["smoke"] },
    { id: "search", name: "Search" },
  ];
  const smokeTests = tests.filter((t) => isSmokeTest(t));
  const nonSmokeTests = tests.filter((t) => !isSmokeTest(t));
  const smokeTestIds = smokeTests.map((t) => t.id);
  const { ordered, skipped } = topologicalSortTests(nonSmokeTests, { satisfiedTestIds: smokeTestIds });
  const dispatched = [...smokeTests, ...ordered].map((t) => t.id);

  assert.deepEqual(skipped, [], "no missing-upstream skips when smoke satisfies the dep");
  assert.equal(dispatched[0], "login-smoke", "smoke test must dispatch first");
  assert.ok(
    dispatched.indexOf("checkout") < dispatched.indexOf("receipt"),
    "checkout must run before receipt within the non-smoke tail",
  );
});

// ── NEXT.md:58 — pre-seed skips before dispatch (guard contract) ─────────────

test("computeUpstreamSkips identifies every dependent so the dispatch guard short-circuits before executeTest", () => {
  // The runner's contract (`backend/src/testRunner.js:678-687` + `:862`):
  //   - on each failure, `seedUpstreamFailedSkips()` calls computeUpstreamSkips
  //     to find every transitively-blocked test;
  //   - each is added to `resolvedTestIds` via `recordSkipResult`;
  //   - the poolMap callback exits early via `if (resolvedTestIds.has(test.id)) return;`
  //     BEFORE invoking `executeTest`.
  // We pin the cascade resolver here so a regression that lets a transitive
  // dependent slip through can't silently allow `executeTest` to be called
  // for a blocked test.
  const tests = [
    { id: "login" },
    { id: "checkout", dependsOn: ["login"] },
    { id: "receipt", dependsOn: ["checkout"] },
    { id: "history", dependsOn: ["receipt"] },
    { id: "unrelated" },
  ];
  const skips = computeUpstreamSkips(tests, new Set(["login"]));
  assert.deepEqual([...skips].sort(), ["checkout", "history", "receipt"]);
  // `unrelated` shares no edge with the failed root → must NOT be skipped.
  assert.equal(skips.has("unrelated"), false);
  // The failed test itself is NOT in the skip set (it ran, it failed —
  // skipping it would double-account in the run aggregator).
  assert.equal(skips.has("login"), false);
});

if (process.exitCode) process.exit(process.exitCode);
