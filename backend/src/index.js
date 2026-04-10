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
 * | `/api` (testFix)   | `routes/testFix`    |
 * | `/api/auth`        | `routes/auth`       |
 * | `/health`          | Health check        |
 */

import dotenv from "dotenv";
import { initCountersFromExistingData } from "./utils/idGenerator.js";
import { getDb } from "./db.js";
import { formatLogLine, structuredLog } from "./utils/logFormatter.js";

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
import { requireAuth } from "./routes/auth.js";
import chatRouter from "./routes/chat.js";
import testFixRouter from "./routes/testFix.js";

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
  // Use formatLogLine for consistent output — but wrapped in try/catch since
  // the formatter itself could theoretically fail during a fatal error.
  try { console.error(formatLogLine("error", null, `[FATAL] Uncaught exception (server kept alive): ${err?.message || err}`)); }
  catch { console.error("[FATAL] Uncaught exception (server kept alive):", err); }
});
process.on("unhandledRejection", (reason) => {
  try { console.error(formatLogLine("error", null, `[FATAL] Unhandled rejection (server kept alive): ${reason?.message || reason}`)); }
  catch { console.error("[FATAL] Unhandled rejection (server kept alive):", reason); }
});

// ─── DB init ──────────────────────────────────────────────────────────────────
const db = getDb();
initCountersFromExistingData(db);

// ─── Seed helper (dev / testing only) ─────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.patch("/api/_seed/runs/:id", requireAuth, (req, res) => {
    db.runs[req.params.id] = { ...req.body, id: req.params.id };
    res.json({ ok: true, id: req.params.id });
  });
}

// ─── Mount route modules ──────────────────────────────────────────────────────
// Auth routes are public (login, register, OAuth callbacks)
app.use("/api/auth", authRouter);


// All other API routes require a valid JWT token
app.use("/api/projects", requireAuth, projectsRouter);
app.use("/api", requireAuth, testsRouter);
app.use("/api", requireAuth, runsRouter);
app.use("/api", requireAuth, sseRouter);
app.use("/api", requireAuth, dashboardRouter);
app.use("/api", requireAuth, settingsRouter);
app.use("/api", requireAuth, systemRouter);
app.use("/api", requireAuth, chatRouter);
app.use("/api", requireAuth, testFixRouter);

// Health check (root-level, not under /api)
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(formatLogLine("info", null, `🐻 Sentri API running on port ${PORT}`));
  structuredLog("server.start", { port: PORT });
});
