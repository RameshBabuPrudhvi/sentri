/**
 * @module aiProvider/quotaGuard
 * @description B3.7 — Token-bucket rate limiter + per-workspace USD spend
 *   cap enforcement for every AI dispatch call.
 *
 * ## Two surfaces
 *
 *   1. **Per-route token-bucket** — caps `rpmLimit` requests/minute and
 *      `tpmLimit` tokens/minute on each `provider_routes` row. Pre-call
 *      `checkAndReserve(routeId, estimatedTokens)` reserves capacity;
 *      post-call `reportActual(routeId, actualTokens, costUsd)` corrects
 *      the estimate so over- or under-counting drifts back to the truth
 *      after one call. Buckets refill at the configured rate-per-minute.
 *
 *   2. **Per-workspace spend cap** — caps the workspace's USD spend per
 *      day / month against `workspaces.dailySpendCapUsd` /
 *      `monthlySpendCapUsd`. `checkSpendCap(workspaceId)` sums realised
 *      cost over the relevant window (24h or month-to-date) and rejects
 *      when over.
 *
 * ## In-memory vs Redis
 *
 * The token-bucket state is in-memory by default. When `REDIS_URL` is
 * set, the same operations route through Redis atomic ops (`EVAL` Lua
 * script) so multi-replica deployments don't independently over-spend
 * their shared quota. The Redis path is OPT-IN — single-replica
 * deployments keep zero-latency in-process buckets without paying for
 * the Redis round-trip per AI call.
 *
 * Spend-cap data ALWAYS comes from the DB (`ai_request_log` table from
 * B2.5) because spend is durable per workspace and survives process
 * restarts. Multi-replica spend caps are correct by construction —
 * every replica queries the same SQL.
 *
 * ## Error contract
 *
 * `checkAndReserve` and `checkSpendCap` never throw. They return
 * `{ ok: false, ... }` shapes so the dispatcher can decide whether to
 * surface `ERR_RATE_LIMIT_LOCAL` / `ERR_SPEND_CAP_EXCEEDED` to the
 * caller WITHOUT burning a provider API call. The dispatcher mints
 * the Error objects with the right `.code` field at its call site;
 * this module never throws to keep the hot-path branchless.
 */
import { isRedisAvailable, redis } from "../utils/redisClient.js";
import { getDatabase } from "../database/sqlite.js";
import { formatLogLine } from "../utils/logFormatter.js";

// ── Token-bucket state (in-memory) ────────────────────────────────────────────
//
// Per-route bucket keyed by routeId. Tracks BOTH a request counter
// (rpmLimit) and a token counter (tpmLimit) because the two dimensions
// refill independently — a route can have plenty of token budget left
// but no request budget, or vice versa. The gate rejects on whichever
// runs out first.
//
// Shape: { reqBucket: number, tokBucket: number, lastRefillMs: number }
//
// The bucket is replenished lazily on every read/write (proportional to
// time elapsed since the last call). No background timer — scheduled
// work even for idle routes would be wasteful. Lazy refill keeps the
// hot path allocation-free.
const inMemoryBuckets = new Map();
const REFILL_WINDOW_MS = 60_000;
// Redis key TTL for abandoned buckets — long enough that a route used
// once an hour doesn't lose state, short enough that deleted routes
// don't leave permanent zombie keys.
const REDIS_BUCKET_TTL_SEC = 60 * 60 * 4;

function refillBucket(bucket, rpmLimit, tpmLimit) {
  const now = Date.now();
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed <= 0) return;
  if (Number.isFinite(rpmLimit) && rpmLimit > 0) {
    const refill = (elapsed / REFILL_WINDOW_MS) * rpmLimit;
    bucket.reqBucket = Math.min(rpmLimit, bucket.reqBucket + refill);
  }
  if (Number.isFinite(tpmLimit) && tpmLimit > 0) {
    const refill = (elapsed / REFILL_WINDOW_MS) * tpmLimit;
    bucket.tokBucket = Math.min(tpmLimit, bucket.tokBucket + refill);
  }
  bucket.lastRefillMs = now;
}

function computeRetryAfterMs(bucket, estimatedTokens, rpmLimit, tpmLimit) {
  let waitReq = 0;
  let waitTok = 0;
  if (Number.isFinite(rpmLimit) && rpmLimit > 0 && bucket.reqBucket < 1) {
    const deficit = 1 - bucket.reqBucket;
    waitReq = Math.ceil((deficit / rpmLimit) * REFILL_WINDOW_MS);
  }
  if (Number.isFinite(tpmLimit) && tpmLimit > 0 && bucket.tokBucket < estimatedTokens) {
    const deficit = estimatedTokens - bucket.tokBucket;
    waitTok = Math.ceil((deficit / tpmLimit) * REFILL_WINDOW_MS);
  }
  return Math.max(waitReq, waitTok);
}

function reserveInMemory(routeId, estimatedTokens, rpmLimit, tpmLimit) {
  // Hot-path short-circuit: routes with no limits skip the bucket
  // machinery entirely.
  if ((!rpmLimit || rpmLimit <= 0) && (!tpmLimit || tpmLimit <= 0)) {
    return { ok: true, retryAfterMs: 0 };
  }
  let bucket = inMemoryBuckets.get(routeId);
  if (!bucket) {
    bucket = {
      reqBucket: Number.isFinite(rpmLimit) ? rpmLimit : Infinity,
      tokBucket: Number.isFinite(tpmLimit) ? tpmLimit : Infinity,
      lastRefillMs: Date.now(),
    };
    inMemoryBuckets.set(routeId, bucket);
  }
  refillBucket(bucket, rpmLimit, tpmLimit);
  // Check both dimensions BEFORE reserving. Reserving on one and
  // failing on the other would leak capacity.
  const reqOk = !Number.isFinite(rpmLimit) || rpmLimit <= 0 || bucket.reqBucket >= 1;
  const tokOk = !Number.isFinite(tpmLimit) || tpmLimit <= 0 || bucket.tokBucket >= estimatedTokens;
  if (!reqOk || !tokOk) {
    return {
      ok: false,
      retryAfterMs: computeRetryAfterMs(bucket, estimatedTokens, rpmLimit, tpmLimit),
      reason: !reqOk ? "rpm" : "tpm",
    };
  }
  if (Number.isFinite(rpmLimit) && rpmLimit > 0) bucket.reqBucket -= 1;
  if (Number.isFinite(tpmLimit) && tpmLimit > 0) bucket.tokBucket -= estimatedTokens;
  return { ok: true, retryAfterMs: 0 };
}

function reportActualInMemory(routeId, estimatedTokens, actualTokens) {
  const bucket = inMemoryBuckets.get(routeId);
  if (!bucket) return;
  const delta = (Number(actualTokens) || 0) - (Number(estimatedTokens) || 0);
  if (delta === 0) return;
  // Direct mutation — `delta` can be positive (under-estimated, deduct
  // more) or negative (over-estimated, add back capacity). Don't refill
  // before this correction so the lazy refill at next reserve picks up
  // the corrected state.
  bucket.tokBucket = bucket.tokBucket - delta;
}

// ── Redis-backed token-bucket (multi-node) ────────────────────────────────────
//
// Lua script atomically refills the bucket, checks both dimensions,
// and either deducts (success) or returns the wait-ms (failure).
// Atomic because `EVAL` runs Redis-side without other commands
// interleaving — two replicas can never both succeed when only one
// unit of capacity remains.
//
//   KEYS[1] = bucket hash key (`qg:bucket:<routeId>`)
//   ARGV[1] = now (ms)
//   ARGV[2] = rpmLimit (or 0 for unlimited on that dimension)
//   ARGV[3] = tpmLimit
//   ARGV[4] = estimatedTokens
//   ARGV[5] = REFILL_WINDOW_MS
//   ARGV[6] = TTL_SEC for the hash key
//
// Returns `{ok, retryAfterMs, reason}` as an array; ioredis unpacks
// nested tables into JS arrays.
const RESERVE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local rpm = tonumber(ARGV[2])
local tpm = tonumber(ARGV[3])
local est = tonumber(ARGV[4])
local window = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

local bucket = redis.call("HMGET", key, "req", "tok", "last")
local reqB = tonumber(bucket[1])
local tokB = tonumber(bucket[2])
local last = tonumber(bucket[3])
if reqB == nil then reqB = rpm > 0 and rpm or 0 end
if tokB == nil then tokB = tpm > 0 and tpm or 0 end
if last == nil then last = now end

local elapsed = now - last
if elapsed > 0 then
  if rpm > 0 then reqB = math.min(rpm, reqB + (elapsed / window) * rpm) end
  if tpm > 0 then tokB = math.min(tpm, tokB + (elapsed / window) * tpm) end
end

local reqOk = (rpm <= 0) or (reqB >= 1)
local tokOk = (tpm <= 0) or (tokB >= est)
if (not reqOk) or (not tokOk) then
  local waitR = 0
  local waitT = 0
  if rpm > 0 and reqB < 1 then waitR = math.ceil(((1 - reqB) / rpm) * window) end
  if tpm > 0 and tokB < est then waitT = math.ceil(((est - tokB) / tpm) * window) end
  local wait = math.max(waitR, waitT)
  local reason = (not reqOk) and "rpm" or "tpm"
  redis.call("HMSET", key, "req", tostring(reqB), "tok", tostring(tokB), "last", tostring(now))
  redis.call("EXPIRE", key, ttl)
  return {0, wait, reason}
end

if rpm > 0 then reqB = reqB - 1 end
if tpm > 0 then tokB = tokB - est end
redis.call("HMSET", key, "req", tostring(reqB), "tok", tostring(tokB), "last", tostring(now))
redis.call("EXPIRE", key, ttl)
return {1, 0, ""}
`;

async function reserveViaRedis(routeId, estimatedTokens, rpmLimit, tpmLimit) {
  if ((!rpmLimit || rpmLimit <= 0) && (!tpmLimit || tpmLimit <= 0)) {
    return { ok: true, retryAfterMs: 0 };
  }
  try {
    const result = await redis.eval(
      RESERVE_LUA,
      1,
      `qg:bucket:${routeId}`,
      String(Date.now()),
      String(rpmLimit || 0),
      String(tpmLimit || 0),
      String(estimatedTokens || 0),
      String(REFILL_WINDOW_MS),
      String(REDIS_BUCKET_TTL_SEC),
    );
    const [ok, wait, reason] = Array.isArray(result) ? result : [0, 0, "redis_error"];
    if (Number(ok) === 1) return { ok: true, retryAfterMs: 0 };
    return { ok: false, retryAfterMs: Number(wait) || 0, reason: reason || "unknown" };
  } catch (err) {
    // Fail-OPEN on Redis errors. The token-bucket is a best-effort
    // guard — a Redis outage MUST NOT take down dispatch. We log so
    // ops can correlate, and fall through to in-memory enforcement
    // so single-replica fallback still happens.
    console.warn(formatLogLine("warn", null,
      `[quotaGuard] Redis reserve failed (${err.message}); falling back to in-memory bucket`));
    return reserveInMemory(routeId, estimatedTokens, rpmLimit, tpmLimit);
  }
}

async function reportActualViaRedis(routeId, estimatedTokens, actualTokens) {
  const delta = (Number(actualTokens) || 0) - (Number(estimatedTokens) || 0);
  if (delta === 0) return;
  try {
    // HINCRBYFLOAT with a NEGATIVE delta — Redis decrements the
    // remaining token budget by exactly the under/over-count. We
    // don't refill here; the next reserve's lazy refill in the Lua
    // script handles that.
    await redis.hincrbyfloat(`qg:bucket:${routeId}`, "tok", String(-delta));
    await redis.expire(`qg:bucket:${routeId}`, REDIS_BUCKET_TTL_SEC);
  } catch (err) {
    // Same fail-open contract — drift correction is best-effort.
    console.warn(formatLogLine("warn", null,
      `[quotaGuard] Redis report-actual failed (${err.message})`));
    reportActualInMemory(routeId, estimatedTokens, actualTokens);
  }
}

// ── Spend cap (per-workspace, USD) ────────────────────────────────────────────
//
// Source of truth: `ai_request_log.costUsd` summed over the cap window.
// The dispatcher writes one row per AI call via `logRequest()` regardless
// of storage mode — even `mode: "none"` populates the metadata columns
// (token counts + cost + outcome), so spend-cap math works without
// requiring the operator to opt into prompt logging.
//
// Window semantics:
//   • daily: rolling 24h (NOT calendar-day) — matches the way operators
//     read "we spent $X in the last day" without timezone surprises.
//   • monthly: month-to-date (calendar-month, UTC) — matches typical
//     vendor billing cycles.
//
// Both caps apply: if EITHER is exceeded, dispatch is blocked.

function readSpendCaps(workspaceId) {
  if (!workspaceId) return null;
  try {
    return getDatabase().prepare(
      "SELECT dailySpendCapUsd, monthlySpendCapUsd, spendAlertThresholdPct FROM workspaces WHERE id = ?",
    ).get(workspaceId);
  } catch (err) {
    // DB unavailable — fail OPEN. Spend cap is best-effort; a DB
    // outage shouldn't take down AI dispatch.
    console.warn(formatLogLine("warn", null,
      `[quotaGuard] spend-cap read failed (${err.message}); allowing call`));
    return null;
  }
}

function readWindowedSpend(workspaceId) {
  const now = new Date();
  const dayCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  try {
    const db = getDatabase();
    const dayRow = db.prepare(
      "SELECT COALESCE(SUM(costUsd), 0) AS spent FROM ai_request_log WHERE workspaceId = ? AND createdAt >= ?",
    ).get(workspaceId, dayCutoff);
    const monthRow = db.prepare(
      "SELECT COALESCE(SUM(costUsd), 0) AS spent FROM ai_request_log WHERE workspaceId = ? AND createdAt >= ?",
    ).get(workspaceId, monthStart);
    return { day: Number(dayRow?.spent) || 0, month: Number(monthRow?.spent) || 0 };
  } catch (err) {
    console.warn(formatLogLine("warn", null,
      `[quotaGuard] windowed-spend read failed (${err.message}); treating spend as 0`));
    return { day: 0, month: 0 };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reserve quota for a single dispatch call.
 *
 * Hot-path. Routes with no `rpmLimit`/`tpmLimit` get the fast `{ ok:
 * true }` return without touching any state. When `REDIS_URL` is set
 * the Lua-atomic Redis path is used so multi-replica deployments share
 * one bucket; otherwise the in-memory path runs.
 *
 * @param {string} routeId
 * @param {number} estimatedTokens - Best-effort estimate. The post-call
 *   `reportActual` corrects drift after the SDK returns.
 * @param {{rpmLimit?: number|null, tpmLimit?: number|null}} [limits]
 * @returns {Promise<{ok: boolean, retryAfterMs: number, reason?: string}>}
 */
export async function checkAndReserve(routeId, estimatedTokens, limits = {}) {
  if (!routeId) return { ok: true, retryAfterMs: 0 };
  const { rpmLimit, tpmLimit } = limits;
  if (isRedisAvailable() && redis) {
    return reserveViaRedis(routeId, estimatedTokens, rpmLimit, tpmLimit);
  }
  return reserveInMemory(routeId, estimatedTokens, rpmLimit, tpmLimit);
}

/**
 * Correct the token-bucket after the real call completes. Cost is
 * accepted for parity with the public API spec but currently unused —
 * spend-cap math reads from `ai_request_log` directly, so we don't
 * need to maintain a separate in-memory spend counter.
 *
 * @param {string} routeId
 * @param {number} estimatedTokens
 * @param {number} actualTokens
 * @param {number} [_costUsd] - reserved for future per-route spend buckets
 */
export async function reportActual(routeId, estimatedTokens, actualTokens, _costUsd) {
  if (!routeId) return;
  if (isRedisAvailable() && redis) {
    return reportActualViaRedis(routeId, estimatedTokens, actualTokens);
  }
  reportActualInMemory(routeId, estimatedTokens, actualTokens);
}

/**
 * Check per-workspace USD spend cap. Reads the workspace's configured
 * caps + sums realised cost over the rolling 24h / month-to-date windows
 * from `ai_request_log` (B2.5).
 *
 * Workspaces with no cap configured (both columns NULL) pass through
 * unconditionally; the function never queries `ai_request_log` for them.
 *
 * @param {string} workspaceId
 * @returns {{ ok: boolean, remainingUsd: number|null, exceeded?: "day"|"month", alertTriggered?: boolean, dailyCap?: number|null, monthlyCap?: number|null, dailySpent?: number, monthlySpent?: number, thresholdPct?: number }}
 */
export function checkSpendCap(workspaceId) {
  if (!workspaceId) return { ok: true, remainingUsd: null };
  const caps = readSpendCaps(workspaceId);
  const dailyCap = caps?.dailySpendCapUsd;
  const monthlyCap = caps?.monthlySpendCapUsd;
  if ((!dailyCap || dailyCap <= 0) && (!monthlyCap || monthlyCap <= 0)) {
    return { ok: true, remainingUsd: null };
  }
  const { day: dailySpent, month: monthlySpent } = readWindowedSpend(workspaceId);
  // Compute remaining against whichever cap is configured. When both
  // are set, the smaller remaining wins (most-restrictive enforcement).
  let remaining = Infinity;
  let exceeded = null;
  if (Number.isFinite(dailyCap) && dailyCap > 0) {
    const r = dailyCap - dailySpent;
    if (r <= 0) exceeded = "day";
    remaining = Math.min(remaining, r);
  }
  if (Number.isFinite(monthlyCap) && monthlyCap > 0) {
    const r = monthlyCap - monthlySpent;
    if (r <= 0 && exceeded == null) exceeded = "month";
    remaining = Math.min(remaining, r);
  }
  if (!Number.isFinite(remaining)) remaining = null;
  const thresholdPct = Number(caps?.spendAlertThresholdPct) || 80;
  // Alert fires when current spend crosses `cap * pct/100`. Whichever
  // window crosses first wins.
  let alertTriggered = false;
  if (Number.isFinite(dailyCap) && dailyCap > 0) {
    if (dailySpent >= dailyCap * (thresholdPct / 100)) alertTriggered = true;
  }
  if (Number.isFinite(monthlyCap) && monthlyCap > 0) {
    if (monthlySpent >= monthlyCap * (thresholdPct / 100)) alertTriggered = true;
  }
  return {
    ok: exceeded == null,
    remainingUsd: remaining,
    exceeded,
    alertTriggered,
    dailyCap: Number.isFinite(dailyCap) && dailyCap > 0 ? dailyCap : null,
    monthlyCap: Number.isFinite(monthlyCap) && monthlyCap > 0 ? monthlyCap : null,
    dailySpent,
    monthlySpent,
    thresholdPct,
  };
}

// ── Test seam ─────────────────────────────────────────────────────────────────
/**
 * Test-only — wipe in-memory state between assertions. Never call
 * from product code; the in-memory bucket map is process-local and
 * self-managing in production.
 * @internal
 */
export function _resetForTests() {
  inMemoryBuckets.clear();
}
