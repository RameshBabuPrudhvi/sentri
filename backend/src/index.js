import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import { crawlAndGenerateTests } from "./crawler.js";
import { runTests, runEvents, ARTIFACTS_DIR } from "./testRunner.js";
import { getDb } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const db = getDb();

// Serve artifacts (videos, screenshots, traces) as static files
app.use("/artifacts", express.static(ARTIFACTS_DIR));

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
    run.logs.push(`[${new Date().toISOString()}] FATAL: ${err.message}`);
  });

  res.json({ runId });
});

// ─── Run Tests ────────────────────────────────────────────────────────────────

app.post("/api/projects/:id/run", async (req, res) => {
  const project = db.projects[req.params.id];
  if (!project) return res.status(404).json({ error: "not found" });

  const tests = Object.values(db.tests).filter((t) => t.projectId === project.id);
  if (!tests.length) return res.status(400).json({ error: "no tests found, crawl first" });

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
    run.logs.push(`[${new Date().toISOString()}] FATAL: ${err.message}`);
    runEvents.emit(`log:${run.id}`, `[${new Date().toISOString()}] FATAL: ${err.message}`);
    runEvents.emit(`complete:${run.id}`, run);
  });

  res.json({ runId });
});

// ─── SSE: Real-time log streaming ───────────────────────────────────────────────────

app.get("/api/runs/:runId/stream", (req, res) => {
  const run = db.runs[req.params.runId];
  if (!run) return res.status(404).json({ error: "not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send existing logs first
  for (const line of run.logs) {
    res.write(`data: ${JSON.stringify({ type: "log", data: line })}\n\n`);
  }

  // If already completed, send final state and close
  if (run.status !== "running") {
    res.write(`data: ${JSON.stringify({ type: "complete", data: run })}\n\n`);
    res.end();
    return;
  }

  // Listen for new log entries
  const onLog = (entry) => {
    res.write(`data: ${JSON.stringify({ type: "log", data: entry })}\n\n`);
  };

  const onComplete = (completedRun) => {
    res.write(`data: ${JSON.stringify({ type: "complete", data: completedRun })}\n\n`);
    cleanup();
    res.end();
  };

  runEvents.on(`log:${run.id}`, onLog);
  runEvents.on(`complete:${run.id}`, onComplete);

  const cleanup = () => {
    runEvents.off(`log:${run.id}`, onLog);
    runEvents.off(`complete:${run.id}`, onComplete);
  };

  req.on("close", cleanup);
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🛡️ Sentri QA API running on port ${PORT}`));
