/**
 * feedbackIntegration.js — Post-run feedback loop integration
 *
 * Wraps the AI feedback loop (pipeline/feedbackLoop.js) with the
 * provider-availability check, testMap construction, failure-category
 * logging, and run.feedbackLoop assignment that were previously inlined
 * in runTests().
 *
 * Exports:
 *   runFeedbackLoop(run, tests, signal)
 */

import { applyFeedbackLoop, analyzeRunResults } from "../pipeline/feedbackLoop.js";
import { isRunAborted } from "../utils/abortHelper.js";
import { log, logWarn, logSuccess } from "../utils/runLogger.js";
import { structuredLog } from "../utils/logFormatter.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { computeAndPersistFlakyScores } from "../utils/flakyDetector.js";

/** Maximum time the AI feedback loop is allowed to run before being abandoned. */
const FEEDBACK_TIMEOUT_MS = parseInt(process.env.FEEDBACK_TIMEOUT_MS, 10) || 60_000;

/**
 * runFeedbackLoop(run, tests, signal)
 *
 * Analyses failures from the completed test run and auto-regenerates
 * high-priority failing tests via AI.  No-ops silently when:
 *   - There are no failures
 *   - The run was aborted
 *   - No AI provider is configured
 *   - The AI provider is degraded (rate-limited / circuit-broken)
 *
 * The AI portion is wrapped in a timeout (FEEDBACK_TIMEOUT_MS, default 60s)
 * so it can never block run completion indefinitely.
 *
 * @param {object}       run    — mutable run record
 * @param {Array}        tests  — the test objects that were executed
 * @param {AbortSignal}  [signal]
 */
export async function runFeedbackLoop(run, tests, signal) {
  // DIF-004: Always compute flaky scores after a test run, even if all passed.
  // This runs before the AI feedback loop since it's lightweight (no LLM calls).
  try {
    if (run.projectId) {
      computeAndPersistFlakyScores(run.projectId);
    }
  } catch (err) {
    logWarn(run, `Flaky score computation failed: ${err.message}`);
  }

  if (run.failed === 0 || isRunAborted(run, signal)) return;

  try {
    const { hasProvider, isProviderDegraded } = await import("../aiProvider.js");
    if (!hasProvider()) return;

    // Skip AI feedback when the provider is degraded (rate-limited primary with
    // a sticky fallback active, or circuit breaker open).  The feedback loop
    // makes multiple sequential AI calls that would each burn minutes retrying
    // the rate-limited provider, blocking run completion.
    if (isProviderDegraded() || run.rateLimitError) {
      log(run, `⏭️  Skipping AI feedback loop — provider is degraded (rate limit active). Failure analysis logged above.`);
      return;
    }

    structuredLog("feedback.start", { runId: run.id, failures: run.failed });
    log(run, `🔄 Feedback loop: analyzing ${run.failed} failure(s)...`);

    // Build testMap from the actual tests array (not run.tests which is
    // only populated during crawl runs).
    const testMap = {};
    for (const t of tests) {
      const fresh = testRepo.getById(t.id);
      if (fresh) testMap[t.id] = fresh;
    }

    // Populate run.tests so applyFeedbackLoop can find them
    if (!run.tests || run.tests.length === 0) {
      run.tests = tests.map(t => t.id);
    }

    const snapshotsByUrl = {};
    for (const snap of (run.snapshots || [])) { snapshotsByUrl[snap.url] = snap; }
    const { improvements } = analyzeRunResults(run.results, testMap, snapshotsByUrl);

    // Log failure categories so the user can see what went wrong
    const categories = {};
    for (const imp of improvements) {
      categories[imp.failureCategory] = (categories[imp.failureCategory] || 0) + 1;
    }
    if (Object.keys(categories).length > 0) {
      const breakdown = Object.entries(categories).map(([k, v]) => `${k}: ${v}`).join(", ");
      log(run, `📊 Failure breakdown: ${breakdown}`);
    }

    // Wrap the AI-heavy feedback loop in a timeout so it can never block run
    // completion indefinitely (e.g. when Ollama hangs on an oversized prompt).
    const feedback = await Promise.race([
      applyFeedbackLoop(run, { signal }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Feedback loop timed out after ${FEEDBACK_TIMEOUT_MS / 1000}s`)), FEEDBACK_TIMEOUT_MS)
      ),
    ]);
    structuredLog("feedback.complete", { runId: run.id, improved: feedback.improved, skipped: feedback.skipped, failures: run.failed });
    if (feedback.improved > 0) {
      logSuccess(run, `Auto-regenerated ${feedback.improved} failing test(s) (${feedback.skipped} skipped)`);
      log(run, `💡 Regenerated tests will use improved selectors on next run`);
      run.feedbackLoop = feedback;
    } else {
      log(run, `ℹ️  No tests auto-regenerated (${feedback.skipped} low-priority failures skipped)`);
    }
  } catch (err) {
    structuredLog("feedback.error", { runId: run.id, error: err.message?.slice(0, 200) });
    logWarn(run, `Feedback loop error: ${err.message}`);
  }
}
