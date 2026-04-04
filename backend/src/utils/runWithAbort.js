/**
 * runWithAbort.js — Abortable run helper + abort controller registry
 *
 * Encapsulates the AbortController lifecycle, success/failure logging, and error
 * handling that every async pipeline route (crawl, run, generate) repeats.
 *
 *   runWithAbort(runId, run, asyncFn, { onSuccess, onFailActivity })
 *
 * - Creates & registers an AbortController so POST /api/runs/:id/abort works.
 * - Calls asyncFn(signal) and attaches .then/.catch handlers.
 * - On success: cleans up controller, calls onSuccess(result) unless aborted.
 * - On failure: cleans up controller, marks run as failed, logs activity, emits SSE.
 * - AbortErrors are silently swallowed (already handled by the abort endpoint).
 */

import { emitRunEvent } from "../routes/sse.js";
import { logActivity } from "./activityLogger.js";

// ─── Abort registry: runId → AbortController ──────────────────────────────────
// Allows in-progress crawl / generate / test_run operations to be cancelled.
export const runAbortControllers = new Map();

export function runWithAbort(runId, run, asyncFn, { onSuccess, onFailActivity }) {
  const abortController = new AbortController();
  runAbortControllers.set(runId, abortController);

  asyncFn(abortController.signal)
    .then((result) => {
      runAbortControllers.delete(runId);
      if (run.status !== "aborted") {
        onSuccess?.(result);
      }
    })
    .catch((err) => {
      runAbortControllers.delete(runId);
      if (err.name === "AbortError" || run.status === "aborted") return;
      run.status = "failed";
      run.error = err.message;
      run.finishedAt = new Date().toISOString();
      logActivity({ ...onFailActivity(err), status: "failed" });
      emitRunEvent(runId, "done", { status: "failed" });
    });
}
