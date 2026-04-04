/**
 * runs.js — Run routes: crawl, test execution, abort, listing
 *
 * Mounted at /api in index.js
 */

import { Router } from "express";
import { getDb } from "../db.js";
import { generateRunId } from "../utils/idGenerator.js";
import { logActivity } from "../utils/activityLogger.js";
import { runWithAbort, runAbortControllers } from "../utils/runWithAbort.js";
import { emitRunEvent } from "./sse.js";
import { resolveDialsPrompt, resolveDialsConfig } from "../testDials.js";
import { crawlAndGenerateTests } from "../crawler.js";
import { runTests } from "../testRunner.js"; // thin orchestrator — delegates to runner/ modules

const router = Router();

// ─── Crawl & Generate Tests ───────────────────────────────────────────────────

router.post("/projects/:id/crawl", async (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });

  const { dialsConfig } = req.body || {};
  const dialsPrompt = resolveDialsPrompt(dialsConfig);
  const validatedDials = resolveDialsConfig(dialsConfig);
  const testCount = validatedDials?.testCount || "auto";

  const runId = generateRunId(db);
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
  db.runs[runId] = run;

  logActivity({
    type: "crawl.start", projectId: project.id, projectName: project.name,
    detail: `Crawl started for ${project.url}`, status: "running",
  });

  runWithAbort(runId, run,
    (signal) => crawlAndGenerateTests(project, run, db, { dialsPrompt, testCount, signal }),
    {
      onSuccess: () => logActivity({
        type: "crawl.complete", projectId: project.id, projectName: project.name,
        detail: `Crawl completed — ${run.pagesFound || 0} pages found`,
      }),
      onFailActivity: (err) => ({
        type: "crawl.fail", projectId: project.id, projectName: project.name,
        detail: `Crawl failed: ${err.message}`,
      }),
    },
  );

  res.json({ runId });
});

// ─── Run Tests ────────────────────────────────────────────────────────────────

router.post("/projects/:id/run", async (req, res) => {
  const db = getDb();
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });

  const allTests = Object.values(db.tests).filter((t) => t.projectId === project.id);
  const tests = allTests.filter((t) => t.reviewStatus === "approved");
  if (!allTests.length) return res.status(400).json({ error: "no tests found, crawl first" });
  if (!tests.length) return res.status(400).json({ error: "no approved tests — review generated tests and approve them before running regression" });

  const runId = generateRunId(db);
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
    testQueue: tests.map((t) => ({ id: t.id, name: t.name, steps: t.steps || [] })),
  };
  db.runs[runId] = run;

  logActivity({
    type: "test_run.start", projectId: project.id, projectName: project.name,
    detail: `Test run started — ${tests.length} test${tests.length !== 1 ? "s" : ""}`, status: "running",
  });

  runWithAbort(runId, run,
    (signal) => runTests(project, tests, run, db, { signal }),
    {
      onSuccess: () => logActivity({
        type: "test_run.complete", projectId: project.id, projectName: project.name,
        detail: `Test run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
      }),
      onFailActivity: (err) => ({
        type: "test_run.fail", projectId: project.id, projectName: project.name,
        detail: `Test run failed: ${err.message}`,
      }),
    },
  );

  res.json({ runId });
});

// ─── Run listing ──────────────────────────────────────────────────────────────

router.get("/projects/:id/runs", (req, res) => {
  const db = getDb();
  const runs = Object.values(db.runs)
    .filter((r) => r.projectId === req.params.id)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(runs);
});

router.get("/runs/:runId", (req, res) => {
  const db = getDb();
  const run = db.runs[req.params.runId];
  if (!run) return res.status(404).json({ error: "not found" });
  res.json(run);
});

// ─── Abort a running task ─────────────────────────────────────────────────────

router.post("/runs/:runId/abort", (req, res) => {
  const db = getDb();
  const run = db.runs[req.params.runId];
  if (!run) return res.status(404).json({ error: "not found" });
  if (run.status !== "running") {
    return res.status(409).json({ error: "Run is not in progress" });
  }

  const controller = runAbortControllers.get(req.params.runId);
  if (controller) {
    controller.abort();
    runAbortControllers.delete(req.params.runId);
  }

  run.status = "aborted";
  run.finishedAt = new Date().toISOString();
  run.duration = run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null;
  run.error = "Aborted by user";

  const project = db.projects[run.projectId];
  logActivity({
    type: `${run.type === "test_run" || run.type === "run" ? "test_run" : run.type}.abort`,
    projectId: run.projectId,
    projectName: project?.name || null,
    detail: `Run aborted by user`,
    status: "aborted",
  });

  emitRunEvent(req.params.runId, "done", { status: "aborted" });

  res.json({ ok: true });
});

export default router;
