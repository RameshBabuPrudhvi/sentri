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
import { redis, redisSub, isRedisAvailable } from "../utils/redisClient.js";
import { formatLogLine } from "../utils/logFormatter.js";

const router = Router();

// ─── SSE: Real-time run events (INF-002: Redis pub/sub for multi-instance) ────
// Registry: runId → Set of SSE response objects (local to this process)
export const runListeners = new Map();

/** Redis channel prefix for run events. */
const CHANNEL_PREFIX = "sentri:run:";

/** Unique identifier for this server instance — used to skip self-echo from Redis. */
const _instanceId = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * emitRunEvent(runId, type, payload)
 *
 * Broadcasts a Server-Sent Event to every client listening on this run.
 * Called from testRunner.js and crawler.js to push live updates.
 *
 * When Redis is available, the event is also published to a Redis channel
 * so other server instances can relay it to their connected SSE clients.
 * The local delivery happens first (instant), then Redis pub (async).
 * The message includes an `_origin` field so the subscriber can skip
 * messages published by this same instance (preventing duplicate delivery).
 */
export function emitRunEvent(runId, type, payload = {}) {
  const data = JSON.stringify({ type, ...payload });

  // ── Publish to Redis so other instances can relay ──────────────────────
  if (isRedisAvailable()) {
    // Include _origin so the subscriber on this instance can skip self-echo.
    const redisData = JSON.stringify({ type, ...payload, _origin: _instanceId });
    redis.publish(`${CHANNEL_PREFIX}${runId}`, redisData).catch(() => {});
  }

  // ── Deliver to local SSE listeners ────────────────────────────────────
  _deliverToLocal(runId, type, data);
}

/**
 * Deliver an SSE event to locally connected clients for a given run.
 * Separated from emitRunEvent so the Redis subscriber can call it too.
 *
 * @param {string} runId
 * @param {string} type  — event type (for "done" cleanup logic)
 * @param {string} data  — pre-serialised JSON string
 */
function _deliverToLocal(runId, type, data) {
  const listeners = runListeners.get(runId);
  if (!listeners || listeners.size === 0) {
    if (type === "done") runListeners.delete(runId);
    return;
  }
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

// ─── Redis pub/sub subscriber (INF-002) ───────────────────────────────────────
// When a client connects to an SSE endpoint on this instance, we subscribe to
// the Redis channel for that run.  Events published by ANY instance are then
// relayed to the local SSE clients.  This is how instance A's run events reach
// instance B's connected browsers.

/** Set of runIds this instance is subscribed to (avoids duplicate subscribes). */
const _subscribedRuns = new Set();

/**
 * Subscribe to the Redis channel for a run (if not already subscribed).
 * @param {string} runId
 */
function _subscribeToRun(runId) {
  if (!isRedisAvailable() || !redisSub) return;
  if (_subscribedRuns.has(runId)) return;
  _subscribedRuns.add(runId);
  redisSub.subscribe(`${CHANNEL_PREFIX}${runId}`).catch(err => {
    console.warn(formatLogLine("warn", null, `[sse] Redis subscribe failed for ${runId}: ${err.message}`));
    _subscribedRuns.delete(runId);
  });
}

/**
 * Unsubscribe from the Redis channel for a run (when no local listeners remain).
 * @param {string} runId
 */
function _unsubscribeFromRun(runId) {
  if (!isRedisAvailable() || !redisSub) return;
  if (!_subscribedRuns.has(runId)) return;
  _subscribedRuns.delete(runId);
  redisSub.unsubscribe(`${CHANNEL_PREFIX}${runId}`).catch(() => {});
}

// Handle incoming messages from Redis — relay to local SSE clients.
// Skip messages that originated from this instance to prevent duplicate
// delivery (emitRunEvent already delivered locally before publishing).
if (redisSub) {
  redisSub.on("message", (channel, message) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const runId = channel.slice(CHANNEL_PREFIX.length);
    try {
      const parsed = JSON.parse(message);
      // Skip self-echo: this instance already delivered the event locally.
      if (parsed._origin === _instanceId) return;
      // Strip _origin before forwarding to clients — it's an internal field.
      const { _origin, ...clientPayload } = parsed;
      const clientData = JSON.stringify(clientPayload);
      _deliverToLocal(runId, parsed.type, clientData);
    } catch { /* malformed message — ignore */ }
  });
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

  // Subscribe to the Redis channel so events from other instances are relayed.
  _subscribeToRun(runId);

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
    if (runListeners.get(runId)?.size === 0) {
      runListeners.delete(runId);
      // No more local listeners for this run — unsubscribe from Redis channel
      _unsubscribeFromRun(runId);
    }
  });
});

export default router;