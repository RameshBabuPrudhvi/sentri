import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { initCountersFromExistingData } from "./utils/idGenerator.js";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db.js";

// ─── Route modules ────────────────────────────────────────────────────────────
import projectsRouter from "./routes/projects.js";
import runsRouter from "./routes/runs.js";
import sseRouter from "./routes/sse.js";
import dashboardRouter from "./routes/dashboard.js";
import settingsRouter from "./routes/settings.js";
import systemRouter from "./routes/system.js";

// Re-export SSE symbols so existing imports from "./index.js" keep working
// during incremental migration (runLogger.js, crawler.js, testRunner.js).
export { emitRunEvent, runListeners } from "./routes/sse.js";
export { runAbortControllers } from "./utils/runWithAbort.js";

dotenv.config();

// ─── Process-level crash guards ───────────────────────────────────────────────
// Prevent the server from dying on unhandled errors (which wipes the in-memory DB).
// Playwright can throw unhandled rejections from browser internals, page event
// handlers, or video flush operations — especially when assertions fail mid-test.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception (server kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection (server kept alive):", reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// ─── Serve Playwright artifacts ────────────────────────────────────────────
const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");
app.use("/artifacts", express.static(ARTIFACTS_DIR, {
  setHeaders(res, fp) {
    if (fp.endsWith(".webm")) res.setHeader("Content-Type", "video/webm");
    if (fp.endsWith(".zip"))  res.setHeader("Content-Type", "application/zip");
    if (fp.endsWith(".png"))  res.setHeader("Content-Type", "image/png");
    res.setHeader("Accept-Ranges", "bytes");
  },
}));

const db = getDb();

// Seed sequential ID counters from any data restored from disk so new IDs
// don't collide with previously generated ones.
initCountersFromExistingData(db);

// ─── Seed helper (dev / testing only) ────────────────────────────────────
// Allows seed.js to inject pre-built run objects directly into the in-memory DB
// without going through the real crawl/run flow. Disabled in production.
if (process.env.NODE_ENV !== "production") {
  app.patch("/api/_seed/runs/:id", (req, res) => {
    db.runs[req.params.id] = { ...req.body, id: req.params.id };
    res.json({ ok: true, id: req.params.id });
  });
}

// ─── Mount route modules ──────────────────────────────────────────────────────
app.use("/api/projects", projectsRouter);
app.use("/api", runsRouter);
app.use("/api", sseRouter);
app.use("/api", dashboardRouter);
app.use("/api", settingsRouter);
app.use("/api", systemRouter);

// Health check (root-level, not under /api)
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Test routes (TODO: extract to routes/tests.js in a follow-up) ────────────
// These remain here temporarily because the file is too large for a single
// extraction step. All other routes have been moved to backend/src/routes/*.js.

import { generateTestId, generateRunId } from "./utils/idGenerator.js";
import { logActivity } from "./utils/activityLogger.js";
import { runWithAbort } from "./utils/runWithAbort.js";
import { hasProvider } from "./aiProvider.js";              // used by tests/generate route
import { resolveDialsPrompt, resolveDialsConfig } from "./testDials.js"; // used by tests/generate route
import { generateSingleTest } from "./crawler.js";          // used by tests/generate route
import { runTests } from "./testRunner.js";                  // used by tests/:testId/run route

// ─── Tests ────────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/tests", (req, res) => {
  const tests = Object.values(db.tests).filter((t) => t.projectId === req.params.id);
  res.json(tests);
});

// ── All tests (batch endpoint for frontend) ──────────────────────────────────
app.get("/api/tests", (req, res) => {
  res.json(Object.values(db.tests));
});

// ── Single test by ID (for TestDetail page) ───────────────────────────────────
app.get("/api/tests/:testId", (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test) return res.status(404).json({ error: "not found" });
  res.json(test);
});

// PATCH /api/tests/:testId — persist user-edited steps (and optionally other fields)
// Called after the review phase so edits made in the UI are not silently discarded.
// When `regenerateCode: true` is sent AND steps changed, re-generates Playwright code via AI.
app.patch("/api/tests/:testId", async (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test) return res.status(404).json({ error: "not found" });

  const { steps, name, description, priority, regenerateCode, playwrightCode } = req.body;

  if (typeof name === "string")        test.name        = name.trim();
  if (typeof description === "string") test.description = description.trim();
  if (typeof priority === "string")    test.priority    = priority;
  if (typeof playwrightCode === "string") {
    if (test.playwrightCode && test.playwrightCode !== playwrightCode) {
      test.playwrightCodePrev = test.playwrightCode;
    }
    test.playwrightCode = playwrightCode;
  }

  const stepsChanged = Array.isArray(steps) &&
    JSON.stringify(steps) !== JSON.stringify(test.steps);

  if (Array.isArray(steps)) test.steps = steps;

  test.updatedAt = new Date().toISOString();

  // Track whether code was actually regenerated in THIS request (not a prior one)
  let codeRegeneratedNow = false;

  // If caller requested code regeneration, rebuild Playwright script from current steps.
  // Regenerates whenever regenerateCode is true — not just when steps changed — so the
  // script stays in sync with name, description, and step edits alike.
  if (regenerateCode && hasProvider() && Array.isArray(test.steps) && test.steps.length > 0) {
    try {
      const project = db.projects[test.projectId];
      const appUrl = project?.url || test.sourceUrl || "";
      const { generateText, parseJSON } = await import("./aiProvider.js");

      const codePrompt = `You are a Playwright automation expert. Convert the following QA test steps into a complete, runnable Playwright test.

Test Name: ${test.name}
Application URL: ${appUrl}
Test Steps:
${test.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Requirements:
- MUST start with: await page.goto('${appUrl}')
- Use role-based selectors: getByRole(), getByLabel(), getByText(), getByPlaceholder()
- Add page.waitForLoadState() after each navigation
- Include at least 3 meaningful expect() assertions
- Do NOT include import statements at the top — test/expect are provided externally

Return ONLY valid JSON with no markdown fences:
{
  "playwrightCode": "test('${test.name}', async ({ page }) => {\\n  // full test implementation\\n});"
}`;

      const codeRaw = await generateText(codePrompt);
      let playwrightCode = null;
      try {
        const parsed = parseJSON(codeRaw);
        playwrightCode = typeof parsed.playwrightCode === "string" ? parsed.playwrightCode : null;
      } catch {
        if (codeRaw.includes("test(") && codeRaw.includes("async")) {
          playwrightCode = codeRaw.trim();
        }
      }
      if (playwrightCode) {
        // Preserve the previous version so the frontend can show a diff
        if (test.playwrightCode && test.playwrightCode !== playwrightCode) {
          test.playwrightCodePrev = test.playwrightCode;
        }
        test.playwrightCode = playwrightCode;
        test.codeRegeneratedAt = new Date().toISOString();
        codeRegeneratedNow = true;
      }
    } catch (err) {
      console.error("[PATCH test] code regeneration failed:", err.message);
      // Non-fatal: steps are saved, code stays stale. Frontend will see codeStale flag.
    }
  }

  // Log the edit activity
  const project = db.projects[test.projectId];
  logActivity({
    type: stepsChanged && regenerateCode ? "test.regenerate" : "test.edit",
    projectId: test.projectId,
    projectName: project?.name || null,
    testId: test.id,
    testName: test.name,
    detail: stepsChanged
      ? `Steps updated (${test.steps.length} steps)${codeRegeneratedNow ? " — Playwright code regenerated" : ""}`
      : "Test metadata updated",
  });

  // Let the frontend know if the code may be out of sync with steps
  const response = { ...test };
  if (regenerateCode && !codeRegeneratedNow) {
    response._codeStale = true;
  }

  res.json(response);
});

// ── Manual test creation ──────────────────────────────────────────────────────
app.post("/api/projects/:id/tests", (req, res) => {
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const { name, description, steps, playwrightCode, priority, type } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const testId = generateTestId(db);
  const test = {
    id: testId,
    projectId: project.id,
    name: name.trim(),
    description: description?.trim() || "",
    steps: Array.isArray(steps) ? steps : [],
    playwrightCode: playwrightCode || null,
    priority: priority || "medium",
    type: type || "manual",
    sourceUrl: project.url,
    pageTitle: project.name,
    createdAt: new Date().toISOString(),
    lastResult: null,
    lastRunAt: null,
    qualityScore: null,
    isJourneyTest: false,
    reviewStatus: "draft", // all new tests start as draft — must be reviewed before regression
    reviewedAt: null,
  };

  db.tests[testId] = test;

  logActivity({
    type: "test.create", projectId: project.id, projectName: project.name,
    testId, testName: test.name,
    detail: `Manual test created — "${test.name}"`,
  });

  res.status(201).json(test);
});

app.delete("/api/projects/:id/tests/:testId", (req, res) => {
  const test = db.tests[req.params.testId];
  const project = db.projects[req.params.id];
  if (test) {
    logActivity({
      type: "test.delete", projectId: req.params.id, projectName: project?.name || null,
      testId: req.params.testId, testName: test.name,
      detail: `Test deleted — "${test.name}"`,
    });
  }
  delete db.tests[req.params.testId];
  res.json({ ok: true });
});

// ── AI-powered test generation (pipeline-based) ──────────────────────────────
// POST /api/projects/:id/tests/generate
// Body: { name, description }
//
// Reuses the crawl pipeline stages 3-7 (Classify → Generate → Deduplicate →
// Enhance → Validate), skipping stages 1-2 (Crawl & Filter) since the user
// provides a title + description instead of a URL to crawl.
//
// Returns 202 { runId } immediately. The AI pipeline runs asynchronously in the
// background — the frontend navigates to the live run view to track progress.
app.post("/api/projects/:id/tests/generate", async (req, res) => {
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const { name, description, dialsConfig } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  const cleanDescription = (description || "").trim();
  // Build the dials prompt server-side from the structured config
  const dialsPrompt = resolveDialsPrompt(dialsConfig);
  const validatedGenDials = resolveDialsConfig(dialsConfig);
  // Default to "single" for the generate endpoint (user-requested tests)
  // to preserve the original contract of generating exactly 1 test.
  // The crawl endpoint defaults to "auto" which generates 5-8 tests per page.
  const testCount = validatedGenDials?.testCount || "single";

  if (!hasProvider()) {
    return res.status(503).json({
      error: "No AI provider configured. Add an API key in Settings to use AI test generation.",
    });
  }

  const runId = generateRunId(db);
  const run = {
    id: runId,
    projectId: project.id,
    type: "generate",
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
    tests: [],
    pagesFound: 0,
    // Store the generation input so the frontend can display it
    generateInput: { name: name.trim(), description: cleanDescription },
  };
  db.runs[runId] = run;

  logActivity({
    type: "test.generate", projectId: project.id, projectName: project.name,
    detail: `Test generation pipeline started for "${name.trim()}"`, status: "running",
  });

  // Respond immediately with runId so the frontend can navigate to the live
  // run view while the pipeline executes asynchronously in the background.
  res.status(202).json({ runId });

  // Run pipeline async after response is flushed
  runWithAbort(runId, run,
    (signal) => generateSingleTest(project, run, db, {
      name: name.trim(),
      description: cleanDescription,
      dialsPrompt,
      testCount,
      signal,
    }),
    {
      onSuccess: (createdTestIds) => logActivity({
        type: "test.generate", projectId: project.id, projectName: project.name,
        detail: `Test generation completed — ${createdTestIds.length} test(s) created for "${name.trim()}"`,
      }),
      onFailActivity: (err) => ({
        type: "test.generate", projectId: project.id, projectName: project.name,
        detail: `Test generation failed for "${name.trim()}" — ${err.message}`,
      }),
    },
  );
});

// ── Run a single test by ID ───────────────────────────────────────────────────
app.post("/api/tests/:testId/run", async (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test) return res.status(404).json({ error: "test not found" });

  const project = db.projects[test.projectId];
  if (!project) return res.status(404).json({ error: "project not found" });

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
    total: 1,
    testQueue: [{ id: test.id, name: test.name, steps: test.steps || [] }],
  };
  db.runs[runId] = run;

  logActivity({
    type: "test_run.start", projectId: project.id, projectName: project.name,
    testId: test.id, testName: test.name,
    detail: `Single test run started — "${test.name}"`, status: "running",
  });

  runWithAbort(runId, run,
    (signal) => runTests(project, [test], run, db, { signal }),
    {
      onSuccess: () => logActivity({
        type: "test_run.complete", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Single test completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
      }),
      onFailActivity: (err) => ({
        type: "test_run.fail", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Single test failed: ${err.message}`,
      }),
    },
  );

  res.json({ runId });
});

const PORT = process.env.PORT || 3001;

// ─── Test Review: Approve / Reject / Restore / Bulk ──────────────────────────

app.patch("/api/projects/:id/tests/:testId/approve", (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "approved";
  test.reviewedAt = new Date().toISOString();
  const project = db.projects[req.params.id];
  logActivity({
    type: "test.approve", projectId: req.params.id, projectName: project?.name || null,
    testId: test.id, testName: test.name,
    detail: `Test approved — "${test.name}"`,
  });
  res.json(test);
});

app.patch("/api/projects/:id/tests/:testId/reject", (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "rejected";
  test.reviewedAt = new Date().toISOString();
  const project = db.projects[req.params.id];
  logActivity({
    type: "test.reject", projectId: req.params.id, projectName: project?.name || null,
    testId: test.id, testName: test.name,
    detail: `Test rejected — "${test.name}"`,
  });
  res.json(test);
});

app.patch("/api/projects/:id/tests/:testId/restore", (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "draft";
  test.reviewedAt = null;
  const project = db.projects[req.params.id];
  logActivity({
    type: "test.restore", projectId: req.params.id, projectName: project?.name || null,
    testId: test.id, testName: test.name,
    detail: `Test restored to draft — "${test.name}"`,
  });
  res.json(test);
});

// NOTE: bulk must be declared BEFORE :testId wildcard routes to avoid conflict
app.post("/api/projects/:id/tests/bulk", (req, res) => {
  const { testIds, action } = req.body;
  if (!testIds || !Array.isArray(testIds) || !["approve", "reject", "restore", "delete"].includes(action))
    return res.status(400).json({ error: "testIds[] and valid action required" });

  if (action === "delete") {
    const deleted = [];
    testIds.forEach((tid) => {
      const test = db.tests[tid];
      if (test && test.projectId === req.params.id) {
        deleted.push({ id: test.id, name: test.name });
        delete db.tests[tid];
      }
    });
    if (deleted.length) {
      const project = db.projects[req.params.id];
      logActivity({
        type: "test.bulk_delete", projectId: req.params.id, projectName: project?.name || null,
        detail: `Bulk delete — ${deleted.length} test${deleted.length !== 1 ? "s" : ""}`,
      });
    }
    return res.json({ deleted: deleted.length, tests: deleted });
  }

  const statusMap = { approve: "approved", reject: "rejected", restore: "draft" };
  const updated = [];
  testIds.forEach((tid) => {
    const test = db.tests[tid];
    if (test && test.projectId === req.params.id) {
      test.reviewStatus = statusMap[action];
      test.reviewedAt = action === "restore" ? null : new Date().toISOString();
      updated.push(test);
    }
  });
  if (updated.length) {
    const project = db.projects[req.params.id];
    logActivity({
      type: `test.bulk_${action}`, projectId: req.params.id, projectName: project?.name || null,
      detail: `Bulk ${action} — ${updated.length} test${updated.length !== 1 ? "s" : ""}`,
    });
  }
  res.json({ updated: updated.length, tests: updated });
});

app.listen(PORT, () => console.log(`🐻 Sentri API running on port ${PORT}`));
