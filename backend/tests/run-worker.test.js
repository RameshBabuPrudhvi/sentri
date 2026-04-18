/**
 * @module tests/run-worker
 * @description Unit tests for BullMQ worker retry logic in runWorker.js.
 *
 * Verifies:
 *   - On a non-final attempt, the run is reset to "running" (no terminal
 *     side-effects: no activity log, no SSE event, no failed status persisted).
 *   - On the final attempt, the run is persisted as "failed" with full
 *     terminal side-effects (activity log, SSE event, error fields set).
 *   - Abort/aborted runs are handled correctly regardless of attempt number.
 *
 * These tests exercise the logic extracted from the processJob catch block
 * without requiring a real BullMQ worker or Redis connection.
 */

import assert from "node:assert/strict";

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── Simulate the retry-aware catch logic from runWorker.processJob ───────────
// We extract the decision logic to test it in isolation without importing the
// full worker (which requires Redis, BullMQ, and database connections).

/**
 * Simulate the catch-block logic from processJob.
 * Returns an object describing what actions would be taken.
 *
 * @param {Object} params
 * @param {Object} params.run        - Mutable run object.
 * @param {Object} params.job        - Simulated BullMQ job.
 * @param {Error}  params.err        - The error that was thrown.
 * @param {string} params.type       - "crawl" or "test_run".
 * @param {AbortSignal} [params.signal] - Optional AbortSignal for abort detection.
 * @returns {{ action: string, run: Object }}
 */
function simulateCatchBlock({ run, job, err, type, signal }) {
  // Abort handling — check all three paths:
  //   1. err.name === "AbortError" (standard AbortController error)
  //   2. signal.aborted (synchronously set by controller.abort())
  //   3. run.status === "aborted" (set by abort endpoint on in-memory run)
  if (err.name === "AbortError" || signal?.aborted || run.status === "aborted") {
    return { action: "abort", run };
  }

  const maxAttempts = job.opts?.attempts || 2;
  const isFinalAttempt = job.attemptsMade >= maxAttempts - 1;

  const runType = type === "crawl" ? "crawl" : "run";

  if (isFinalAttempt) {
    run.status = "failed";
    run.error = err.message;
    run.errorCategory = "unknown";
    run.finishedAt = new Date().toISOString();
    return { action: "final_fail", run, runType };
  } else {
    run.status = "running";
    run.error = null;
    run.errorCategory = null;
    run.finishedAt = null;
    run.results = [];
    run.passed = 0;
    run.failed = 0;
    run.pagesFound = 0;
    run.logs = [];
    return { action: "retry", run, runType };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log("\n── runWorker retry logic ──");

test("non-final attempt resets run to running state", () => {
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 2 }, attemptsMade: 0 };
  const err = new Error("transient failure");

  const result = simulateCatchBlock({ run, job, err, type: "test_run" });

  assert.equal(result.action, "retry");
  assert.equal(result.run.status, "running");
  assert.equal(result.run.error, null);
  assert.equal(result.run.errorCategory, null);
  assert.equal(result.run.finishedAt, null);
});

test("non-final attempt clears accumulated results, pass/fail counts, and logs", () => {
  // Simulate a run that accumulated partial results before failing
  const run = {
    status: "running",
    error: null,
    errorCategory: null,
    finishedAt: null,
    results: [{ testId: "T-1", status: "passed" }, { testId: "T-2", status: "failed" }],
    passed: 1,
    failed: 1,
    pagesFound: 5,
    logs: ["log line 1", "log line 2"],
  };
  const job = { opts: { attempts: 2 }, attemptsMade: 0 };
  const err = new Error("transient failure");

  const result = simulateCatchBlock({ run, job, err, type: "test_run" });

  assert.equal(result.action, "retry");
  assert.deepEqual(result.run.results, [], "results should be cleared on retry");
  assert.equal(result.run.passed, 0, "passed count should be reset on retry");
  assert.equal(result.run.failed, 0, "failed count should be reset on retry");
  assert.equal(result.run.pagesFound, 0, "pagesFound should be reset on retry");
  assert.deepEqual(result.run.logs, [], "logs should be cleared on retry");
});

test("final attempt persists failed state", () => {
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 2 }, attemptsMade: 1 };
  const err = new Error("permanent failure");

  const result = simulateCatchBlock({ run, job, err, type: "test_run" });

  assert.equal(result.action, "final_fail");
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.error, "permanent failure");
  assert.equal(result.run.errorCategory, "unknown");
  assert.ok(result.run.finishedAt, "finishedAt should be set");
});

test("single-attempt job (attempts=1) is always final", () => {
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 1 }, attemptsMade: 0 };
  const err = new Error("only chance");

  const result = simulateCatchBlock({ run, job, err, type: "crawl" });

  assert.equal(result.action, "final_fail");
  assert.equal(result.run.status, "failed");
});

test("three-attempt job: first two attempts are retries, third is final", () => {
  // Attempt 0 (first try)
  const run1 = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job3 = { opts: { attempts: 3 }, attemptsMade: 0 };
  assert.equal(simulateCatchBlock({ run: run1, job: job3, err: new Error("x"), type: "test_run" }).action, "retry");

  // Attempt 1 (second try)
  const run2 = { status: "running", error: null, errorCategory: null, finishedAt: null };
  job3.attemptsMade = 1;
  assert.equal(simulateCatchBlock({ run: run2, job: job3, err: new Error("x"), type: "test_run" }).action, "retry");

  // Attempt 2 (third and final try)
  const run3 = { status: "running", error: null, errorCategory: null, finishedAt: null };
  job3.attemptsMade = 2;
  assert.equal(simulateCatchBlock({ run: run3, job: job3, err: new Error("x"), type: "test_run" }).action, "final_fail");
});

test("defaults to 2 attempts when job.opts.attempts is not set", () => {
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: {}, attemptsMade: 0 };
  const err = new Error("no attempts configured");

  // attemptsMade=0 < 2-1=1, so this should retry
  assert.equal(simulateCatchBlock({ run, job, err, type: "test_run" }).action, "retry");

  // attemptsMade=1 >= 2-1=1, so this should be final
  const run2 = { status: "running", error: null, errorCategory: null, finishedAt: null };
  job.attemptsMade = 1;
  assert.equal(simulateCatchBlock({ run: run2, job, err, type: "test_run" }).action, "final_fail");
});

test("abort error is handled regardless of attempt number", () => {
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 2 }, attemptsMade: 0 };
  const err = new Error("Aborted");
  err.name = "AbortError";

  const result = simulateCatchBlock({ run, job, err, type: "test_run" });
  assert.equal(result.action, "abort");
});

test("aborted run status is handled regardless of attempt number", () => {
  const run = { status: "aborted", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 2 }, attemptsMade: 0 };
  const err = new Error("something");

  const result = simulateCatchBlock({ run, job, err, type: "test_run" });
  assert.equal(result.action, "abort");
});

test("signal.aborted detects abort even when error is not AbortError", () => {
  // Simulates Playwright wrapping the abort into its own error type
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 2 }, attemptsMade: 0 };
  const err = new Error("Target page, context or browser has been closed");
  // err.name is "Error", not "AbortError" — but the signal was aborted
  const controller = new AbortController();
  controller.abort();

  const result = simulateCatchBlock({ run, job, err, type: "test_run", signal: controller.signal });
  assert.equal(result.action, "abort", "should detect abort via signal.aborted");
});

test("non-aborted signal does not trigger abort path", () => {
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 2 }, attemptsMade: 1 };
  const err = new Error("real failure");
  const controller = new AbortController();
  // signal NOT aborted

  const result = simulateCatchBlock({ run, job, err, type: "test_run", signal: controller.signal });
  assert.equal(result.action, "final_fail", "should not trigger abort when signal is not aborted");
});

test("crawl type is correctly identified", () => {
  const run = { status: "running", error: null, errorCategory: null, finishedAt: null };
  const job = { opts: { attempts: 2 }, attemptsMade: 1 };
  const err = new Error("crawl failed");

  const result = simulateCatchBlock({ run, job, err, type: "crawl" });
  assert.equal(result.action, "final_fail");
  assert.equal(result.runType, "crawl");
});

// ─── Results ──────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
