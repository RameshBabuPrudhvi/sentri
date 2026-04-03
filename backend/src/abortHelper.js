/**
 * abortHelper.js — Shared abort-signal utilities
 *
 * Centralises the abort-check pattern used across pipeline functions so
 * every call-site doesn't repeat the DOMException construction.
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
