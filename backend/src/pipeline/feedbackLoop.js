/**
 * feedbackLoop.js — Layer 5: Analyze run results and improve failing tests
 *
 * Pipeline: generate → run → analyze → improve → rerun
 *
 * Failure categories:
 *   SELECTOR_ISSUE    — element not found, locator broke
 *   WEAK_ASSERTION    — test passed but assertion was too loose
 *   FLAKY             — passed sometimes, failed sometimes
 *   NAVIGATION_FAIL   — page didn't load or wrong URL
 *   TIMEOUT           — element wait exceeded timeout
 */

import { generateText, parseJSON } from "../aiProvider.js";

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

// ── Flakiness detection ───────────────────────────────────────────────────────

export function detectFlakiness(testHistory) {
  // testHistory = array of "passed"|"failed"|"warning" strings
  if (testHistory.length < 2) return false;
  const statuses = new Set(testHistory);
  return statuses.has("passed") && statuses.has("failed");
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

    NAVIGATION_FAIL: `The test failed due to navigation issues.
Fix by:
- Adding proper waitUntil: 'networkidle' or 'domcontentloaded'
- Adding a retry mechanism for page.goto()
- Checking the URL is correct and accessible`,

    TIMEOUT: `The test timed out waiting for elements.
Fix by:
- Increasing timeout: { timeout: 30000 }
- Waiting for network idle before assertions
- Using waitForSelector before interactions
- Adding page.waitForLoadState()`,

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
  "type": "${test.type || "visibility"}",
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
        priority: failureCategory === "SELECTOR_ISSUE" ? "high" : "medium",
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
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
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
  if (!run.results?.length) return { improved: 0, skipped: 0 };

  // Build lookup maps
  const testMap = {};
  for (const testId of (run.tests || [])) {
    if (db.tests[testId]) testMap[testId] = db.tests[testId];
  }

  const snapshotsByUrl = {};
  // Snapshots are stored on the run during crawl
  for (const snap of (run.snapshots || [])) {
    snapshotsByUrl[snap.url] = snap;
  }

  const { improvements, stats } = analyzeRunResults(run.results, testMap, snapshotsByUrl);

  let improved = 0;
  for (const improvement of improvements) {
    if (improvement.priority !== "high") continue; // Only auto-fix high priority failures
    if (signal?.aborted) break; // Respect abort signal between AI calls
    const regenerated = await regenerateFailingTest(improvement, signal);
    if (regenerated) {
      db.tests[improvement.testId] = { ...db.tests[improvement.testId], ...regenerated };
      improved++;
    }
  }

  return { improved, skipped: improvements.length - improved, stats };
}
