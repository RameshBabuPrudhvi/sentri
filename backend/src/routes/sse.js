/**
 * @module routes/sse
 * @description SSE (Server-Sent Events) infrastructure for real-time run updates.
 *
 * ### Endpoints (INF-005: all under `/api/v1/`)
 * | Method | Path                            | Description                 |
 * |--------|---------------------------------|-----------------------------|
 * | `GET`  | `/api/v1/runs/:runId/events`    | SSE stream for a single run |
 *
 * ### Exports
 * - {@link emitRunEvent} — Broadcast an event to all listeners on a run.
 * - {@link runListeners} — `Map<runId, Set<res>>` — active SSE connections.
 */

import { Router } from "express";
import * as runRepo from "../database/repositories/runRepo.js";
import * as projectRepo from "../database/repositories/projectRepo.js";
import * as runLogRepo from "../database/repositories/runLogRepo.js";
import * as agentMessageRepo from "../database/repositories/agentMessageRepo.js";
// Task 2 — per-agent SSE event history is hydrated by `runRepo.getById`
// (see `run.agentEvents` below). No separate repo import needed here —
// reusing the hydrated array avoids a redundant DB round-trip and keeps
// the `data`-parse contract in one place (`runRepo.parseAgentEventRow`).
import { signRunArtifacts, signArtifactUrl } from "../middleware/appSetup.js";
import { redis, redisSub, isRedisAvailable } from "../utils/redisClient.js";
import { formatLogLine } from "../utils/logFormatter.js";

const router = Router();

// ─── SSE: Real-time run events (INF-002: Redis pub/sub for multi-instance) ────
// Registry: runId → Set of SSE response objects (local to this process)
export const runListeners = new Map();

// CR-009 — Defence-in-depth cap on concurrent SSE listeners per run.
// Without this a single run with thousands of reconnecting tabs / leaked
// connections (mobile sleep, network drop, abnormal close that misses the
// "close" handler) can grow `runListeners.get(runId)` without bound. Each
// listener carries a 5 s heartbeat interval + the snapshot payload, so an
// unbounded Set is a memory + event-loop pressure leak.
//
// The cap is per-run, per-process. Multi-instance deployments naturally
// shard listeners across instances (each browser tab opens one EventSource
// against whichever backend pod the load balancer picks), so a per-instance
// cap of 50 is generous for legitimate usage (a single run with 50 reviewers
// open simultaneously on the same pod is already an edge case) while still
// closing the unbounded-growth attack surface.
//
// Override via env for stress tests; bounded below at 1 so a misconfigured
// `0` doesn't accidentally disable all SSE on this instance.
const MAX_LISTENERS_PER_RUN = Math.max(
  1,
  Number.parseInt(process.env.SSE_MAX_LISTENERS_PER_RUN || "50", 10) || 50,
);

// §11.3 — Per-listener backpressure high-water mark, in bytes.
// `res.write()` returns false and buffers internally when the kernel TCP
// send buffer is full. A slow consumer (mobile on a throttled connection,
// paused tab, half-closed proxy) keeps the JS-side buffer growing without
// bound for the lifetime of the run — a 20-minute run emitting 500+ log
// events at ~1 KB each is ~500 KB of backlog per stalled client.
//
// On every write, if the underlying socket's `writableLength` exceeds this
// cap, we treat the client as gone: end the response, remove it from the
// listener Set, and let the close handler clean up. EventSource clients
// will reconnect automatically with their normal retry backoff, picking up
// from the snapshot on the next handshake.
//
// Default 1 MiB — gives a legitimate but slow viewer enough headroom to
// catch up across a single burst (e.g. a 500-event log flush) without
// permanently growing the process's resident memory.
const MAX_WRITABLE_LENGTH = Math.max(
  64 * 1024,
  Number.parseInt(process.env.SSE_MAX_WRITABLE_BYTES || "1048576", 10) || 1048576,
);

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
        // §11.3 — Backpressure check BEFORE the write. If this client's
        // socket already has >MAX_WRITABLE_LENGTH bytes queued in Node's
        // stream layer, treat them as gone: end the response and let the
        // "close" handler remove them from the Set. Without this, a
        // single stalled tab on a high-volume run grows resident memory
        // until the run ends or the process OOMs.
        if (res.writableLength > MAX_WRITABLE_LENGTH) {
          res.end();
          continue;
        }
        res.write(`data: ${data}\n\n`);
        if (type === "done") res.end();
    } catch { /* client gone */ }
  }
  if (type === "done") {
    runListeners.delete(runId);
    _unsubscribeFromRun(runId);
  }
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

  // Verify the run belongs to the current workspace (ACL-001)
  const project = projectRepo.getByIdInWorkspace(run.projectId, req.workspaceId);
  if (!project) return res.status(404).json({ error: "project not found" });

  // CR-009 — Reject before flushing headers when this instance is already at
  // the per-run listener cap. Done here (not after `flushHeaders()`) so the
  // caller gets a proper JSON 503 instead of an SSE stream that closes
  // immediately. The cap only applies to actively-running runs; terminal
  // runs short-circuit below with snapshot+done+end and never register a
  // listener.
  if (run.status === "running") {
    const existing = runListeners.get(runId);
    if (existing && existing.size >= MAX_LISTENERS_PER_RUN) {
      return res.status(503).json({
        error: "too many SSE listeners on this run",
        retryAfter: 5,
      });
    }
  }

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
  //
  // Task 2 — per-agent `agentEvents[]` is already hydrated on `run` by
  // `runRepo.getById` (line 152) with `data` parsed via the shared
  // `parseAgentEventRow` helper. Reuse it verbatim instead of re-fetching
  // + re-parsing — one DB query per SSE connect, one parse contract.
  const signedRun = signRunArtifacts({
    ...run,
    logs: runLogRepo.getMessagesByRunId(run.id),
    agentMessages: agentMessageRepo.listByRun(run.id, req.workspaceId),
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
