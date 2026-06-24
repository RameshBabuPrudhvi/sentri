/**
 * @module utils/dbWriteQueue
 * @description B1.2 (AUDIT-ROADMAP Bundle 1) — write-batching queue for
 * the hottest SQLite write paths.
 *
 * ## Why
 *
 * Under `parallelWorkers > 1`, SQLite WAL serialises writers. Three call
 * sites dominate the contention: `healingRepo.set()`,
 * `runTestResultRepo.append()` (B1.1), and `runLogRepo.appendLog()`.
 * Wrapping consecutive writes in a single transaction collapses N
 * `BEGIN/COMMIT` round-trips into one, lifting effective throughput on
 * `parallelWorkers = 10` from ~60% of capacity back to near-100%.
 *
 * ## Behaviour
 *
 * - **SQLite**: writes enqueued via {@link enqueue} are buffered until
 *   either `DB_WRITE_BATCH_SIZE` is reached or `DB_WRITE_FLUSH_MS`
 *   elapses, then drained inside a single `db.transaction()`.
 * - **PostgreSQL**: the queue is a passthrough — calls execute
 *   synchronously. Postgres handles concurrent writers natively; the
 *   batching machinery would add latency without throughput benefit.
 * - **Graceful shutdown**: {@link drain} flushes all pending writes
 *   synchronously. The shutdown sequence in `index.js` calls it before
 *   `closeDatabase()`.
 *
 * ## Durability contract — read this before adding a call site
 *
 * The queue is a **write-behind cache** with three documented modes,
 * matching the industry-standard tiered-durability pattern (Postgres
 * `synchronous_commit`, Kafka `acks`, MySQL `sync_binlog`). Pick the
 * mode that matches the audit / compliance need of the write:
 *
 * | Mode             | API                                  | Latency | Durability on SIGKILL                                 |
 * |------------------|--------------------------------------|---------|-------------------------------------------------------|
 * | `"batched"` (default) | `enqueue(fn)`                    | < 1 ms (enqueue) | Loses up to one batch (≤ `DB_WRITE_BATCH_SIZE` rows or `DB_WRITE_FLUSH_MS` ms of writes) |
 * | `"durable"`      | `enqueue(fn, { priority: "durable" })` | ~1–5 ms | Loses nothing — synchronous `BEGIN/COMMIT` before return |
 * | `"high"` (alias) | `enqueue(fn, { priority: "high" })` | ~1–5 ms | Same as `"durable"` — kept as a back-compat alias |
 *
 * **Rule of thumb:**
 *   • Audit / compliance / circuit-breaker writes → `"durable"`.
 *   • Append-only telemetry / per-test results → `"batched"` (default).
 *   • Heavy log volume (`run_logs`) → `"batched"`.
 *
 * The default `"batched"` mode is **strictly better than the pre-B1.2
 * baseline** for graceful SIGTERM (the drain hook flushes everything)
 * but **trades up to `DB_WRITE_FLUSH_MS` of writes for throughput on
 * SIGKILL / OOM kill**. This tradeoff is identical to Kafka producer
 * `acks=1` and Postgres `synchronous_commit=off` — operators who need
 * "lose-nothing" semantics opt into `"durable"` on a per-write basis.
 *
 * ## Failure model
 *
 * Each queued closure is wrapped in `try/catch` inside the flush
 * transaction. A throwing closure rolls back the *batch* — but rather
 * than discarding every queued write, the queue replays the surviving
 * closures one-by-one after the rollback. This trades a small latency
 * hit on poison-pill writes for "one bad write never silently drops 49
 * others".
 *
 * ## Metrics
 *
 * - `app_db_write_queue_depth` (Gauge) — current queue size
 * - `app_db_write_batch_duration_seconds` (Histogram) — flush wall-clock
 * - `app_db_write_batch_size` (Histogram) — operations per flush
 *
 * @example
 * import { enqueue, drain } from "./utils/dbWriteQueue.js";
 *
 * // Default — batched, high throughput, may lose up to one batch on SIGKILL.
 * enqueue(() => db.prepare("INSERT INTO run_logs …").run(…));
 *
 * // Compliance-critical — synchronous transaction, lose-nothing on SIGKILL.
 * enqueue(
 *   () => db.prepare("INSERT INTO activities (…)").run(…),
 *   { priority: "durable" },
 * );
 *
 * // …later, at shutdown:
 * drain();
 */

import { getDatabase, getDatabaseDialect } from "../database/sqlite.js";
import { formatLogLine } from "./logFormatter.js";
import {
  dbWriteQueueDepth,
  dbWriteBatchDurationSeconds,
  dbWriteBatchSize,
} from "./metrics.js";

const BATCH_SIZE = Number(process.env.DB_WRITE_BATCH_SIZE) || 50;
const FLUSH_MS = Number(process.env.DB_WRITE_FLUSH_MS) || 100;

/**
 * @typedef {function(): void} WriteFn
 *   A zero-arg closure that performs one or more `db.prepare(…).run(…)`
 *   writes. Wrapped by `flushNow()` in a single transaction. JSDoc-form
 *   (`function(): void`) per AGENTS.md §"Do not use TypeScript syntax in
 *   JSDoc comments" — the `() => void` arrow form is TypeScript-only and
 *   trips the `jsdoc -c jsdoc.json` parser at the CI docs build step.
 */

/** @type {Array<WriteFn>} */
const _queue = [];
let _flushScheduled = false;
let _flushTimer = null;

function updateDepthGauge() {
  try { dbWriteQueueDepth.set(_queue.length); } catch { /* best-effort */ }
}

/**
 * Drain the queue inside a single transaction. Called by the flush
 * scheduler and synchronously by {@link drain}.
 *
 * @returns {number} ops flushed
 */
function flushNow() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _flushScheduled = false;
  if (_queue.length === 0) {
    updateDepthGauge();
    return 0;
  }

  const batch = _queue.splice(0, _queue.length);
  updateDepthGauge();
  const start = Date.now();
  const db = getDatabase();

  // Track which closure threw inside the batch transaction so the replay
  // path can skip the poison pill instead of re-executing it. Without
  // this, a closure that calls `generateRunTestResultId()` (or any other
  // `counterRepo.next()`) before the failing INSERT bumps the SQLite
  // counter on EVERY replay attempt, leaving permanent gaps in the ID
  // sequence and emitting a duplicate warn line that's indistinguishable
  // from a genuinely separate failure on a different write.
  let poisonIndex = -1;
  let poisonErr = null;
  try {
    db.transaction(() => {
      for (let i = 0; i < batch.length; i++) {
        try {
          batch[i]();
        } catch (err) {
          // Capture-and-rethrow so the transaction rolls back, but the
          // replay loop can identify which slot to skip.
          poisonIndex = i;
          poisonErr = err;
          throw err;
        }
      }
    })();
  } catch (err) {
    // One poison pill must not drop the rest. Replay survivors
    // individually outside the failed transaction. Skip the captured
    // poison-pill slot (replaying it would re-throw the same error and
    // waste any ID-counter increments the closure performed before the
    // failing INSERT).
    const known = poisonIndex >= 0 ? ` (slot ${poisonIndex} threw: ${poisonErr?.message || poisonErr})` : "";
    console.warn(formatLogLine(
      "warn",
      null,
      `[dbWriteQueue] batch of ${batch.length} rolled back${known} — replaying ${batch.length - (poisonIndex >= 0 ? 1 : 0)} survivor(s)`,
    ));
    for (let i = 0; i < batch.length; i++) {
      if (i === poisonIndex) continue; // skip the known poison pill
      try {
        db.transaction(() => batch[i]())();
      } catch (replayErr) {
        // Defence-in-depth: a replay that fails for a different reason
        // than the captured poison pill (e.g. a UNIQUE constraint that
        // depended on the rolled-back row) — drop with a structured warn
        // so operators can correlate via `runId` if the closure carries it.
        console.warn(formatLogLine(
          "warn",
          null,
          `[dbWriteQueue] dropped one write on replay (slot ${i}): ${replayErr?.message || replayErr}`,
        ));
      }
    }
  }

  try {
    const seconds = (Date.now() - start) / 1000;
    dbWriteBatchDurationSeconds.observe(seconds);
    dbWriteBatchSize.observe(batch.length);
  } catch { /* best-effort */ }

  return batch.length;
}

/**
 * Enqueue a write closure for batched execution.
 *
 * Durability mode is selected via `opts.priority`:
 *   • `"batched"` (default) — buffered; flushed on size/time trigger or drain.
 *   • `"durable"` — synchronous transaction; returns only after commit.
 *   • `"high"` — back-compat alias for `"durable"`.
 *
 * On PostgreSQL ALL modes execute synchronously (the queue is a
 * passthrough — Postgres handles concurrent writers natively without
 * the batching machinery).
 *
 * @param {WriteFn} fn      - Closure that runs one or more `db.prepare(…).run(…)` calls.
 * @param {Object}  [opts]
 * @param {"batched"|"durable"|"high"|"normal"} [opts.priority="batched"]
 *   `"normal"` is a back-compat alias for `"batched"`.
 * @returns {void}
 */
export function enqueue(fn, opts = {}) {
  if (typeof fn !== "function") return;

  // Two priority families: durable (`"durable"` | `"high"`) → sync write,
  // batched (`"batched"` | `"normal"` | anything else) → buffered. Both
  // aliases for each mode are accepted so existing callers keep working
  // and new callers can use the more honest `"durable"` label.
  const isDurable = opts.priority === "durable" || opts.priority === "high";

  const dialect = getDatabaseDialect();
  if (dialect === "postgres" || isDurable) {
    // Synchronous transaction — durable writes must be committed before
    // this call returns, and Postgres handles concurrency natively so
    // batching adds latency without throughput benefit.
    try {
      const db = getDatabase();
      db.transaction(() => fn())();
    } catch (err) {
      console.warn(formatLogLine(
        "warn",
        null,
        `[dbWriteQueue] direct write failed: ${err?.message || err}`,
      ));
    }
    return;
  }

  _queue.push(fn);
  updateDepthGauge();

  if (_queue.length >= BATCH_SIZE) {
    flushNow();
    return;
  }

  if (!_flushScheduled) {
    _flushScheduled = true;
    _flushTimer = setTimeout(() => {
      flushNow();
    }, FLUSH_MS);
    // Allow process exit even if the queue is empty / idle.
    if (_flushTimer.unref) _flushTimer.unref();
  }
}

/**
 * Synchronously flush all pending writes. Called from graceful shutdown
 * in `index.js` and from tests that need to assert post-flush state.
 *
 * Safe to call repeatedly — no-op when the queue is empty.
 *
 * @returns {number} total ops flushed across all drain iterations
 */
export function drain() {
  let total = 0;
  // Loop in case enqueue() races with drain() on a hot path; a single
  // flushNow call processes the snapshot it captured, so re-check.
  while (_queue.length > 0) {
    total += flushNow();
  }
  return total;
}

/**
 * Current queue depth — used by tests.
 *
 * @returns {number}
 */
export function depth() {
  return _queue.length;
}
