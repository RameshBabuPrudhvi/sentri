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
