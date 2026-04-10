/**
 * @module testRunner
 * @description Thin orchestrator for Playwright test execution with parallel
 * worker support.
 *
 * Owns the browser lifecycle, per-test loop (sequential or parallel), trace
 * management, and final status transition. Delegates heavy sub-tasks to
 * focused modules:
 *
 * | Module                          | Responsibility                        |
 * |---------------------------------|---------------------------------------|
 * | `runner/config.js`              | Env constants, artifact dir setup     |
 * | `runner/codeParsing.js`         | `extractTestBody` (hasCode check)     |
 * | `runner/executeTest.js`         | Single-test execution                 |
 * | `runner/feedbackIntegration.js` | Post-run AI feedback loop             |
 *
 * ### Parallel execution
 * When `parallelWorkers > 1`, tests run in concurrent browser contexts within
 * a single Chromium instance. Each worker picks the next queued test, executes
 * it in its own isolated `BrowserContext`, and reports back. The shared browser
 * process keeps memory usage lower than launching N separate browsers.
 *
 * Concurrency is controlled by:
 * 1. `PARALLEL_WORKERS` env var (default for all runs)
 * 2. Per-run override via `options.parallelWorkers` (from Test Dials / API)
 *
 * ### Exports
 * - {@link runTests} — Execute an array of approved tests against a project.
 */

import { extractTestBody, isApiTest } from "./runner/codeParsing.js";
import { executeTest } from "./runner/executeTest.js";
import { runFeedbackLoop } from "./runner/feedbackIntegration.js";
import { TRACES_DIR, DEFAULT_PARALLEL_WORKERS, launchBrowser } from "./runner/config.js";
import { finalizeRunIfNotAborted, isRunAborted } from "./utils/abortHelper.js";
import { emitRunEvent, log, logWarn, logError, logSuccess } from "./utils/runLogger.js";
import { classifyError } from "./utils/errorClassifier.js";
import { structuredLog, formatLogLine } from "./utils/logFormatter.js";

// ── Concurrency helper ────────────────────────────────────────────────────────
// Lightweight promise pool — no external dependencies. Runs `fn` for each item
// in `items` with at most `concurrency` in-flight at once. Results are returned
// in the original item order.

async function poolMap(items, concurrency, fn, signal) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      if (signal?.aborted) break;
      const idx = nextIndex++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Execute an array of approved tests against a project using Playwright.
 * Launches Chromium, runs each test with self-healing (optionally in parallel),
 * collects results, saves traces/videos, runs the AI feedback loop, and
 * finalises the run.
 *
 * @param {Object}      project                   - The project `{ id, name, url }`.
 * @param {Object[]}    tests                     - Array of test objects to execute.
 * @param {Object}      run                       - The run record (mutated in place).
 * @param {Object}      db                        - The database object from {@link module:db.getDb}.
 * @param {Object}      [options]
 * @param {number}      [options.parallelWorkers]  - Concurrent browser contexts (1–10). Overrides env default.
 * @param {AbortSignal} [options.signal]           - Abort signal for cancellation.
 * @returns {Promise<void>}
 */
export async function runTests(project, tests, run, db, { parallelWorkers, signal } = {}) {
  const runId = run.id;
  const tracePath = `${TRACES_DIR}/${runId}.zip`;

  // Resolve concurrency: per-run override → env default → 1 (sequential)
  const workers = Math.max(1, Math.min(10, parallelWorkers || DEFAULT_PARALLEL_WORKERS));

  // Classify each test once upfront and cache the result on the test object.
  // This avoids re-parsing the code body via isApiTest() multiple times per
  // test (previously called 4× each: allApiOnly, apiCount, logging, executeTest).
  // executeTest reads test._isApi instead of re-calling isApiTest().
  for (const t of tests) {
    t._isApi = !!(t.playwrightCode && isApiTest(t.playwrightCode));
    // Persist the classification on the test object so the frontend can read
    // test.isApiTest directly without reimplementing the detection heuristic.
    if (db.tests[t.id]) {
      db.tests[t.id].isApiTest = t._isApi;
    }
  }

  // If every test is API-only, skip the entire browser launch + trace context
  // to save ~100-200MB of RAM.
  const allApiOnly = tests.every(t => t._isApi);

  let browser = null;
  let traceContext = null;

  structuredLog("run.start", { runId, projectId: project.id, tests: tests.length, workers, allApiOnly });

  if (!allApiOnly) {
    try {
      browser = await launchBrowser();
      structuredLog("browser.launched", { runId });
    } catch (launchErr) {
      const classified = classifyError(launchErr, "run");
      run.status = "failed";
      run.error = classified.message;
      run.errorCategory = classified.category;
      run.finishedAt = new Date().toISOString();
      logError(run, classified.message);
      structuredLog("browser.launch_failed", { runId, error: classified.message });
      throw launchErr;
    }

    // Shared tracing context (separate from per-test video contexts)
    try {
      traceContext = await browser.newContext({
        userAgent: "Mozilla/5.0 (compatible; AutonomousQA/1.0)",
        viewport: { width: 1280, height: 720 },
      });
      await traceContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
    } catch (ctxErr) {
      await browser.close().catch(() => {});
      const classified = classifyError(ctxErr, "run");
      run.status = "failed";
      run.error = classified.message;
      run.errorCategory = classified.category;
      run.finishedAt = new Date().toISOString();
      logError(run, classified.message);
      throw ctxErr;
    }
  }

  const apiCount = tests.filter(t => t._isApi).length;
  const modeLabel = workers > 1 ? `${workers} parallel workers` : "sequential";
  log(run, `🚀 Starting test run: ${tests.length} tests (${modeLabel})`);
  log(run, `⚙️ Run config:`);
  log(run, `Execution mode: ${workers > 1 ? `⚡ Parallel (${workers} workers)` : "▶ Sequential (1 worker)"}`);
  log(run, `Tests queued: ${tests.length}${apiCount > 0 ? ` (${apiCount} API, ${tests.length - apiCount} browser)` : ""}`);
  log(run, `Project URL: ${project.url}`);
  log(run, allApiOnly ? `Browser: ⏭️ Skipped (all tests are API-only)` : `Browser: Chromium (headless)`);

  const runStart = Date.now();
  const allVideoSegments = [];

  // ── Process a single test result — shared by the pool worker callback ────
  function processResult(test, result) {
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

    // Broadcast a snapshot after each result so the frontend progress bar
    // updates in real time (especially important during parallel execution
    // where multiple results arrive in quick succession).
    if (!isRunAborted(run, signal)) {
      emitRunEvent(run.id, "snapshot", { run });
    }
  }

  try {
    await poolMap(tests, workers, async (test, i) => {
      if (signal?.aborted) return;

      const hasCode = !!(test.playwrightCode && extractTestBody(test.playwrightCode));
      const workerTag = workers > 1 ? ` [w${(i % workers) + 1}]` : "";
      const typeTag = test._isApi ? "🌐 API" : hasCode ? "executing generated code" : "fallback smoke test";
      log(run, `▶ [${i + 1}/${tests.length}]${workerTag} ${test.name} (${typeTag})`);

      try {
        const result = await executeTest(test, browser, runId, i, runStart, db);
        structuredLog("test.result", { runId, testId: test.id, status: result.status, durationMs: result.durationMs });
        processResult(test, result);
      } catch (err) {
        // Build a synthetic result and route through processResult so SSE
        // `result` and `snapshot` events are emitted — otherwise the
        // frontend progress bar stalls during parallel execution.
        structuredLog("test.crash", { runId, testId: test.id, error: err.message?.slice(0, 200) });
        const errorResult = {
          testId: test.id, testName: test.name,
          status: "failed", error: err.message,
          durationMs: 0, network: [], consoleLogs: [],
        };
        processResult(test, errorResult);
      }
    }, signal);
  } finally {
    // Always clean up browser resources — even if the loop threw unexpectedly.
    // browser/traceContext are null when all tests are API-only.
    if (traceContext) {
      try {
        await traceContext.tracing.stop({ path: tracePath });
        run.tracePath = `/artifacts/traces/${runId}.zip`;
        log(run, `📊 Trace saved`);
      } catch (e) {
        logWarn(run, `Trace save failed: ${e.message}`);
      }
      await traceContext.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch((err) => {
        console.warn(formatLogLine("warn", null, `[testRunner] browser.close() failed: ${err.message}`));
      });
    }
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
  const elapsed = ((Date.now() - runStart) / 1000).toFixed(1);
  log(run, `📋 Test execution done: ${run.passed} passed, ${run.failed} failed out of ${run.total} in ${elapsed}s${workers > 1 ? ` (${workers}x parallel)` : ""} — starting post-run analysis…`);

  // Broadcast a final snapshot so the frontend sees the complete pass/fail
  // counts before the feedback loop starts its long-running AI calls.
  // (processResult already emits per-result snapshots, but this ensures the
  // frontend has the final state even if the last result's snapshot was lost.)
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
    structuredLog("run.complete", {
      runId, projectId: project.id,
      passed: run.passed, failed: run.failed, total: run.total,
      durationMs: run.duration,
    });
  });

  // Emit "done" only now — after the feedback loop — so the frontend's
  // fetchRun() always sees the final, stable completed state.
  // Skip if already aborted — the abort endpoint already emitted the done event.
  if (!isRunAborted(run, signal)) {
    emitRunEvent(run.id, "done", { status: run.status, passed: run.passed, failed: run.failed, total: run.total });
  }
}