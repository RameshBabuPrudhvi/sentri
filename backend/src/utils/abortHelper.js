/**
 * abortHelper.js — Shared abort-signal utilities
 *
 * Centralises the abort-check pattern used across pipeline functions so
 * every call-site doesn't repeat the DOMException construction.
 *
 * Moved from src/abortHelper.js → src/utils/abortHelper.js to live
 * alongside other shared utilities (idGenerator.js, runLogger.js).
 */

/**
 * Throws an AbortError if the signal has already been aborted.
 * No-op when signal is null/undefined or not yet aborted.
 *
 * @param {AbortSignal | undefined | null} signal
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Returns true if the run has been aborted (either via run.status or signal).
 * Centralises the duplicated `run.status !== "aborted" && !signal?.aborted`
 * guard used across pipeline functions.
 *
 * @param {object}                       run
 * @param {AbortSignal | undefined | null} [signal]
 */
export function isRunAborted(run, signal) {
  return run.status === "aborted" || !!signal?.aborted;
}

/**
 * Guard that marks a run as "completed" only if it wasn't already aborted,
 * then calls `onComplete` for site-specific logging / SSE emission.
 *
 * Extracts the duplicated pattern:
 *   if (run.status !== "aborted") {
 *     run.status = "completed";
 *     // …log summary, emit SSE done…
 *   }
 *
 * @param {object}   run         — mutable run record
 * @param {function} [onComplete] — called (with no args) only when the run
 *                                   is actually completed (not aborted)
 */
export function finalizeRunIfNotAborted(run, onComplete) {
  if (run.status !== "aborted") {
    run.status = "completed";
    onComplete?.();
  }
}
