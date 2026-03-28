import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import { crawlAndGenerateTests } from "./crawler.js";
import { runTests } from "./testRunner.js";
import { getDb } from "./db.js";
import { getProviderName, hasProvider, setRuntimeKey, getProviderMeta, getConfiguredKeys } from "./aiProvider.js";

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

  // Kick off async - stream updates via polling
  crawlAndGenerateTests(project, run, db).catch((err) => {
    run.status = "failed";
    run.error = err.message;
    run.finishedAt = new Date().toISOString();
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
  };
  db.runs[runId] = run;

  runTests(project, tests, run, db).catch((err) => {
    run.status = "failed";
    run.error = err.message;
    run.finishedAt = new Date().toISOString();
  });

  res.json({ runId });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/tests", (req, res) => {
  const tests = Object.values(db.tests).filter((t) => t.projectId === req.params.id);
  res.json(tests);
});

app.delete("/api/projects/:id/tests/:testId", (req, res) => {
  delete db.tests[req.params.testId];
  res.json({ ok: true });
});

// ─── Runs ─────────────────────────────────────────────────────────────────────

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
      { id: "google",    name: "Gemini 1.5 Flash", model: "gemini-1.5-flash",         docsUrl: "https://aistudio.google.com/apikey" },
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
  const validProviders = ["anthropic", "openai", "google"];

  if (!provider || !validProviders.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${validProviders.join(", ")}` });
  }
  if (!apiKey || apiKey.trim().length < 10) {
    return res.status(400).json({ error: "apiKey is required and must be at least 10 characters" });
  }

  setRuntimeKey(provider, apiKey.trim());

  res.json({
    ok: true,
    provider,
    providerName: getProviderMeta()?.name || provider,
    message: `${provider} API key saved. Provider is now active.`,
  });
});

// DELETE /api/settings/:provider — remove a key
app.delete("/api/settings/:provider", (req, res) => {
  const { provider } = req.params;
  setRuntimeKey(provider, "");
  res.json({ ok: true });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;

// ─── Test Review: Approve / Reject / Restore / Bulk ──────────────────────────

app.patch("/api/projects/:id/tests/:testId/approve", (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "approved";
  test.reviewedAt = new Date().toISOString();
  res.json(test);
});

app.patch("/api/projects/:id/tests/:testId/reject", (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "rejected";
  test.reviewedAt = new Date().toISOString();
  res.json(test);
});

app.patch("/api/projects/:id/tests/:testId/restore", (req, res) => {
  const test = db.tests[req.params.testId];
  if (!test || test.projectId !== req.params.id)
    return res.status(404).json({ error: "not found" });
  test.reviewStatus = "draft";
  test.reviewedAt = null;
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
  res.json({ updated: updated.length, tests: updated });
});

app.listen(PORT, () => console.log(`🐻 Sentri API running on port ${PORT}`));
