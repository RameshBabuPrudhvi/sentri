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
// Task 2 — per-agent SSE events. `regenerateFailingTest` is the post-run
// quality-fix LLM call (the only AI call left in the feedback-loop stage),
// so we emit start/done on step 7 — the "Validate / quality check" stage
// users see in the NarrativeFeed.
import { emitAgentEvent } from "../aiProvider/agentEventEmitter.js";
import { emitHandoffEnvelope, mainThreadId, readLatestEnvelope } from "../aiProvider/agentHandoff.js";
// AUTO-023 B3 — reviewer↔author loop runner. Wires the post-run quality-fix
// regenerator through `runReviewerAuthorLoop` so a regenerated test that
// STILL fails heuristic validation (brittle selectors, unbalanced brackets,
// unknown matchers, secret-scan hits) gets one more author pass to fix the
// specific issues the heuristic reviewer flagged — rather than shipping a
// "fixed" test that still has the same shape of bug. The reviewer is the
// existing `validateTest` heuristic — **zero extra LLM cost**: an `accept`
// on round 0 short-circuits identically to pre-loop behaviour.
import { runReviewerAuthorLoop, ReviewRejection } from "../aiProvider/agentLoop.js";
import { validateTest } from "./testValidator.js";
import { PIPELINE_STEPS } from "../utils/pipelineState.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import { getPromptRules } from "../selfHealing.js";
import { getTier, TIER_CONFIG } from "./prompts/promptTiers.js";
import { buildCapabilityCoverageBlock } from "./prompts/playwrightCapabilityGuide.js";
import { scoreTestWithFactors, normalizeQualityToConfidence } from "./deduplicator.js";
import { logActivity } from "../utils/activityLogger.js";
import { ACTIVITY_TYPES } from "../constants/activityTypes.js";

// ── Failure classification ────────────────────────────────────────────────────
//
// Priority-ordered array of [category, patterns] tuples.
//
// Order matters: the first matching category wins. Using an ordered array (not
// a plain object) makes the priority explicit and stable — Object.entries
// iteration order is implementation-defined and can vary across V8 versions.
//
// Priority rationale:
//   1. SELECTOR_ISSUE  — checked first because "waiting for locator … timeout
//      30 000 ms exceeded" matches both SELECTOR_ISSUE and TIMEOUT. A locator
//      failure is the root cause; the timeout is the symptom. Reporting the
//      root cause produces more actionable self-healing hints.
//   2. URL_MISMATCH    — specific navigation-result error; distinct from a
//      general navigation failure.
//   3. NAVIGATION_FAIL — network / goto errors.
//   4. ASSERTION_FAIL  — generic expect() mismatch (lower specificity than the
//      above, so checked after them).
//   5. TIMEOUT         — catch-all for any remaining timeout messages that were
//      not already classified as a selector or navigation issue.

const FAILURE_PATTERNS = [
  // BOT_BLOCK — checked FIRST because anti-bot interstitials produce SECONDARY
  // symptoms (locator timeout, navigation timeout) that would otherwise be
  // misclassified as SELECTOR_ISSUE / TIMEOUT and trigger the misleading
  // "AI is generating CSS selectors" insight. The runtime page URL ends up
  // on `/sorry/`, `/captcha`, `/challenge`, `/blocked` (mirrors the same
  // anti-bot list at `backend/src/pipeline/stateExplorer.js:51-52`), or the
  // raw "Are you a robot" / CAPTCHA page-text leaks into the error message
  // via the failure screenshot's adjacent log lines. Telling operators
  // "this site blocks automation" is the only honest message — no amount of
  // selector self-healing or assertion softening recovers from an
  // interstitial that intentionally hides the real page.
  // NOTE: `/access denied/i` is intentionally OMITTED — it matches generic
  // HTTP 403 authorization failures (e.g. `"Error: Access denied — insufficient
  // permissions for /admin"`), which are NOT bot-block interstitials. Classifying
  // them as BOT_BLOCK would skip auto-regeneration on legitimate auth-needed
  // tests. Bot-detection pages reliably surface one of the URL/text patterns
  // below; falling back to UNKNOWN for naked "access denied" preserves the
  // feedback loop's chance to repair an auth-flow test.
  ["BOT_BLOCK", [
    /\/sorry\//i,
    /\/captcha/i,
    /\/challenge/i,
    // `/blocked` mirrors the `stateExplorer.js` anti-bot URL list referenced
    // in the comment block above. Without it a SUT that redirects to
    // `/blocked` (Cloudflare's "you have been blocked" page, custom WAF
    // landing pages) falls through to SELECTOR_ISSUE on the secondary
    // locator timeout — defeating the entire reason this category exists.
    //
    // Anchored to a path-segment boundary (`/blocked` followed by `/`,
    // `?`, `#`, or end-of-string) so legitimate application paths like
    // `/users/blocked-list`, `/content/blocked-items`, or
    // `/admin/blocked-accounts` are NOT misclassified as bot-blocks. The
    // canonical anti-bot landing page is exactly `/blocked` (Cloudflare,
    // most WAF vendors); apps that nest functionality under `/blocked-*`
    // are a real-world false-positive risk per Lifeguard BUG-0003.
    /\/blocked(?:[/?#]|$)/i,
    /recaptcha/i,
    /unusual traffic/i,
    /are you a robot/i,
    /detected unusual traffic/i,
    /verify you are human/i,
    /cloudflare.*challenge/i,
  ]],
  ["SELECTOR_ISSUE", [
    /locator.*not found/i,
    /element not visible/i,
    /no elements found/i,
    /waiting for locator/i,
    /element handle is not attached/i,
    /strict mode violation/i,
  ]],
  ["URL_MISMATCH", [
    /url mismatch/i,
    /redirected to unexpected url/i,
    /page\.url\(\).*not.*match/i,
    /expect\(received\)\.toHaveURL\(expected\)/i,
    /toHaveURL.*received/i,
  ]],
  ["NAVIGATION_FAIL", [
    /net::ERR/i,
    /page.goto/i,
    /navigation failed/i,
    /timeout.*navigation/i,
    /ERR_NAME_NOT_RESOLVED/i,
  ]],
  ["NETWORK_MOCK_FAIL", [
    /page\.route/i,
    /route\.fulfill/i,
    /route handler/i,
    /mock(ed)? response/i,
  ]],
  ["FRAME_FAIL", [
    /frameLocator/i,
    /frame .* not found/i,
    /iframe.*not found/i,
    /cannot access iframe/i,
  ]],
  ["API_ASSERTION_FAIL", [
    /request\.newContext.*(?:status|schema|contract|body)/i,
    /api\.(?:get|post|put|patch|delete|fetch).*(?:status|schema|contract|body)/i,
    /api response (?:status|schema|contract)/i,
    /\bres\.status\(\)/i,
  ]],
  ["ASSERTION_FAIL", [
    /expect.*received/i,
    /toHave.*expected/i,
    /toBeVisible.*expected/i,
    /matcher error/i,
  ]],
  ["TIMEOUT", [
    /timeout \d+ms exceeded/i,
    /waiting for.*timeout/i,
    /Test timeout/i,
  ]],
];

/**
 * Classify a test failure.
 *
 * @param {string}  errorMessage  Playwright error text (`result.error`).
 * @param {Object}  [context]
 * @param {string}  [context.finalUrl]    Last page URL recorded on the result
 *   (`result.url`). When the SUT redirected the test onto an anti-bot
 *   interstitial like `https://www.google.com/sorry/…`, the URL is the most
 *   reliable signal — the error message itself usually just shows a generic
 *   `waiting for locator('h3')` timeout (the bot wall hides the real page).
 *   Checking the URL alongside the error text closes that gap and prevents
 *   bot-blocked runs from being misclassified as SELECTOR_ISSUE, which
 *   surfaces the misleading "AI is generating CSS selectors" insight.
 * @returns {string} One of the FAILURE_PATTERNS keys, or "UNKNOWN".
 */
export function classifyFailure(errorMessage, context = {}) {
  const finalUrl = typeof context?.finalUrl === "string" ? context.finalUrl : "";
  if (!errorMessage && !finalUrl) return "UNKNOWN";
  for (const [category, patterns] of FAILURE_PATTERNS) {
    // `finalUrl` is ONLY consulted for BOT_BLOCK. The other categories'
    // patterns are tuned for Playwright error text — letting them match
    // arbitrary URL substrings (e.g. `executeTest.js` falls back to
    // `test.sourceUrl` when the live page URL is blank, so a test sourced
    // from `https://example.com/expect/received` could spuriously trigger
    // ASSERTION_FAIL's `/expect.*received/i`) misclassifies failures and
    // distorts the dashboard's defect breakdown.
    const allowUrlMatch = category === "BOT_BLOCK";
    if (patterns.some(p =>
      (errorMessage && p.test(errorMessage)) ||
      (allowUrlMatch && finalUrl && p.test(finalUrl))
    )) {
      return category;
    }
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
 * detectFlakyTests(projectId) → Map<testId, flakyInfo>
 *
 * Scans all run results for a project and identifies tests that have both
 * passed and failed across different runs.
 */
export function detectFlakyTests(projectId) {
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
  if (byCategory.BOT_BLOCK > 0) {
    // Honest message — when the SUT redirects to an anti-bot interstitial
    // (`/sorry/`, `/captcha`, "unusual traffic", etc.) the test code itself
    // is fine. No selector self-heal or assertion rewrite recovers from a
    // CAPTCHA. Surfacing the truth keeps operators from chasing the
    // misleading "AI is generating CSS selectors" insight that would
    // otherwise fire on the secondary `waiting for locator('h3') timeout`
    // symptom.
    insights.push(`${byCategory.BOT_BLOCK} test(s) were blocked by the site's bot-detection (CAPTCHA / "unusual traffic" / "are you a robot" interstitial). The generated test is fine — the target site refused automation. Try a test-friendly site (e.g. https://duckduckgo.com, https://demoqa.com, your own staging environment), or configure browser fingerprinting / proxy rotation if you must exercise this domain.`);
  }
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

function buildImprovementPrompt(test, failureCategory, errorMessage, snapshot, tier) {
  const categoryInstructions = {
    NETWORK_MOCK_FAIL: `The test failed around network interception/mocking.
Fix by:
- Preserving page.route()/route.fulfill() flow — do not remove mock setup
- Ensuring mocked response shape matches app expectations (keys/types)
- Keeping assertions aligned to the mocked payload and rendered UI`,

    FRAME_FAIL: `The test failed inside an iframe/frame context.
Fix by:
- Using frameLocator() targeting the correct iframe selector/title/name
- Performing interactions/assertions on frame-scoped locators
- Avoiding page-level selectors for frame-contained elements`,

    API_ASSERTION_FAIL: `The test failed in API request/response validation.
Fix by:
- Keeping request.newContext() calls and endpoint method usage intact
- Asserting status/body against actual API contract (types + required keys)
- Avoiding UI-only page assertions for API-only tests`,

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
This often happens because the test hard-coded a crawl-time value that changed at runtime.
Fix by:
- Using softer matchers: toContainText instead of toHaveText for any text that may vary
- Using regex patterns for dynamic content: dates (/\\d{4}-\\d{2}-\\d{2}/), IDs (/Order #\\d+/), prices (/\\$[\\d,.]+/), UUIDs (/[a-f0-9-]{36}/)
- For personalized text (e.g. "Welcome John"), assert only the static label: toContainText('Welcome')
- For counts that change, use not.toHaveCount(0) instead of toHaveCount(N)
- For toasts/notifications, use toContainText(/success|saved|created|updated|deleted/i)
- Adding proper wait before assertion: await expect(locator).toContainText('expected', { timeout: 10000 })
- Asserting on what's actually present on the page — check the error message for the "received" value`,

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
- Elements: ${JSON.stringify((snapshot?.elements || []).slice(0, TIER_CONFIG[tier || "cloud"].maxElements), null, 2)}

INSTRUCTIONS:
${categoryInstructions[failureCategory] || categoryInstructions.UNKNOWN}

SELF-HEALING RULES:
${getPromptRules(tier || "cloud")}

${buildCapabilityCoverageBlock({ mode: "debug", tier: tier || "cloud" })}

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
  // ASSERTION_FAIL is included because hard-coded crawl-time values (dates, IDs,
  // counts) are a prompt-quality issue, not a real application regression.
  //
  // BOT_BLOCK is intentionally EXCLUDED — when the target site redirects to a
  // CAPTCHA / "unusual traffic" interstitial, no AI rewrite of the test code
  // recovers (the bot wall hides the real page). Regenerating would waste an
  // AI call and produce another test that fails the same way. The Quality
  // Insights banner already surfaces the honest BOT_BLOCK message.
  const HIGH_PRIORITY_CATEGORIES = new Set([
    "SELECTOR_ISSUE",
    "URL_MISMATCH",
    "TIMEOUT",
    "ASSERTION_FAIL",
    "NETWORK_MOCK_FAIL",
    "FRAME_FAIL",
    "API_ASSERTION_FAIL",
  ]);

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

      // Pass `result.url` (final page URL captured by `executeTest.js` in its
      // `finally` block) so the classifier can catch bot-block interstitials
      // — e.g. a test against google.com that lands on `/sorry/index` shows
      // up as a generic "waiting for locator('h3') timeout" in `result.error`
      // but the URL clearly identifies the anti-bot page. See classifyFailure
      // jsdoc for the full rationale.
      const failureCategory = classifyFailure(result.error, { finalUrl: result.url });
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
 * regenerateFailingTest(improvement, signal, options) → improved test or null
 *
 * Calls the AI to produce a fixed version of a failing test.
 * Accepts an optional AbortSignal so the operation can be cancelled.
 *
 * @param {Object} improvement       - From `analyzeRunResults`.
 * @param {AbortSignal} [signal]     - Forwarded to the AI provider call.
 * @param {Object} [options]
 * @param {string} [options.runId]   - GAP-005 (migration 056): correlate
 *   the AI request log row to the originating run. The caller
 *   (`applyFeedbackLoop` below) passes `run.id`; standalone callers may
 *   omit it and the column simply stays NULL.
 */
export async function regenerateFailingTest(improvement, signal, options = {}) {
  const { test, failureCategory, errorMessage, snapshot } = improvement;

  try {
    throwIfAborted(signal);
    const tier = getTier();
    // AI-005 — resolve workspaceId from the project row.
    let workspaceId = null;
    if (test.projectId) {
      try { workspaceId = projectRepo.getById(test.projectId)?.workspaceId || null; }
      catch { /* DB unavailable — fall back to env-default routing */ }
    }
    // Project URL: needed by `validateTest` for placeholder-URL detection.
    // Best-effort — missing project just loosens that one check; syntax /
    // selector / secret-scan gates remain intact.
    let projectUrl = "";
    if (test.projectId) {
      try { projectUrl = projectRepo.getById(test.projectId)?.url || ""; }
      catch { /* see above */ }
    }
    // Step 7 — Quality check. GAP-005 (migration 056) threads `runId`
    // through `generateText` so the AI request log row correlates to the
    // originating run. `_runId === null` (eval harness, CLI, standalone
    // tests) silently no-ops every envelope + agent_event emit downstream.
    const _runId = options.runId || null;
    const threadId = _runId ? mainThreadId(_runId) : null;
    // Bundle 2 contract — read the inbound envelope addressed to `author`
    // at stage entry. Pinned by the pipeline-driven spy test in
    // `backend/tests/agent-pipeline-envelope.test.js`. The result feeds
    // the first author handoff inside the loop via the captured
    // `inbound.id` (threaded through the per-round emit on the
    // round-0 author handoff envelope).
    const inbound = readLatestEnvelope({ threadId, workspaceId, toRole: "author" });

    // ──────────────────────────────────────────────────────────────────
    // AUTO-023 B3 — runReviewerAuthorLoop wire-up
    // ──────────────────────────────────────────────────────────────────
    //
    // Reviewer is the existing `testValidator.validateTest` heuristic —
    // NOT an LLM call. Worst-case cost is `maxReviewRounds: 2` author
    // LLM calls (one initial fix + one retry on heuristic-detected
    // residual issues). Best-case is one author call — byte-identical
    // to the pre-loop single-call path. Zero extra LLM cost on accept.
    //
    // Why heuristic-only reviewer: the pre-loop regenerator silently
    // shipped tests that STILL had brittle selectors / unbalanced
    // brackets / placeholder URLs / secret-scan hits because the
    // validator's signal arrived AFTER the LLM call. Surfacing those
    // issues to a second author pass closes the "we regenerated, but
    // the regenerated test is also broken" gap.
    //
    // Bundle 2 contract preserved: the loop emits author→reviewer +
    // reviewer→author handoff envelopes via its own `agent_message`
    // writes with `replyToId` threading the chain. The captured
    // `inbound` envelope's id is used to seed the first author message's
    // `replyToId` so the audit chain remains intact whether one or two
    // rounds run.
    //
    // `runId === null` callers (eval harness, CLI, standalone tests):
    // every envelope/event emit no-ops; behaviour is identical to the
    // pre-loop path.
    let firstAuthorStartFired = false;
    let finalCandidate = null;
    const out = await runReviewerAuthorLoop(
      // Initial artifact carries the failing test as a single-test
      // collection so the loop's `validateRevisionIssues` can match
      // reviewer issues back to the right test by id on round 1+.
      { tests: [{ ...test, _regenerationReason: failureCategory }] },
      {
        runId: _runId,
        threadId,
        workspaceId,
        // Cap at 2 rounds so a chronically-bad LLM bails out instead of
        // burning credits. Per-workspace `agent_configs.maxReviewRounds`
        // can override (clamped to [1, HARD_MAX_REVIEW_ROUNDS=10]) but
        // we explicitly pin 2 as the operationally safe ceiling for
        // the post-run feedback-loop surface.
        maxReviewRounds: 2,

        runAuthor: async ({ round, reviewerIssues }) => {
          throwIfAborted(signal);
          let prompt = buildImprovementPrompt(test, failureCategory, errorMessage, snapshot, tier);
          if (round > 0 && Array.isArray(reviewerIssues) && reviewerIssues.length > 0) {
            const issueLines = reviewerIssues
              .slice(0, 8)
              .map((i) => "- " + i.problem + (i.suggestion ? " (try: " + i.suggestion + ")" : ""))
              .join("\n");
            prompt = prompt + "\n\nROUND " + (round + 1) + " — the previous attempt STILL has these issues per heuristic review:\n" + issueLines + "\n\nFIX THESE SPECIFIC ISSUES. Keep the rest of the test unchanged.";
          }
          // The B2.2 `emitAgentEvent` start/done bracket on step 7 fires
          // ONCE on round 0 to preserve the pre-loop NarrativeFeed log
          // shape. The loop itself emits richer per-round `agent_message`
          // envelopes — the operator sees iteration via the
          // AgentConversation feed, not via repeated step-7 start events.
          if (!firstAuthorStartFired) {
            emitAgentEvent(_runId, { step: PIPELINE_STEPS.REVIEW, agent: "author", phase: "start", workspaceId,
              message: "Repairing " + (test?.name || "failing test") + " (" + failureCategory + ")" });
            firstAuthorStartFired = true;
          }
          const text = await generateText(prompt, { signal, agentRole: "author", workspaceId, runId: _runId });
          const improved = parseJSON(text);
          // Project safe fields onto a fresh copy of the ORIGINAL test
          // (never let the LLM override id / projectId / reviewStatus).
          const candidate = {
            ...test,
            name: improved?.name || test.name,
            description: improved?.description || test.description,
            priority: improved?.priority || test.priority,
            type: improved?.type || test.type,
            steps: Array.isArray(improved?.steps) ? improved.steps : test.steps,
            playwrightCode: improved?.playwrightCode || test.playwrightCode,
            _regenerated: true,
            _regenerationReason: failureCategory,
            _originalCode: test.playwrightCode,
          };
          finalCandidate = candidate;
          return { tests: [candidate] };
        },

        runReviewer: async ({ artifact }) => {
          throwIfAborted(signal);
          const candidate = artifact?.tests?.[0];
          if (!candidate) return { verdict: "accept" };
          const issues = validateTest(candidate, projectUrl) || [];
          if (issues.length === 0) return { verdict: "accept" };
          // Cap at 5 issues — the prompt-side `runAuthor` already slices
          // to 8 as defence-in-depth. validateTest's issue strings embed
          // the suggested fix inline (e.g. "use getByRole instead of CSS
          // selector"), so we don't need a separate `suggestion` field.
          const shaped = issues.slice(0, 5).map((problem) => ({
            testId: candidate.id,
            problem,
          }));
          return { verdict: "revise", artifact: { issues: shaped } };
        },
      },
    );

    // Done event fires ONCE after the loop terminates (mirror of the
    // single start event above) so the NarrativeFeed shows one
    // start/done pair per regeneration, not one per round.
    emitAgentEvent(_runId, { step: PIPELINE_STEPS.REVIEW, agent: "author", phase: "done", workspaceId });

    // Bundle 2 audit-trail bridge: the loop wrote its own author/reviewer
    // envelopes internally, but the captured `inbound` envelope's reply
    // chain expects ONE explicit author→reviewer handoff bridging the
    // stage entry. Emit it once after the loop terminates so the chain
    // anchors to the inbound envelope's id — preserves the pre-PR
    // audit-trail shape that downstream consumers (NarrativeFeed, audit
    // export) already key on.
    emitHandoffEnvelope({
      runId: _runId, threadId, workspaceId,
      fromRole: "author", toRole: "reviewer",
      replyToId: inbound?.id || null,
      artifact: {
        testId: test?.id || null,
        failureCategory,
        outcome: out?.outcome || null,
        roundsCompleted: out?.roundsCompleted || 0,
        improved: { name: finalCandidate?.name, description: finalCandidate?.description },
      },
      rationale: "Author regenerated failing test (B3 loop outcome: " + (out?.outcome || "unknown") + ")",
    });

    // Return the final candidate. The loop's `artifact` field carries
    // the latest tests collection regardless of `outcome` (accept /
    // max_rounds / timeout / quota_exhausted) — we always ship the
    // best attempt the author produced.
    return finalCandidate || (out?.artifact?.tests?.[0] || null);
  } catch (err) {
    if (err.name === "AbortError") throw err; // propagate abort
    if (err instanceof ReviewRejection) return null; // unrecoverable — keep original
    return null; // Regeneration failed — keep original
  }
}

/**
 * applyFeedbackLoop(run, { signal } = {}) → summary
 *
 * Full feedback loop: analyzes results, regenerates failing tests.
 * Called after a test run completes.
 * Accepts an optional AbortSignal so long-running AI calls can be cancelled.
 */
export async function applyFeedbackLoop(run, { signal } = {}) {
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
    const flakyTests = detectFlakyTests(projectId);
    analytics.flakyTests = Array.from(flakyTests.values());
    stats.flaky = flakyTests.size;
  }

  // Store analytics on the run record so the frontend can display them
  run.qualityAnalytics = analytics;

  let improved = 0;
  for (const improvement of improvements) {
    if (improvement.priority !== "high") continue; // Only auto-fix high priority failures
    if (signal?.aborted) break; // Respect abort signal between AI calls
    const regenerated = await regenerateFailingTest(improvement, signal, { runId: run.id });
    if (regenerated) {
      // Route regenerated tests back through human review instead of
      // auto-approving. This preserves the "nothing executes until a
      // human approves" principle and prevents silently introducing
      // flawed tests into the approved pool.
      // Strip non-column properties before persisting. regenerateFailingTest()
      // adds underscore-prefixed metadata (_regenerated, _regenerationReason,
      // _originalCode) and the original test may carry _quality, _assertionEnhanced,
      // _generatedFrom — none of which are columns in the tests table.
      const { id: _id, _regenerated, _regenerationReason, _originalCode, _quality, _assertionEnhanced, _generatedFrom, ...fields } = regenerated;

      // Re-score quality against the *regenerated* `playwrightCode`. Without
      // this, the persisted `qualityScore` / `qualityScoreFactors` /
      // `confidenceScore` keep the values from the original (failing) test,
      // so the Review Queue's "why was this drafted?" popover shows penalties
      // that no longer apply, and the auto-approval threshold compares against
      // a stale score. Mirrors the Step 6a re-score in
      // `backend/src/pipeline/pipelineOrchestrator.js:108-129` so feedback-loop
      // regenerations stay consistent with first-time generations.
      const { score, factors } = scoreTestWithFactors(fields);
      fields.qualityScore = score;
      fields.qualityScoreFactors = factors;
      fields.confidenceScore = normalizeQualityToConfidence(score);

      // Persist the regeneration reason on the test row so the frontend can
      // explain "why is this back in draft?" — without this column, users
      // see a previously-approved test silently revert to draft with no
      // visible cause (the underscore-prefixed `_regenerationReason` was
      // stripped above because it is not a tests-table column). We piggy-back
      // on the existing `reviewComment` column (already shown on test detail
      // + review queue cards) so no schema migration is required.
      const reason = _regenerationReason || "UNKNOWN";
      const reviewComment = `Auto-regenerated by feedback loop after failure (${reason}). Original code preserved in run results.`;

      const wasApproved = improvement.test.reviewStatus === "approved";
      const previousSource = improvement.test.approvalSource || null;

      testRepo.update(improvement.testId, {
        ...fields,
        reviewStatus: "draft",
        reviewComment,
        // Clear stale approval provenance — the previous decision applied to
        // the *old* code, not the regenerated one. Without this, a once-
        // auto-approved test that just regenerated would still display
        // "auto-approved at score 0.87" provenance pointing at code that no
        // longer exists in the row.
        approvalSource: null,
        approvalThreshold: null,
        approvedAt: null,
        approvedBy: null,
      });

      // Write an audit row so operators can see why a previously-approved
      // test silently reverted to draft. Without this, the only signal in
      // the Audit Log is `test_run.complete` — a user looking at the test
      // detail sees "draft" with no explanation of who/what changed it.
      // Actor is the system (no req available inside the pipeline); we use
      // `userName: "auto-feedback-loop"` so the audit row visually matches
      // the existing `auto-approver` convention used by AUTO-003b.
      try {
        const project = projectRepo.getById(improvement.test.projectId);
        logActivity({
          type: ACTIVITY_TYPES.TEST_REGENERATE,
          projectId: improvement.test.projectId,
          projectName: project?.name || null,
          workspaceId: project?.workspaceId || null,
          testId: improvement.testId,
          testName: improvement.test.name,
          // ENT-004 (migration 055) — pass `runId` as a first-class arg
          // for consistency with every other PR-modified `logActivity`
          // call site (routes/runs.js, routes/tests.js). The legacy
          // `meta.runId` fallback in `activityLogger.js` still works,
          // but explicit-arg is the canonical shape and won't break if
          // the auto-derive fallback is ever removed.
          runId: run.id,
          userId: "system",
          userName: "auto-feedback-loop",
          detail: wasApproved
            ? `Auto-regenerated after failure (${reason}) — reverted from ${previousSource === "auto" ? "auto-approved" : "approved"} to draft for re-review.`
            : `Auto-regenerated after failure (${reason}). Re-scored quality=${Number((fields.qualityScore ?? 0)).toFixed(2)}.`,
          status: "success",
          meta: {
            reason,
            runId: run.id,
            wasApproved,
            previousApprovalSource: previousSource,
            newQualityScore: fields.qualityScore ?? null,
            newConfidenceScore: fields.confidenceScore ?? null,
          },
        });
      } catch (auditErr) {
        // Best-effort — never let an audit-log failure abort the regeneration.
        // The persisted `reviewComment` already captures the reason on the
        // test row, so the user-facing "why is this draft?" signal survives
        // even if the activity row write fails.
        // eslint-disable-next-line no-console
        console.warn(`[feedbackLoop] failed to write audit row for test.regenerate: ${auditErr?.message || auditErr}`);
      }

      improved++;
    }
  }

  return { improved, skipped: improvements.length - improved, stats, analytics };
}
