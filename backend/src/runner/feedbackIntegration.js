/**
 * feedbackIntegration.js — Post-run feedback loop integration
 *
 * Wraps the AI feedback loop (pipeline/feedbackLoop.js) with the
 * provider-availability check, testMap construction, failure-category
 * logging, and run.feedbackLoop assignment that were previously inlined
 * in runTests().
 *
 * Exports:
 *   runFeedbackLoop(run, tests, db, signal)
 */

import { applyFeedbackLoop, analyzeRunResults } from "../pipeline/feedbackLoop.js";
import { isRunAborted } from "../utils/abortHelper.js";
import { log, logWarn, logSuccess } from "../utils/runLogger.js";

/**
 * runFeedbackLoop(run, tests, db, signal)
 *
 * Analyses failures from the completed test run and auto-regenerates
 * high-priority failing tests via AI.  No-ops silently when:
 *   - There are no failures
 *   - The run was aborted
 *   - No AI provider is configured
 *
 * @param {object}       run    — mutable run record
 * @param {Array}        tests  — the test objects that were executed
 * @param {object}       db     — in-memory database
 * @param {AbortSignal}  [signal]
 */
export async function runFeedbackLoop(run, tests, db, signal) {
  if (run.failed === 0 || isRunAborted(run, signal)) return;

  try {
    const { hasProvider } = await import("../aiProvider.js");
    if (!hasProvider()) return;

    log(run, `🔄 Feedback loop: analyzing ${run.failed} failure(s)...`);

    // Build testMap from the actual tests array (not run.tests which is
    // only populated during crawl runs).
    const testMap = {};
    for (const t of tests) { if (db.tests[t.id]) testMap[t.id] = db.tests[t.id]; }

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
      log(run, `    📊 Failure breakdown: ${breakdown}`);
    }

    const feedback = await applyFeedbackLoop(run, db, { signal });
    if (feedback.improved > 0) {
      logSuccess(run, `Auto-regenerated ${feedback.improved} failing test(s) (${feedback.skipped} skipped)`);
      log(run, `    💡 Regenerated tests will use improved selectors on next run`);
      run.feedbackLoop = feedback;
    } else {
      log(run, `    ℹ️  No tests auto-regenerated (${feedback.skipped} low-priority failures skipped)`);
    }
  } catch (err) {
    logWarn(run, `Feedback loop error: ${err.message}`);
  }
}
