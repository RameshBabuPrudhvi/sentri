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
import { hasProvider } from "./aiProvider.js";
import { resolveDialsPrompt, resolveDialsConfig } from "./testDials.js";
import { generateSingleTest } from "./crawler.js";
import { runTests } from "./testRunner.js";

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

app.get("/api/projects/:id/runs", (req, res) => {
  const runs = Object.values(db.runs)
    .filter((r) => r.projectId === req.params.id)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  res.json(runs);
});

app.get("/api/runs/:runId", (req, res) => {
  const run = db.runs[req.params.runId];
  if (!run) return res.status(404).json({ error: "not found" });
  res.json(run);
});

// ─── Abort registry: runId → AbortController ──────────────────────────────────
// Allows in-progress crawl / generate / test_run operations to be cancelled.
// Declared before runWithAbort() which references it.
export const runAbortControllers = new Map();

// ─── SSE: Real-time run events ────────────────────────────────────────────────
// Registry: runId → Set of SSE response objects
export const runListeners = new Map();

/**
 * emitRunEvent(runId, type, payload)
 * Broadcasts a Server-Sent Event to every client listening on this run.
 * Called from testRunner.js and crawler.js to push live updates.
 */
export function emitRunEvent(runId, type, payload = {}) {
  const listeners = runListeners.get(runId);
  if (!listeners || listeners.size === 0) {
    // Even with no active listeners, clean up the registry on "done" so
    // the Map doesn't grow unboundedly with stale runId keys.
    if (type === "done") runListeners.delete(runId);
    return;
  }
  const data = JSON.stringify({ type, ...payload });
  // Snapshot the Set before iterating — res.end() triggers the "close"
  // handler which mutates the Set, causing concurrent-modification issues.
  const snapshot = [...listeners];
  for (const res of snapshot) {
    try {
        res.write(`data: ${data}\n\n`);
        if (type === "done") res.end();
    } catch { /* client gone */ }
  }
  if (type === "done") runListeners.delete(runId);
}

// GET /api/runs/:id/events  — SSE stream for a single run
app.get("/api/runs/:runId/events", (req, res) => {
  const { runId } = req.params;
  const run = db.runs[runId];
  if (!run) return res.status(404).json({ error: "not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  // Send current snapshot immediately so the client has something to render
  res.write(`data: ${JSON.stringify({ type: "snapshot", run })}\n\n`);

  // If already done, send done event and close
  if (run.status !== "running") {
    res.write(`data: ${JSON.stringify({ type: "done", status: run.status })}\n\n`);
    return res.end();
  }

  if (!runListeners.has(runId)) runListeners.set(runId, new Set());
  runListeners.get(runId).add(res);

  // Heartbeat — keeps the connection alive through proxies / load balancers.
  // 10 s interval (down from 20 s) to avoid ECONNRESET from aggressive proxies
  // or OS TCP stacks during long-running feedback-loop AI calls.
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 10000);

  req.on("close", () => {
    clearInterval(heartbeat);
    runListeners.get(runId)?.delete(res);
    if (runListeners.get(runId)?.size === 0) runListeners.delete(runId);
  });
});

// ─── Abort a running task ─────────────────────────────────────────────────────
// POST /api/runs/:runId/abort — cancels a crawl, generate, or test_run in progress
app.post("/api/runs/:runId/abort", (req, res) => {
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

  // Mark as aborted immediately so the UI updates even if the async
  // pipeline takes a moment to notice the signal.
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

// ─── Dashboard summary ────────────────────────────────────────────────────────

app.get("/api/dashboard", (req, res) => {
  const projects = Object.values(db.projects);
  const runs = Object.values(db.runs);
  const tests = Object.values(db.tests);
  const activities = Object.values(db.activities);

  // ── Pass rate (last 10 completed test runs) ─────────────────────────────
  const completedTestRuns = runs
    .filter((r) => (r.type === "test_run" || r.type === "run") && r.status === "completed")
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 10);

  const passRate =
    completedTestRuns.length
      ? Math.round(
          (completedTestRuns.reduce((s, r) => s + (r.passed || 0), 0) /
            completedTestRuns.reduce((s, r) => s + (r.total || 1), 0)) *
            100
        )
      : null;

  // ── Chart history — last 20 test runs with results (chronological) ──────
  const history = runs
    .filter((r) => (r.type === "test_run" || r.type === "run") && r.passed != null)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .slice(-20)
    .map((r) => ({ passed: r.passed || 0, failed: r.failed || 0, total: r.total || 0, date: r.startedAt }));

  // ── Recent runs — ALL statuses so failures/aborts are visible ───────────
  const recentRuns = runs
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 8)
    .map((r) => {
      const p = db.projects[r.projectId];
      return { id: r.id, projectId: r.projectId, projectName: p?.name || null, type: r.type, status: r.status, startedAt: r.startedAt, passed: r.passed, failed: r.failed, total: r.total };
    });

  // ── Run status distribution ─────────────────────────────────────────────
  const runsByStatus = { completed: 0, failed: 0, aborted: 0, running: 0 };
  for (const r of runs) { if (r.status in runsByStatus) runsByStatus[r.status]++; }

  // ── Test review pipeline ────────────────────────────────────────────────
  const testsByReview = { draft: 0, approved: 0, rejected: 0 };
  for (const t of tests) { const s = t.reviewStatus || "draft"; if (s in testsByReview) testsByReview[s]++; }

  // ── Tests created / generated (today & this week) ───────────────────────
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
  let testsCreatedToday = 0, testsCreatedThisWeek = 0, testsGeneratedTotal = 0;
  for (const a of activities) {
    if (a.type !== "test.create" && a.type !== "test.generate") continue;
    testsGeneratedTotal++;
    if (a.createdAt >= todayStart) testsCreatedToday++;
    if (a.createdAt >= weekStart) testsCreatedThisWeek++;
  }

  // ── Tests auto-fixed (feedback loop + self-healing) ─────────────────────
  let testsAutoFixed = 0;
  for (const r of runs) { if (r.feedbackLoop?.improved) testsAutoFixed += r.feedbackLoop.improved; }
  const healingEntries = Object.keys(db.healingHistory || {}).length;
  const healingSuccesses = Object.values(db.healingHistory || {}).filter((h) => h.strategyIndex >= 0 && h.succeededAt).length;

  // ── Average run duration (completed test runs) ──────────────────────────
  const durations = completedTestRuns.filter((r) => r.duration > 0).map((r) => r.duration);
  const avgRunDurationMs = durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null;

  // ── Defect / failure category breakdown (across all test run results) ───
  const defectBreakdown = { SELECTOR_ISSUE: 0, NAVIGATION_FAIL: 0, TIMEOUT: 0, ASSERTION_FAIL: 0, UNKNOWN: 0 };
  const testResultStatuses = {};   // testId → Set<"passed"|"failed">
  const testRunResults = runs.filter((r) => (r.type === "test_run" || r.type === "run") && r.results?.length);
  for (const r of testRunResults) {
    for (const result of r.results) {
      // Accumulate per-test statuses for flaky detection
      if (!testResultStatuses[result.testId]) testResultStatuses[result.testId] = new Set();
      if (result.status) testResultStatuses[result.testId].add(result.status);
      // Classify failures
      if (result.status === "failed" && result.error) {
        const cat = classifyFailure(result.error);
        if (cat in defectBreakdown) defectBreakdown[cat]++;
        else defectBreakdown.UNKNOWN++;
      }
    }
  }

  // ── Flaky test count (tests with both "passed" and "failed" across runs) ─
  let flakyTestCount = 0;
  for (const statuses of Object.values(testResultStatuses)) {
    if (statuses.has("passed") && statuses.has("failed")) flakyTestCount++;
  }

  // ── Test growth — cumulative test count per week (last 8 weeks) ─────────
  // Buckets are ISO-week start dates; each entry = { week, count }.
  const GROWTH_WEEKS = 8;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const growthStart = new Date(now.getTime() - GROWTH_WEEKS * weekMs);
  const weekBuckets = {};
  // Seed empty buckets so the chart always has 8 data points
  for (let i = 0; i < GROWTH_WEEKS; i++) {
    const d = new Date(growthStart.getTime() + i * weekMs);
    const key = d.toISOString().slice(0, 10);
    weekBuckets[key] = 0;
  }
  for (const a of activities) {
    if (a.type !== "test.create" && a.type !== "test.generate") continue;
    if (a.createdAt < growthStart.toISOString()) continue;
    // Find which bucket this activity falls into
    const aTime = new Date(a.createdAt).getTime();
    for (let i = GROWTH_WEEKS - 1; i >= 0; i--) {
      const bucketStart = growthStart.getTime() + i * weekMs;
      if (aTime >= bucketStart) {
        const key = new Date(bucketStart).toISOString().slice(0, 10);
        weekBuckets[key] = (weekBuckets[key] || 0) + 1;
        break;
      }
    }
  }
  // Convert to cumulative array
  const testGrowth = [];
  let cumulative = tests.length;
  // Subtract recent additions to find the starting point
  const sortedKeys = Object.keys(weekBuckets).sort();
  const totalRecent = sortedKeys.reduce((s, k) => s + weekBuckets[k], 0);
  cumulative = Math.max(0, tests.length - totalRecent);
  for (const key of sortedKeys) {
    cumulative += weekBuckets[key];
    testGrowth.push({ week: key, count: cumulative });
  }

  // ── MTTR — mean time to recovery (failed → passed) ─────────────────────
  // For each test, walk chronological runs and find failed→passed transitions.
  // MTTR = average of (recovery_run.startedAt − failure_run.startedAt).
  const chronologicalRuns = runs
    .filter((r) => (r.type === "test_run" || r.type === "run") && r.results?.length && r.startedAt)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const lastFailTime = {};  // testId → ISO timestamp of most recent failure
  const recoveryDeltas = [];
  for (const r of chronologicalRuns) {
    for (const result of r.results) {
      if (result.status === "failed") {
        lastFailTime[result.testId] = r.startedAt;
      } else if (result.status === "passed" && lastFailTime[result.testId]) {
        const delta = new Date(r.startedAt) - new Date(lastFailTime[result.testId]);
        if (delta > 0) recoveryDeltas.push(delta);
        delete lastFailTime[result.testId];
      }
    }
  }
  const mttrMs = recoveryDeltas.length
    ? Math.round(recoveryDeltas.reduce((s, d) => s + d, 0) / recoveryDeltas.length)
    : null;

  res.json({
    totalProjects: projects.length,
    totalTests: tests.length,
    totalRuns: runs.length,
    passRate,
    history,
    recentRuns,
    runsByStatus,
    testsByReview,
    testsCreatedToday,
    testsCreatedThisWeek,
    testsGeneratedTotal,
    testsAutoFixed,
    healingEntries,
    healingSuccesses,
    avgRunDurationMs,
    defectBreakdown,
    flakyTestCount,
    testGrowth,
    mttrMs,
  });
});

// ── Config & Settings ─────────────────────────────────────────────────────────

// GET /api/config — provider info for the LLM badge shown everywhere
app.get("/api/config", (req, res) => {
  const meta = getProviderMeta();
  res.json({
    provider: meta?.provider || null,
    providerName: meta?.name || "No provider configured",
    model: meta?.model || null,
    color: meta?.color || null,
    hasProvider: hasProvider(),
    supportedProviders: [
      { id: "anthropic", name: "Claude Sonnet",    model: "claude-sonnet-4-20250514", docsUrl: "https://console.anthropic.com/settings/keys" },
      { id: "openai",    name: "GPT-4o-mini",      model: "gpt-4o-mini",              docsUrl: "https://platform.openai.com/api-keys" },
      { id: "google",    name: "Gemini 2.5 Flash", model: "gemini-2.5-flash",         docsUrl: "https://aistudio.google.com/apikey" },
      { id: "local",     name: "Ollama (local)",   model: "llama3.2",                 docsUrl: "https://ollama.ai" },
    ],
  });
});

// GET /api/settings — returns masked key status (never full keys)
app.get("/api/settings", (req, res) => {
  res.json(getConfiguredKeys());
});

// POST /api/settings — save API key at runtime (no server restart needed)
// For the "local" (Ollama) provider, apiKey is not required;
// instead accepts { baseUrl?, model? } for Ollama configuration.
app.post("/api/settings", (req, res) => {
  const { provider, apiKey, baseUrl, model } = req.body;
  const validProviders = ["anthropic", "openai", "google", "local"];

  if (!provider || !validProviders.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${validProviders.join(", ")}` });
  }

  if (provider === "local") {
    // Validate Ollama base URL if provided.
    // Unlike /api/test-connection, we allow localhost and LAN IPs (where Ollama
    // legitimately runs), but block cloud metadata and link-local addresses.
    if (baseUrl && baseUrl.trim()) {
      let parsedUrl;
      try { parsedUrl = new URL(baseUrl.trim()); } catch {
        return res.status(400).json({ error: "Invalid Ollama base URL format" });
      }
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: "Ollama base URL must use http or https protocol" });
      }
      const host = parsedUrl.hostname.replace(/^\[|\]$/g, "");
      const ollamaBlocked =
        host === "169.254.169.254" ||
        host === "metadata.google.internal" ||
        /^fe80:/i.test(host);                                // link-local IPv6
      if (ollamaBlocked) {
        return res.status(400).json({ error: "Ollama base URL must not point to cloud metadata or link-local addresses" });
      }
    }
    // Ollama — no API key needed, just update base URL / model if provided
    // Clear the disabled flag so Ollama becomes active again after deactivation
    // Trim values so whitespace-only strings don't bypass validation and cause
    // malformed fetch URLs (e.g. "   /api/generate").
    setRuntimeOllama({ baseUrl: (baseUrl || "").trim(), model: (model || "").trim(), disabled: false });
    logActivity({ type: "settings.update", detail: "Ollama (local) provider configured" });
    return res.json({
      ok: true,
      provider: "local",
      providerName: getProviderMeta()?.name || "Ollama (local)",
      message: "Local Ollama provider activated. Ensure Ollama is running.",
    });
  }

  if (!apiKey || apiKey.trim().length < 10) {
    return res.status(400).json({ error: "apiKey is required and must be at least 10 characters" });
  }

  setRuntimeKey(provider, apiKey.trim());

  logActivity({
    type: "settings.update",
    detail: `API key configured for ${getProviderMeta()?.name || provider}`,
  });

  res.json({
    ok: true,
    provider,
    providerName: getProviderMeta()?.name || provider,
    message: `${provider} API key saved. Provider is now active.`,
  });
});

// DELETE /api/settings/:provider — remove a key or deactivate local provider
app.delete("/api/settings/:provider", (req, res) => {
  const { provider } = req.params;

  if (provider === "local") {
    setRuntimeOllama({ baseUrl: "", model: "", disabled: true });
  } else {
    setRuntimeKey(provider, "");
  }

  logActivity({
    type: "settings.update",
    detail: `Provider "${provider}" deactivated`,
  });

  res.json({ ok: true });
});

// ─── Activities ───────────────────────────────────────────────────────────────
// GET /api/activities — returns all activities sorted newest-first.
// Optional query params: ?type=generate&projectId=xxx&limit=100
app.get("/api/activities", (req, res) => {
  let activities = Object.values(db.activities)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (req.query.type) {
    activities = activities.filter(a => a.type === req.query.type);
  }
  if (req.query.projectId) {
    activities = activities.filter(a => a.projectId === req.query.projectId);
  }

  const limit = parseInt(req.query.limit, 10) || 200;
  res.json(activities.slice(0, limit));
});

// GET /api/ollama/status — check Ollama connectivity + list available models
// Used by the Settings UI to give real-time feedback on the local provider.
app.get("/api/ollama/status", async (req, res) => {
  const status = await checkOllamaConnection();
  // Always return 200 so the frontend can read the structured { ok, error, availableModels }
  // body. Returning 503 causes api.js to throw before the component can parse the JSON.
  res.json(status);
});

// ── URL reachability test ──────────────────────────────────────────────────────
// POST /api/test-connection — verify that a URL is reachable before creating a project
app.post("/api/test-connection", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "URL must use http or https protocol" });
  }
  // SSRF protection: block loopback, link-local, and private IP ranges
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Resolve IPv4-mapped IPv6 addresses (e.g. ::ffff:a00:1 or ::ffff:127.0.0.1)
  // Node's URL parser converts ::ffff:10.0.0.1 → ::ffff:a00:1 (hex), which would
  // bypass naive regex checks against dotted-decimal private ranges.
  function extractMappedIPv4(host) {
    // Dotted form: ::ffff:10.0.0.1
    const dottedMatch = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (dottedMatch) return dottedMatch[1];
    // Hex form: ::ffff:AABB:CCDD → A.B.C.D
    const hexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
  }

  // Check an IPv4 address (dotted-decimal) against private/reserved ranges
  function isPrivateIPv4(ip) {
    return (
      /^127\.\d+\.\d+\.\d+$/.test(ip) ||                // 127.0.0.0/8
      /^10\.\d+\.\d+\.\d+$/.test(ip) ||                  // 10.0.0.0/8
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip) ||  // 172.16.0.0/12
      /^192\.168\.\d+\.\d+$/.test(ip) ||                  // 192.168.0.0/16
      ip === "0.0.0.0" ||
      ip === "169.254.169.254"                             // AWS metadata
    );
  }

  const mappedIPv4 = extractMappedIPv4(hostname);
  const blocked =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIPv4(hostname) ||
    (mappedIPv4 && isPrivateIPv4(mappedIPv4)) ||            // IPv4-mapped IPv6 bypass
    hostname === "0.0.0.0" ||
    hostname === "::" ||                                     // IPv6 unspecified (equivalent to 0.0.0.0)
    hostname === "::1" ||
    (/^::ffff:/i.test(hostname) && mappedIPv4 === null) ||   // unknown ::ffff: form — block
    hostname === "169.254.169.254" ||                        // AWS metadata
    hostname === "metadata.google.internal" ||               // GCE metadata
    hostname.endsWith(".internal") ||                        // GCE internal DNS
    /^fe80:/i.test(hostname) ||                              // link-local IPv6
    /^fd[0-9a-f]{2}:/i.test(hostname) ||                    // unique-local IPv6
    /^fc[0-9a-f]{2}:/i.test(hostname);                      // unique-local IPv6
  if (blocked) {
    return res.status(400).json({ error: "URL must not point to localhost, private, or internal addresses" });
  }
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10000) });
    res.json({ ok: true, status: response.status });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ── System Info ───────────────────────────────────────────────────────────────
// GET /api/system — lightweight stats for the Settings "About" section
app.get("/api/system", async (req, res) => {
  let playwrightVersion = null;
  try {
    const pwPkg = await import("playwright/package.json", { with: { type: "json" } }).catch(() => null);
    playwrightVersion = pwPkg?.default?.version || null;
  } catch { /* ignore */ }

  // If the dynamic import didn't work, try reading package.json directly
  if (!playwrightVersion) {
    try {
      const { createRequire } = await import("module");
      const require = createRequire(import.meta.url);
      const pwPkg = require("playwright/package.json");
      playwrightVersion = pwPkg.version;
    } catch { /* ignore */ }
  }

  const projects = Object.values(db.projects);
  const tests    = Object.values(db.tests);
  const runs     = Object.values(db.runs);
  const activities = Object.values(db.activities);
  const healingEntries = Object.keys(db.healingHistory || {}).length;

  res.json({
    projects:     projects.length,
    tests:        tests.length,
    runs:         runs.length,
    activities:   activities.length,
    healingEntries,
    approvedTests: tests.filter(t => t.reviewStatus === "approved").length,
    draftTests:    tests.filter(t => t.reviewStatus === "draft").length,
    uptime:        Math.floor(process.uptime()),
    nodeVersion:   process.version,
    playwrightVersion,
    memoryMB:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

// ── Data Management ───────────────────────────────────────────────────────────
// DELETE /api/data/runs — clear all runs (keeps projects & tests)
app.delete("/api/data/runs", (req, res) => {
  const count = Object.keys(db.runs).length;
  for (const key of Object.keys(db.runs)) delete db.runs[key];
  logActivity({ type: "settings.update", detail: `Cleared ${count} run(s)` });
  res.json({ ok: true, cleared: count });
});

// DELETE /api/data/activities — clear activity log
app.delete("/api/data/activities", (req, res) => {
  const count = Object.keys(db.activities).length;
  for (const key of Object.keys(db.activities)) delete db.activities[key];
  // Don't log this one — we just cleared the log
  res.json({ ok: true, cleared: count });
});

// DELETE /api/data/healing — clear self-healing history
app.delete("/api/data/healing", (req, res) => {
  const count = Object.keys(db.healingHistory || {}).length;
  if (db.healingHistory) {
    for (const key of Object.keys(db.healingHistory)) delete db.healingHistory[key];
  }
  logActivity({ type: "settings.update", detail: `Cleared ${count} healing history entries` });
  res.json({ ok: true, cleared: count });
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
