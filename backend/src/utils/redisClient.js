/**
 * @module utils/redisClient
 * @description Shared Redis client for rate limiting, token revocation, and SSE pub/sub.
 *
 * When `REDIS_URL` is set, creates an `ioredis` client and a separate subscriber
 * client (Redis requires dedicated connections for pub/sub).  When `REDIS_URL` is
 * not set, all exports are no-ops / in-memory fallbacks so the application works
 * identically in single-instance mode without Redis.
 *
 * ### Exports
 * - {@link redis}          — Primary client for GET/SET/DEL commands (or `null`).
 * - {@link redisSub}       — Subscriber client for pub/sub (or `null`).
 * - {@link isRedisAvailable} — `true` when a live Redis connection exists.
 * - {@link closeRedis}     — Gracefully disconnect both clients (shutdown hook).
 *
 * ### Usage
 * ```js
 * import { redis, isRedisAvailable } from "../utils/redisClient.js";
 * if (isRedisAvailable()) {
 *   await redis.set("key", "value", "EX", 3600);
 * }
 * ```
 */

import { createRequire } from "module";
import { formatLogLine } from "./logFormatter.js";

const _require = createRequire(import.meta.url);

// ─── Lazy-load ioredis ────────────────────────────────────────────────────────
// ioredis is an optional dependency — only loaded when REDIS_URL is set.

let Redis = null;
if (process.env.REDIS_URL) {
  try {
    const ioredis = _require("ioredis");
    Redis = ioredis.default || ioredis;
  } catch {
    console.warn(formatLogLine("warn", null,
      "[redis] REDIS_URL is set but `ioredis` is not installed. " +
      "Run `npm install ioredis` to enable Redis. Falling back to in-memory stores."
    ));
  }
}

// ─── Client instances ─────────────────────────────────────────────────────────

/** @type {Object|null} Primary ioredis client for commands. */
export let redis = null;

/** @type {Object|null} Dedicated subscriber client for pub/sub. */
export let redisSub = null;

let _connected = false;

if (Redis && process.env.REDIS_URL) {
  try {
    const opts = {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) return null; // stop retrying after 10 attempts
        return Math.min(times * 200, 5000);
      },
      lazyConnect: false,
    };

    redis = new Redis(process.env.REDIS_URL, opts);
    // Subscriber needs its own connection — Redis does not allow commands
    // on a connection that has entered subscriber mode.
    redisSub = new Redis(process.env.REDIS_URL, opts);

    redis.on("connect", () => {
      _connected = true;
      console.log(formatLogLine("info", null, "[redis] Connected to Redis"));
    });
    redis.on("error", (err) => {
      _connected = false;
      console.warn(formatLogLine("warn", null, `[redis] Connection error: ${err.message}`));
    });
    redis.on("close", () => {
      _connected = false;
    });

    redisSub.on("error", (err) => {
      console.warn(formatLogLine("warn", null, `[redis-sub] Connection error: ${err.message}`));
    });
  } catch (err) {
    console.warn(formatLogLine("warn", null, `[redis] Failed to create client: ${err.message}`));
    redis = null;
    redisSub = null;
  }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Check whether a live Redis connection is available.
 *
 * @returns {boolean} `true` when the primary client is connected.
 */
export function isRedisAvailable() {
  return _connected && redis !== null;
}

/**
 * Gracefully disconnect both Redis clients.
 * Called from the shutdown hook in `index.js`.
 *
 * @returns {Promise<void>}
 */
export async function closeRedis() {
  const promises = [];
  if (redis) {
    promises.push(
      redis.quit()
        .then(() => console.log(formatLogLine("info", null, "[redis] Primary client disconnected")))
        .catch(err => console.warn(formatLogLine("warn", null, `[redis] Disconnect error: ${err.message}`)))
    );
  }
  if (redisSub) {
    promises.push(
      redisSub.quit()
        .then(() => console.log(formatLogLine("info", null, "[redis-sub] Subscriber client disconnected")))
        .catch(err => console.warn(formatLogLine("warn", null, `[redis-sub] Disconnect error: ${err.message}`)))
    );
  }
  await Promise.allSettled(promises);
  redis = null;
  redisSub = null;
  _connected = false;
}

const _memoryCounters = new Map();

/**
 * Atomically increment a counter and attach/refresh an expiry window.
 *
 * Uses Redis `MULTI` when available and an in-memory fallback otherwise so
 * single-process development keeps the same middleware contract.
 *
 * @param {string} key
 * @param {number} cost
 * @param {number} windowSec
 * @returns {Promise<{value: number, ttl: number}>}
 */
export async function incrWithExpiry(key, cost = 1, windowSec = 60) {
  const safeCost = Math.max(1, Number.parseInt(cost, 10) || 1);
  const safeWindow = Math.max(1, Number.parseInt(windowSec, 10) || 60);
  if (isRedisAvailable()) {
    const script = `
      local value = redis.call("INCRBY", KEYS[1], ARGV[1])
      local ttl = redis.call("TTL", KEYS[1])
      if ttl < 0 then
        redis.call("EXPIRE", KEYS[1], ARGV[2])
        ttl = tonumber(ARGV[2])
      end
      return { value, ttl }
    `;
    const result = await redis.eval(script, 1, key, safeCost, safeWindow);
    return { value: Number(result?.[0] || 0), ttl: Math.max(1, Number(result?.[1] || safeWindow)) };
  }
  const now = Date.now();
  const existing = _memoryCounters.get(key);
  if (!existing || existing.expiresAt <= now) {
    const expiresAt = now + safeWindow * 1000;
    _memoryCounters.set(key, { value: safeCost, expiresAt });
    return { value: safeCost, ttl: safeWindow };
  }
  existing.value += safeCost;
  return { value: existing.value, ttl: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)) };
}
