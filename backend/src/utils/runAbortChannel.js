/**
 * @module utils/runAbortChannel
 * @description CAP-002 Phase 2 (Prerequisite #5) — cross-process run-abort
 * signal channel over Redis pub/sub.
 *
 * Why this exists: when a user clicks "Abort" on a sharded run, the abort
 * route in `backend/src/routes/runs.js` only knows about the local replica's
 * `workerAbortControllers`. Shard workers running on *other* replicas would
 * keep executing until natural completion, leaving orphan jobs and burning
 * compute. This module fans the abort signal out to every replica so each
 * one can cancel any matching in-flight job via its local
 * `workerAbortControllers` map.
 *
 * ### Channel contract
 *
 *   `sentri:run-abort` — JSON-encoded `{ runId: string, origin: string }`.
 *   Published by the abort route; subscribed by every shard worker at boot.
 *
 * ### Self-echo suppression
 *
 * Each Node process generates a fresh `origin` id at module load (UUID-shape
 * hex string, same pattern as `routes/sse.js:_instanceId`). The publisher
 * stamps it on every message; the subscriber drops messages whose `origin`
 * matches its own. This prevents the same-process round-trip — the local
 * fast-path in `routes/runs.js` already aborted the controller before
 * publishing, so re-firing it via the channel would be wasteful (and could
 * race against the cleanup that the route performed synchronously).
 *
 * ### Degraded mode (no Redis)
 *
 * When `REDIS_URL` is unset or `isRedisAvailable()` returns false:
 *
 *   - `publishRunAbort()` returns `false` and is a clean no-op.
 *   - `subscribeToRunAborts()` returns `false`; the worker keeps its
 *     in-process `workerAbortControllers` map as the only abort path.
 *
 * Single-replica deployments therefore behave bit-for-bit identically to
 * pre-Phase-2 today — no Redis, no cross-process abort, but local aborts
 * still work because the abort route always calls
 * `workerAbortControllers.get(runId)?.controller.abort()` *before* delegating
 * to this channel. This module is purely *additional* cross-replica reach.
 *
 * ### Test coverage
 *
 * Gated on `REDIS_URL` (see `backend/tests/run-abort-pubsub.test.js`) — a
 * single-process unit test can't exercise the cross-process semantics; we
 * spin up two real subscriber clients against a real Redis instance and
 * assert (a) both receive the message, (b) the publisher self-suppresses.
 */

import crypto from "crypto";
import { redis, redisSub, isRedisAvailable } from "./redisClient.js";
import { formatLogLine } from "./logFormatter.js";

/** Redis channel name. Single channel for all runs — payload carries the runId. */
export const RUN_ABORT_CHANNEL = "sentri:run-abort";

/**
 * Per-process origin id used for self-echo suppression. Generated once at
 * module load. The shape (16-byte hex) matches `routes/sse.js`'s
 * `_instanceId` pattern so future operators reading process telemetry see a
 * consistent identifier format across both pub/sub channels.
 *
 * @type {string}
 */
export const RUN_ABORT_ORIGIN = `inst_${crypto.randomBytes(16).toString("hex")}`;

let _subscribed = false;
const _onAbortHandlers = new Set();

/**
 * Publish a run-abort signal to every replica subscribed to the channel.
 * Same-replica subscribers self-suppress via the `origin` stamp — the
 * caller is responsible for the local-fast-path abort *before* publishing.
 *
 * @param {string} runId
 * @returns {Promise<boolean>} Resolves to `true` when the message was
 *   published, `false` when Redis is unavailable (degraded single-replica
 *   mode — caller should rely on the local `workerAbortControllers` only).
 */
export async function publishRunAbort(runId) {
  if (!runId || typeof runId !== "string") return false;
  if (!isRedisAvailable() || !redis) return false;
  const payload = JSON.stringify({ runId, origin: RUN_ABORT_ORIGIN });
  try {
    await redis.publish(RUN_ABORT_CHANNEL, payload);
    return true;
  } catch (err) {
    // Publish failures are best-effort — never throw out of the abort path.
    // The local fast-path already cancelled this replica's controller, so
    // the worst case is sibling replicas finish their shards naturally.
    console.warn(formatLogLine("warn", null,
      `[run-abort-channel] publish failed for ${runId}: ${err.message}`));
    return false;
  }
}

/**
 * Subscribe this process to the run-abort channel. Idempotent — calling
 * twice is safe; only the first call performs the SUBSCRIBE. Every
 * registered handler is invoked with the runId whenever a cross-replica
 * abort arrives (own-origin messages are filtered out before dispatch).
 *
 * Workers call this at boot from `startWorker()`. The handler typically
 * looks up `workerAbortControllers.get(runId)` and aborts the local
 * controller — exactly the same code path the in-process abort route uses.
 *
 * @param {Object}   opts
 * @param {Function} opts.onAbort - Local abort handler `(runId) => void`.
 * @returns {boolean} `true` if subscribed (or already was), `false` when
 *   Redis is unavailable (caller should keep using the local-only path).
 */
export function subscribeToRunAborts({ onAbort }) {
  if (typeof onAbort !== "function") {
    throw new TypeError("subscribeToRunAborts: onAbort must be a function");
  }
  if (!isRedisAvailable() || !redisSub) return false;

  _onAbortHandlers.add(onAbort);

  // Idempotent SUBSCRIBE — the underlying ioredis client multiplexes the
  // single channel across all callers in this process.
  if (_subscribed) return true;
  _subscribed = true;

  redisSub.subscribe(RUN_ABORT_CHANNEL).catch((err) => {
    // Subscribe failure → revert state so a later retry (e.g. after a
    // Redis reconnect) can try again. The caller logs the warning; we
    // surface it here for operator visibility.
    _subscribed = false;
    console.warn(formatLogLine("warn", null,
      `[run-abort-channel] subscribe failed: ${err.message}`));
  });

  redisSub.on("message", (channel, message) => {
    if (channel !== RUN_ABORT_CHANNEL) return;
    let parsed;
    try { parsed = JSON.parse(message); } catch { return; }
    if (!parsed || typeof parsed.runId !== "string") return;
    // Self-echo suppression: the local abort route already cancelled the
    // controller before publishing, so re-firing here would be a no-op at
    // best and a confused-state bug at worst.
    if (parsed.origin === RUN_ABORT_ORIGIN) return;
    for (const handler of _onAbortHandlers) {
      try { handler(parsed.runId); }
      catch (err) {
        console.warn(formatLogLine("warn", null,
          `[run-abort-channel] handler threw for ${parsed.runId}: ${err.message}`));
      }
    }
  });

  console.log(formatLogLine("info", null,
    `[run-abort-channel] subscribed to ${RUN_ABORT_CHANNEL} (origin=${RUN_ABORT_ORIGIN})`));

  return true;
}

/**
 * Test-only: clear the registered handlers and reset subscribed state.
 * Used by `run-abort-pubsub.test.js` to isolate test cases. Never call
 * this from production code — it leaves the redisSub client subscribed
 * but with no handlers registered, which is wasteful (cheap, but pointless).
 *
 * @returns {void}
 */
export function __resetForTest() {
  _onAbortHandlers.clear();
  _subscribed = false;
}
