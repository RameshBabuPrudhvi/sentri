/**
 * @module index
 * @description Server entry point. Initialises the database, mounts all route
 * modules on the Express app, and starts listening.
 *
 * ### Mounted routes
 * | Prefix             | Module              |
 * |--------------------|---------------------|
 * | `/api/projects`    | `routes/projects`   |
 * | `/api` (tests)     | `routes/tests`      |
 * | `/api` (runs)      | `routes/runs`       |
 * | `/api` (SSE)       | `routes/sse`        |
 * | `/api` (dashboard) | `routes/dashboard`  |
 * | `/api` (settings)  | `routes/settings`   |
 * | `/api` (system)    | `routes/system`     |
 * | `/api/auth`        | `routes/auth`       |
 * | `/health`          | Health check        |
 */

import dotenv from "dotenv";
import { initCountersFromExistingData } from "./utils/idGenerator.js";
import { getDb } from "./db.js";

// ─── App + global middleware ──────────────────────────────────────────────────
import { app } from "./middleware/appSetup.js";

// ─── Route modules ────────────────────────────────────────────────────────────
import projectsRouter from "./routes/projects.js";
import testsRouter from "./routes/tests.js";
import runsRouter from "./routes/runs.js";
import sseRouter from "./routes/sse.js";
import dashboardRouter from "./routes/dashboard.js";
import settingsRouter from "./routes/settings.js";
import systemRouter from "./routes/system.js";
import authRouter from "./routes/auth.js";

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

// ─── DB init ──────────────────────────────────────────────────────────────────
const db = getDb();
initCountersFromExistingData(db);

// ─── Seed helper (dev / testing only) ─────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.patch("/api/_seed/runs/:id", (req, res) => {
    db.runs[req.params.id] = { ...req.body, id: req.params.id };
    res.json({ ok: true, id: req.params.id });
  });
}

// ─── Mount route modules ──────────────────────────────────────────────────────
app.use("/api/projects", projectsRouter);
app.use("/api", testsRouter);
app.use("/api", runsRouter);
app.use("/api", sseRouter);
app.use("/api", dashboardRouter);
app.use("/api", settingsRouter);
app.use("/api", systemRouter);
app.use("/api/auth", authRouter);

// Health check (root-level, not under /api)
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🐻 Sentri API running on port ${PORT}`));
