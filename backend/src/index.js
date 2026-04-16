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
import { getDatabase, closeDatabase } from "./database/sqlite.js";
import { migrateFromJsonIfNeeded } from "./database/migrate.js";
import * as runRepo from "./database/repositories/runRepo.js";
import { formatLogLine, structuredLog } from "./utils/logFormatter.js";
import { loadKeysFromDatabase } from "./aiProvider.js";
import { initScheduler, stopAllTasks } from "./scheduler.js";

// ─── App + global middleware ──────────────────────────────────────────────────
import { app } from "./middleware/appSetup.js";

// ─── Route modules ────────────────────────────────────────────────────────────
import projectsRouter from "./routes/projects.js";
import testsRouter from "./routes/tests.js";
import runsRouter from "./routes/runs.js";
import triggerRouter from "./routes/trigger.js";
import sseRouter from "./routes/sse.js";
import dashboardRouter from "./routes/dashboard.js";
import settingsRouter from "./routes/settings.js";
import systemRouter from "./routes/system.js";
import authRouter from "./routes/auth.js";
import { requireAuth } from "./routes/auth.js";
import chatRouter from "./routes/chat.js";
import testFixRouter from "./routes/testFix.js";
import recycleBinRouter from "./routes/recycleBin.js";

// Re-export SSE symbols so existing imports from "./index.js" keep working
// during incremental migration (runLogger.js, crawler.js, testRunner.js).
export { emitRunEvent, runListeners } from "./routes/sse.js";
export { runAbortControllers } from "./utils/runWithAbort.js";

import { runAbortControllers } from "./utils/runWithAbort.js";

dotenv.config();

// ─── Process-level crash guards ───────────────────────────────────────────────
// Prevent the server from dying on unhandled errors.
// Playwright can throw unhandled rejections from browser internals, page event
// handlers, or video flush operations — especially when assertions fail mid-test.
process.on("uncaughtException", (err) => {
  // Use formatLogLine for consistent output — but wrapped in try/catch since
  // the formatter itself could theoretically fail during a fatal error.
  try { console.error(formatLogLine("error", null, `[FATAL] Uncaught exception (server kept alive): ${err?.stack || err?.message || err}`)); }
  catch { console.error("[FATAL] Uncaught exception (server kept alive):", err); }
});
process.on("unhandledRejection", (reason) => {
  try { console.error(formatLogLine("error", null, `[FATAL] Unhandled rejection (server kept alive): ${reason?.stack || reason?.message || reason}`)); }
  catch { console.error("[FATAL] Unhandled rejection (server kept alive):", reason); }
});

// ─── DB init ──────────────────────────────────────────────────────────────────
// 1. Open SQLite and apply schema
getDatabase();
// 2. Migrate legacy sentri-db.json → SQLite (one-time, skips if already done)
migrateFromJsonIfNeeded();
// 3. Restore persisted AI provider keys from the database into the runtime cache.
//    Must run after DB init but before the first AI call.
loadKeysFromDatabase();
// 4. Orphan recovery — mark any "running" runs from a previous crash as interrupted
const orphanCount = runRepo.markOrphansInterrupted();
if (orphanCount > 0) {
  console.warn(formatLogLine("warn", null, `[db] Marked ${orphanCount} orphaned run(s) as interrupted`));
}
// 5. Initialise cron-based test scheduler (ENH-006)
//    Must run after DB init so scheduleRepo can read the schedules table.
initScheduler();

// ─── Graceful shutdown (MAINT-013) ────────────────────────────────────────────
// Instead of killing the process immediately, drain in-flight runs so they
// persist their results and Playwright browsers are cleaned up properly.
const SHUTDOWN_DRAIN_MS = parseInt(process.env.SHUTDOWN_DRAIN_MS, 10) || 10_000;
const DRAIN_POLL_MS = 250;
let _server = null; // populated when app.listen() returns
let _shuttingDown = false;

async function gracefulShutdown(signal) {
  if (_shuttingDown) return; // prevent double-fire from SIGINT+SIGTERM
  _shuttingDown = true;
  console.log(formatLogLine("info", null, `[shutdown] ${signal} received — starting graceful shutdown (drain ${SHUTDOWN_DRAIN_MS}ms)`));

  // 1. Stop accepting new connections
  if (_server) {
    _server.close(() => {
      console.log(formatLogLine("info", null, "[shutdown] HTTP server closed — no new connections"));
    });
  }

  // 2. Stop all cron tasks so no new runs are scheduled
  stopAllTasks();
  console.log(formatLogLine("info", null, "[shutdown] Scheduler tasks stopped"));

  // 3. Wait for in-flight runs to finish (up to SHUTDOWN_DRAIN_MS)
  const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
  while (runAbortControllers.size > 0 && Date.now() < deadline) {
    console.log(formatLogLine("info", null, `[shutdown] Draining ${runAbortControllers.size} in-flight run(s)…`));
    await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_MS));
  }

  // 4. Force-abort any stragglers and mark them interrupted
  if (runAbortControllers.size > 0) {
    console.warn(formatLogLine("warn", null, `[shutdown] Force-aborting ${runAbortControllers.size} straggler run(s)`));
    for (const [runId, entry] of runAbortControllers) {
      try {
        entry.controller.abort();
        // Mark the run as interrupted in the database so it isn't left
        // in "running" state (the normal abort flow may not complete in time).
        runRepo.update(runId, {
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          error: "Server shutdown while run was in progress",
        });
      } catch (err) {
        console.warn(formatLogLine("warn", null, `[shutdown] Error aborting run ${runId}: ${err.message}`));
      }
    }
    runAbortControllers.clear();
  }

  // 5. Close SQLite cleanly (WAL checkpoint)
  closeDatabase();
  console.log(formatLogLine("info", null, "[shutdown] Graceful shutdown complete"));
  process.exit(0);
}

process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// NOTE: The _seed/runs endpoint has been removed from this file.
// If you need it for integration tests, mount it in your test setup file
// directly on a test-only Express instance — never in this production entry point.

// ─── Mount route modules ──────────────────────────────────────────────────────
// Auth routes are public (login, register, OAuth callbacks)
app.use("/api/auth", authRouter);

// CI/CD trigger endpoint (/api/projects/:id/trigger) uses its own token-based
// auth — it must be mounted WITHOUT requireAuth so CI pipelines can call it
// with a project token rather than a user JWT.
app.use("/api", triggerRouter);

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
app.use("/api", requireAuth, recycleBinRouter);

// ─── Health probes (root-level, not under /api, no auth required) ────────────
// GET /health  — liveness: is the process alive?
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    version: process.env.npm_package_version || "unknown",
  });
});

// GET /health/ready — readiness: can the process serve traffic?
// Returns 503 if any critical subsystem is unhealthy so load balancers
// can stop routing requests to this instance rather than returning errors.
app.get("/health/ready", async (_req, res) => {
  const checks = {};
  let allOk = true;

  // 1. SQLite ping
  try {
    const { getDatabase } = await import("./database/sqlite.js").catch(() => ({}));
    if (getDatabase) {
      getDatabase().prepare("SELECT 1").get();
      checks.database = { ok: true };
    } else {
      checks.database = { ok: false, error: "db module unavailable" };
      allOk = false;
    }
  } catch (err) {
    checks.database = { ok: false, error: err.message };
    allOk = false;
  }

  // 2. Memory guard — flag if heap is over 90% of the V8 heap limit.
  //    We use v8.getHeapStatistics().heap_size_limit (the actual max the heap
  //    can grow to) instead of process.memoryUsage().heapTotal (the currently
  //    allocated heap, which V8 resizes dynamically). Using heapTotal would
  //    give a misleadingly high ratio after GC cycles and cause false 503s.
  try {
    const v8 = await import("v8");
    const heapStats = v8.getHeapStatistics();
    const heapUsed = heapStats.used_heap_size;
    const heapLimit = heapStats.heap_size_limit;
    const heapMb = Math.round(heapUsed / 1024 / 1024);
    const limitMb = Math.round(heapLimit / 1024 / 1024);
    const pct = Math.round((heapUsed / heapLimit) * 100);
    checks.memory = { ok: pct < 90, heapMb, limitMb, pct };
    if (pct >= 90) allOk = false;
  } catch (err) {
    checks.memory = { ok: true }; // non-fatal if unavailable
  }

  // 3. Artifacts directory writable
  try {
    const { ARTIFACTS_DIR } = await import("./middleware/appSetup.js").catch(() => ({}));
    if (ARTIFACTS_DIR) {
      const fs = await import("fs");
      fs.accessSync(ARTIFACTS_DIR, fs.constants.W_OK);
      checks.artifacts = { ok: true };
    }
  } catch (err) {
    checks.artifacts = { ok: false, error: err.message };
    allOk = false;
  }

  res.status(allOk ? 200 : 503).json({ ok: allOk, checks });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
_server = app.listen(PORT, () => {
  console.log(formatLogLine("info", null, `🐻 Sentri API running on port ${PORT}`));
  structuredLog("server.start", { port: PORT });
});
