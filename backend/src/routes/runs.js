/**
 * @module routes/runs
 * @description Run routes — crawl, test execution, abort, and listing. Mounted at `/api`.
 *
 * ### Endpoints
 * | Method | Path                         | Description                        |
 * |--------|------------------------------|------------------------------------|
 * | `POST` | `/api/projects/:id/crawl`    | Start crawl + AI test generation   |
 * | `POST` | `/api/projects/:id/run`      | Execute all approved tests         |
 * | `GET`  | `/api/projects/:id/runs`     | List runs for a project            |
 * | `GET`  | `/api/runs/:runId`           | Get run detail                     |
 * | `POST` | `/api/runs/:runId/abort`     | Abort a running crawl or test run  |
 */

import { Router } from "express";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as runRepo from "../database/repositories/runRepo.js";
import * as testRepo from "../database/repositories/testRepo.js";
import { generateRunId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort, runAbortControllers } from "../utils/runWithAbort.js";
import { emitRunEvent } from "./sse.js";
import { resolveDialsPrompt, resolveDialsConfig } from "../testDials.js";
import { crawlAndGenerateTests } from "../crawler.js";
import { runTests } from "../testRunner.js"; // thin orchestrator — delegates to runner/ modules
import { classifyError } from "../utils/errorClassifier.js";
import { expensiveOpLimiter } from "../middleware/appSetup.js";
// ─── Audit trail helper ──────────────────────────────────────────────────────
// Extracts userId and userName from req.authUser (set by requireAuth middleware)
// so every logActivity() call automatically records who performed the action.
// Returns an object that can be spread into logActivity({ ...actor(req), ...actor(req), ... }).
function actor(req) {
  const u = req?.authUser;
  if (!u) return {};
  return { userId: u.sub, userName: u.name || u.email || u.sub };
}


const router = Router();

// ─── Crawl & Generate Tests ───────────────────────────────────────────────────

router.post("/projects/:id/crawl", expensiveOpLimiter, async (req, res) => {
  const project = projectRepo.getById(req.params.id);
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
  };
  runRepo.create(run);

  logActivity({ ...actor(req),
    type: "crawl.start", projectId: project.id, projectName: project.name,
    detail: `Crawl started for ${project.url}`, status: "running",
  });

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
    },
  );

  res.json({ runId });
});

// ─── Run Tests ────────────────────────────────────────────────────────────────

router.post("/projects/:id/run", expensiveOpLimiter, async (req, res) => {
  const project = projectRepo.getById(req.params.id);
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

  // Extract parallel workers from dials config (if provided)
  const { dialsConfig } = req.body || {};
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
    testQueue: tests.map((t) => ({ id: t.id, name: t.name, steps: t.steps || [] })),
  };
  runRepo.create(run);

  logActivity({ ...actor(req),
    type: "test_run.start", projectId: project.id, projectName: project.name,
    detail: `Test run started — ${tests.length} test${tests.length !== 1 ? "s" : ""}${parallelWorkers > 1 ? ` (${parallelWorkers}x parallel)` : ""}`, status: "running",
  });

  runWithAbort(runId, run,
    (signal) => runTests(project, tests, run, { parallelWorkers, signal }),
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
    },
  );

  res.json({ runId });
});

// ─── Run listing ──────────────────────────────────────────────────────────────

router.get("/projects/:id/runs", (req, res) => {
  const runs = runRepo.getByProjectId(req.params.id);
  res.json(runs);
});

router.get("/runs/:runId", (req, res) => {
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json(run);
});

// ─── Abort a running task ─────────────────────────────────────────────────────

router.post("/runs/:runId/abort", (req, res) => {
  const run = runRepo.getById(req.params.runId);
  if (!run) return res.status(404).json({ error: "not found" });
  if (run.status !== "running") {
    return res.status(409).json({ error: "Run is not in progress" });
  }

  const entry = runAbortControllers.get(req.params.runId);
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
  }

  runRepo.update(req.params.runId, {
    status: "aborted",
    finishedAt: new Date().toISOString(),
    duration: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
    error: "Aborted by user",
  });

  const project = projectRepo.getById(run.projectId);
  logActivity({ ...actor(req),
    type: `${run.type === "test_run" || run.type === "run" ? "test_run" : run.type}.abort`,
    projectId: run.projectId,
    projectName: project?.name || null,
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

export default router;
