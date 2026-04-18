/**
 * @module queue
 * @description Shared BullMQ queue for durable run execution (INF-003).
 *
 * When Redis is available (`REDIS_URL` is set and `ioredis` + `bullmq` are
 * installed), run execution is routed through a BullMQ queue instead of the
 * fire-and-forget `runWithAbort` pattern.  This provides:
 *
 * - **Durability** — jobs survive process crashes; stuck runs are retried.
 * - **Global concurrency** — `MAX_WORKERS` limits total parallel runs.
 * - **Visibility** — queue depth and active job count are queryable.
 *
 * When Redis is NOT available, the queue is `null` and callers fall back to
 * the existing `runWithAbort` in-process execution.  This keeps SQLite-only
 * deployments working unchanged.
 *
 * ### Exports
 * - {@link runQueue}        — BullMQ `Queue` instance (or `null`).
 * - {@link isQueueAvailable} — `true` when the queue is usable.
 * - {@link closeQueue}      — Gracefully close the queue connection.
 * - {@link getQueueStats}   — Return queue depth and active job count.
 */

import { createRequire } from "module";
import { formatLogLine } from "./utils/logFormatter.js";

const _require = createRequire(import.meta.url);

// ─── Lazy-load BullMQ ─────────────────────────────────────────────────────────
// BullMQ is an optional dependency — only loaded when REDIS_URL is set.

let Queue = null;
if (process.env.REDIS_URL) {
  try {
    const bullmq = _require("bullmq");
    Queue = bullmq.Queue;
  } catch {
    console.warn(formatLogLine("warn", null,
      "[queue] REDIS_URL is set but `bullmq` is not installed. " +
      "Run `npm install bullmq` to enable durable job queues. Falling back to in-process execution."
    ));
  }
}

// ─── Queue instance ───────────────────────────────────────────────────────────

/** @type {Object|null} BullMQ Queue instance for run jobs. */
export let runQueue = null;

if (Queue && process.env.REDIS_URL) {
  try {
    runQueue = new Queue("sentri:runs", {
      connection: {
        url: process.env.REDIS_URL,
        maxRetriesPerRequest: null,
      },
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });

    console.log(formatLogLine("info", null, "[queue] BullMQ run queue initialised"));
  } catch (err) {
    console.warn(formatLogLine("warn", null,
      `[queue] Failed to create BullMQ queue: ${err.message}. Falling back to in-process execution.`));
    runQueue = null;
  }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Check whether the BullMQ queue is available.
 *
 * @returns {boolean}
 */
export function isQueueAvailable() {
  return runQueue !== null;
}

/**
 * Get queue statistics (waiting + active counts).
 *
 * @returns {Promise<Object>} `{ waiting, active, delayed, failed }`
 */
export async function getQueueStats() {
  if (!runQueue) return { waiting: 0, active: 0, delayed: 0, failed: 0 };
  const [waiting, active, delayed, failed] = await Promise.all([
    runQueue.getWaitingCount(),
    runQueue.getActiveCount(),
    runQueue.getDelayedCount(),
    runQueue.getFailedCount(),
  ]);
  return { waiting, active, delayed, failed };
}

/**
 * Gracefully close the queue connection.
 * Called from the shutdown hook in `index.js`.
 *
 * @returns {Promise<void>}
 */
export async function closeQueue() {
  if (runQueue) {
    try {
      await runQueue.close();
      console.log(formatLogLine("info", null, "[queue] BullMQ queue closed"));
    } catch (err) {
      console.warn(formatLogLine("warn", null, `[queue] Queue close error: ${err.message}`));
    }
    runQueue = null;
  }
}
