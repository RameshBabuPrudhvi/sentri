/**
 * @module utils/runWithAbort
 * @description Abortable run helper and abort controller registry.
 *
 * Encapsulates the `AbortController` lifecycle, success/failure logging, and
 * error handling that every async pipeline route (crawl, run, generate) repeats.
 *
 * ### Exports
 * - {@link runWithAbort} — Execute an async function with abort support.
 * - {@link runAbortControllers} — `Map<runId, AbortController>` registry.
 */

import { emitRunEvent } from "../routes/sse.js";
import { logActivity } from "./activityLogger.js";
import { saveDb } from "../db.js";
import { classifyError } from "./errorClassifier.js";

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
      // Persist completed run (results, pass/fail counts, duration, feedback
      // loop improvements). Without this, a crash before the 30s periodic
      // flush restores the run as "interrupted" with all results gone.
      saveDb();
    })
    .catch((err) => {
      runAbortControllers.delete(runId);
      if (err.name === "AbortError" || run.status === "aborted") return;
      const runType = run.type === "crawl" ? "crawl" : "run";
      const classified = classifyError(err, runType);
      console.error(`[${runType}] Run ${runId} failed: ${err.message}`);
      run.status = "failed";
      run.error = classified.message;
      run.errorCategory = classified.category;
      run.finishedAt = new Date().toISOString();
      logActivity({ ...onFailActivity(err), status: "failed" });
      emitRunEvent(runId, "done", { status: "failed" });
      saveDb(); // persist failed status so it isn't misreported as "interrupted"
    });
}
