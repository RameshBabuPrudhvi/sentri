/**
 * @module worker
 * @description Standalone worker entrypoint for the distributed runner (AUTO-008).
 *
 * The `docker-compose.yml` `worker` service uses the same image as `web` but
 * overrides the command to `node src/worker.js`. This process:
 *
 *   - Boots the database + AI key cache (the BullMQ job handler needs both).
 *   - Starts the BullMQ Worker (`workers/runWorker.js`) that pulls jobs from
 *     the shared `sentri:runs` queue.
 *   - Does NOT bind any HTTP port — workers are queue consumers only, so
 *     scaling `worker` replicas with `--scale worker=N` doesn't fight over
 *     port 3001 the way running the full Express app would.
 *
 * Requires `REDIS_URL` to be set; without Redis the BullMQ Worker is a no-op
 * and the container exits cleanly (so misconfiguration surfaces fast in logs
 * rather than silently running no jobs).
 */
import dotenv from "dotenv";
import http from "http";
import { getDatabase, closeDatabase } from "./database/sqlite.js";
import { migrateFromJsonIfNeeded } from "./database/migrate.js";
import { loadKeysFromDatabase } from "./aiProvider.js";
import { ensureDefaultWorkspaces } from "./database/repositories/workspaceRepo.js";
import { closeQueue } from "./queue.js";
import { startWorker, stopWorker } from "./workers/runWorker.js";
import { closeRedis, isRedisAvailable } from "./utils/redisClient.js";
import { formatLogLine } from "./utils/logFormatter.js";

dotenv.config();

// Same crash guards as `index.js` — Playwright surfaces unhandled rejections
// from browser internals that must not crash a worker mid-shard.
process.on("uncaughtException", (err) => {
  try { console.error(formatLogLine("error", null, `[FATAL] Uncaught exception (worker kept alive): ${err?.stack || err?.message || err}`)); }
  catch { console.error("[FATAL] Uncaught exception (worker kept alive):", err); }
});
process.on("unhandledRejection", (reason) => {
  try { console.error(formatLogLine("error", null, `[FATAL] Unhandled rejection (worker kept alive): ${reason?.stack || reason?.message || reason}`)); }
  catch { console.error("[FATAL] Unhandled rejection (worker kept alive):", reason); }
});

if (!process.env.REDIS_URL) {
  console.error(formatLogLine("error", null,
    "[worker] REDIS_URL is not set — distributed worker requires a shared BullMQ queue. Exiting."));
  process.exit(1);
}

// 1. DB init — repositories used by the job handler need the schema present.
getDatabase();
migrateFromJsonIfNeeded();

// 2. AI keys — feedback loop / regeneration calls happen inside jobs.
loadKeysFromDatabase();

// 3. Workspace backfill — same one-shot as the web entry point.
ensureDefaultWorkspaces();

let _workerReady = false;

// 4. Start the BullMQ Worker.
startWorker();
_workerReady = true;
const healthPort = Number(process.env.WORKER_HEALTH_PORT || 3002);
// Two-endpoint health server:
//   - /livez   → always 200 if the Node process is responsive. Used by
//                the Kubernetes livenessProbe. MUST NOT check external
//                deps (Redis/DB) — restarting the worker doesn't fix a
//                Redis outage, it just creates a restart loop.
//   - /healthz → 200 only when BullMQ worker is ready AND Redis is
//                reachable. Used by the readinessProbe so kubelet stops
//                routing jobs to a worker that can't process them.
const healthServer = http.createServer((req, res) => {
  if (req.url === "/livez") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // /healthz (default for any other path — readiness check)
  if (_workerReady && isRedisAvailable()) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false }));
});
healthServer.listen(healthPort, () => {
  console.log(formatLogLine("info", null, `[worker] health endpoint listening on :${healthPort}`));
});

console.log(formatLogLine("info", null,
  `[worker] Standalone worker process started (REDIS_URL configured, WORKER_CONCURRENCY=${process.env.WORKER_CONCURRENCY || process.env.MAX_WORKERS || 2})`));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(formatLogLine("info", null, `[worker] ${signal} received — draining BullMQ worker`));
  try {
    await stopWorker();
    await closeQueue();
    await closeRedis();
    await new Promise((resolve) => healthServer.close(resolve));
    await closeDatabase();
    process.exit(0);
  } catch (err) {
    console.error(formatLogLine("error", null, `[worker] Shutdown error: ${err?.message || err}`));
    process.exit(1);
  }
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
