/**
 * @module utils/compatConfigCache
 * @description In-memory TTL cache for compat (`compat:<id>`) provider configs
 * with Redis pub/sub invalidation for multi-process coherence.
 *
 * ### Why
 * Without a cache every `callProvider()` / `streamText()` invocation for a
 * compat slot reads `api_keys` from SQLite (hot path for AI generation, can
 * be called hundreds of times per pipeline run). This module caches the
 * decrypted `{ apiKey, baseUrl, model, displayName }` blob with a short TTL
 * and invalidates it on write.
 *
 * ### Multi-process coherence
 * When `REDIS_URL` is set, every `invalidate()` / `invalidateAll()` call
 * also publishes to `sentri:compat-config:invalidate`.  Other server
 * instances listening on the channel drop their cached entry for the same
 * slot id, so a save on instance A is visible to instance B within one
 * Redis round-trip.  The published message includes an `_origin` field so
 * the publisher skips its own echo (same pattern as `routes/sse.js`).
 *
 * ### Single-process mode
 * When Redis is not available the module degrades to a purely local cache
 * with TTL-based staleness.  This is safe for single-instance deployments;
 * the TTL (default 60 s, overridable via `COMPAT_CONFIG_CACHE_TTL_MS`)
 * bounds the staleness window.
 *
 * ### Exports
 * - {@link get}          — Read-through accessor `(slotId, loader) => value|null`.
 * - {@link invalidate}   — Drop a single slot's cached entry + publish.
 * - {@link invalidateAll} — Drop every entry + publish (used by admin resets).
 * - {@link __test}       — Internals exposed for tests (stats, clear, TTL override).
 */

import { redis, redisSub, isRedisAvailable } from "./redisClient.js";
import { formatLogLine } from "./logFormatter.js";

/** Pub/sub channel name.  Prefix matches the `sentri:` convention used by sse.js. */
const CHANNEL = "sentri:compat-config:invalidate";

/** Sentinel payload for "invalidate every cached slot". */
const ALL = "*";

/** Unique id for this process — used to skip self-echo from Redis. */
const _instanceId = `inst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * TTL in milliseconds.  Exposed via `__test.setTtl()` so tests can shrink
 * the TTL without waiting 60 s in real time.  Read from env at module load
 * so production deployments can tune staleness without a code change.
 */
let _ttlMs = parseInt(process.env.COMPAT_CONFIG_CACHE_TTL_MS, 10) || 60_000;

/**
 * Cache entries:  `slotId → { value, expiresAt }`.
 * `value === null` is a legitimate cached result (slot deleted) — we use
 * `expiresAt` rather than presence-of-key to test staleness.
 */
const _cache = new Map();

/** Stats for observability / tests. */
const _stats = { hits: 0, misses: 0, invalidations: 0, crossProcessInvalidations: 0 };

// ─── Redis subscription (multi-process coherence) ─────────────────────────────
// Wire this up at module load so every instance that imports the cache starts
// receiving invalidations immediately.  `redisSub` is the dedicated subscriber
// client from utils/redisClient.js — the primary `redis` client cannot be used
// here because entering subscriber mode blocks all other commands.
let _subscribed = false;
function _ensureSubscribed() {
  if (_subscribed || !isRedisAvailable() || !redisSub) return;
  _subscribed = true;
  redisSub.subscribe(CHANNEL).catch((err) => {
    _subscribed = false;
    console.warn(formatLogLine("warn", null, `[compatConfigCache] Redis subscribe failed: ${err.message}`));
  });
  redisSub.on("message", (channel, message) => {
    if (channel !== CHANNEL) return;
    let parsed;
    try { parsed = JSON.parse(message); } catch { return; }
    // Skip self-echo: this instance already cleared the entry locally before publishing.
    if (!parsed || parsed._origin === _instanceId) return;
    if (parsed.slotId === ALL) {
      _cache.clear();
    } else if (typeof parsed.slotId === "string") {
      _cache.delete(parsed.slotId);
    }
    _stats.crossProcessInvalidations += 1;
  });
}
_ensureSubscribed();

/**
 * Read-through accessor.  Returns the cached value for `slotId` if fresh,
 * otherwise calls `loader(slotId)` to refresh the entry.  `loader` is
 * supplied by the caller (rather than imported here) to avoid a circular
 * dependency on `apiKeyRepo`.
 *
 * @param {string}   slotId  - Canonical provider id (e.g. `"compat:deepseek"`).
 * @param {Function} loader  - `() => value` — called on miss / expired entry.
 * @returns {any} The cached or freshly-loaded value.
 */
export function get(slotId, loader) {
  const now = Date.now();
  const entry = _cache.get(slotId);
  if (entry && entry.expiresAt > now) {
    _stats.hits += 1;
    return entry.value;
  }
  _stats.misses += 1;
  const value = loader();
  _cache.set(slotId, { value, expiresAt: now + _ttlMs });
  return value;
}

/**
 * Drop the cached entry for a single slot and broadcast the invalidation to
 * other instances.  Must be called by every write-path (`setCompatSlot`,
 * `deleteCompatSlot`) so the cache never serves stale credentials.
 *
 * @param {string} slotId - Canonical provider id.
 */
export function invalidate(slotId) {
  _cache.delete(slotId);
  _stats.invalidations += 1;
  if (isRedisAvailable() && redis) {
    redis.publish(CHANNEL, JSON.stringify({ slotId, _origin: _instanceId })).catch(() => {});
  }
}

/**
 * Drop every cached entry and broadcast.  Used by admin resets and tests.
 */
export function invalidateAll() {
  _cache.clear();
  _stats.invalidations += 1;
  if (isRedisAvailable() && redis) {
    redis.publish(CHANNEL, JSON.stringify({ slotId: ALL, _origin: _instanceId })).catch(() => {});
  }
}

/**
 * Test-only handle.  Exposed so tests can reset state between cases and
 * shrink the TTL without altering env for the whole process.  Not part of
 * the public module contract.
 *
 * @private
 */
export const __test = {
  /** Reset cache + stats (does NOT publish — used for per-test isolation). */
  clear() {
    _cache.clear();
    _stats.hits = 0;
    _stats.misses = 0;
    _stats.invalidations = 0;
    _stats.crossProcessInvalidations = 0;
  },
  /** Snapshot of the stats counters. */
  stats() { return { ..._stats }; },
  /** Override the TTL for deterministic test timing. */
  setTtl(ms) { _ttlMs = ms; },
  /** Current TTL in ms. */
  getTtl() { return _ttlMs; },
  /** Channel + instance id for cross-process tests that publish directly. */
  channel: CHANNEL,
  instanceId: _instanceId,
  /** Direct cache probe for assertion convenience. */
  has(slotId) { return _cache.has(slotId); },
};
