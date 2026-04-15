/**
 * @module routes/sse
 * @description SSE (Server-Sent Events) infrastructure for real-time run updates.
 *
 * ### Endpoints
 * | Method | Path                         | Description                 |
 * |--------|------------------------------|-----------------------------|
 * | `GET`  | `/api/runs/:runId/events`    | SSE stream for a single run |
 *
 * ### Exports
 * - {@link emitRunEvent} — Broadcast an event to all listeners on a run.
 * - {@link runListeners} — `Map<runId, Set<res>>` — active SSE connections.
 */

import { Router } from "express";
import * as runRepo from "../database/repositories/runRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as runLogRepo from "../database/repositories/runLogRepo.js";
import { signRunArtifacts, signArtifactUrl } from "../middleware/appSetup.js";

const router = Router();

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
// Auth is handled by the requireAuth middleware (mounted in index.js) which
// accepts both Authorization header and ?token= query param. The query param
// fallback exists because EventSource cannot send custom headers.
router.get("/runs/:runId/events", (req, res) => {
  const { runId } = req.params;
  const run = runRepo.getById(runId);
  if (!run) return res.status(404).json({ error: "not found" });

  // Verify the run's project exists (future: check user ownership here)
  const project = projectRepo.getById(run.projectId);
  if (!project) return res.status(404).json({ error: "project not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  // Send current snapshot immediately so the client has something to render.
  // Logs are hydrated from the run_logs table (ENH-008) rather than the
  // legacy runs.logs JSON column — getById() already does this, but we
  // re-fetch here to ensure we have the latest rows even if the run object
  // was cached before recent appends.
  const signedRun = signRunArtifacts({
    ...run,
    logs: runLogRepo.getMessagesByRunId(run.id),
  });
  res.write(`data: ${JSON.stringify({ type: "snapshot", run: signedRun })}\n\n`);

  // If already done (completed, failed, aborted, interrupted), send snapshot +
  // done event and close immediately. This handles SSE reconnections that
  // arrive after the run finished — including when the connection dropped
  // during the feedback loop (ECONNRESET) and the client reconnects post-completion.
  if (run.status !== "running") {
    // testsGenerated is not a DB column — derive from the persisted tests array
    const testsGenerated = run.testsGenerated ?? (Array.isArray(run.tests) ? run.tests.length : undefined);
    res.write(`data: ${JSON.stringify({
      type: "done",
      status: run.status,
      ...(run.passed != null && { passed: run.passed }),
      ...(run.failed != null && { failed: run.failed }),
      ...(run.total != null && { total: run.total }),
      ...(testsGenerated != null && { testsGenerated }),
    })}\n\n`);
    return res.end();
  }

  if (!runListeners.has(runId)) runListeners.set(runId, new Set());
  runListeners.get(runId).add(res);

  // Heartbeat — keeps the connection alive through proxies / load balancers.
  // 5 s interval: long AI feedback-loop calls (30–120 s) can cause aggressive
  // OS TCP stacks or proxies to reset the idle SSE connection. A shorter
  // heartbeat keeps the pipe warm without meaningful overhead.
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 5000);

  req.on("close", () => {
    clearInterval(heartbeat);
    runListeners.get(runId)?.delete(res);
    if (runListeners.get(runId)?.size === 0) runListeners.delete(runId);
  });
});

export default router;