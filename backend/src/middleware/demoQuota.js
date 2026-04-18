/**
 * @module middleware/demoQuota
 * @description Per-user daily quota enforcement for demo mode.
 *
 * When the platform provides a shared AI key (`DEMO_GOOGLE_API_KEY`), users
 * who have NOT configured their own AI provider are subject to daily limits
 * on expensive operations (crawl, test run, AI generation).
 *
 * Users who bring their own key (BYOK) bypass all demo quotas.
 *
 * ### Quota defaults (overridable via env vars)
 * | Operation      | Env var                  | Default |
 * |----------------|--------------------------|---------|
 * | Crawl          | `DEMO_DAILY_CRAWLS`      | 2       |
 * | Test run       | `DEMO_DAILY_RUNS`        | 3       |
 * | AI generation  | `DEMO_DAILY_GENERATIONS` | 5       |
 *
 * Counters reset at midnight UTC. Stored in-memory (single instance) or
 * Redis (multi-instance) when available.
 *
 * @example
 * import { demoQuota } from "../middleware/demoQuota.js";
 * router.post("/projects/:id/crawl", demoQuota("crawl"), expensiveOpLimiter, handler);
 */

import { getConfiguredKeys } from "../aiProvider.js";
import { redis, isRedisAvailable } from "../utils/redisClient.js";

// ── Configuration ─────────────────────────────────────────────────────────────

/** @type {boolean} Demo mode is active when a platform-owned key is set. */
export const isDemoEnabled = !!process.env.DEMO_GOOGLE_API_KEY;

const DAILY_LIMITS = {
  crawl:      parseInt(process.env.DEMO_DAILY_CRAWLS, 10)      || 2,
  run:        parseInt(process.env.DEMO_DAILY_RUNS, 10)         || 3,
  generation: parseInt(process.env.DEMO_DAILY_GENERATIONS, 10)  || 5,
};

// ── In-memory counter store (fallback when Redis is unavailable) ──────────────
// Key format: "userId:operation:dateStr" → count
const memCounters = new Map();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function todayKey(userId, operation) {
  const d = new Date();
  const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${userId}:${operation}:${dateStr}`;
}

/** Remove stale entries from yesterday or earlier. */
function cleanupMemCounters() {
  if (Date.now() - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = Date.now();
  const todayStr = todayKey("", "").split(":").pop(); // just the date part
  for (const key of memCounters.keys()) {
    if (!key.endsWith(todayStr)) memCounters.delete(key);
  }
}

// ── Counter operations (Redis or in-memory) ───────────────────────────────────

async function getCount(userId, operation) {
  if (isRedisAvailable()) {
    const key = `sentri:demo:${todayKey(userId, operation)}`;
    const val = await redis.get(key);
    return parseInt(val, 10) || 0;
  }
  cleanupMemCounters();
  return memCounters.get(todayKey(userId, operation)) || 0;
}

async function incrementCount(userId, operation) {
  if (isRedisAvailable()) {
    const key = `sentri:demo:${todayKey(userId, operation)}`;
    const count = await redis.incr(key);
    // Set TTL to 25 hours so keys auto-expire even if cleanup fails
    if (count === 1) await redis.expire(key, 25 * 60 * 60);
    return count;
  }
  cleanupMemCounters();
  const key = todayKey(userId, operation);
  const current = (memCounters.get(key) || 0) + 1;
  memCounters.set(key, current);
  return current;
}

// ── BYOK detection ────────────────────────────────────────────────────────────

/**
 * Check whether any AI provider key has been configured on this server
 * (beyond the platform-owned demo key). When true, all users bypass
 * demo quotas — this is a SERVER-GLOBAL check, not per-user.
 *
 * Rationale: Sentri stores AI keys at the server level (env vars or
 * Settings page), not per-user. If an admin configures a key via
 * `POST /api/v1/settings`, ALL users benefit from it. In the intended
 * demo deployment, no admin keys are set — only `DEMO_GOOGLE_API_KEY`.
 *
 * If per-user key storage is added in the future, this function should
 * be updated to check user-scoped keys instead.
 *
 * @returns {boolean}
 */
function serverHasConfiguredKey() {
  const keys = getConfiguredKeys();
  // If any cloud provider has a key that is NOT the demo key, server is BYOK
  if (keys.anthropic) return true;
  if (keys.openai) return true;
  // For Google: getConfiguredKeys() uses getUserConfiguredKey() which
  // excludes the demo fallback. A non-empty value means an admin saved
  // their own Google key via Settings.
  if (keys.google) return true;
  if (keys.ollamaConfigured) return true;
  return false;
}

// ── Middleware factory ─────────────────────────────────────────────────────────

/**
 * Create a middleware that enforces demo-mode daily quotas.
 *
 * @param {"crawl"|"run"|"generation"} operation - Which quota bucket to check.
 * @returns {Function} Express middleware.
 */
export function demoQuota(operation) {
  return async (req, res, next) => {
    // Skip if demo mode is not enabled
    if (!isDemoEnabled) return next();

    // Skip if the server has a configured AI key (admin BYOK — server-global)
    if (serverHasConfiguredKey()) return next();

    const userId = req.authUser?.sub;
    if (!userId) return next(); // unauthenticated — let auth middleware handle it

    const limit = DAILY_LIMITS[operation];
    if (!limit) return next(); // unknown operation — no quota

    const current = await getCount(userId, operation);
    if (current >= limit) {
      return res.status(429).json({
        error: `Daily demo limit reached (${limit} ${operation}${limit !== 1 ? "s" : ""} per day). Add your own AI provider key in Settings for unlimited usage.`,
        demoLimit: true,
        operation,
        limit,
        used: current,
      });
    }

    // Increment AFTER the check (will be incremented again if the operation
    // actually starts — but this prevents burst-through on concurrent requests)
    await incrementCount(userId, operation);
    next();
  };
}

/**
 * Get the current demo quota status for a user.
 * Used by the dashboard/config endpoint so the frontend can show remaining quota.
 *
 * @param {string} userId
 * @returns {Promise<Object>} Quota status per operation.
 */
export async function getDemoQuotaStatus(userId) {
  if (!isDemoEnabled) return null;
  const status = {};
  for (const [op, limit] of Object.entries(DAILY_LIMITS)) {
    const used = await getCount(userId, op);
    status[op] = { used, limit, remaining: Math.max(0, limit - used) };
  }
  return status;
}
