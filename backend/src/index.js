import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import { crawlAndGenerateTests, generateSingleTest } from "./crawler.js";
import { runTests } from "./testRunner.js";
import { getDb } from "./db.js";
import { getProviderName, hasProvider, setRuntimeKey, getProviderMeta, getConfiguredKeys, getOllamaConfig } from "./aiProvider.js";

dotenv.config();

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

// ─── Seed helper (dev / testing only) ────────────────────────────────────
// Allows seed.js to inject pre-built run objects directly into the in-memory DB
// without going through the real crawl/run flow. Disabled in production.
if (process.env.NODE_ENV !== "production") {
  app.patch("/api/_seed/runs/:id", (req, res) => {
    db.runs[req.params.id] = { ...req.body, id: req.params.id };
    res.json({ ok: true, id: req.params.id });
  });
}

// ─── Activity Logger ──────────────────────────────────────────────────────────
// Records user/system actions so the Work page shows a complete timeline.
//
// Standard naming convention — dot-separated: <resource>.<action>
//   project.create
//   crawl.start          crawl.complete        crawl.fail
//   test_run.start       test_run.complete     test_run.fail
//   test.create          test.generate         test.regenerate
//   test.edit            test.delete
//   test.approve         test.reject           test.restore
//   test.bulk_approve    test.bulk_reject      test.bulk_restore
//   settings.update
function logActivity({ type, projectId, projectName, testId, testName, detail, status }) {
  const id = uuidv4();
  db.activities[id] = {
    id,
    type,
    projectId: projectId || null,
    projectName: projectName || null,
    testId: testId || null,
    testName: testName || null,
    detail: detail || null,
    status: status || "completed",
    createdAt: new Date().toISOString(),
  };
  return db.activities[id];
}

// ─── Projects ────────────────────────────────────────────────────────────────

app.post("/api/projects", (req, res) => {
  const { name, url, credentials } = req.body;
  if (!name || !url) return res.status(400).json({ error: "name and url required" });

  const id = uuidv4();
  const project = {
    id,
    name,
    url,
    credentials: credentials || null,
    createdAt: new Date().toISOString(),
    status: "idle",
  };
  db.projects[id] = project;

  logActivity({
    type: "project.create", projectId: id, projectName: name,
    detail: `Project created — "${name}" (${url})`,
  });

  res.json(project);
});

app.get("/api/projects", (req, res) => {
  res.json(Object.values(db.projects));
});

app.get("/api/projects/:id", (req, res) => {
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(project);
});

// ─── Crawl & Generate Tests ───────────────────────────────────────────────────

app.post("/api/projects/:id/crawl", async (req, res) => {
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });

  const runId = uuidv4();
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

  // Kick off async - stream updates via polling
  crawlAndGenerateTests(project, run, db)
    .then(() => {
      logActivity({
        type: "crawl.complete", projectId: project.id, projectName: project.name,
        detail: `Crawl completed — ${run.pagesFound || 0} pages found`,
      });
    })
    .catch((err) => {
      run.status = "failed";
      run.error = err.message;
      run.finishedAt = new Date().toISOString();
      logActivity({
        type: "crawl.fail", projectId: project.id, projectName: project.name,
        detail: `Crawl failed: ${err.message}`, status: "failed",
      });
    });

  res.json({ runId });
});

// ─── Run Tests ────────────────────────────────────────────────────────────────

app.post("/api/projects/:id/run", async (req, res) => {
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });

  const allTests = Object.values(db.tests).filter((t) => t.projectId === project.id);
  // Only run approved tests — draft/rejected tests must not enter regression
  const tests = allTests.filter((t) => t.reviewStatus === "approved");
  if (!allTests.length) return res.status(400).json({ error: "no tests found, crawl first" });
  if (!tests.length) return res.status(400).json({ error: "no approved tests — review generated tests and approve them before running regression" });

  const runId = uuidv4();
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

  runTests(project, tests, run, db)
    .then(() => {
      logActivity({
        type: "test_run.complete", projectId: project.id, projectName: project.name,
        detail: `Test run completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
      });
    })
    .catch((err) => {
      run.status = "failed";
      run.error = err.message;
      run.finishedAt = new Date().toISOString();
      logActivity({
        type: "test_run.fail", projectId: project.id, projectName: project.name,
        detail: `Test run failed: ${err.message}`, status: "failed",
      });
    });

  res.json({ runId });
});

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
  if (typeof playwrightCode === "string") test.playwrightCode = playwrightCode;

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

  const testId = uuidv4();
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
// Runs synchronously and returns the first created test object directly so the
// frontend CreateTestModal can display steps and transition to the review phase.
app.post("/api/projects/:id/tests/generate", async (req, res) => {
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "project not found" });

  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });

  if (!hasProvider()) {
    return res.status(503).json({
      error: "No AI provider configured. Add an API key in Settings to use AI test generation.",
    });
  }

  const runId = uuidv4();
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
    generateInput: { name: name.trim(), description: (description || "").trim() },
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
  generateSingleTest(project, run, db, {
    name: name.trim(),
    description: (description || "").trim(),
  }).then(createdTestIds => {
    logActivity({
      type: "test.generate", projectId: project.id, projectName: project.name,
      detail: `Test generation completed — ${createdTestIds.length} test(s) created for "${name.trim()}"`,
    });
  }).catch(err => {
    run.status = "failed";
    run.error = err.message;
    run.finishedAt = new Date().toISOString();
    logActivity({
      type: "test.generate", projectId: project.id, projectName: project.name,
      detail: `Test generation failed for "${name.trim()}" — ${err.message}`,
      status: "failed",
    });
  });
});

// ── Run a single test by ID ───────────────────────────────────────────────────
app.post("/api/tests/:testId/run", async (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test) return res.status(404).json({ error: "test not found" });

  const project = db.projects[test.projectId];
  if (!project) return res.status(404).json({ error: "project not found" });

  const runId = uuidv4();
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

  runTests(project, [test], run, db)
    .then(() => {
      logActivity({
        type: "test_run.complete", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Single test completed — ${run.passed || 0} passed, ${run.failed || 0} failed`,
      });
    })
    .catch((err) => {
      run.status = "failed";
      run.error = err.message;
      run.finishedAt = new Date().toISOString();
      logActivity({
        type: "test_run.fail", projectId: project.id, projectName: project.name,
        testId: test.id, testName: test.name,
        detail: `Single test failed: ${err.message}`, status: "failed",
      });
    });

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

// ─── Dashboard summary ────────────────────────────────────────────────────────

app.get("/api/dashboard", (req, res) => {
  const projects = Object.values(db.projects);
  const runs = Object.values(db.runs);
  const tests = Object.values(db.tests);

  const lastRuns = runs
    .filter((r) => r.type === "test_run" && r.status === "completed")
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 10);

  const passRate =
    lastRuns.length
      ? Math.round(
          (lastRuns.reduce((s, r) => s + (r.passed || 0), 0) /
            lastRuns.reduce((s, r) => s + (r.total || 1), 0)) *
            100
        )
      : null;

  res.json({
    totalProjects: projects.length,
    totalTests: tests.length,
    totalRuns: runs.length,
    passRate,
    recentRuns: lastRuns.slice(0, 5),
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
      { id: "ollama",    name: "Ollama (Local)",   model: getOllamaConfig().model,     docsUrl: "https://ollama.com" },
    ],
  });
});

// GET /api/settings — returns masked key status (never full keys)
app.get("/api/settings", (req, res) => {
  res.json(getConfiguredKeys());
});

// POST /api/settings — save API key at runtime (no server restart needed)
app.post("/api/settings", (req, res) => {
  const { provider, apiKey } = req.body;
  const validProviders = ["anthropic", "openai", "google", "ollama"];

  if (!provider || !validProviders.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${validProviders.join(", ")}` });
  }
  // Ollama doesn't need a traditional API key — it sends a JSON config or "enabled"
  if (provider !== "ollama" && (!apiKey || apiKey.trim().length < 10)) {
    return res.status(400).json({ error: "apiKey is required and must be at least 10 characters" });
  }

  setRuntimeKey(provider, apiKey?.trim() || "");

  logActivity({
    type: "settings.update",
    detail: `API key configured for ${getProviderMeta()?.name || provider}`,
  });

  res.json({
    ok: true,
    provider,
    providerName: getProviderMeta()?.name || provider,
    message: `${provider} ${provider === "ollama" ? "configured" : "API key saved"}. Provider is now active.`,
  });
});

// DELETE /api/settings/:provider — remove a key
app.delete("/api/settings/:provider", (req, res) => {
  const { provider } = req.params;
  setRuntimeKey(provider, "");

  logActivity({
    type: "settings.update",
    detail: `API key removed for provider "${provider}"`,
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
  if (["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "169.254.169.254"].includes(parsed.hostname)) {
    return res.status(400).json({ error: "URL must not point to localhost or internal addresses" });
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
  if (!testIds || !Array.isArray(testIds) || !["approve", "reject", "restore"].includes(action))
    return res.status(400).json({ error: "testIds[] and valid action required" });
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
