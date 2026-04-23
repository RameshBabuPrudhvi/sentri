/**
 * @module utils/runWithAbort
 * @description Abortable run helper and abort controller registry.
 *
 * Encapsulates the `AbortController` lifecycle, success/failure logging, and
 * error handling that every async pipeline route (crawl, run, generate) repeats.
 *
 * ### Exports
 * - {@link runWithAbort} — Execute an async function with abort support.
 * - {@link runAbortControllers} — `Map<runId, { controller: AbortController, run: Object, provider: string|null }>` registry.
 */

import { emitRunEvent } from "../routes/sse.js";
import { logActivity } from "./activityLogger.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as runLogRepo from "../database/repositories/runLogRepo.js";
import { classifyError } from "./errorClassifier.js";
import { formatLogLine } from "./logFormatter.js";
import { captureProvider } from "./activeRuns.js";

// ─── Abort registry: runId → AbortController ──────────────────────────────────
// Allows in-progress crawl / generate / test_run operations to be cancelled.
// Maps runId → { controller: AbortController, run: Object, provider: string|null }
// Storing the run reference lets the abort endpoint mutate the same
// in-memory object the pipeline holds, preventing status overwrites.
// Storing the provider lets the chat endpoint skip runs that aren't using
// Ollama when checking for concurrent LLM activity.
export const runAbortControllers = new Map();

/**
 * @param {Object}   [opts.actorInfo]   - { userId, userName } from the triggering request.
 *                                        Spread into the failure logActivity call so the
 *                                        audit trail records who started the run.
 * @param {Function} [opts.onComplete]  - Called after the run reaches any terminal state
 *                                        (completed, failed, or aborted). Receives the
 *                                        run object so callers can inspect final status.
 *                                        Errors thrown by onComplete are silently caught
 *                                        to avoid masking the original run outcome.
 */
export function runWithAbort(runId, run, asyncFn, { onSuccess, onFailActivity, actorInfo, onComplete }) {
  const abortController = new AbortController();
  // Capture the provider at start time so the chat busy guard can accurately
  // filter to runs actually using Ollama. If the user switches providers
  // mid-run, the captured value stays the same — matching the provider the
  // pipeline's LLM calls are pinned to via the sticky fallback mechanism.
  runAbortControllers.set(runId, { controller: abortController, run, provider: captureProvider() });

  asyncFn(abortController.signal)
    .then((result) => {
      runAbortControllers.delete(runId);
      if (run.status !== "aborted") {
        onSuccess?.(result);
      }
      // Persist completed run to SQLite (results, pass/fail counts, duration,
      // feedback loop improvements).
      runRepo.save(run);
    })
    .catch((err) => {
      runAbortControllers.delete(runId);
      if (err.name === "AbortError" || run.status === "aborted") {
        // Flush any results accumulated before the abort so they aren't lost.
        // The abort endpoint already set status="aborted" via runRepo.update(),
        // but the in-memory run object may have results/logs not yet persisted.
        runRepo.save(run);
        return;
      }
      const runType = run.type === "crawl" ? "crawl" : "run";
      const classified = classifyError(err, runType);
      console.error(formatLogLine("error", runId, `[${runType}] ${err.message}`));
      run.status = "failed";
      run.error = classified.message;
      run.errorCategory = classified.category;
      run.finishedAt = new Date().toISOString();
      logActivity({ ...onFailActivity(err), ...(actorInfo || {}), status: "failed" });
      emitRunEvent(runId, "done", { status: "failed" });
      runRepo.save(run); // persist failed status to SQLite
    })
    .finally(async () => {
      // Fire onComplete for any terminal state (completed, failed, aborted).
      // Errors (sync or async) are silently caught so a failing callback
      // never masks the original run outcome or breaks the pipeline cleanup.
      try { await onComplete?.(run); } catch { /* best-effort */ }
      // Evict the run's seq counter from the runLogRepo cache — the run is
      // finished and will never append more log lines, so keeping the entry
      // would be an unbounded memory leak on long-running servers.
      runLogRepo.evictCache(runId);
    });
}
