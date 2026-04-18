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
 * | `POST`   | `/api/v1/projects/:id/trigger`              | CI/CD token-authenticated test run  |
 * | `GET`    | `/api/v1/projects/:id/trigger-tokens`       | List trigger tokens for a project   |
 * | `POST`   | `/api/v1/projects/:id/trigger-tokens`       | Create a new trigger token          |
 * | `DELETE` | `/api/v1/projects/:id/trigger-tokens/:tid`  | Revoke a trigger token              |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import * as webhookTokenRepo from "../database/repositories/webhookTokenRepo.js";
import { generateRunId, generateWebhookTokenId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort, runAbortControllers } from "../utils/runWithAbort.js";
import { workerAbortControllers } from "../workers/runWorker.js";
import { emitRunEvent } from "./sse.js";
import { resolveDialsPrompt, resolveDialsConfig } from "../testDials.js";
import { crawlAndGenerateTests } from "../crawler.js";
import { runTests } from "../testRunner.js"; // thin orchestrator — delegates to runner/ modules
import { classifyError } from "../utils/errorClassifier.js";
import { expensiveOpLimiter, signRunArtifacts } from "../middleware/appSetup.js";
import { demoQuota } from "../middleware/demoQuota.js";
import { actor } from "../utils/actor.js";
import { requireRole } from "../middleware/requireRole.js";
import { runQueue, isQueueAvailable } from "../queue.js";
import { fireNotifications } from "../utils/notifications.js";

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
    workspaceId: project.workspaceId || null,
  };
  runRepo.create(run);

  logActivity({ ...actor(req),
    type: "crawl.start", projectId: project.id, projectName: project.name,
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
      (signal) => crawlAndGenerateTests(project, run, { dialsPrompt, testCount, explorerMode, explorerTuning, signal }),
      {
        onSuccess: () => logActivity({ ...actor(req),
          type: "crawl.complete", projectId: project.id, projectName: project.name,
          detail: `Crawl completed — ${run.pagesFound || 0} pages found`,
        }),
        onFailActivity: (err) => ({
          type: "crawl.fail", projectId: project.id, projectName: project.name,
          detail: `Crawl failed: ${classifyError(err, "crawl").message}`,
        }),
        actorInfo: actor(req),
        onComplete: async (finishedRun) => {
          // FEA-001: Fire failure notifications — best-effort
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

  const allTests = testRepo.getByProjectId(project.id);
  const tests = allTests.filter((t) => t.reviewStatus === "approved");
  if (!allTests.length) return res.status(400).json({ error: "no tests found, crawl first" });
  if (!tests.length) return res.status(400).json({ error: "no approved tests — review generated tests and approve them before running regression" });

  // Extract parallel workers and device emulation from request body / dials config
  const { dialsConfig, device } = req.body || {};
  const validatedRunDials = resolveDialsConfig(dialsConfig);
  const parallelWorkers = validatedRunDials?.parallelWorkers ?? 1;

  const runId = generateRunId();
  const run = {
    id: runId,
    projectId: project.id,
    type: "test_run",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    results: [],
    passed: 0,
    failed: 0,
    total: tests.length,
    parallelWorkers,
    device: device || null,
    testQueue: tests.map((t) => ({ id: t.id, name: t.name, steps: t.steps || [] })),
    workspaceId: project.workspaceId || null,
  };
  runRepo.create(run);

  logActivity({ ...actor(req),
    type: "test_run.start", projectId: project.id, projectName: project.name,
    detail: `Test run started — ${tests.length} test${tests.length !== 1 ? "s" : ""}${parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : ""}`, status: "running",
  });

  if (isQueueAvailable()) {
    // INF-003: Enqueue via BullMQ for durable execution.
    // Snapshot approved test IDs at enqueue time so retries use the same
    // set — prevents mismatch between run.total/testQueue and the actual
    // tests executed if approvals change between attempts.
    try {
      await runQueue.add("test_run", {
        runId,
        projectId: project.id,
        type: "test_run",
        options: { parallelWorkers, device: device || null, testIds: tests.map((t) => t.id), actorInfo: actor(req) },
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
      (signal) => runTests(project, tests, run, { parallelWorkers, device, signal }),
      {
        onSuccess: () => logActivity({ ...actor(req),
          type: "test_run.complete", projectId: project.id, projectName: project.name,
          detail: `Test run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
        }),
        onFailActivity: (err) => ({
          type: "test_run.fail", projectId: project.id, projectName: project.name,
          detail: `Test run failed: ${classifyError(err, "run").message}`,
        }),
        actorInfo: actor(req),
        onComplete: async (finishedRun) => {
          // FEA-001: Fire failure notifications — best-effort
          try { await fireNotifications(finishedRun, project); } catch { /* best-effort */ }
        },
      },
    );
  }

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

router.get("/runs/:runId", (req, res) => {
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  // Verify the run's project belongs to the user's workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(run.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(signRunArtifacts(run));
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
  const workerController = workerAbortControllers.get(req.params.runId);
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
  } else if (workerController) {
    // BullMQ-processed run: signal the worker's AbortController.
    // The worker's catch block checks signal.aborted (set synchronously
    // by controller.abort()) and skips terminal side-effects.
    workerController.abort();
    workerAbortControllers.delete(req.params.runId);
  }

  // Mark queued tests that never executed as "skipped" so pass/fail/total
  // metrics are consistent (FLW-03).  Uses the live in-memory run when
  // available (has the latest results from processResult calls).
  // For BullMQ runs (workerController path), re-read from DB after signalling
  // abort — testRunner flushes results to SQLite after each test, so the fresh
  // snapshot captures results completed between the initial read and the abort.
  const liveRun = entry?.run || (workerController ? (runRepo.getById(req.params.runId) || run) : run);
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

  runRepo.update(req.params.runId, {
    status: "aborted",
    finishedAt: new Date().toISOString(),
    duration: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
    error: "Aborted by user",
  });
  // Persist the updated results (with skipped entries) to SQLite
  if (liveRun.results) {
    runRepo.update(req.params.runId, { results: liveRun.results });
  }

  logActivity({ ...actor(req),
    type: `${run.type === "test_run" || run.type === "run" ? "test_run" : run.type}.abort`,
    projectId: run.projectId,
    projectName: ownerProject.name,
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

  res.json({ ok: true });
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

export default router;
