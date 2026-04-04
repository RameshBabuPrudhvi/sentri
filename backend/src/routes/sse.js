/**
 * sse.js — SSE (Server-Sent Events) infrastructure for real-time run updates.
 *
 * Exports:
 *   emitRunEvent(runId, type, payload)  — broadcast to all listeners on a run
 *   runListeners                        — Map<runId, Set<res>>
 *   default                             — Express Router with GET /runs/:runId/events
 */

import { Router } from "express";
import { getDb } from "../db.js";

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
router.get("/runs/:runId/events", (req, res) => {
  const db = getDb();
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

export default router;
