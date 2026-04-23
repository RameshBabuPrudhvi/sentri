/**
 * @module workers/runWorker
 * @description BullMQ Worker for durable run execution (INF-003).
 *
 * Processes jobs from the `sentri:runs` queue.  Each job contains the
 * serialised run parameters (project, tests, run record, options).  The
 * worker calls `crawlAndGenerateTests` or `runTests` depending on the
 * job type, mirroring the logic previously inlined in route handlers.
 *
 * ### Concurrency
 * Controlled by `MAX_WORKERS` env var (default 2).  Each concurrent slot
 * processes one run at a time — Playwright browser instances are not shared
 * across jobs.
 *
 * ### Lifecycle
 * - {@link startWorker} — Create and start the BullMQ Worker.
 * - {@link stopWorker}  — Gracefully close the worker (drain + disconnect).
 *
 * When Redis is not available, both functions are no-ops.
 */

import { createRequire } from "module";
import { formatLogLine, structuredLog } from "../utils/logFormatter.js";
import { logActivity } from "../utils/activityLogger.js";
import { classifyError } from "../utils/errorClassifier.js";
import { emitRunEvent } from "../routes/sse.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as runLogRepo from "../database/repositories/runLogRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { runTests } from "../testRunner.js";
import { crawlAndGenerateTests } from "../crawler.js";
import { fireNotifications } from "../utils/notifications.js";
import { captureProvider } from "../utils/activeRuns.js";

const _require = createRequire(import.meta.url);

let Worker = null;
if (process.env.REDIS_URL) {
  try {
    const bullmq = _require("bullmq");
    Worker = bullmq.Worker;
  } catch {
    // Queue module already warned about missing bullmq
  }
}

/** @type {Object|null} BullMQ Worker instance. */
let _worker = null;

/**
 * Registry of active BullMQ-processed runs. The chat endpoint reads `.provider`
 * to skip runs that aren't using Ollama when checking for concurrent LLM
 * activity (prevents false-positive 503s when a cloud run is active and the
 * user switches to Ollama).
 *
 * @type {Map<string, {controller: AbortController, provider: string|null}>}
 */
export const workerAbortControllers = new Map();

const MAX_WORKERS = parseInt(process.env.MAX_WORKERS, 10) || 2;

/**
 * Process a single run job from the queue.
 *
 * @param {Object} job — BullMQ Job instance.
 * @returns {Promise<void>}
 */
async function processJob(job) {
  const { runId, projectId, type, options } = job.data;

  structuredLog("worker.job_start", { runId, projectId, type, jobId: job.id });

  const project = projectRepo.getById(projectId);
  if (!project) {
    console.warn(formatLogLine("warn", null,
      `[worker] Project ${projectId} not found for job ${job.id} — marking run failed`));
    runRepo.update(runId, {
      status: "failed",
      error: "Project not found",
      finishedAt: new Date().toISOString(),
    });
    emitRunEvent(runId, "done", { status: "failed" });
    return;
  }

  // Reconstruct the run object from the database (it was created by the
  // route handler before the job was enqueued).
  const run = runRepo.getById(runId);
  if (!run) {
    console.warn(formatLogLine("warn", null,
      `[worker] Run ${runId} not found for job ${job.id}`));
    return;
  }

  // Create an AbortController so the abort endpoint can cancel this job.
  // Capture the active provider at job-start time so the chat busy guard
  // can accurately filter to runs using Ollama (prevents false-positive
  // "AI is busy" 503s when a cloud run is active and the user switches
  // to Ollama).
  const abortController = new AbortController();
  workerAbortControllers.set(runId, { controller: abortController, provider: captureProvider() });
  const signal = abortController.signal;

  try {
    if (type === "crawl") {
      await crawlAndGenerateTests(project, run, {
        dialsPrompt: options.dialsPrompt,
        testCount: options.testCount,
        explorerMode: options.explorerMode,
        explorerTuning: options.explorerTuning,
        signal,
      });

      if (run.status !== "aborted") {
        logActivity({
          ...options.actorInfo,
          type: "crawl.complete",
          projectId: project.id,
          projectName: project.name,
          detail: `Crawl completed — ${run.pagesFound || 0} pages found`,
        });
      }

      // FEA-001: Fire failure notifications — best-effort (consistent with
      // the in-process fallback in runs.js which calls fireNotifications for
      // crawls via the onComplete callback).
      try { await fireNotifications(run, project); } catch { /* best-effort */ }
    } else if (type === "test_run") {
      // Use the snapshotted test IDs from enqueue time (options.testIds) so
      // retries execute the same set of tests as the original attempt.
      // Falls back to a fresh DB query for jobs enqueued before this fix.
      let tests;
      if (Array.isArray(options.testIds) && options.testIds.length > 0) {
        const allTests = testRepo.getByProjectId(project.id);
        const idSet = new Set(options.testIds);
        tests = allTests.filter(t => idSet.has(t.id));
      } else {
        tests = testRepo.getByProjectId(project.id)
          .filter(t => t.reviewStatus === "approved");
      }

      await runTests(project, tests, run, {
        parallelWorkers: options.parallelWorkers || 1,
        device: options.device || null,
        locale: options.locale || null,
        timezoneId: options.timezoneId || null,
        geolocation: options.geolocation || null,
        signal,
      });

      if (run.status !== "aborted") {
        logActivity({
          ...options.actorInfo,
          type: "test_run.complete",
          projectId: project.id,
          projectName: project.name,
          detail: `Test run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        });
      }

      // Fire failure notifications (FEA-001) — best-effort
      try { await fireNotifications(run, project); } catch { /* best-effort */ }
    }

    // Check abort signal one final time before persisting.  If the abort
    // endpoint fired between the pipeline completing and this point, the DB
    // already has status="aborted" + "skipped" entries.  Writing the worker's
    // stale in-memory run back would overwrite that state.
    if (signal.aborted || run.status === "aborted") return;

    // Persist final state
    runRepo.save(run);

    structuredLog("worker.job_complete", {
      runId, projectId, type, jobId: job.id,
      status: run.status, passed: run.passed, failed: run.failed,
    });
  } catch (err) {
    workerAbortControllers.delete(runId);

    if (err.name === "AbortError" || signal.aborted || run.status === "aborted") {
      // The abort endpoint (runs.js) is the single owner of abort state:
      // it writes status="aborted", adds "skipped" entries for unexecuted
      // tests, and persists everything to the DB.  The worker must NOT
      // write its in-memory `run` back — doing so would race with the
      // abort endpoint and could overwrite the "skipped" entries with the
      // worker's stale results snapshot.  Simply bail out.
      return;
    }

    const maxAttempts = job.opts?.attempts || 2;
    const isFinalAttempt = job.attemptsMade >= maxAttempts - 1;

    const runType = type === "crawl" ? "crawl" : "run";
    const classified = classifyError(err, runType);
    console.error(formatLogLine("error", runId, `[worker] ${err.message}`));

    if (isFinalAttempt) {
      // Only persist terminal state on the final attempt to prevent
      // retries from re-executing an already-failed run (the DB row
      // would have status="failed" and finishedAt set, causing duplicate
      // activity logs, duplicate SSE events, and status overwrites).
      run.status = "failed";
      run.error = classified.message;
      run.errorCategory = classified.category;
      run.finishedAt = new Date().toISOString();

      logActivity({
        ...options.actorInfo,
        type: `${runType === "crawl" ? "crawl" : "test_run"}.fail`,
        projectId: project.id,
        projectName: project.name,
        detail: `${runType === "crawl" ? "Crawl" : "Test run"} failed: ${classified.message}`,
        status: "failed",
      });

      emitRunEvent(runId, "done", { status: "failed" });
      runRepo.save(run);
    } else {
      // Non-final attempt: reset ALL accumulated run state so the retry
      // starts completely clean.  Without this, the retry would reload the
      // partially-populated run from the DB (via runRepo.getById at line 81)
      // and runTests/crawlAndGenerateTests would append MORE results to the
      // already-populated arrays, causing duplicate entries in run.results,
      // inflated pass/fail counts, and incorrect totals.
      run.status = "running";
      run.error = null;
      run.errorCategory = null;
      run.finishedAt = null;
      run.results = [];
      run.passed = 0;
      run.failed = 0;
      run.pagesFound = 0;
      run.logs = [];
      // Delete run_logs table rows from the failed attempt so the retry
      // doesn't start with stale log entries.  runRepo.getById() hydrates
      // run.logs from run_logs, so without this the retry would see the
      // old logs concatenated with new ones.
      runLogRepo.deleteByRunId(runId);
      runRepo.save(run);
    }

    throw err; // Let BullMQ handle retry logic
  } finally {
    workerAbortControllers.delete(runId);
    runLogRepo.evictCache(runId);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create and start the BullMQ Worker.
 * No-op if Redis or BullMQ is not available.
 */
export function startWorker() {
  if (!Worker || !process.env.REDIS_URL) return;

  try {
    _worker = new Worker("sentri:runs", processJob, {
      connection: {
        url: process.env.REDIS_URL,
        maxRetriesPerRequest: null,
      },
      concurrency: MAX_WORKERS,
    });

    _worker.on("failed", (job, err) => {
      console.error(formatLogLine("error", null,
        `[worker] Job ${job?.id} failed: ${err.message}`));
    });

    _worker.on("error", (err) => {
      console.error(formatLogLine("error", null,
        `[worker] Worker error: ${err.message}`));
    });

    console.log(formatLogLine("info", null,
      `[worker] BullMQ worker started (concurrency: ${MAX_WORKERS})`));
  } catch (err) {
    console.warn(formatLogLine("warn", null,
      `[worker] Failed to start BullMQ worker: ${err.message}`));
  }
}

/**
 * Gracefully close the worker.
 * Called from the shutdown hook in `index.js`.
 *
 * @returns {Promise<void>}
 */
export async function stopWorker() {
  // Abort all in-flight jobs
  for (const [runId, entry] of workerAbortControllers) {
    entry.controller.abort();
    workerAbortControllers.delete(runId);
  }

  if (_worker) {
    try {
      await _worker.close();
      console.log(formatLogLine("info", null, "[worker] BullMQ worker stopped"));
    } catch (err) {
      console.warn(formatLogLine("warn", null,
        `[worker] Worker close error: ${err.message}`));
    }
    _worker = null;
  }
}
