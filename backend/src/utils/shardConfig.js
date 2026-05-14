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
 *     badge on RunDetail and the BullMQ job fan-out.
 *   - `parallelWorkers` — concurrency *inside* one shard's process.
 *     `shards: N` implies "execute N partitions concurrently", so the
 *     effective concurrency is `max(dialsRequest, shardCount)`.
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
  const parallelWorkers = Math.max(shardCount, dialsParallelWorkers ?? 1);
  return { shardCount, parallelWorkers, maxWorkers };
}
