/**
 * feedbackLoop.js — Layer 5: Analyze run results, track failure patterns, improve tests
 *
 * Pipeline: generate → run → analyze → improve → rerun
 *
 * Failure categories:
 *   SELECTOR_ISSUE    — element not found, locator broke
 *   ASSERTION_FAIL    — assertion value mismatch
 *   NAVIGATION_FAIL   — page didn't load or wrong URL
 *   TIMEOUT           — element wait exceeded timeout
 *   URL_MISMATCH      — toHaveURL assertion failed, URL redirect, or page.url() mismatch
 *   UNKNOWN           — unclassified failure
 *
 * Quality analytics (P3):
 *   - Failure breakdown by category, test type, prompt version, assertion pattern
 *   - Flaky test detection across run history
 *   - Actionable insights for prompt improvement
 */

import { generateText, parseJSON } from "../aiProvider.js";
import { throwIfAborted } from "../utils/abortHelper.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";

// ── Failure classification ────────────────────────────────────────────────────

const FAILURE_PATTERNS = {
  SELECTOR_ISSUE: [
    /locator.*not found/i,
    /element not visible/i,
    /no elements found/i,
    /waiting for locator/i,
    /element handle is not attached/i,
    /strict mode violation/i,
  ],
  URL_MISMATCH: [
    /url mismatch/i,
    /redirected to unexpected url/i,
    /page\.url\(\).*not.*match/i,
    /expect\(received\)\.toHaveURL\(expected\)/i,
    /toHaveURL.*received/i,
  ],
  NAVIGATION_FAIL: [
    /net::ERR/i,
    /page.goto/i,
    /navigation failed/i,
    /timeout.*navigation/i,
    /ERR_NAME_NOT_RESOLVED/i,
  ],
  TIMEOUT: [
    /timeout \d+ms exceeded/i,
    /waiting for.*timeout/i,
    /Test timeout/i,
  ],
  ASSERTION_FAIL: [
    /expect.*received/i,
    /toHave.*expected/i,
    /toBeVisible.*expected/i,
    /matcher error/i,
  ],
};

export function classifyFailure(errorMessage) {
  if (!errorMessage) return "UNKNOWN";
  for (const [category, patterns] of Object.entries(FAILURE_PATTERNS)) {
    if (patterns.some(p => p.test(errorMessage))) return category;
  }
  return "UNKNOWN";
}

// ── Assertion pattern extraction ──────────────────────────────────────────────
// Extracts which Playwright assertion method caused the failure so we can
// track which assertion types are most fragile across runs.

const ASSERTION_METHOD_RE = /\.(toHaveURL|toHaveTitle|toBeVisible|toContainText|toHaveText|toHaveValue|toBeEnabled|toBeDisabled|toHaveCount|toBeChecked)\b/i;

function extractFailedAssertionMethod(errorMessage) {
  const match = (errorMessage || "").match(ASSERTION_METHOD_RE);
  return match ? match[1] : null;
}

// ── Flakiness detection ───────────────────────────────────────────────────────

export function detectFlakiness(testHistory) {
  // testHistory = array of "passed"|"failed"|"warning" strings
  if (testHistory.length < 2) return false;
  const statuses = new Set(testHistory);
  return statuses.has("passed") && statuses.has("failed");
}

/**
 * detectFlakyTests(db, projectId) → Map<testId, flakyInfo>
 *
 * Scans all run results for a project and identifies tests that have both
 * passed and failed across different runs.
 */
export function detectFlakyTests(db, projectId) {
  const testResults = new Map(); // testId → { passes, fails }
  const allRuns = runRepo.getByProjectId(projectId);

  for (const run of allRuns) {
    if (!run.results) continue;
    for (const result of run.results) {
      if (!testResults.has(result.testId)) {
        testResults.set(result.testId, { passes: 0, fails: 0 });
      }
      const entry = testResults.get(result.testId);
      if (result.status === "passed") entry.passes++;
      if (result.status === "failed") entry.fails++;
    }
  }

  const flakyTests = new Map();
  for (const [testId, { passes, fails }] of testResults) {
    if (passes > 0 && fails > 0) {
      const test = testRepo.getById(testId);
      const total = passes + fails;
      flakyTests.set(testId, {
        testId,
        name: test?.name || "Unknown",
        passCount: passes,
        failCount: fails,
        flakyRate: Math.round((Math.min(passes, fails) / total) * 100),
      });
    }
  }

  return flakyTests;
}

// ── Quality analytics ────────────────────────────────────────────────────────
// Correlates failures with test metadata (type, promptVersion, modelUsed,
// assertion patterns) to produce actionable insights for prompt improvement.

/**
 * buildQualityAnalytics(improvements, testMap) → analytics object
 *
 * Produces a structured breakdown of failures for the run record.
 */
export function buildQualityAnalytics(improvements, testMap) {
  const byCategory = {};
  const byType = {};
  const byPromptVersion = {};
  const byModel = {};
  const failedAssertionMethods = {};

  for (const imp of improvements) {
    const t = imp.test;

    // By failure category
    byCategory[imp.failureCategory] = (byCategory[imp.failureCategory] || 0) + 1;

    // By test type
    const type = t.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;

    // By prompt version
    const pv = t.promptVersion || "unknown";
    byPromptVersion[pv] = (byPromptVersion[pv] || 0) + 1;

    // By AI model
    const model = t.modelUsed || "unknown";
    byModel[model] = (byModel[model] || 0) + 1;

    // By assertion method that failed
    const method = extractFailedAssertionMethod(imp.errorMessage);
    if (method) {
      failedAssertionMethods[method] = (failedAssertionMethods[method] || 0) + 1;
    }
  }

  // Generate actionable insights
  const insights = [];
  if (byCategory.URL_MISMATCH > 0) {
    insights.push(`${byCategory.URL_MISMATCH} test(s) failed on URL assertions — consider switching to content-based assertions (toBeVisible, toContainText) instead of toHaveURL.`);
  }
  if (byCategory.SELECTOR_ISSUE > 0) {
    insights.push(`${byCategory.SELECTOR_ISSUE} test(s) failed on selectors — the AI may be generating CSS selectors instead of using self-healing helpers (safeClick, safeFill, safeExpect).`);
  }
  if (byCategory.TIMEOUT > 0) {
    insights.push(`${byCategory.TIMEOUT} test(s) timed out — likely using waitForLoadState('networkidle') or insufficient timeouts. Check for SPA-heavy pages.`);
  }
  if (failedAssertionMethods.toHaveURL > 0) {
    const maxMethod = Object.entries(failedAssertionMethods).sort((a, b) => b[1] - a[1])[0];
    const qualifier = maxMethod && maxMethod[0] === "toHaveURL" ? "the most fragile" : "a fragile";
    insights.push(`toHaveURL is ${qualifier} assertion (${failedAssertionMethods.toHaveURL} failure${failedAssertionMethods.toHaveURL !== 1 ? "s" : ""}). Prefer asserting visible page content over URL patterns.`);
  }

  return {
    byCategory,
    byType,
    byPromptVersion,
    byModel,
    failedAssertionMethods,
    insights,
    totalFailures: improvements.length,
  };
}

// ── Improvement prompt builder ────────────────────────────────────────────────

function buildImprovementPrompt(test, failureCategory, errorMessage, snapshot) {
  const categoryInstructions = {
    SELECTOR_ISSUE: `The test failed because a selector couldn't find an element. 
Rewrite using more resilient selectors:
- Use getByRole(), getByLabel(), getByText() instead of CSS selectors
- Use .filter({ hasText: /.../ }) for specificity
- Add .first() to avoid strict mode violations
- Avoid nth-child, position-based selectors`,

    URL_MISMATCH: `The test failed because a toHaveURL() assertion didn't match the actual URL.
Real-world sites redirect unpredictably (CAPTCHAs, consent pages, geo-redirects, login walls).
Fix by:
- REMOVE the toHaveURL() assertion entirely
- Replace it with a CONTENT assertion: await expect(page.getByText('expected heading')).toBeVisible()
- If you must check the URL, use the LOOSEST hostname-only regex: await expect(page).toHaveURL(/example\\.com/i)
- NEVER match on path segments or query params`,

    NAVIGATION_FAIL: `The test failed due to navigation issues.
Fix by:
- Using { waitUntil: 'domcontentloaded' } instead of 'networkidle'
- Adding a retry mechanism for page.goto()
- Checking the URL is correct and accessible`,

    TIMEOUT: `The test timed out waiting for elements.
Fix by:
- Increasing timeout: { timeout: 30000 }
- Using await page.waitForSelector('selector', { timeout: 15000 }) before assertions
- Using { waitUntil: 'domcontentloaded' } after navigation — NEVER use 'networkidle'
- Adding await page.waitForLoadState('domcontentloaded') after page.goto()`,

    ASSERTION_FAIL: `The assertion failed - the actual value didn't match expected.
Fix by:
- Using softer matchers: toContainText instead of toHaveText
- Using regex patterns: /partial match/i
- Adding proper wait before assertion
- Asserting on what's actually present on the page`,

    UNKNOWN: `The test failed for an unknown reason.
Rewrite more defensively:
- Wrap risky operations in try/catch
- Use .catch(() => {}) for optional assertions
- Add explicit waits before interactions`,
  };

  return `You are a senior QA engineer fixing a broken Playwright test.

FAILED TEST:
Name: ${test.name}
URL: ${test.sourceUrl}
Error: ${errorMessage}
Failure Category: ${failureCategory}

ORIGINAL CODE:
${test.playwrightCode}

PAGE CONTEXT:
- Title: ${snapshot?.title || "unknown"}
- Forms: ${snapshot?.forms || 0}
- Elements: ${JSON.stringify((snapshot?.elements || []).slice(0, 15), null, 2)}

INSTRUCTIONS:
${categoryInstructions[failureCategory] || categoryInstructions.UNKNOWN}

Return ONLY valid JSON (no markdown):
{
  "name": "improved test name",
  "description": "what was fixed and why",
  "priority": "${test.priority || "medium"}",
  "type": "${test.type || "functional"}",
  "steps": ["step 1", "step 2"],
  "playwrightCode": "full improved playwright test code"
}`;
}

// ── Main feedback loop ────────────────────────────────────────────────────────

/**
 * analyzeRunResults(runResults, tests, snapshots) → improvement plan
 *
 * Returns a list of tests that need regeneration with failure context.
 */
export function analyzeRunResults(runResults, testMap, snapshotsByUrl) {
  const improvements = [];
  const stats = { total: 0, passed: 0, failed: 0, flaky: 0, needsRegeneration: 0 };

  // High-priority categories that should be auto-fixed — these are almost always
  // prompt-quality issues rather than real application bugs.
  const HIGH_PRIORITY_CATEGORIES = new Set(["SELECTOR_ISSUE", "URL_MISMATCH", "TIMEOUT"]);

  for (const result of runResults) {
    stats.total++;

    if (result.status === "passed") {
      stats.passed++;
      continue;
    }

    if (result.status === "failed") {
      stats.failed++;
      const test = testMap[result.testId];
      if (!test) continue;

      const failureCategory = classifyFailure(result.error);
      const snapshot = snapshotsByUrl[test.sourceUrl];

      improvements.push({
        testId: result.testId,
        test,
        failureCategory,
        errorMessage: result.error,
        snapshot,
        assertionMethod: extractFailedAssertionMethod(result.error),
        priority: HIGH_PRIORITY_CATEGORIES.has(failureCategory) ? "high" : "medium",
      });
      stats.needsRegeneration++;
    }
  }

  return { improvements, stats };
}

/**
 * regenerateFailingTest(improvement, signal) → improved test or null
 *
 * Calls the AI to produce a fixed version of a failing test.
 * Accepts an optional AbortSignal so the operation can be cancelled.
 */
export async function regenerateFailingTest(improvement, signal) {
  const { test, failureCategory, errorMessage, snapshot } = improvement;

  try {
    throwIfAborted(signal);
    const prompt = buildImprovementPrompt(test, failureCategory, errorMessage, snapshot);
    const text = await generateText(prompt, { signal });
    const improved = parseJSON(text);

    // Only pick safe fields from the AI response — never let the LLM
    // override critical DB fields like id, projectId, or reviewStatus.
    return {
      ...test,
      name: improved.name || test.name,
      description: improved.description || test.description,
      priority: improved.priority || test.priority,
      type: improved.type || test.type,
      steps: Array.isArray(improved.steps) ? improved.steps : test.steps,
      playwrightCode: improved.playwrightCode || test.playwrightCode,
      _regenerated: true,
      _regenerationReason: failureCategory,
      _originalCode: test.playwrightCode,
    };
  } catch (err) {
    if (err.name === "AbortError") throw err; // propagate abort
    return null; // Regeneration failed — keep original
  }
}

/**
 * applyFeedbackLoop(run, db, { signal } = {}) → summary
 *
 * Full feedback loop: analyzes results, regenerates failing tests.
 * Called after a test run completes.
 * Accepts an optional AbortSignal so long-running AI calls can be cancelled.
 */
export async function applyFeedbackLoop(run, db, { signal } = {}) {
  if (!run.results?.length) return { improved: 0, skipped: 0, analytics: null };

  // Build lookup maps
  const testMap = {};
  for (const testId of (run.tests || [])) {
    const t = testRepo.getById(testId);
    if (t) testMap[testId] = t;
  }

  const snapshotsByUrl = {};
  // Snapshots are stored on the run during crawl
  for (const snap of (run.snapshots || [])) {
    snapshotsByUrl[snap.url] = snap;
  }

  const { improvements, stats } = analyzeRunResults(run.results, testMap, snapshotsByUrl);

  // Build quality analytics — correlate failures with prompt version, model, type
  const analytics = buildQualityAnalytics(improvements, testMap);

  // Detect flaky tests across all runs for this project
  const projectId = run.projectId;
  if (projectId) {
    const flakyTests = detectFlakyTests(db, projectId);
    analytics.flakyTests = Array.from(flakyTests.values());
    stats.flaky = flakyTests.size;
  }

  // Store analytics on the run record so the frontend can display them
  run.qualityAnalytics = analytics;

  let improved = 0;
  for (const improvement of improvements) {
    if (improvement.priority !== "high") continue; // Only auto-fix high priority failures
    if (signal?.aborted) break; // Respect abort signal between AI calls
    const regenerated = await regenerateFailingTest(improvement, signal);
    if (regenerated) {
      // Route regenerated tests back through human review instead of
      // auto-approving. This preserves the "nothing executes until a
      // human approves" principle and prevents silently introducing
      // flawed tests into the approved pool.
      const { id: _id, ...fields } = regenerated;
      testRepo.update(improvement.testId, { ...fields, reviewStatus: "draft" });
      improved++;
    }
  }

  return { improved, skipped: improvements.length - improved, stats, analytics };
}
