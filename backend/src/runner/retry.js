/**
 * Execute an async function with retries.
 *
 * `fn` receives the current zero-based `attempt` index so callers can branch
 * (e.g. log differently on retry). On exhaustion, the last error is rethrown
 * with `err.retryCount` set to the number of retry attempts actually made
 * (i.e. total attempts minus the initial try) — callers should prefer this
 * over assuming `maxRetries`, since `fn` itself may have thrown synchronously
 * before reaching its first retry.
 *
 * ## Artifact overwrite behaviour (AUTO-005 + testRunner.js integration)
 *
 * The test runner (`backend/src/testRunner.js:229-240`) calls
 * `executeWithRetries` with the same `(runId, stepIndex)` on every attempt.
 * Each attempt recreates its temp Playwright context, records a video, and
 * writes screenshots / step captures keyed by `(runId, stepIndex)` — so the
 * **last attempt's artifacts are the ones that survive**; earlier attempts'
 * files are overwritten via `fs.renameSync` during teardown.
 *
 * This is intentional — reviewers want to see what happened on the winning
 * (or final failing) attempt, not the noise of prior flaky attempts. But it
 * means you cannot replay intermediate retries: if attempt 1 failed, attempt
 * 2 passed, the DB records `retryCount=1, status=passed` and only attempt
 * 2's video/screenshots/trace exist on disk.
 *
 * If per-attempt artifact retention is ever needed (e.g. for flake-root-cause
 * investigation), scope the artifact paths by `(runId, stepIndex, attempt)`
 * in `backend/src/runner/executeTest.js` and add a retention policy — the
 * storage hit is N× video size per retried test.
 *
 * @param {Function} fn         - `(attempt: number) => Promise<any>`
 * @param {number}   maxRetries - Number of retries after the first attempt.
 * @returns {Promise<{result: Object, retryCount: number}>}
 */
export async function executeWithRetries(fn, maxRetries) {
  const attempts = Math.max(1, maxRetries + 1);
  let lastError;
  let attempt = 0;
  for (; attempt < attempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, retryCount: attempt };
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError && typeof lastError === "object") {
    // Annotate with the number of retries that were actually consumed
    // (total attempts minus the initial try). Caller uses this to populate
    // `result.retryCount` accurately on exhausted failures.
    lastError.retryCount = Math.max(0, attempt - 1);
  }
  throw lastError;
}
