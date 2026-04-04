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

// ─── Test routes ──────────────────────────────────────────────────────────────
import testsRouter from "./routes/tests.js";
app.use("/api", testsRouter);

// (All test routes are now in routes/tests.js)

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🐻 Sentri API running on port ${PORT}`));

