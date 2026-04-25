/**
 * @module tests/feedback-loop-deep
 * @description Deep unit tests for pipeline/feedbackLoop.js
 *
 * The existing pipeline.test.js has 9 smoke tests covering classifyFailure
 * patterns and detectFlakiness basics. This file covers the gaps:
 * every individual regex pattern in each failure category, edge cases in
 * classifyFailure ordering (first-match-wins), analyzeRunResults stat
 * counting, priority assignment, missing-testId tolerance, assertion method
 * extraction, buildQualityAnalytics grouping and insights generation,
 * and detectFlakiness boundary conditions.
 *
 * Coverage areas:
 *   1. classifyFailure — all 6 patterns per category (not just one sample),
 *                        null/empty input, first-match-wins ordering,
 *                        case-insensitivity
 *   2. analyzeRunResults — stat shape, passed/failed/total counts,
 *                          high vs medium priority assignment,
 *                          skips results with missing testId in testMap,
 *                          assertionMethod extraction from error message,
 *                          snapshot lookup from snapshotsByUrl
 *   3. buildQualityAnalytics — byCategory, byType, byPromptVersion, byModel,
 *                              failedAssertionMethods, insights content,
 *                              totalFailures, empty improvements input
 *   4. detectFlakiness — boundary: single result, all-passed, all-failed,
 *                        mixed (the true-flaky case)
 *
 * Run: node tests/feedback-loop-deep.test.js
 */

import assert from "node:assert/strict";
import {
  classifyFailure,
  detectFlakiness,
  analyzeRunResults,
  buildQualityAnalytics,
} from "../src/pipeline/feedbackLoop.js";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

// ── 1. classifyFailure — every pattern in every category ─────────────────────

console.log("\n🏷️  classifyFailure — exhaustive pattern coverage");

// SELECTOR_ISSUE patterns
test("SELECTOR_ISSUE: 'locator...not found'", () => {
  assert.equal(classifyFailure("locator('#btn') not found after 30000ms"), "SELECTOR_ISSUE");
});
test("SELECTOR_ISSUE: 'element not visible'", () => {
  assert.equal(classifyFailure("element not visible in the viewport"), "SELECTOR_ISSUE");
});
test("SELECTOR_ISSUE: 'no elements found'", () => {
  assert.equal(classifyFailure("no elements found matching selector '.submit-btn'"), "SELECTOR_ISSUE");
});
test("SELECTOR_ISSUE: 'waiting for locator'", () => {
  assert.equal(classifyFailure("waiting for locator('.modal') to be visible"), "SELECTOR_ISSUE");
});
test("SELECTOR_ISSUE: 'element handle is not attached'", () => {
  assert.equal(classifyFailure("element handle is not attached to the DOM"), "SELECTOR_ISSUE");
});
test("SELECTOR_ISSUE: 'strict mode violation'", () => {
  assert.equal(classifyFailure("strict mode violation: locator('button') resolved to 3 elements"), "SELECTOR_ISSUE");
});

test("NETWORK_MOCK_FAIL: route.fulfill mismatch", () => {
  assert.equal(classifyFailure("route.fulfill returned malformed mocked response body"), "NETWORK_MOCK_FAIL");
});

test("FRAME_FAIL: frameLocator target missing", () => {
  assert.equal(classifyFailure("frameLocator('#payment-frame') could not resolve element"), "FRAME_FAIL");
});

test("API_ASSERTION_FAIL: request.newContext response status mismatch", () => {
  assert.equal(classifyFailure("request.newContext api.get expected res.status() 200 but got 500"), "API_ASSERTION_FAIL");
});

// URL_MISMATCH patterns
test("URL_MISMATCH: 'url mismatch'", () => {
  assert.equal(classifyFailure("url mismatch: expected '/dashboard' received '/login'"), "URL_MISMATCH");
});
test("URL_MISMATCH: 'redirected to unexpected url'", () => {
  assert.equal(classifyFailure("redirected to unexpected url: https://myapp.com/captcha"), "URL_MISMATCH");
});
test("URL_MISMATCH: 'page.url()...not...match'", () => {
  assert.equal(classifyFailure("page.url() did not match expected /dashboard/i"), "URL_MISMATCH");
});
test("URL_MISMATCH: 'expect(received).toHaveURL(expected)'", () => {
  assert.equal(classifyFailure("expect(received).toHaveURL(expected)\n  received: '/login'\n  expected: '/dash'"), "URL_MISMATCH");
});
test("URL_MISMATCH: 'toHaveURL...received'", () => {
  assert.equal(classifyFailure("toHaveURL assertion failed: received '/home' expected '/dashboard'"), "URL_MISMATCH");
});

// NAVIGATION_FAIL patterns
test("NAVIGATION_FAIL: 'net::ERR'", () => {
  assert.equal(classifyFailure("net::ERR_NAME_NOT_RESOLVED at https://myapp.invalid"), "NAVIGATION_FAIL");
});
test("NAVIGATION_FAIL: 'page.goto'", () => {
  assert.equal(classifyFailure("page.goto failed: net::ERR_CONNECTION_REFUSED"), "NAVIGATION_FAIL");
});
test("NAVIGATION_FAIL: 'navigation failed'", () => {
  assert.equal(classifyFailure("navigation failed: server returned 502"), "NAVIGATION_FAIL");
});
test("NAVIGATION_FAIL: 'timeout...navigation'", () => {
  assert.equal(classifyFailure("timeout 30000ms waiting for navigation to complete"), "NAVIGATION_FAIL");
});
test("NAVIGATION_FAIL: 'ERR_NAME_NOT_RESOLVED'", () => {
  assert.equal(classifyFailure("ERR_NAME_NOT_RESOLVED: myapp.local"), "NAVIGATION_FAIL");
});

// TIMEOUT patterns
test("TIMEOUT: 'timeout NNNms exceeded'", () => {
  assert.equal(classifyFailure("timeout 30000ms exceeded waiting for element"), "TIMEOUT");
});
test("TIMEOUT: 'waiting for...timeout'", () => {
  assert.equal(classifyFailure("waiting for element '.btn' to be visible, timeout: 15000ms"), "TIMEOUT");
});
test("TIMEOUT: 'Test timeout'", () => {
  assert.equal(classifyFailure("Test timeout of 60000ms exceeded."), "TIMEOUT");
});

// ASSERTION_FAIL patterns
test("ASSERTION_FAIL: 'expect...received'", () => {
  assert.equal(classifyFailure("expect(received).toContainText(expected)\n  received: 'foo'\n  expected: 'bar'"), "ASSERTION_FAIL");
});
test("ASSERTION_FAIL: 'toHave...expected'", () => {
  assert.equal(classifyFailure("toHaveText expected 'Submit' but received 'Cancel'"), "ASSERTION_FAIL");
});
test("ASSERTION_FAIL: 'toBeVisible...expected'", () => {
  assert.equal(classifyFailure("toBeVisible expected: visible, received: hidden"), "ASSERTION_FAIL");
});
test("ASSERTION_FAIL: 'matcher error'", () => {
  assert.equal(classifyFailure("matcher error: received value must be a Locator"), "ASSERTION_FAIL");
});

// UNKNOWN / edge cases
test("UNKNOWN: completely unrecognised error text", () => {
  assert.equal(classifyFailure("something something darkside"), "UNKNOWN");
});
test("UNKNOWN: null input", () => {
  assert.equal(classifyFailure(null), "UNKNOWN");
});
test("UNKNOWN: empty string", () => {
  assert.equal(classifyFailure(""), "UNKNOWN");
});
test("UNKNOWN: undefined input", () => {
  assert.equal(classifyFailure(undefined), "UNKNOWN");
});

// Case-insensitivity verification
test("case-insensitive: 'LOCATOR Not Found' → SELECTOR_ISSUE", () => {
  assert.equal(classifyFailure("LOCATOR Not Found in the page"), "SELECTOR_ISSUE");
});
test("case-insensitive: 'Navigation Failed' → NAVIGATION_FAIL", () => {
  assert.equal(classifyFailure("Navigation Failed due to timeout"), "NAVIGATION_FAIL");
});

// First-match-wins: NAVIGATION_FAIL contains 'timeout...navigation' which overlaps TIMEOUT
test("first-match-wins: 'timeout...navigation' → NAVIGATION_FAIL not TIMEOUT", () => {
  // NAVIGATION_FAIL is checked before TIMEOUT in FAILURE_PATTERNS object
  // "timeout 30000ms waiting for navigation" matches both NAVIGATION_FAIL (/timeout.*navigation/i)
  // and TIMEOUT (/timeout \d+ms exceeded/i). NAVIGATION_FAIL wins as it's iterated first.
  const result = classifyFailure("timeout 30000ms waiting for navigation to complete");
  assert.equal(result, "NAVIGATION_FAIL");
});

// ── 2. analyzeRunResults ──────────────────────────────────────────────────────

console.log("\n📊  analyzeRunResults — stats, priority, and improvement shape");

/** Build a minimal testMap entry */
function makeTest(id, overrides = {}) {
  return { id, sourceUrl: `http://app.com/${id}`, type: "functional", ...overrides };
}

test("stats.total counts all results regardless of status", () => {
  const results = [
    { testId: "t1", status: "passed" },
    { testId: "t2", status: "failed", error: "locator not found" },
    { testId: "t3", status: "failed", error: "timeout 30000ms exceeded" },
  ];
  const testMap = { t2: makeTest("t2"), t3: makeTest("t3") };
  const { stats } = analyzeRunResults(results, testMap, {});
  assert.equal(stats.total, 3);
});

test("stats.passed counts only passed results", () => {
  const results = [
    { testId: "t1", status: "passed" },
    { testId: "t2", status: "passed" },
    { testId: "t3", status: "failed", error: "timeout 5000ms exceeded" },
  ];
  const testMap = { t3: makeTest("t3") };
  const { stats } = analyzeRunResults(results, testMap, {});
  assert.equal(stats.passed, 2);
});

test("stats.failed counts only failed results", () => {
  const results = [
    { testId: "t1", status: "passed" },
    { testId: "t2", status: "failed", error: "locator not found" },
    { testId: "t3", status: "failed", error: "navigation failed" },
  ];
  const testMap = { t2: makeTest("t2"), t3: makeTest("t3") };
  const { stats } = analyzeRunResults(results, testMap, {});
  assert.equal(stats.failed, 2);
});

test("stats.needsRegeneration only counts failed results WITH a testMap entry", () => {
  const results = [
    { testId: "t1", status: "failed", error: "locator not found" },
    { testId: "t2", status: "failed", error: "locator not found" }, // t2 NOT in testMap
  ];
  const testMap = { t1: makeTest("t1") }; // only t1
  const { stats } = analyzeRunResults(results, testMap, {});
  // t2 is skipped because testMap["t2"] is undefined
  assert.equal(stats.needsRegeneration, 1);
});

test("stats.passed + stats.failed = stats.total", () => {
  const results = [
    { testId: "t1", status: "passed" },
    { testId: "t2", status: "failed", error: "x" },
    { testId: "t3", status: "passed" },
  ];
  const testMap = { t2: makeTest("t2") };
  const { stats } = analyzeRunResults(results, testMap, {});
  assert.equal(stats.passed + stats.failed, stats.total);
});

test("SELECTOR_ISSUE and URL_MISMATCH and TIMEOUT get priority='high'", () => {
  const highPriorityErrors = [
    { testId: "t1", status: "failed", error: "locator not found after 30000ms" },
    { testId: "t2", status: "failed", error: "expect(received).toHaveURL(expected) received '/login'" },
    { testId: "t3", status: "failed", error: "timeout 30000ms exceeded" },
  ];
  const testMap = {
    t1: makeTest("t1"), t2: makeTest("t2"), t3: makeTest("t3"),
  };
  const { improvements } = analyzeRunResults(highPriorityErrors, testMap, {});
  for (const imp of improvements) {
    assert.equal(imp.priority, "high",
      `${imp.failureCategory} should be high priority, got ${imp.priority}`);
  }
});

test("NAVIGATION_FAIL and UNKNOWN get priority='medium'", () => {
  const mediumErrors = [
    { testId: "t1", status: "failed", error: "navigation failed: 503" },
    { testId: "t3", status: "failed", error: "a completely unknown error" },
  ];
  const testMap = {
    t1: makeTest("t1"), t3: makeTest("t3"),
  };
  const { improvements } = analyzeRunResults(mediumErrors, testMap, {});
  for (const imp of improvements) {
    assert.equal(imp.priority, "medium",
      `${imp.failureCategory} should be medium priority, got ${imp.priority}`);
  }
});

test("ASSERTION_FAIL gets priority='high' (hard-coded values are prompt-quality issues)", () => {
  const assertionErrors = [
    { testId: "t1", status: "failed", error: "expect(received).toContainText(expected) received: 'x'" },
  ];
  const testMap = { t1: makeTest("t1") };
  const { improvements } = analyzeRunResults(assertionErrors, testMap, {});
  assert.equal(improvements[0].priority, "high",
    `ASSERTION_FAIL should be high priority, got ${improvements[0].priority}`);
});

test("improvement object contains testId, test, failureCategory, errorMessage, priority", () => {
  const results = [{ testId: "t1", status: "failed", error: "locator not found" }];
  const testMap = { t1: makeTest("t1") };
  const { improvements } = analyzeRunResults(results, testMap, {});
  assert.equal(improvements.length, 1);
  const imp = improvements[0];
  assert.ok("testId" in imp);
  assert.ok("test" in imp);
  assert.ok("failureCategory" in imp);
  assert.ok("errorMessage" in imp);
  assert.ok("priority" in imp);
  assert.equal(imp.testId, "t1");
  assert.equal(imp.errorMessage, "locator not found");
});

test("assertionMethod extracted correctly from toHaveURL failure", () => {
  const results = [{
    testId: "t1", status: "failed",
    error: "expect(received).toHaveURL(expected) received: '/login'",
  }];
  const testMap = { t1: makeTest("t1") };
  const { improvements } = analyzeRunResults(results, testMap, {});
  assert.equal(improvements[0].assertionMethod, "toHaveURL");
});

test("assertionMethod extracted for toBeVisible failure", () => {
  // The regex requires a dot before the method name — use realistic Playwright output
  const results = [{
    testId: "t1", status: "failed",
    error: "expect(received).toBeVisible(expected) received: false",
  }];
  const testMap = { t1: makeTest("t1") };
  const { improvements } = analyzeRunResults(results, testMap, {});
  assert.equal(improvements[0].assertionMethod, "toBeVisible");
});

test("assertionMethod is null when no assertion method in error", () => {
  const results = [{
    testId: "t1", status: "failed",
    error: "locator('#btn') not found",
  }];
  const testMap = { t1: makeTest("t1") };
  const { improvements } = analyzeRunResults(results, testMap, {});
  assert.equal(improvements[0].assertionMethod, null);
});

test("snapshot from snapshotsByUrl is attached to improvement", () => {
  const results = [{ testId: "t1", status: "failed", error: "locator not found" }];
  const testMap = { t1: makeTest("t1", { sourceUrl: "http://app.com/login" }) };
  const snapshotsByUrl = { "http://app.com/login": { url: "http://app.com/login", title: "Login" } };
  const { improvements } = analyzeRunResults(results, testMap, snapshotsByUrl);
  assert.deepEqual(improvements[0].snapshot, { url: "http://app.com/login", title: "Login" });
});

test("snapshot is undefined when sourceUrl not in snapshotsByUrl", () => {
  const results = [{ testId: "t1", status: "failed", error: "locator not found" }];
  const testMap = { t1: makeTest("t1", { sourceUrl: "http://app.com/unknown" }) };
  const { improvements } = analyzeRunResults(results, testMap, {});
  assert.equal(improvements[0].snapshot, undefined);
});

test("empty results returns zero stats and no improvements", () => {
  const { improvements, stats } = analyzeRunResults([], {}, {});
  assert.equal(improvements.length, 0);
  assert.equal(stats.total, 0);
  assert.equal(stats.passed, 0);
  assert.equal(stats.failed, 0);
});

// ── 3. buildQualityAnalytics ──────────────────────────────────────────────────

console.log("\n📈  buildQualityAnalytics — grouping and insights");

function makeImprovement(testId, failureCategory, errorMessage, testOverrides = {}) {
  return {
    testId,
    test: makeTest(testId, testOverrides),
    failureCategory,
    errorMessage,
    priority: "high",
    assertionMethod: null,
    snapshot: null,
  };
}

test("byCategory groups failures by category correctly", () => {
  const improvements = [
    makeImprovement("t1", "SELECTOR_ISSUE", "locator not found"),
    makeImprovement("t2", "SELECTOR_ISSUE", "element not visible"),
    makeImprovement("t3", "URL_MISMATCH", "toHaveURL failed"),
  ];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.equal(analytics.byCategory.SELECTOR_ISSUE, 2);
  assert.equal(analytics.byCategory.URL_MISMATCH, 1);
});

test("byType groups failures by test.type", () => {
  const improvements = [
    makeImprovement("t1", "TIMEOUT", "timeout", { type: "e2e" }),
    makeImprovement("t2", "TIMEOUT", "timeout", { type: "e2e" }),
    makeImprovement("t3", "TIMEOUT", "timeout", { type: "functional" }),
  ];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.equal(analytics.byType.e2e, 2);
  assert.equal(analytics.byType.functional, 1);
});

test("byPromptVersion groups by test.promptVersion", () => {
  const improvements = [
    makeImprovement("t1", "UNKNOWN", "x", { promptVersion: "2.1.0" }),
    makeImprovement("t2", "UNKNOWN", "x", { promptVersion: "2.1.0" }),
    makeImprovement("t3", "UNKNOWN", "x", { promptVersion: "2.0.0" }),
  ];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.equal(analytics.byPromptVersion["2.1.0"], 2);
  assert.equal(analytics.byPromptVersion["2.0.0"], 1);
});

test("byModel groups by test.modelUsed", () => {
  const improvements = [
    makeImprovement("t1", "UNKNOWN", "x", { modelUsed: "claude-3-5-sonnet" }),
    makeImprovement("t2", "UNKNOWN", "x", { modelUsed: "gpt-4o" }),
  ];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.equal(analytics.byModel["claude-3-5-sonnet"], 1);
  assert.equal(analytics.byModel["gpt-4o"], 1);
});

test("uses 'unknown' for missing promptVersion and modelUsed", () => {
  const improvements = [makeImprovement("t1", "UNKNOWN", "x")];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.equal(analytics.byPromptVersion.unknown, 1);
  assert.equal(analytics.byModel.unknown, 1);
});

test("failedAssertionMethods counts assertion methods from error messages", () => {
  // ASSERTION_METHOD_RE requires a dot before the method name: /\.(toHaveURL|...)\b/i
  // Use realistic Playwright assertion failure messages that include the dot
  const improvements = [
    { ...makeImprovement("t1", "URL_MISMATCH",    "expect(received).toHaveURL(expected) received: '/x'") },
    { ...makeImprovement("t2", "URL_MISMATCH",    "expect(received).toHaveURL(expected) received: '/y'") },
    { ...makeImprovement("t3", "ASSERTION_FAIL",  "expect(received).toBeVisible(expected) received: false") },
  ];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.equal(analytics.failedAssertionMethods.toHaveURL, 2);
  assert.equal(analytics.failedAssertionMethods.toBeVisible, 1);
});

test("totalFailures equals improvements.length", () => {
  const improvements = [
    makeImprovement("t1", "SELECTOR_ISSUE", "x"),
    makeImprovement("t2", "TIMEOUT", "y"),
    makeImprovement("t3", "UNKNOWN", "z"),
  ];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.equal(analytics.totalFailures, 3);
});

test("insights contains URL_MISMATCH hint when URL_MISMATCH failures exist", () => {
  const improvements = [makeImprovement("t1", "URL_MISMATCH", "toHaveURL received '/x'")];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.ok(analytics.insights.some(i => /toHaveURL|URL/i.test(i)),
    `Expected URL hint in insights: ${JSON.stringify(analytics.insights)}`);
});

test("insights contains SELECTOR_ISSUE hint when selector failures exist", () => {
  const improvements = [makeImprovement("t1", "SELECTOR_ISSUE", "locator not found")];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.ok(analytics.insights.some(i => /selector|safeClick|safeFill/i.test(i)),
    `Expected selector hint in insights: ${JSON.stringify(analytics.insights)}`);
});

test("insights contains TIMEOUT hint when timeout failures exist", () => {
  const improvements = [makeImprovement("t1", "TIMEOUT", "timeout 30000ms exceeded")];
  const analytics = buildQualityAnalytics(improvements, {});
  assert.ok(analytics.insights.some(i => /networkidle|timeout|SPA/i.test(i)),
    `Expected timeout hint in insights: ${JSON.stringify(analytics.insights)}`);
});

test("empty improvements returns empty analytics with zero totalFailures", () => {
  const analytics = buildQualityAnalytics([], {});
  assert.equal(analytics.totalFailures, 0);
  assert.deepEqual(analytics.byCategory, {});
  assert.deepEqual(analytics.byType, {});
  assert.equal(analytics.insights.length, 0);
});

test("analytics shape has all required top-level keys", () => {
  const analytics = buildQualityAnalytics([], {});
  const REQUIRED_KEYS = ["byCategory","byType","byPromptVersion","byModel",
                          "failedAssertionMethods","insights","totalFailures"];
  for (const key of REQUIRED_KEYS) {
    assert.ok(key in analytics, `Missing key: ${key}`);
  }
});

// ── 4. detectFlakiness ────────────────────────────────────────────────────────

console.log("\n🎲  detectFlakiness — boundary conditions");

test("empty history → not flaky", () => {
  assert.equal(detectFlakiness([]), false);
});

test("single 'passed' → not flaky", () => {
  assert.equal(detectFlakiness(["passed"]), false);
});

test("single 'failed' → not flaky", () => {
  assert.equal(detectFlakiness(["failed"]), false);
});

test("all passed → not flaky", () => {
  assert.equal(detectFlakiness(["passed","passed","passed","passed"]), false);
});

test("all failed → not flaky", () => {
  assert.equal(detectFlakiness(["failed","failed","failed"]), false);
});

test("one pass one fail → flaky", () => {
  assert.equal(detectFlakiness(["passed","failed"]), true);
});

test("one fail one pass (different order) → flaky", () => {
  assert.equal(detectFlakiness(["failed","passed"]), true);
});

test("mostly passed with one fail → flaky", () => {
  assert.equal(detectFlakiness(["passed","passed","passed","failed","passed"]), true);
});

test("mostly failed with one pass → flaky", () => {
  assert.equal(detectFlakiness(["failed","failed","passed","failed"]), true);
});

test("'warning' status alone → not flaky (no pass+fail combination)", () => {
  assert.equal(detectFlakiness(["warning","warning"]), false);
});

test("'warning' with 'passed' but no 'failed' → not flaky", () => {
  // detectFlakiness checks for both "passed" AND "failed" in the Set
  assert.equal(detectFlakiness(["passed","warning"]), false);
});

// ── 5. FAILURE_PATTERNS priority ordering (array refactor) ───────────────────

console.log("\n🏅  FAILURE_PATTERNS priority — ordered array ensures correct classification");

test("SELECTOR_ISSUE beats TIMEOUT: 'waiting for locator ... timeout 30000ms exceeded'", () => {
  // This error matches both SELECTOR_ISSUE (/waiting for locator/i) and
  // TIMEOUT (/timeout \d+ms exceeded/i). SELECTOR_ISSUE must win because
  // the locator failure is the root cause; the timeout is the symptom.
  const error = "waiting for locator('.submit-btn') to be visible: timeout 30000ms exceeded";
  assert.equal(classifyFailure(error), "SELECTOR_ISSUE");
});

test("SELECTOR_ISSUE beats TIMEOUT: 'locator not found ... timeout exceeded'", () => {
  const error = "locator('#missing') not found, timeout 5000ms exceeded";
  assert.equal(classifyFailure(error), "SELECTOR_ISSUE");
});

test("ASSERTION_FAIL beats TIMEOUT: 'expect(received).toBeVisible timeout 30000ms exceeded'", () => {
  // ASSERTION_FAIL (/expect.*received/i) is checked before TIMEOUT
  const error = "expect(received).toBeVisible(expected): timeout 30000ms exceeded, received: hidden";
  assert.equal(classifyFailure(error), "ASSERTION_FAIL");
});

test("URL_MISMATCH beats ASSERTION_FAIL: 'expect(received).toHaveURL(expected)'", () => {
  // URL_MISMATCH has /expect\(received\)\.toHaveURL\(expected\)/i which is more
  // specific than ASSERTION_FAIL's /expect.*received/i
  const error = "expect(received).toHaveURL(expected)\n  received: '/login'\n  expected: '/dashboard'";
  assert.equal(classifyFailure(error), "URL_MISMATCH");
});

test("NAVIGATION_FAIL beats TIMEOUT: 'timeout 30000ms waiting for navigation'", () => {
  // NAVIGATION_FAIL has /timeout.*navigation/i which matches before TIMEOUT
  const error = "timeout 30000ms waiting for navigation to /dashboard";
  assert.equal(classifyFailure(error), "NAVIGATION_FAIL");
});

test("pure TIMEOUT still classified correctly when no other category matches", () => {
  const error = "Test timeout of 60000ms exceeded.";
  assert.equal(classifyFailure(error), "TIMEOUT");
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n🎉 All feedback-loop-deep tests passed!`);
}
