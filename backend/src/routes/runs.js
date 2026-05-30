/**
 * @module routes/runs
 * @description Run routes — crawl, test execution, abort, listing, and CI/CD triggers.
 * Mounted at `/api/v1` (INF-005).
 *
 * ### Endpoints
 * | Method   | Path                                        | Description                         |
 * |----------|---------------------------------------------|-------------------------------------|
 * | `POST`   | `/api/v1/projects/:id/crawl`                | Start crawl + AI test generation    |
 * | `POST`   | `/api/v1/projects/:id/run`                  | Execute all approved tests          |
 * | `GET`    | `/api/v1/projects/:id/runs`                 | List runs for a project             |
 * | `GET`    | `/api/v1/runs/:runId`                       | Get run detail                      |
 * | `POST`   | `/api/v1/runs/:runId/abort`                 | Abort a running crawl or test run   |
 * | `POST`   | `/api/v1/runs/:runId/resume`                | Resume a crash-recovered run (B1)   |
 * | `POST`   | `/api/v1/projects/:id/trigger`              | CI/CD token-authenticated test run  |
 * | `GET`    | `/api/v1/projects/:id/trigger-tokens`       | List trigger tokens for a project   |
 * | `POST`   | `/api/v1/projects/:id/trigger-tokens`       | Create a new trigger token          |
 * | `DELETE` | `/api/v1/projects/:id/trigger-tokens/:tid`  | Revoke a trigger token              |
 */

import { Router } from "express";
import { getDatabase } from "../database/sqlite.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as runTestResultRepo from "../database/repositories/runTestResultRepo.js";
import { resolveEnvOrThrow } from "../utils/routeHelpers.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import * as activityRepo from "../database/repositories/activityRepo.js";
import { generateRunId, generateWebhookTokenId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort, runAbortControllers } from "../utils/runWithAbort.js";
import { workerAbortControllers, abortAllShardsForRun } from "../workers/runWorker.js";
import { publishRunAbort } from "../utils/runAbortChannel.js"; // CAP-002 Phase 2 — cross-replica abort fan-out.
import { emitRunEvent } from "./sse.js";
import { resolveDialsPrompt, resolveDialsConfig } from "../testDials.js";
import { crawlAndGenerateTests } from "../crawler.js";
import { runTests, partitionTestIdsForShards } from "../testRunner.js"; // thin orchestrator — delegates to runner/ modules
import { resolveBrowser } from "../runner/config.js";
import { classifyError } from "../utils/errorClassifier.js";
import { expensiveOpLimiter, signRunArtifacts } from "../middleware/appSetup.js";
import { demoQuota } from "../middleware/demoQuota.js";
import { actor } from "../utils/actor.js";
import { requireRole } from "../middleware/requireRole.js";
import * as aiRequestLogRepo from "../database/repositories/aiRequestLogRepo.js";
import { trackTelemetry } from "../utils/telemetry.js";
import { runQueue, isQueueAvailable } from "../queue.js";
import { fireNotifications } from "../utils/notifications.js";
import { orderTestsByRisk, applyBudgetToQueue, normalizeBudgetMinutes } from "../pipeline/riskScorer.js";
import { envScopedProject } from "../utils/envScope.js"; // DIF-012 — shared helper, see module doc.
import { normalizeShardConfig } from "../utils/shardConfig.js"; // CAP-002 — shared shards + parallelWorkers clamp.

const router = Router();

// ─── Crawl & Generate Tests ───────────────────────────────────────────────────

router.post("/projects/:id/crawl", requireRole("qa_lead"), demoQuota("crawl"), expensiveOpLimiter, async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const existingRun = runRepo.findActiveByProjectId(project.id);
  if (existingRun) {
    return res.status(409).json({
      error: `A run is already in progress (${existingRun.id}). Please wait for it to finish or abort it first.`,
    });
  }

  // DIF-012: optional per-run environment override. Validates the env
  // belongs to this project so callers can't run against a sibling
  // project's environment by ID guessing.
  let environment;
  try {
    environment = resolveEnvOrThrow(req.body?.environmentId, project);
  } catch (err) {
    return res.status(err.httpStatus || 400).json({ error: err.message });
  }

  const { dialsConfig } = req.body || {};
  const dialsPrompt = resolveDialsPrompt(dialsConfig);
  const validatedDials = resolveDialsConfig(dialsConfig);
  const testCount = validatedDials?.testCount || "ai_decides";
  const explorerMode = validatedDials?.exploreMode || "crawl";
  const explorerTuning = {
    maxStates:     validatedDials?.exploreMaxStates     ?? 30,
    maxDepth:      validatedDials?.exploreMaxDepth      ?? 3,
    maxActions:    validatedDials?.exploreMaxActions     ?? 8,
    actionTimeout: validatedDials?.exploreActionTimeout  ?? 5000,
  };
  const parallelWorkers = validatedDials?.parallelWorkers ?? 1;

  const runId = generateRunId();
  const run = {
    id: runId,
    projectId: project.id,
    type: "crawl",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    tests: [],
    pagesFound: 0,
    generateInput: validatedDials ? { dialsConfig: validatedDials } : undefined,
    workspaceId: project.workspaceId || null,
    environmentId: environment?.id || null,
  };
  runRepo.create(run);

  logActivity({ ...actor(req),
    type: "crawl.start", projectId: project.id, projectName: project.name,
    runId, // ENT-004 (migration 055): indexed for /audit-log?runId=
    detail: `Crawl started for ${project.url}`, status: "running",
  });

  if (isQueueAvailable()) {
    // INF-003: Enqueue via BullMQ for durable execution
    try {
      await runQueue.add("crawl", {
        runId,
        projectId: project.id,
        type: "crawl",
        options: { dialsPrompt, testCount, explorerMode, explorerTuning, actorInfo: actor(req) },
      }, { jobId: runId });
    } catch (enqueueErr) {
      // Redis connection dropped after startup — mark the run as failed so it
      // doesn't block the project with a perpetual "running" status.
      runRepo.update(runId, { status: "failed", error: "Failed to enqueue job", finishedAt: new Date().toISOString() });
      return res.status(503).json({ error: "Job queue unavailable. Please try again." });
    }
  } else {
    // Fallback: in-process execution (no Redis)
    runWithAbort(runId, run,
      // DIF-012: env override applies at execution only — project.url +
      // project.credentials are preserved in the DB; only this run sees the
      // override. envScopedProject also stamps `canonicalUrl` so the
      // AUTO-015 diff-aware baseline guard treats this as a preview-style
      // crawl and doesn't replace production baselines.
      (signal) => crawlAndGenerateTests(
        envScopedProject(project, environment),
        run,
        { dialsPrompt, testCount, explorerMode, explorerTuning, signal }
      ),
      {
        onSuccess: () => logActivity({ ...actor(req),
          type: "crawl.complete", projectId: project.id, projectName: project.name,
          runId, // ENT-004 (migration 055)
          detail: `Crawl completed — ${run.pagesFound || 0} pages found`,
        }),
        onFailActivity: (err) => ({
          type: "crawl.fail", projectId: project.id, projectName: project.name,
          runId, // ENT-004 (migration 055)
          detail: `Crawl failed: ${classifyError(err, "crawl").message}`,
        }),
        actorInfo: actor(req),
        onComplete: async (finishedRun) => {
          // AUTO-005: per-test retry runs inside testRunner.js before results
          // are tallied, so `finishedRun.failed` only counts tests with
          // `failedAfterRetry: true` — notifications correctly fire only after
          // the retry budget is exhausted.
          try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }
        },
      },
    );
  }

  res.json({ runId });
});

// ─── Run Tests ────────────────────────────────────────────────────────────────

router.post("/projects/:id/run", requireRole("qa_lead"), demoQuota("run"), expensiveOpLimiter, async (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  const existingRun = runRepo.findActiveByProjectId(project.id);
  if (existingRun) {
    return res.status(409).json({
      error: `A run is already in progress (${existingRun.id}). Please wait for it to finish or abort it first.`,
    });
  }

  // DIF-012: optional per-run environment override. Validated up-front
  // (before the no-tests / no-approved-tests checks) so a bad envId fails
  // fast with `invalid environmentId` rather than masking behind a
  // misleading "no tests found" error. Matches the ordering used by the
  // crawl path above and the trigger path (trigger.js), and the contract
  // documented in QA.md (line 903).
  let environment;
  try {
    environment = resolveEnvOrThrow(req.body?.environmentId, project);
  } catch (err) {
    return res.status(err.httpStatus || 400).json({ error: err.message });
  }

  const allTests = testRepo.getByProjectId(project.id);
  const tests = allTests.filter((t) => t.reviewStatus === "approved");
  if (!allTests.length) return res.status(400).json({ error: "no tests found, crawl first" });
  if (!tests.length) return res.status(400).json({ error: "no approved tests — review generated tests and approve them before running regression" });

  // Extract parallel workers, device emulation, browser engine, and locale/geo
  // from the request body / dials config. `browser` (DIF-002) is validated
  // against the known engines by `resolveBrowser()` inside `runTests`; we only
  // pass it through here and stamp the sanitised canonical name onto the run
  // record for display on the Run Detail page.
  const { dialsConfig, browser, device, locale, timezoneId, geolocation, networkCondition, budgetMinutes, shards } = req.body || {};
  const validatedRunDials = resolveDialsConfig(dialsConfig);
  // CAP-002: `shardCount` and `parallelWorkers` are *separate* concepts —
  // see `utils/shardConfig.js` for the full BUG-0001 rationale. Shared with
  // `routes/trigger.js` so both entry points apply identical semantics.
  const { shardCount, parallelWorkers } = normalizeShardConfig(shards, validatedRunDials?.parallelWorkers);
  const canonicalBrowser = resolveBrowser(browser).name;

  // AUTO-001: risk-based ordering + optional budget truncation. Reorder is for
  // DISPATCH only — `tests` (approved, original order) is what we persist on
  // the run record below so the audit trail reflects what the reviewer queued,
  // not how the runner chose to schedule it.
  //
  // History is bounded to the 20 most recent completed test runs via the lean
  // accessor `getRecentCompletedWithResults` (id/type/status/startedAt/results
  // only — no testQueue/promptAudit/qualityAnalytics blobs). The scorer caps
  // its per-test window at the 10 newest results anyway (`riskScorer.js`
  // `rows.slice(0, 10)` — newest-first), so 20 runs gives ample headroom
  // while keeping memory bounded on projects with hundreds of historical runs.
  const RISK_HISTORY_RUN_LIMIT = 20;
  const recentRuns = runRepo.getRecentCompletedWithResults(project.id, RISK_HISTORY_RUN_LIMIT);
  const history = recentRuns.flatMap((r) => Array.isArray(r.results) ? r.results : []);
  // Lean lookup — single-row SQL with `LIMIT 1`, no full-table scan.
  const latestCrawl = runRepo.getLatestCrawlWithChangedPages(project.id);
  const changedPages = (latestCrawl?.changedPages || []).map((p) => p?.url || p).filter(Boolean);
  const safeBudget = normalizeBudgetMinutes(budgetMinutes);
  const riskOrderedTests = orderTestsByRisk(tests, history, { changedPages });
  const { kept: selectedTests, skipped: budgetSkipped } = applyBudgetToQueue(riskOrderedTests, safeBudget);

  const runId = generateRunId();
  // Build a riskScore lookup so the persisted testQueue carries the scorer
  // output even though the queue itself follows the approved-test order.
  const riskById = new Map(riskOrderedTests.map((t) => [t.id, t.riskScore]));
  // Pre-seed `results` with "skipped (over budget)" markers — every test must
  // have a resolution (AGENTS.md issue-handling rule); silently dropping
  // budget-truncated tests would violate observability.
  const initialResults = budgetSkipped.map((t) => ({
    testId: t.id,
    testName: t.name,
    status: "skipped",
    skipReason: "over_budget",
    riskScore: t.riskScore,
  }));
  const run = {
    id: runId,
    projectId: project.id,
    type: "test_run",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    results: initialResults,
    passed: 0,
    failed: 0,
    // Total reflects the approved-test set — saved run preserves the audit
    // trail of "what the reviewer queued" even when budget truncated dispatch.
    total: tests.length,
    parallelWorkers,
    shardCount,
    shardsCompleted: 0,
    browser: canonicalBrowser,
    device: device || null,
    networkCondition: networkCondition || "fast",
    // Persisted queue mirrors the approved order; `riskScore` per row lets the
    // UI sort/display by risk without losing the canonical order.
    testQueue: tests.map((t) => ({
      id: t.id, name: t.name, steps: t.steps || [],
      riskScore: riskById.get(t.id) ?? null,
    })),
    budgetMinutes: safeBudget,
    workspaceId: project.workspaceId || null,
    environmentId: environment?.id || null,
  };
  runRepo.create(run);

  logActivity({ ...actor(req),
    type: "test_run.start", projectId: project.id, projectName: project.name,
    runId, // ENT-004 (migration 055): indexed for /audit-log?runId=
    detail: `Test run started — ${selectedTests.length} of ${tests.length} test${tests.length !== 1 ? "s" : ""}${budgetSkipped.length ? ` (${budgetSkipped.length} skipped over budget)` : ""}${parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : ""}`, status: "running",
  });

  if (isQueueAvailable()) {
    // INF-003: Enqueue via BullMQ for durable execution.
    // Snapshot approved test IDs at enqueue time so retries use the same
    // set — prevents mismatch between run.total/testQueue and the actual
    // tests executed if approvals change between attempts.
    //
    // CAP-002 Phase 2 — when the caller requested `shards: N > 1`, fan out
    // to N BullMQ jobs sharing the parent `runId`. Each job carries its
    // pre-computed test-ID slice; the worker never re-derives the split.
    // `jobId: ${runId}:s${i}` keeps each shard job unique while sharing
    // the parent `runs` row (Prerequisite #4 contract — one row per run).
    // The last shard to finish — detected via the boundary-crossing
    // `incrementShardsCompleted` UPDATE — owns finalization (feedback loop
    // + status transition + `done` event). See `workers/runWorker.js`
    // `test_run_shard` branch.
    try {
      if (shardCount > 1) {
        const dispatchedIds = selectedTests.map((t) => t.id);
        const slices = partitionTestIdsForShards(dispatchedIds, shardCount);
        // Enqueue all shards in parallel so a partial failure of the
        // Promise.all surfaces immediately and we can mark the run failed
        // before any shard starts executing. Each shard job uses the same
        // `attempts: 2` retry budget as the single-shard path (inherited
        // from `queue.js` `defaultJobOptions`).
        await Promise.all(slices.map((testIds, shardIndex) =>
          runQueue.add("test_run_shard", {
            runId,
            projectId: project.id,
            type: "test_run_shard",
            shardIndex,
            shardCount,
            options: {
              parallelWorkers, browser: canonicalBrowser,
              device: device || null, locale: locale || null,
              timezoneId: timezoneId || null, geolocation: geolocation || null,
              networkCondition: networkCondition || "fast",
              testIds, actorInfo: actor(req),
            },
          }, { jobId: `${runId}:s${shardIndex}` })
        ));
      } else {
        await runQueue.add("test_run", {
          runId,
          projectId: project.id,
          type: "test_run",
          options: { parallelWorkers, browser: canonicalBrowser, device: device || null, locale: locale || null, timezoneId: timezoneId || null, geolocation: geolocation || null, networkCondition: networkCondition || "fast", testIds: selectedTests.map((t) => t.id), actorInfo: actor(req) },
        }, { jobId: runId });
      }
    } catch (enqueueErr) {
      // Redis connection dropped after startup — mark the run as failed so it
      // doesn't block the project with a perpetual "running" status.
      runRepo.update(runId, { status: "failed", error: "Failed to enqueue job", finishedAt: new Date().toISOString() });
      return res.status(503).json({ error: "Job queue unavailable. Please try again." });
    }
  } else {
    // Fallback: in-process execution (no Redis)
    runWithAbort(runId, run,
      // DIF-012: env override applies at execution only — project.url +
      // project.credentials are unchanged in the DB; only this run's
      // testRunner sees the override.
      (signal) => runTests(
        envScopedProject(project, environment),
        selectedTests,
        run,
        { parallelWorkers, browser: canonicalBrowser, device, locale, timezoneId, geolocation, networkCondition, signal }
      ),
      {
        onSuccess: () => logActivity({ ...actor(req),
          type: "test_run.complete", projectId: project.id, projectName: project.name,
          runId, // ENT-004 (migration 055)
          detail: `Test run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        }),
        onFailActivity: (err) => ({
          type: "test_run.fail", projectId: project.id, projectName: project.name,
          runId, // ENT-004 (migration 055)
          detail: `Test run failed: ${classifyError(err, "run").message}`,
        }),
        actorInfo: actor(req),
        onComplete: async (finishedRun) => {
          // AUTO-005: per-test retry runs inside testRunner.js before results
          // are tallied, so `finishedRun.failed` only counts tests with
          // `failedAfterRetry: true` — notifications correctly fire only after
          // the retry budget is exhausted.
          try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }
        },
      },
    );
  }

  trackTelemetry("run.started", { projectId: project.id, tests: selectedTests.length, browser: canonicalBrowser, networkCondition: networkCondition || "fast", url: project.url });
  res.json({ runId });
});

// ─── Run listing ──────────────────────────────────────────────────────────────

router.get("/projects/:id/runs", (req, res) => {
  // Verify the project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  const { page, pageSize } = req.query;
  if (page !== undefined || pageSize !== undefined) {
    const result = runRepo.getByProjectIdPaged(req.params.id, page, pageSize);
    return res.json({ ...result, data: result.data.map(signRunArtifacts) });
  }
  const runs = runRepo.getByProjectId(req.params.id);
  res.json(runs.map(signRunArtifacts));
});


/**
 * GET /api/v1/projects/:id/last-deployment-run
 *
 * AUTO-015b: powers the "Last deployment run" badge on the project header
 * (NEXT.md:69 acceptance criterion). Returns the most recent deployment-
 * triggered crawl for this project **within the last 24 hours**, or `null`
 * if none. The badge chip only renders when this endpoint returns a run.
 *
 * Data source: `activities.crawl.start.deployment` markers (emitted by
 * `routes/trigger.js:launchPreviewCrawl`) — keyed by `meta.runId` so we can
 * cross-reference the live run's status and surface a success/failure chip.
 */
router.get("/projects/:id/last-deployment-run", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  // 24-hour lookback window, matching NEXT.md:69 ("a deployment-triggered
  // run completed in the last 24h").
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = activityRepo.getFiltered({
    type: "crawl.start.deployment",
    projectId: project.id,
    workspaceId: req.workspaceId,
    after: since,
    limit: 1,
  });
  if (rows.length === 0) return res.json({ run: null });

  const activity = rows[0];
  const runId = activity.meta?.runId || null;
  if (!runId) return res.json({ run: null });

  const run = runRepo.getById(runId);
  // Badge renders even while the run is still in-flight ("Deployment crawl
  // in progress…"), so we don't require a terminal status here — only that
  // the run row still exists.
  if (!run) return res.json({ run: null });

  res.json({
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt || null,
      pagesFound: run.pagesFound ?? 0,
      testsGenerated: Array.isArray(run.tests) ? run.tests.length : 0,
      changedPages: run.changedPages || [],
      removedPages: run.removedPages || [],
      provider: activity.meta?.provider || null,
      previewUrl: activity.meta?.previewUrl || null,
      triggeredAt: activity.createdAt,
    },
  });
});

router.get("/runs/:runId/compare/:otherRunId", (req, res) => {
  const rawBaseRun = runRepo.getById(req.params.runId);
  const rawOtherRun = runRepo.getById(req.params.otherRunId);
  if (!rawBaseRun || !rawOtherRun) return res.status(404).json({ error: "not found" });

  // ACL-001: both runs must belong to projects in the caller's workspace.
  const baseProject = projectRepo.getByIdInWorkspace(rawBaseRun.projectId, req.workspaceId);
  const otherProject = projectRepo.getByIdInWorkspace(rawOtherRun.projectId, req.workspaceId);
  if (!baseProject || !otherProject) return res.status(404).json({ error: "not found" });

  // Sign artifact paths up-front and build diffs from the signed copies so
  // that nested `current` / `previous` result objects in `diffs[]` carry
  // the same HMAC-signed `screenshotPath` / `videoPath` / `visualDiff.*Path`
  // URLs as the top-level `baseRun` / `otherRun`. Without this, consumers
  // loading artifact images via `diffs[i].current.screenshotPath` would hit
  // 401 from the artifact-token validator.
  const baseRun = signRunArtifacts(rawBaseRun);
  const otherRun = signRunArtifacts(rawOtherRun);

  const baseResults = Array.isArray(baseRun.results) ? baseRun.results : [];
  const otherResults = Array.isArray(otherRun.results) ? otherRun.results : [];

  const baseById = new Map(baseResults.map((r) => [r.testId, r]));
  const otherById = new Map(otherResults.map((r) => [r.testId, r]));
  const allTestIds = new Set([...baseById.keys(), ...otherById.keys()]);

  const diffs = Array.from(allTestIds).map((testId) => {
    const current = baseById.get(testId) || null;
    const previous = otherById.get(testId) || null;
    const currentStatus = current?.status || null;
    const previousStatus = previous?.status || null;

    let changeType = "unchanged";
    if (current && !previous) changeType = "added";
    else if (!current && previous) changeType = "removed";
    else if (currentStatus !== previousStatus) changeType = "flipped";

    return {
      testId,
      testName: current?.testName || previous?.testName || null,
      currentStatus,
      previousStatus,
      changeType,
      current,
      previous,
    };
  });

  const summary = diffs.reduce((acc, item) => {
    acc.total += 1;
    if (item.changeType === "flipped") acc.flipped += 1;
    if (item.changeType === "added") acc.added += 1;
    if (item.changeType === "removed") acc.removed += 1;
    if (item.changeType === "unchanged") acc.unchanged += 1;
    return acc;
  }, { total: 0, flipped: 0, added: 0, removed: 0, unchanged: 0 });

  res.json({
    baseRun,
    otherRun,
    summary,
    diffs,
  });
});

router.get("/runs/:runId", (req, res) => {
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  // Verify the run's project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(run.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  // NAV-002 (audit): hydrate `projectName` onto the response so RunDetail's
  // breadcrumb (Dashboard › Projects › [Project Name] › Runs › Run #abc) can
  // render without a second `GET /projects/:id` round-trip. `project` is
  // already in scope from the ACL check above — adding the name is free.
  res.json({ ...signRunArtifacts(run), projectName: project.name });
});

// ─── Abort a running task ─────────────────────────────────────────────────────

router.post("/runs/:runId/abort", requireRole("qa_lead"), (req, res) => {
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  // Verify the run's project belongs to the user's workspace (ACL-001)
  const ownerProject = projectRepo.getByIdInWorkspace(run.projectId, req.workspaceId);
  if (!ownerProject) return res.status(404).json({ error: "not found" });
  if (run.status !== "running") {
    return res.status(409).json({ error: "Run is not in progress" });
  }

  const entry = runAbortControllers.get(req.params.runId);
  // CAP-002 Phase 2 (Prerequisite #4) — `workerAbortControllers` is keyed by
  // BullMQ jobId (bare `runId` for legacy single-shard runs, `${runId}:s${i}`
  // for each shard). Use the parent-keyed iterator to detect whether *any*
  // shard of this run is in flight on this replica, instead of a single
  // `.get(runId)` lookup that would miss shard-keyed entries entirely.
  let workerAborted = 0;
  const hasWorkerEntries = (() => {
    for (const e of workerAbortControllers.values()) {
      if (e?.runId === req.params.runId) return true;
    }
    return false;
  })();
  if (entry) {
    // Mutate the in-memory run object that the pipeline holds so that
    // finalizeRunIfNotAborted() and runRepo.save(run) see "aborted" and
    // don't overwrite it with "running" or "completed".
    const liveRun = entry.run;
    liveRun.status = "aborted";
    liveRun.finishedAt = new Date().toISOString();
    liveRun.duration = liveRun.startedAt ? Date.now() - new Date(liveRun.startedAt).getTime() : null;
    liveRun.error = "Aborted by user";

    entry.controller.abort();
    runAbortControllers.delete(req.params.runId);
  } else if (hasWorkerEntries) {
    // BullMQ-processed run: write abort status to DB BEFORE signaling the
    // worker to prevent a race where the worker's completion write overwrites
    // the abort status between signal and the worker's catch block.
    runRepo.update(req.params.runId, {
      status: "aborted",
      finishedAt: new Date().toISOString(),
      duration: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
      error: "Aborted by user",
    });
    // CAP-002 Phase 2 (Prerequisite #4) — fan out to every shard
    // controller for this run on this replica, then `publishRunAbort`
    // below reaches sibling replicas. `abortAllShardsForRun` handles
    // both legacy single-key entries and shard-keyed entries.
    workerAborted = abortAllShardsForRun(req.params.runId);
  }

  // Mark queued tests that never executed as "skipped" so pass/fail/total
  // metrics are consistent (FLW-03).  Uses the live in-memory run when
  // available (has the latest results from processResult calls).
  // For BullMQ runs (workerEntry path), re-read from DB after signalling
  // abort — testRunner flushes results to SQLite after each test, so the fresh
  // snapshot captures results completed between the initial read and the abort.
  const liveRun = entry?.run || (hasWorkerEntries ? (runRepo.getById(req.params.runId) || run) : run);
  if (Array.isArray(liveRun.results) && Array.isArray(liveRun.testQueue)) {
    const executedIds = new Set(liveRun.results.map(r => r.testId));
    for (const queued of liveRun.testQueue) {
      if (!executedIds.has(queued.id)) {
        liveRun.results.push({
          testId: queued.id,
          testName: queued.name,
          status: "skipped",
          error: "Aborted before execution",
        });
      }
    }
  }

  // For BullMQ runs, the DB was already updated above before signaling
  // the worker. For all other paths (in-process or stale runs with no
  // live controller), write the abort status now.
  if (!hasWorkerEntries) {
    runRepo.update(req.params.runId, {
      status: "aborted",
      finishedAt: new Date().toISOString(),
      duration: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
      error: "Aborted by user",
    });
  }
  // Persist the updated results (with skipped entries) to SQLite
  if (liveRun.results) {
    runRepo.update(req.params.runId, { results: liveRun.results });
  }

  logActivity({ ...actor(req),
    type: `${run.type === "test_run" || run.type === "run" ? "test_run" : run.type}.abort`,
    projectId: run.projectId,
    projectName: ownerProject.name,
    runId: req.params.runId, // ENT-004 (migration 055): indexed for /audit-log?runId=
    detail: `Run aborted by user`,
    status: "aborted",
  });

  // Use the live in-memory run (if available) for pass/fail counts — it has
  // the latest results from processResult() calls that may not yet be flushed
  // to SQLite. Fall back to the SQLite snapshot for runs without a live ref.
  const countsSource = entry?.run || run;
  emitRunEvent(req.params.runId, "done", {
    status: "aborted",
    passed: countsSource.passed ?? undefined,
    failed: countsSource.failed ?? undefined,
    total: countsSource.total ?? undefined,
    testsGenerated: countsSource.testsGenerated ?? undefined,
  });

  // CAP-002 Phase 2 (Prerequisite #5) — fan the abort out to every replica's
  // worker via Redis pub/sub. The local-fast-path above already cancelled
  // any controller in *this* process; this publish reaches sibling replicas
  // whose `workerAbortControllers` map may hold the same runId for shard
  // jobs we don't see. Origin-stamp suppression prevents self-echo. Fire
  // and forget — `publishRunAbort` already swallows publish errors, and
  // the abort response shouldn't block on a sibling-replica round-trip.
  publishRunAbort(req.params.runId).catch(() => { /* best-effort */ });

  res.json({ ok: true, shardsAborted: workerAborted });
});

// ─── Resume a crash-recovered run (B1 — AUDIT-ROADMAP Bundle 1) ──────────────
//
// Recovers a run that the orphan-recovery sweep marked
// `status='interrupted', failureReason='process_crash'` on the last server
// restart. Re-dispatches ONLY the tests that never landed a row in
// `run_test_results` so the resumed run picks up where the crash left off
// instead of restarting from zero.
//
// Industry-standard contract (mirrors GitHub Actions `re-run failed jobs`,
// CircleCI `rerun-from-failed`, Buildkite `retry job`):
//   • Only `interrupted` + `failureReason='process_crash'` runs are
//     resumable. User aborts (`status='aborted'`) and ordinary failures
//     are NOT resumable — the operator must re-trigger the run instead.
//   • The new run is dispatched against the SAME project + environment
//     the original used (replayed from the run row, not re-derived from
//     request inputs) to keep the audit trail honest about what was
//     re-attempted.
//   • Admin-gated. Resuming a run executes tests with the original
//     credentials and against the original environment; a `qa_lead` who
//     can trigger a fresh run should not necessarily be able to replay
//     against an environment they may no longer have access to.
//
// Why not POST /run? The fresh-run endpoint would re-dispatch ALL approved
// tests and reset the run's progress; resume preserves the partial result
// set and only re-executes the missing slice. The two operations are
// semantically distinct — a re-run is "start fresh", a resume is "continue
// from checkpoint".

router.post("/runs/:runId/resume", requireRole("admin"), expensiveOpLimiter, async (req, res) => {
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });

  // ACL-001: the run's project must belong to the caller's workspace.
  const project = projectRepo.getByIdInWorkspace(run.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  // Resume is only valid for crash-recovered runs. Other terminal states
  // (`aborted`, `completed`, `failed`) re-trigger via `/run` instead — a
  // user-aborted run shouldn't silently restart, and an ordinary failure
  // typically reflects a real bug that re-running won't fix.
  if (run.status !== "interrupted" || run.failureReason !== "process_crash") {
    return res.status(409).json({
      error: "Run is not resumable — only crash-recovered runs (status='interrupted', failureReason='process_crash') can be resumed",
      code: "RUN_NOT_RESUMABLE",
      status: run.status,
      failureReason: run.failureReason || null,
    });
  }
  if (run.type !== "test_run" && run.type !== "run") {
    return res.status(409).json({
      error: "Only test runs are resumable — crawls must be re-triggered",
      code: "RUN_TYPE_NOT_RESUMABLE",
      type: run.type,
    });
  }

  // Block resume when a sibling run is already executing for this project —
  // mirrors the `findActiveByProjectId` gate on `POST /run`. Operators must
  // wait or abort the live run before resuming the crash-recovered one.
  const activeRun = runRepo.findActiveByProjectId(project.id);
  if (activeRun) {
    return res.status(409).json({
      error: `A run is already in progress (${activeRun.id}). Wait for it to finish or abort it before resuming.`,
      code: "RUN_ALREADY_ACTIVE",
    });
  }

  // Replay the dispatch context from the persisted run record — the testQueue
  // (audit-of-record), the environment override the original used, and the
  // browser / network / parallelism config. Re-deriving from request inputs
  // would let a caller change the resume target's project / environment /
  // browser silently, breaking the "resume re-executes what crashed" contract.
  const originalQueue = Array.isArray(run.testQueue) ? run.testQueue : [];
  if (originalQueue.length === 0) {
    return res.status(409).json({
      error: "Run has no persisted testQueue — cannot resume; re-trigger via POST /run instead",
      code: "RUN_NO_QUEUE",
    });
  }

  // The checkpoint contract: any test with a `run_test_results` row is
  // considered done (passed / failed / warning all count — the test
  // executed). The remaining set is what the resumed run must re-dispatch.
  const completedTestIds = runTestResultRepo.getCompletedTestIds(req.params.runId);
  const remainingTestIds = originalQueue
    .map((t) => t.id)
    .filter((id) => id && !completedTestIds.has(id));

  if (remainingTestIds.length === 0) {
    return res.status(409).json({
      error: "All tests already completed — nothing to resume",
      code: "RUN_ALREADY_COMPLETE",
      completed: completedTestIds.size,
      total: originalQueue.length,
    });
  }

  // Build the new run row. New ID (resume is a fresh row that links back to
  // the original via `resumedFromRunId` in the activity log — the original
  // remains terminal so historical analytics treat it as one crashed run +
  // one resumed run, not a single run that mysteriously came back to life).
  const newRunId = generateRunId();
  let environment = null;
  if (run.environmentId) {
    try {
      environment = resolveEnvOrThrow(run.environmentId, project);
    } catch (err) {
      // Env may have been deleted since the original run — fail loud rather
      // than silently resuming against a different baseline URL.
      return res.status(err.httpStatus || 409).json({
        error: `Cannot resume — original environment is no longer available: ${err.message}`,
        code: "RUN_ENV_GONE",
      });
    }
  }

  // Look up the actual Test rows for the remaining IDs. Tests that have
  // been deleted or rejected since the crash are silently dropped (the
  // approval gate on `/run` would have rejected them anyway).
  const allTests = testRepo.getByProjectId(project.id);
  const testsById = new Map(allTests.map((t) => [t.id, t]));
  const selectedTests = remainingTestIds
    .map((id) => testsById.get(id))
    .filter((t) => t && t.reviewStatus === "approved");

  if (selectedTests.length === 0) {
    return res.status(409).json({
      error: "No remaining approved tests to resume (the missing tests may have been deleted or unapproved)",
      code: "RUN_NO_REMAINING_TESTS",
      remaining: remainingTestIds.length,
    });
  }

  const newRun = {
    id: newRunId,
    projectId: project.id,
    type: "test_run",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    results: [],
    passed: 0,
    failed: 0,
    total: selectedTests.length,
    parallelWorkers: run.parallelWorkers || 1,
    shardCount: 1, // Resume never re-shards — keeps the dispatch graph simple.
    shardsCompleted: 0,
    browser: run.browser || "chromium",
    device: run.device || null,
    networkCondition: run.networkCondition || "fast",
    testQueue: selectedTests.map((t) => ({
      id: t.id, name: t.name, steps: t.steps || [],
    })),
    workspaceId: project.workspaceId || null,
    environmentId: environment?.id || null,
  };

  // Atomic create-new + mark-original-resumed. Both writes go through one
  // SQLite transaction so a crash or concurrent request between them can't
  // leave RUN-1 still resumable while RUN-2 is already dispatched — which
  // would let a second `POST /runs/RUN-1/resume` re-dispatch the exact same
  // "remaining" slice (RUN-2's `run_test_results` rows live under RUN-2's
  // id, so `getCompletedTestIds(RUN-1)` returns the same set), causing
  // duplicate records / emails / payments on the target app. Same pattern
  // used by `runRepo.markOrphansInterrupted` for its SELECT-then-UPDATE.
  //
  // `runRepo.create` and `runRepo.update` both call `getDatabase()` under
  // the hood, so wrapping their callsites in `db.transaction(...)` here
  // funnels both statements into a single BEGIN/COMMIT.
  //
  // **NOTE — async BullMQ enqueue is OUTSIDE this transaction.** The
  // queue write happens below and can fail with 503; if it does, we
  // revert the original run's `failureReason` back to `process_crash`
  // in the catch arm so the operator can re-attempt resume instead of
  // being permanently locked out by an enqueue glitch. See the rationale
  // at the catch site (line below).
  const db = getDatabase();
  db.transaction(() => {
    runRepo.create(newRun);
    // Stamping `failureReason='resumed'` flips the gate at line 687
    // (`failureReason !== 'process_crash'`) to reject any subsequent resume
    // attempt on RUN-1. It also documents in the DB that this run was
    // successfully resumed (correlate with the matching activity log row
    // via `meta.resumedFromRunId`).
    runRepo.update(req.params.runId, { failureReason: "resumed" });
  })();

  logActivity({ ...actor(req),
    type: "test_run.resume", projectId: project.id, projectName: project.name,
    runId: newRunId,
    detail: `Resumed crash-recovered run ${req.params.runId} — ${selectedTests.length} of ${originalQueue.length} test${originalQueue.length !== 1 ? "s" : ""} remaining`,
    status: "running",
    meta: { resumedFromRunId: req.params.runId, completed: completedTestIds.size, remaining: selectedTests.length },
  });

  if (isQueueAvailable()) {
    try {
      await runQueue.add("test_run", {
        runId: newRunId,
        projectId: project.id,
        type: "test_run",
        options: {
          parallelWorkers: newRun.parallelWorkers,
          browser: newRun.browser,
          device: newRun.device,
          networkCondition: newRun.networkCondition,
          testIds: selectedTests.map((t) => t.id),
          actorInfo: actor(req),
        },
      }, { jobId: newRunId });
    } catch (enqueueErr) {
      // Roll back the new run AND restore the original's resumability.
      // Without the revert below, the original run's `failureReason` stays
      // `'resumed'` from the transaction above and the gate at line 688
      // (`failureReason !== 'process_crash'`) permanently rejects all
      // future resume attempts on RUN-1 — the operator's only recourse
      // would be `POST /run` which restarts from zero, defeating B1's
      // entire crash-recovery contract for what's effectively a transient
      // Redis hiccup. The revert closes that trap so a 503 is genuinely
      // retryable (industry-standard pattern: distinguish "permanent
      // failure" from "retry-after-network-blip").
      runRepo.update(newRunId, { status: "failed", error: "Failed to enqueue job", finishedAt: new Date().toISOString() });
      try {
        runRepo.update(req.params.runId, { failureReason: "process_crash" });
      } catch { /* best-effort — original row may have been deleted concurrently */ }
      return res.status(503).json({ error: "Job queue unavailable. Please try again." });
    }
  } else {
    runWithAbort(newRunId, newRun,
      (signal) => runTests(
        envScopedProject(project, environment),
        selectedTests,
        newRun,
        { parallelWorkers: newRun.parallelWorkers, browser: newRun.browser, device: newRun.device, networkCondition: newRun.networkCondition, signal }
      ),
      {
        onSuccess: () => logActivity({ ...actor(req),
          type: "test_run.complete", projectId: project.id, projectName: project.name,
          runId: newRunId,
          detail: `Resumed run completed — ${newRun.passed || 0} passed, ${newRun.failed || 0} failed`,
        }),
        onFailActivity: (err) => ({
          type: "test_run.fail", projectId: project.id, projectName: project.name,
          runId: newRunId,
          detail: `Resumed run failed: ${classifyError(err, "run").message}`,
        }),
        actorInfo: actor(req),
        onComplete: async (finishedRun) => {
          try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }
        },
      },
    );
  }

  res.status(202).json({
    runId: newRunId,
    resumedFromRunId: req.params.runId,
    completed: completedTestIds.size,
    remaining: selectedTests.length,
    total: originalQueue.length,
  });
});

// ─── CI/CD Trigger token management ──────────────────────────────────────────
// These endpoints are JWT-protected (mounted under requireAuth in index.js).
// The actual trigger endpoint (POST /projects/:id/trigger) lives in trigger.js
// and is mounted without requireAuth so CI pipelines can call it with just a
// project token.

/**
 * GET /api/projects/:id/trigger-tokens
 * List all trigger tokens for a project (hashes never returned).
 */
router.get("/projects/:id/trigger-tokens", (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(webhookTokenRepo.getByProjectId(project.id));
});

/**
 * POST /api/projects/:id/trigger-tokens
 * Create a new trigger token for a project.
 * Returns the plaintext token exactly once — it is never retrievable again.
 *
 * Body: `{ label?: string }`
 * Response `201`: `{ id, token, label, createdAt }`
 */
router.post("/projects/:id/trigger-tokens", requireRole("admin"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  const label = typeof req.body?.label === "string"
    ? req.body.label.trim().slice(0, 120)
    : null;

  const plaintext = webhookTokenRepo.generateToken();
  const id = generateWebhookTokenId();

  webhookTokenRepo.create({
    id,
    projectId: project.id,
    tokenHash: webhookTokenRepo.hashToken(plaintext),
    label,
  });

  logActivity({ ...actor(req),
    type: "project.trigger_token_create",
    projectId: project.id,
    projectName: project.name,
    detail: `CI/CD trigger token created${label ? ` (${label})` : ""}`,
  });

  res.status(201).json({ id, token: plaintext, label, createdAt: new Date().toISOString() });
});

/**
 * DELETE /api/projects/:id/trigger-tokens/:tid
 * Revoke (permanently delete) a trigger token.
 */
router.delete("/projects/:id/trigger-tokens/:tid", requireRole("admin"), (req, res) => {
  const project = projectRepo.getByIdInWorkspace(req.params.id, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  // Verify the token belongs to this project before deleting (prevent
  // cross-project deletion via sequential WH-N ID guessing).
  const tokens = webhookTokenRepo.getByProjectId(project.id);
  if (!tokens.some((t) => t.id === req.params.tid)) {
    return res.status(404).json({ error: "token not found" });
  }

  const deleted = webhookTokenRepo.deleteById(req.params.tid);
  if (!deleted) return res.status(404).json({ error: "token not found" });

  logActivity({ ...actor(req),
    type: "project.trigger_token_delete",
    projectId: project.id,
    projectName: project.name,
    detail: "CI/CD trigger token revoked",
  });

  res.json({ ok: true });
});

// ─── Per-run AI request log (GAP-005, migration 056) ──────────────────────────
//
// Admin-gated endpoint that returns every `ai_request_log` row correlated to
// a specific run. Enables the RunDetail "Agent Call Timeline" component to
// show per-call latency, tokens, cost, model, and (when `aiRequestLogMode`
// is "redacted" or "full") the prompt/response text.
//
// Workspace ACL is enforced by the `workspaceId` predicate inside
// `aiRequestLogRepo.listByRun` — a runId that belongs to a different
// workspace returns zero rows, not a 403, so runId guessing doesn't leak
// cross-workspace data.

router.get("/runs/:runId/ai-requests", requireRole("admin"), (req, res) => {
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  const project = projectRepo.getByIdInWorkspace(run.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });

  const rows = aiRequestLogRepo.listByRun(req.workspaceId, req.params.runId);
  res.json(rows);
});

export default router;
