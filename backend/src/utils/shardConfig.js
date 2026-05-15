/**
 * @module utils/shardConfig
 * @description CAP-002 — Single source of truth for the per-request shard
 * + parallel-worker normalization used by both `/run` and `/trigger`.
 *
 * Replaces the verbatim copy of the clamp + decoupling logic that previously
 * lived in `routes/runs.js` and `routes/trigger.js`. Per AGENT.md pre-flight
 * rule #4 ("if a helper is used by ≥2 call sites, put it in `utils/`"), this
 * lives here as a pure function so both entry points apply identical
 * semantics.
 *
 * ### Contract — BUG-0001 decoupling
 *
 * `shardCount` and `parallelWorkers` are **independent** concepts:
 *
 *   - `shardCount` — cross-process partition count. Only `> 1` when the
 *     caller explicitly passed `shards: N`. Drives the per-shard progress
 *     badge on RunDetail and the BullMQ job fan-out. Cross-shard
 *     parallelism comes from BullMQ's worker pool (`concurrency: MAX_WORKERS`
 *     in `backend/src/workers/runWorker.js`); each shard runs in its own
 *     job and is picked up by a separate worker slot.
 *   - `parallelWorkers` — concurrency *inside* one shard's process (the
 *     in-shard test pool). Reflects only the dials input; defaults to `1`.
 *
 * `shardCount` and `parallelWorkers` are **independent** — total
 * concurrent browser instances on one replica is bounded by
 * `MAX_WORKERS × parallelWorkers`, NOT `shardCount × parallelWorkers`.
 * The previous formula `max(shardCount, dialsParallelWorkers)` re-coupled
 * the two and produced surprising N² concurrency for callers requesting
 * `shards: 4` without an explicit dials override (one slot per shard ×
 * 4 internal workers per shard = 16 browsers). Decoupled here so
 * `shards: 4` with no dials input gives 4× cross-process parallelism at
 * 1 browser per shard — the operator-intuitive shape.
 *
 * A request that only sets `dialsConfig.parallelWorkers: 4` leaves
 * `shardCount = 1` so no shard badge is shown (BUG-0001 — discovered during
 * the CAP-002 review pass).
 *
 * `shards` is clamped to `[1, MAX_WORKERS]` server-side regardless of input
 * type. Non-numeric / negative / fractional values fall back to `1`.
 *
 * @param {unknown}     shardsInput  - Raw `req.body.shards` (any type).
 * @param {number|null} [dialsParallelWorkers] - Validated dials request, may be undefined.
 * @returns {{ shardCount: number, parallelWorkers: number, maxWorkers: number }}
 */
export function normalizeShardConfig(shardsInput, dialsParallelWorkers) {
  const maxWorkers = Math.max(1, parseInt(process.env.MAX_WORKERS || "2", 10) || 2);
  const normalizedShards = Number.isFinite(Number(shardsInput))
    ? Math.max(1, Math.min(maxWorkers, Math.trunc(Number(shardsInput))))
    : null;
  const shardCount = normalizedShards ?? 1;
  const parallelWorkers = Math.max(1, dialsParallelWorkers ?? 1);
  return { shardCount, parallelWorkers, maxWorkers };
}
