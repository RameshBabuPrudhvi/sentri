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
import * as environmentRepo from "../database/repositories/environmentRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { runTests } from "../testRunner.js";
import { crawlAndGenerateTests } from "../crawler.js";
import { fireNotifications } from "../utils/notifications.js";
import { captureProvider } from "../utils/activeRuns.js";
import { isNonExecutedSkip } from "../utils/skipReasons.js";
import { envScopedProject } from "../utils/envScope.js"; // DIF-012 — shared helper, see module doc.
import { subscribeToRunAborts, publishRunAbort } from "../utils/runAbortChannel.js"; // CAP-002 Phase 2 — cross-process abort pub/sub.
import { runFeedbackLoop } from "../runner/feedbackIntegration.js"; // CAP-002 Phase 2 — last-shard finalizer runs the AI feedback loop exactly once.
import { finalizeRunIfNotAborted } from "../utils/abortHelper.js";
import { __evaluateQualityGatesForTest, __evaluateWebVitalsBudgetsForTest } from "../testRunner.js";
import { trackTelemetry } from "../utils/telemetry.js";
import { safeFetch } from "../utils/ssrfGuard.js"; // CAP-002 Phase 2 — trigger-path callbackUrl POST from sharded finalizer.

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
 * ### Key scheme (CAP-002 Phase 2 — Prerequisite #4)
 *
 * The map is keyed by the BullMQ jobId, NOT the bare runId, so multiple
 * shards of the same run executing on the same replica don't collide on a
 * single map slot. The jobId scheme is:
 *
 *   - **Legacy / single-shard runs**: `jobId === runId`. Key is just the
 *     runId — bit-for-bit identical to the pre-Phase-2 behaviour.
 *   - **Shard-mode runs** (coordinator PR): `jobId === ${runId}:s${shardIndex}`.
 *     Each shard gets its own map entry; entries store `runId` + `shardIndex`
 *     so reverse lookups (e.g. the cross-process abort handler) can fan out
 *     to every shard of a given parent run.
 *
 * Use {@link workerAbortKey} when registering and deleting; use
 * {@link abortAllShardsForRun} to fan out an abort to every shard of a parent
 * run (the abort route's local-fast-path + the run-abort pub/sub subscriber
 * both go through this helper).
 *
 * @type {Map<string, {controller: AbortController, provider: string|null, runId: string, shardIndex: number|null}>}
 */
export const workerAbortControllers = new Map();

/**
 * Compute the registry key for a (runId, shardIndex) pair. Mirrors the
 * BullMQ `jobId` shape so the map key, the queue jobId, and the trace
 * artifact path (Prerequisite #2) all derive from the same identifier.
 *
 * @param {string}      runId
 * @param {number|null} shardIndex - 0-based, or `null` for legacy single-shard runs.
 * @returns {string}
 */
export function workerAbortKey(runId, shardIndex) {
  if (shardIndex == null) return runId;
  return `${runId}:s${shardIndex}`;
}

/**
 * Iterate every registry entry belonging to a parent run, regardless of
 * shard. Used by:
 *
 *   - The abort route's local-fast-path so a user-driven abort cancels
 *     every shard's controller on this replica before publishing to the
 *     cross-replica pub/sub channel.
 *   - The run-abort pub/sub subscriber so a cross-replica abort signal
 *     reaches every matching local shard.
 *
 * Visits both shard-keyed entries (`${runId}:s${i}`) and the legacy bare-
 * runId entry. Safe to call concurrently with `processJob` — iteration
 * uses a snapshot so handlers can mutate the map (delete) without
 * affecting the loop.
 *
 * @param {string}   runId
 * @param {Function} fn - Callback `(entry, key) => void`.
 * @returns {number} Number of entries visited.
 */
export function forEachShardEntry(runId, fn) {
  let visited = 0;
  // Snapshot to allow mutation during iteration (the typical use is
  // `entry.controller.abort()` followed by `workerAbortControllers.delete(key)`).
  const snapshot = [];
  for (const [key, entry] of workerAbortControllers) {
    if (entry?.runId === runId) snapshot.push([key, entry]);
  }
  for (const [key, entry] of snapshot) {
    try { fn(entry, key); visited++; } catch { /* fail-open per-entry */ }
  }
  return visited;
}

/**
 * Abort every shard controller for a parent run. Convenience wrapper around
 * {@link forEachShardEntry} that captures the canonical "cancel + delete"
 * sequence used by both the user-driven abort route and the cross-replica
 * pub/sub subscriber.
 *
 * @param {string} runId
 * @returns {number} Number of shard controllers aborted.
 */
export function abortAllShardsForRun(runId) {
  return forEachShardEntry(runId, (entry, key) => {
    try { entry.controller.abort(); } catch { /* already aborted */ }
    workerAbortControllers.delete(key);
  });
}

const MAX_WORKERS = parseInt(process.env.MAX_WORKERS, 10) || 2;

/**
 * Process a single run job from the queue.
 *
 * @param {Object} job — BullMQ Job instance.
 * @returns {Promise<void>}
 */
async function processJob(job) {
  // CAP-002 Phase 2 — `shardIndex` is `null` for legacy single-process runs
  // and for every job that doesn't go through the BullMQ shard fan-out. The
  // retry-reset below uses it to scope the results-array wipe to *this*
  // shard so a sibling shard's already-completed results aren't erased on
  // retry. When `shardIndex` is null the old wipe-all behaviour is preserved
  // verbatim — zero regression for `shardCount === 1`.
  //
  // `shardCount` is the parent run's total shard count, used at the
  // finalization handoff: the boundary-crossing shard (whose
  // `incrementShardsCompleted` UPDATE returns 1 AND lands the counter at
  // `shardCount`) owns the post-run feedback loop + `done` event.
  const { runId, projectId, type, options, shardIndex = null, shardCount: jobShardCount = null } = job.data;

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

  // DIF-012: resolve the per-run environment override (if any) from the
  // persisted run record. The route handler validated the envId at enqueue
  // time, so we only need to look it up here. A row that was deleted
  // between enqueue and worker pickup yields `environment === undefined`,
  // which `envScopedProject` treats as "no override" — the run falls back
  // to project.url, matching the behaviour the caller would have got
  // before DIF-012.
  const environment = run.environmentId ? environmentRepo.getById(run.environmentId) : null;
  const scopedProject = envScopedProject(project, environment);

  // Create an AbortController so the abort endpoint can cancel this job.
  // Capture the active provider at job-start time so the chat busy guard
  // can accurately filter to runs using Ollama (prevents false-positive
  // "AI is busy" 503s when a cloud run is active and the user switches
  // to Ollama).
  const abortController = new AbortController();
  // CAP-002 Phase 2 (Prerequisite #4) — key the registry by jobId so
  // multiple shards of the same run on the same replica don't collide.
  // Legacy single-shard runs (`shardIndex == null`) key by bare runId,
  // preserving the prior shape bit-for-bit. The entry stores `runId` so
  // the parent-keyed fan-out helpers (`forEachShardEntry`,
  // `abortAllShardsForRun`) can reverse-look-up by parent run.
  const abortKey = workerAbortKey(runId, shardIndex);
  workerAbortControllers.set(abortKey, {
    controller: abortController,
    provider: captureProvider(),
    runId,
    shardIndex,
  });
  const signal = abortController.signal;

  try {
    if (type === "crawl") {
      await crawlAndGenerateTests(scopedProject, run, {
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
      //
      // AUTO-001: the order of `options.testIds` is the risk-ranked + budget-
      // capped dispatch sequence assembled by the route layer (see
      // routes/runs.js:202). The previous `allTests.filter(idSet.has)`
      // implementation silently re-sorted tests into DB order — defeating
      // risk-based ordering for every BullMQ-processed run. Re-build the
      // array in the explicit testIds order; drop any ids that no longer
      // resolve (test deleted between enqueue and worker pickup).
      let tests;
      if (Array.isArray(options.testIds) && options.testIds.length > 0) {
        const allTests = testRepo.getByProjectId(project.id);
        const byId = new Map(allTests.map(t => [t.id, t]));
        tests = options.testIds.map(id => byId.get(id)).filter(Boolean);
      } else {
        tests = testRepo.getByProjectId(project.id)
          .filter(t => t.reviewStatus === "approved");
      }

      await runTests(scopedProject, tests, run, {
        parallelWorkers: options.parallelWorkers || 1,
        browser: options.browser || null,         // DIF-002: resolved to chromium inside runTests when null
        device: options.device || null,
        locale: options.locale || null,
        timezoneId: options.timezoneId || null,
        geolocation: options.geolocation || null,
        networkCondition: options.networkCondition || "fast", // AUTO-006
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
    } else if (type === "test_run_shard") {
      // CAP-002 Phase 2 — execute one shard of a sharded run. The coordinator
      // (routes/runs.js) pre-partitioned testIds at enqueue time; we never
      // re-derive the split. `runTests` returns this shard's stats delta;
      // we compose them onto the parent `runs` row atomically and hand off
      // to the boundary-crossing shard for finalization.
      const allTests = testRepo.getByProjectId(project.id);
      const byId = new Map(allTests.map(t => [t.id, t]));
      const sliceTests = (options.testIds || []).map((id) => byId.get(id)).filter(Boolean);

      const shardStats = await runTests(scopedProject, sliceTests, run, {
        parallelWorkers: options.parallelWorkers || 1,
        browser: options.browser || null,
        device: options.device || null,
        locale: options.locale || null,
        timezoneId: options.timezoneId || null,
        geolocation: options.geolocation || null,
        networkCondition: options.networkCondition || "fast",
        signal,
        shardIndex,
      });

      if (signal.aborted || run.status === "aborted") {
        // Abort owns terminal-state writes; don't touch stats or counter.
        workerAbortControllers.delete(abortKey);
        return;
      }

      // Compose this shard's deltas onto the parent run atomically. Sibling
      // shards may be running this same UPDATE concurrently — the SQL row
      // lock is the linearization point.
      if (shardStats && (shardStats.passed || shardStats.failed || shardStats.totalDelta)) {
        runRepo.incrementRunStats(runId, {
          passedDelta: shardStats.passed || 0,
          failedDelta: shardStats.failed || 0,
          totalDelta: shardStats.totalDelta || 0,
        });
      }

      // CAP-002 Phase 2 — finalization handoff. `incrementShardsCompleted`
      // now returns `{ advanced, newValue }` from a single transaction
      // (UPDATE + SELECT under the same row lock) so the boundary check
      // is atomic — no interleaving window where a sibling shard on
      // another Postgres process could read the same post-increment value
      // and fire a duplicate finalizer. The caller checks
      // `newValue === totalShards` directly; no separate `getById` needed.
      const { advanced, newValue } = runRepo.incrementShardsCompleted(runId);
      const totalShards = jobShardCount || 1;
      if (advanced === 1 && newValue >= totalShards) {
        const fresh = runRepo.getById(runId);
        if (fresh) {
          // Pass the full `options` payload so the finalizer can access the
          // CI/CD callback URL (and any future shard-shared knobs) without
          // a second job-data round-trip. Every shard carries the same
          // `callbackUrl`; the finalizer is the single firer thanks to the
          // exclusivity guarantee on `incrementShardsCompleted`.
          await finalizeShardedRun(scopedProject, fresh, options || {});
        }
      }

      workerAbortControllers.delete(abortKey);
      return;  // bypass the tail `runRepo.save(run)` — shard mode owns its writes
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
    // Use the shard-aware key so we delete *this* shard's entry, not the
    // bare-runId entry that might belong to a sibling shard's controller.
    workerAbortControllers.delete(abortKey);

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
      //
      // CAP-002 Phase 2 (Prerequisite #6): for shard-mode runs, use the
      // atomic first-writer-wins UPDATE so the first crashing shard owns
      // the failure reason. A full `runRepo.save(run)` here would
      // overwrite a sibling shard's earlier classified message with this
      // shard's (potentially less-informative) one — confusing the audit
      // trail and the SSE `done` event. The first-writer-wins predicate
      // (`WHERE id = ? AND status = 'running'`) makes the second-place
      // shard a clean no-op. After persisting the terminal state we
      // publish to `sentri:run-abort` so sibling shards in *other*
      // replicas receive the cancel signal and drain — same channel the
      // user-driven abort route uses (Prerequisite #5). For legacy
      // single-shard runs (`shardIndex == null`) the prior `save(run)`
      // path is preserved bit-for-bit so the failure-status semantics
      // don't shift for non-shard callers.
      const isShardMode = shardIndex != null;
      let firstWriter = true;
      if (isShardMode) {
        firstWriter = runRepo.markRunFailedFirstWriterWins(runId, {
          error: classified.message,
          errorCategory: classified.category,
        });
        // Re-hydrate the in-memory run from whatever the DB now holds so
        // the rest of this block (and any downstream `runRepo.save(run)`
        // we might call later) doesn't overwrite the first writer's
        // values with stale snapshot data.
        run.status = "failed";
        run.error = classified.message;
        run.errorCategory = classified.category;
        run.finishedAt = new Date().toISOString();
      } else {
        run.status = "failed";
        run.error = classified.message;
        run.errorCategory = classified.category;
        run.finishedAt = new Date().toISOString();
        runRepo.save(run);
      }

      // Activity log + SSE `done` event fire only when this caller was
      // the first writer (shard mode) or the sole writer (legacy mode).
      // Second-place shards skip emitting so we don't surface duplicate
      // notifications for the same logical failure.
      if (firstWriter) {
        logActivity({
          ...options.actorInfo,
          type: `${runType === "crawl" ? "crawl" : "test_run"}.fail`,
          projectId: project.id,
          projectName: project.name,
          detail: `${runType === "crawl" ? "Crawl" : "Test run"} failed: ${classified.message}`,
          status: "failed",
        });
        emitRunEvent(runId, "done", { status: "failed" });
      }

      // Whether or not this shard was the first writer, publish the abort
      // signal so sibling shards in other replicas stop wasting compute.
      // Same channel as the user-driven abort. `publishRunAbort` is
      // best-effort and a no-op when Redis is unavailable.
      if (isShardMode) {
        publishRunAbort(runId).catch(() => { /* best-effort */ });
      }
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
      // AUTO-001 / AUTO-004: preserve the route-layer's pre-seeded skip
      // markers across retries — `over_budget` AND `skipped_no_impact` both
      // represent a final dispatch decision, not a transient execution
      // state. Dropping either would silently re-classify those tests on
      // the retry (or worse, make them vanish from `run.results` entirely,
      // breaking the pass-rate denominator and the "every approved test
      // has a resolution" invariant). Routed through `isNonExecutedSkip`
      // (`backend/src/utils/skipReasons.js`) so adding a future skip kind
      // doesn't require a third site edit.
      //
      // CAP-002 Phase 2 (Prerequisite #3): when this job is one shard of
      // a multi-shard run, only wipe results belonging to *this* shard.
      // Sibling shards that already finished have their results stamped
      // with `_shardIndex !== thisShardIndex` (see `testRunner.js`
      // `processResult` — every persisted result row carries its shard
      // index) and must survive the retry — otherwise a single shard's
      // BullMQ retry would erase three other shards' worth of completed
      // work. For legacy single-process runs (`shardIndex == null`) the
      // filter degrades to the prior wipe-all behaviour: keep only the
      // non-executed skips, drop everything else — bit-for-bit identical
      // to the pre-CAP-002 code path. Re-derive `passed`/`failed` from
      // the surviving rows instead of resetting to 0 so sibling-shard
      // pass/fail counts are preserved through the retry.
      //
      // Critical lost-write fix: in shard mode we use the atomic
      // `purgeShardResults` primitive instead of an in-memory filter +
      // `runRepo.save(run)`. The previous approach read `run.results`
      // from the job-start DB snapshot (line ~189), filtered in JS,
      // then `save(run)` overwrote the live column — silently
      // truncating any sibling-shard rows that landed via
      // `appendRunResults` between snapshot and save. The primitive
      // performs a transactional read-modify-write on the live column
      // under a `FOR UPDATE` lock (Postgres) / BEGIN IMMEDIATE serial-
      // isation (SQLite), so concurrent sibling appends are honoured.
      const isShardMode = shardIndex != null;
      if (isShardMode) {
        runRepo.purgeShardResults(runId, shardIndex, isNonExecutedSkip);
        // DO NOT overwrite `passed` / `failed` columns here. Those columns
        // are composed atomically by each shard's `incrementRunStats` call
        // after `runTests` returns. If a sibling shard is still executing,
        // its partial results are already in the `results` JSON column (via
        // `appendRunResults`) but its `incrementRunStats` hasn't fired yet.
        // Re-deriving passed/failed from the JSON and writing them as
        // absolute values would inflate the columns — then the sibling's
        // `incrementRunStats(passedDelta)` would add its delta on top,
        // double-counting. Leaving the columns untouched means the retrying
        // shard's own `incrementRunStats` call (after re-execution) adds
        // only its fresh delta, which is correct by construction.
        //
        // run.results in-memory is now stale (the live DB column is
        // canonical). Don't write it back via save() — instead persist
        // only the run-level non-results, non-stats fields the retry needs.
        run.pagesFound = 0;
        run.logs = [];
        runLogRepo.deleteByRunId(runId);
        runRepo.update(runId, {
          status: "running",
          error: null,
          errorCategory: null,
          finishedAt: null,
          pagesFound: 0,
        });
      } else {
        // Legacy single-shard / non-shard path — bit-for-bit unchanged.
        const survivors = (run.results || []).filter((r) => isNonExecutedSkip(r));
        run.results = survivors;
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
    }

    throw err; // Let BullMQ handle retry logic
  } finally {
    workerAbortControllers.delete(abortKey);
    runLogRepo.evictCache(runId);
  }
}

/**
 * CAP-002 Phase 2 — Finalize a sharded run after every shard's results
 * have landed. Called exactly once per run: the shard whose
 * `incrementShardsCompleted` UPDATE crossed the boundary at `shardCount`
 * is the finalizer; all other shards return without invoking this.
 *
 * The "exactly once" guarantee comes from the SQL predicate on
 * `incrementShardsCompleted` (Prerequisite #1) — it returns `1` only for
 * the single UPDATE that landed the counter at the cap. No JS-side mutex
 * needed.
 *
 * Owns (mirrors the single-shard tail of `runTests`):
 *   - gateResult / webVitalsResult evaluation against the full results set
 *     (every shard has flushed via `appendRunResults` — DB is the source
 *     of truth, the local `run` here is the fresh row this worker re-read)
 *   - retryCount / failedAfterRetry aggregation
 *   - one `runFeedbackLoop` invocation (single AI-call pass per run)
 *   - `finalizeRunIfNotAborted` → status = "completed"
 *   - duration computation (now - startedAt)
 *   - one `done` SSE event
 *   - one `test_run.complete` activity log
 *   - one `run.complete` telemetry event
 *   - best-effort notifications + GitHub-check completion
 *
 * @param {Object} project       - DIF-012 env-scoped project (carries `qualityGates`, `webVitalsBudgets`).
 * @param {Object} run           - Fresh `runs` row, hydrated via `runRepo.getById`.
 * @param {Object} jobOptions    - The shard job's `options` payload. Carries:
 *   - `actorInfo`   — `{ userId, userName }` from the triggering request.
 *   - `callbackUrl` — CI/CD POST target (trigger path only). SSRF-validated
 *                     at the route layer; finalizer fires exactly once,
 *                     gated by `incrementShardsCompleted` exclusivity.
 * @returns {Promise<void>}
 */
async function finalizeShardedRun(project, run, jobOptions = {}) {
  const actorInfo = jobOptions.actorInfo || {};
  const callbackUrl = jobOptions.callbackUrl || null;
  // Defensive: if the run was aborted between this shard's increment and
  // this call, the abort route owns terminal-state writes — do nothing.
  if (run.status === "aborted") return;

  const runId = run.id;
  const results = Array.isArray(run.results) ? run.results : [];
  run.retryCount = results.reduce((sum, r) => sum + (r.retryCount || 0), 0);
  run.failedAfterRetry = results.filter((r) => r.failedAfterRetry).length;

  // Quality gates + web vitals — same evaluators as the single-shard path.
  // The exported `__evaluateQualityGatesForTest` / `__evaluateWebVitalsBudgetsForTest`
  // aliases are the public test-friendly names; we deliberately reuse them
  // here rather than duplicate the logic (it's a moderately large pure
  // function with subtle data-driven-skip handling — see testRunner.js).
  run.gateResult = __evaluateQualityGatesForTest(project.qualityGates, run);
  run.webVitalsResult = __evaluateWebVitalsBudgetsForTest(project.webVitalsBudgets, run);

  // Persist aggregates BEFORE the feedback loop so a feedback-loop crash
  // doesn't lose the gate verdict (CI consumers polling `/trigger/runs/:id`
  // would otherwise see a `null` gateResult on a failed-feedback run).
  runRepo.update(runId, {
    retryCount: run.retryCount,
    failedAfterRetry: run.failedAfterRetry,
    gateResult: run.gateResult,
    webVitalsResult: run.webVitalsResult,
  });

  // Feedback loop — runs exactly once per run. Load the FULL approved test
  // set (every shard's slice combined) so the AI regeneration sees the
  // same tests the original dispatch did. Aborts mid-feedback are swallowed
  // by the loop itself; we additionally swallow any unexpected throw so a
  // feedback-loop crash can never block run finalization (CI must still
  // see a terminal status — `completed` or `failed`).
  const tests = testRepo.getByProjectId(project.id).filter((t) => t.reviewStatus === "approved");
  try {
    await runFeedbackLoop(run, tests, null);
  } catch (err) {
    structuredLog("run.feedback_loop_failed", { runId, error: err.message });
  }

  // Status transition + duration + telemetry. `startedAt` is the parent
  // run's column (set when the route created the row); duration is the
  // wall-clock from run start to finalizer arrival — captures the actual
  // parallel speedup vs. a single-shard run on the same suite.
  finalizeRunIfNotAborted(run, () => {
    run.finishedAt = new Date().toISOString();
    run.duration = run.startedAt
      ? Date.now() - new Date(run.startedAt).getTime()
      : null;
    structuredLog("run.complete", {
      runId, projectId: project.id,
      passed: run.passed, failed: run.failed, total: run.total,
      durationMs: run.duration, shardCount: run.shardCount,
    });
    trackTelemetry("run.complete", {
      projectId: project.id,
      browser: run.browser,
      total: run.total, passed: run.passed, failed: run.failed,
      retryCount: run.retryCount || 0,
      failedAfterRetry: run.failedAfterRetry || 0,
      shardCount: run.shardCount || 1,
      parallelWorkers: run.parallelWorkers || 1,
      durationMs: run.duration,
      url: project.url,
    });
  });

  // Persist terminal state atomically with first-writer-wins semantics.
  // Catches the late-abort race where the user clicked Abort between
  // `getById` and here — the predicate `WHERE status = 'running'` makes
  // the UPDATE a no-op when the row is already terminal, so the user's
  // abort isn't silently overwritten with `completed`. When the primitive
  // returns false, treat the run as aborted (the abort route owns the
  // SSE `done` event and activity log for that case) and skip the
  // post-finalize side effects below.
  const persistedTerminal = runRepo.markRunCompletedFirstWriterWins(runId, {
    finishedAt: run.finishedAt,
    duration: run.duration,
    qualityAnalytics: run.qualityAnalytics || null,
  });
  if (!persistedTerminal) {
    structuredLog("run.finalize_skipped_terminal", {
      runId,
      reason: "row already terminal (abort beat finalizer)",
    });
    return;
  }

  // Activity log + `done` SSE — fire exactly once per logical run.
  logActivity({
    ...actorInfo,
    type: "test_run.complete",
    projectId: project.id,
    projectName: project.name,
    detail: `Test run completed — ${run.passed || 0} passed, ${run.failed || 0} failed (${run.shardCount}× shards)`,
  });
  emitRunEvent(runId, "done", {
    status: run.status,
    passed: run.passed, failed: run.failed, total: run.total,
  });

  // Best-effort side effects — never block finalization on these.
  try { await fireNotifications(run, project); } catch { /* best-effort */ }

  // CAP-002 Phase 2 — GitHub Check Run completion. The trigger-path
  // `runWithAbort.onComplete` callback handles this for single-shard runs
  // (`backend/src/routes/trigger.js:685`); the sharded BullMQ path
  // bypasses `runWithAbort` entirely, so without this call a sharded run
  // triggered from a GitHub PR would leave the Check Run stuck
  // "in_progress" forever. Dynamic import avoids a circular dependency at
  // module load (trigger.js → testRunner.js → workers/runWorker.js).
  // Best-effort — a GitHub outage must never block run finalization.
  if (run.githubCheck?.checkRunId) {
    try {
      const { concludeGithubCheck } = await import("../routes/trigger.js");
      await concludeGithubCheck(run, project);
    } catch { /* best-effort */ }
  }

  // CAP-002 Phase 2 — Fire the CI/CD `callbackUrl` POST. Same payload
  // shape as the single-shard trigger path (`routes/trigger.js:780-789`)
  // so CI consumers can use one handler for both sharded and non-sharded
  // runs. SSRF-safe: `safeFetch` re-resolves DNS to mitigate rebinding
  // and blocks redirects to prevent open-redirect bypasses. The URL was
  // validated at the route layer before enqueue. Fires exactly once per
  // run because only the boundary-crossing shard reaches this function
  // (gated by `incrementShardsCompleted`'s exclusivity predicate).
  // Best-effort — a callback failure must never re-throw out of the
  // finalizer, mirroring the `safeFetchCallback(...).catch(() => {})`
  // contract on the single-shard path.
  if (callbackUrl && typeof callbackUrl === "string") {
    try {
      const payload = JSON.stringify({
        runId,
        status: run.status,
        passed: run.passed,
        failed: run.failed,
        total: run.total,
        error: run.error || null,
        gateResult: run.gateResult || null,
        webVitalsResult: run.webVitalsResult || null,
      });
      await safeFetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* best-effort */ }
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

    // CAP-002 Phase 2 (Prerequisite #5) — subscribe to the cross-process
    // run-abort channel so an abort triggered on another replica reaches
    // this worker's in-flight controllers. Same-replica aborts still go
    // through `workerAbortControllers` directly via the abort route's
    // local-fast-path (origin stamp suppresses self-echo on this side).
    // No-op when Redis is unavailable — `subscribeToRunAborts` returns
    // false and the worker continues with local-only abort behaviour.
    subscribeToRunAborts({
      // CAP-002 Phase 2 (Prerequisite #4) — fan out the cross-replica
      // abort signal to *every* shard controller for the parent run.
      // `abortAllShardsForRun` handles both the legacy single-runId-keyed
      // entry and the new `${runId}:s${i}` shard-keyed entries.
      onAbort: (runId) => { abortAllShardsForRun(runId); },
    });
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
  // Abort all in-flight jobs. Iterate by key so we hit every shard entry
  // (`${runId}:s${i}` for shard-mode runs, bare `runId` for legacy runs).
  for (const [key, entry] of workerAbortControllers) {
    entry.controller.abort();
    workerAbortControllers.delete(key);
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
