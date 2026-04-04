/**
 * testRunner.js — Thin orchestrator for test execution
 *
 * Delegates heavy sub-tasks to focused modules under runner/:
 *   - runner/config.js              — env constants, artifact dir setup
 *   - runner/codeParsing.js         — extractTestBody (used for hasCode check)
 *   - runner/executeTest.js         — single-test execution
 *   - runner/feedbackIntegration.js — post-run AI feedback loop
 *
 * This file owns only the browser lifecycle, the per-test loop, trace
 * management, and the final status transition.
 */

import { chromium } from "playwright";
import { extractTestBody } from "./runner/codeParsing.js";
import { executeTest } from "./runner/executeTest.js";
import { runFeedbackLoop } from "./runner/feedbackIntegration.js";
import { BROWSER_HEADLESS, TRACES_DIR } from "./runner/config.js";
import { finalizeRunIfNotAborted, isRunAborted } from "./utils/abortHelper.js";
import { emitRunEvent, log, logWarn, logError, logSuccess } from "./utils/runLogger.js";

// NOTE: extractTestBody, patchNetworkIdle, stripPlaywrightImports,
// runGeneratedCode, getExpect, and executeTest are now in runner/ modules.
// This file only re-uses extractTestBody (imported above) for the "hasCode"
// log message inside the test loop.

export async function runTests(project, tests, run, db, { signal } = {}) {
  const runId = run.id;
  const tracePath = `${TRACES_DIR}/${runId}.zip`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: BROWSER_HEADLESS,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (launchErr) {
    run.status = "failed";
    run.error = `Browser launch failed: ${launchErr.message}`;
    run.finishedAt = new Date().toISOString();
    logError(run, `Browser launch failed: ${launchErr.message}`);
    throw launchErr;
  }

  // Shared tracing context (separate from per-test video contexts)
  let traceContext;
  try {
    traceContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
      viewport: { width: 1280, height: 720 },
    });
    await traceContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
  } catch (ctxErr) {
    await browser.close().catch(() => {});
    run.status = "failed";
    run.error = `Trace context setup failed: ${ctxErr.message}`;
    run.finishedAt = new Date().toISOString();
    logError(run, `Trace context setup failed: ${ctxErr.message}`);
    throw ctxErr;
  }

  log(run, `🚀 Starting test run: ${tests.length} tests`);

  const runStart = Date.now();
  const allVideoSegments = [];

  try {
    for (let i = 0; i < tests.length; i++) {
      // Check abort signal between tests so the run stops promptly
      if (signal?.aborted) {
        logWarn(run, `Abort signal received — skipping remaining ${tests.length - i} test(s)`);
        break;
      }

      const test = tests[i];
      const hasCode = !!(test.playwrightCode && extractTestBody(test.playwrightCode));
      log(run, `  ▶ [${i + 1}/${tests.length}] ${test.name} ${hasCode ? "(executing generated code)" : "(fallback smoke test)"}`);

      try {
        const result = await executeTest(test, browser, runId, i, runStart, db);
        run.results.push(result);

        if (result.videoPath) allVideoSegments.push(result.videoPath);

        if (result.status === "passed") {
          run.passed++;
          logSuccess(run, `PASSED (${result.durationMs}ms)`);
        } else if (result.status === "warning") {
          run.passed++;
          logWarn(run, `WARNING: ${result.error}`);
        } else {
          run.failed++;
          logError(run, `FAILED: ${result.error}`);
        }

        // Emit result event (without the heavy base64 screenshot)
        const { screenshot: _ss, ...resultLean } = result;
        emitRunEvent(run.id, "result", { result: resultLean });
        if (result.screenshotPath) {
          emitRunEvent(run.id, "screenshot", {
            testId: test.id,
            screenshotPath: result.screenshotPath,
          });
        }

        if (db.tests[test.id]) {
          db.tests[test.id].lastResult = result.status;
          db.tests[test.id].lastRunAt = new Date().toISOString();
        }
      } catch (err) {
        run.failed++;
        run.results.push({
          testId: test.id, testName: test.name,
          status: "failed", error: err.message,
          durationMs: 0, network: [], consoleLogs: [],
        });
        logError(run, `FAILED (exception): ${err.message}`);
      }
    }
  } finally {
    // Always clean up browser resources — even if the loop threw unexpectedly
    try {
      await traceContext.tracing.stop({ path: tracePath });
      run.tracePath = `/artifacts/traces/${runId}.zip`;
      log(run, `  📊 Trace saved`);
    } catch (e) {
      logWarn(run, `Trace save failed: ${e.message}`);
    }
    await traceContext.close().catch(() => {});
    await browser.close().catch((err) => {
      console.warn("[testRunner] browser.close() failed:", err.message);
    });
  }

  if (allVideoSegments.length > 0) {
    run.videoPath = allVideoSegments[0];
    run.videoSegments = allVideoSegments;
    log(run, `  🎬 ${allVideoSegments.length} video segment(s) saved`);
  }

  // NOTE: We intentionally keep run.status === "running" here so that:
  //   1. The abort endpoint (POST /api/runs/:id/abort) still works during the
  //      feedback loop — it checks run.status === "running".
  //   2. SSE reconnections don't prematurely close — the /events endpoint sends
  //      an immediate "done" + res.end() when run.status !== "running", which
  //      would cut off the client while the feedback loop is still active.
  // The status is set to "completed" only after the feedback loop finishes.
  log(run, `📋 Test execution done: ${run.passed} passed, ${run.failed} failed out of ${run.total} — starting post-run analysis…`);

  // Broadcast a snapshot so the frontend sees updated pass/fail counts while
  // the feedback loop performs long-running AI calls below.
  if (!isRunAborted(run, signal)) {
    emitRunEvent(run.id, "snapshot", { run });
  }

  // ── Feedback loop: auto-regenerate high-priority failing tests ──────────
  // Delegated to runner/feedbackIntegration.js — no-ops when no failures,
  // aborted, or no AI provider configured.
  await runFeedbackLoop(run, tests, db, signal);

  // Now that the feedback loop is done, finalize the run status.
  // This is the single place where status transitions to "completed".
  // Guard the log() call inside the callback so it only fires when the run
  // actually transitions to "completed". After an abort, the SSE "done" event
  // has already been emitted and the stream is closed — logging here would
  // append to run.logs but the SSE broadcast would be silently lost.
  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = Date.now() - runStart;
    logSuccess(run, `Run complete: ${run.passed} passed, ${run.failed} failed out of ${run.total}`);
  });

  // Emit "done" only now — after the feedback loop — so the frontend's
  // fetchRun() always sees the final, stable completed state.
  // Skip if already aborted — the abort endpoint already emitted the done event.
  if (!isRunAborted(run, signal)) {
    emitRunEvent(run.id, "done", { status: run.status, passed: run.passed, failed: run.failed, total: run.total });
  }
}